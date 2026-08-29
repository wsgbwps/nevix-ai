package kapon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// GenerationsClient is the Kapon adapter for real generation calls. It
// speaks the domain's classified outcomes only: HTTP status codes map onto
// gateway errors, provider payloads map onto outputs, and request IDs, raw
// error bodies, keys, and prompts never leave this package's error paths.
//
// The wire shapes below (OpenAI-style /v1/images/generations and the async
// /v1/contents/generations/tasks family) are the kernel's adapter contract,
// pinned by the fake-Kapon tests; the image/video slices (#160/#161) refine
// the exact vendor payload mapping during their real-invocation acceptance.
type GenerationsClient struct {
	baseURL string
	http    *http.Client
	// imageSubmitTimeout bounds the synchronous image call; losing the
	// response means the outcome is indistinguishable from unexecuted, so
	// the kernel treats it as indeterminate.
	imageSubmitTimeout time.Duration
	pollTimeout        time.Duration
	cancelTimeout      time.Duration
}

// NewGenerationsClient binds the generation adapter to the validated route.
func NewGenerationsClient(baseURL string) *GenerationsClient {
	return &GenerationsClient{
		baseURL:            strings.TrimRight(baseURL, "/"),
		http:               &http.Client{},
		imageSubmitTimeout: 60 * time.Second,
		pollTimeout:        15 * time.Second,
		cancelTimeout:      15 * time.Second,
	}
}

// compile-time proof the adapter satisfies the kernel's seam.
var _ domain.ProviderGateway = (*GenerationsClient)(nil)

// Submit starts one external generation. Image media is synchronous (the
// call returns outputs; a lost response is indeterminate); video media is
// asynchronous (returns the external reference to poll).
func (c *GenerationsClient) Submit(ctx context.Context, req domain.SubmitRequest) (domain.SubmitOutcome, error) {
	if req.Media == domain.MediaImage {
		return c.submitImage(ctx, req)
	}
	return c.submitVideo(ctx, req)
}

func (c *GenerationsClient) submitImage(ctx context.Context, req domain.SubmitRequest) (domain.SubmitOutcome, error) {
	body := map[string]any{
		"model":           req.Model,
		"prompt":          req.Prompt,
		"n":               req.Quantity,
		"response_format": "url",
		"watermark":       false,
	}
	if req.Resolution != nil {
		body["size"] = *req.Resolution
	}
	if len(req.References) > 0 {
		images := make([]string, 0, len(req.References))
		for _, reference := range req.References {
			images = append(images, reference.Data)
		}
		body["image"] = images
	}
	callCtx, cancel := context.WithTimeout(ctx, c.imageSubmitTimeout)
	defer cancel()
	var parsed struct {
		Data []struct {
			URL string `json:"url"`
		} `json:"data"`
	}
	if err := c.call(callCtx, http.MethodPost, "/v1/images/generations", body, &parsed); err != nil {
		if errors.Is(err, errTransportLost) {
			// A lost synchronous answer cannot be distinguished from an
			// executed generation: the outcome is indeterminate and the
			// system must never guess a re-submit.
			return domain.SubmitOutcome{}, domain.ErrSubmitIndeterminate
		}
		return domain.SubmitOutcome{}, err
	}
	outcome := domain.SubmitOutcome{}
	for _, item := range parsed.Data {
		if item.URL != "" {
			outcome.Outputs = append(outcome.Outputs, domain.GatewayOutput{URL: item.URL})
		}
	}
	if len(outcome.Outputs) == 0 {
		return domain.SubmitOutcome{}, &domain.ProviderRejectedError{Reason: domain.ReasonInternalError}
	}
	return outcome, nil
}

func (c *GenerationsClient) submitVideo(ctx context.Context, req domain.SubmitRequest) (domain.SubmitOutcome, error) {
	command := req.Prompt
	if req.Resolution != nil {
		command += " --resolution " + *req.Resolution
	}
	if req.DurationS != nil {
		command += " --duration " + strconv.Itoa(*req.DurationS)
	}
	content := []map[string]any{{"type": "text", "text": command}}
	for _, reference := range req.References {
		item := map[string]any{"type": "image_url", "image_url": map[string]string{"url": reference.Data}}
		switch reference.Role {
		case domain.RoleFirstFrame:
			item["role"] = "first_frame"
		case domain.RoleLastFrame:
			item["role"] = "last_frame"
		default:
			item["role"] = "reference"
		}
		content = append(content, item)
	}
	body := map[string]any{"model": req.Model, "content": content}
	callCtx, cancel := context.WithTimeout(ctx, c.pollTimeout)
	defer cancel()
	var parsed struct {
		ID string `json:"id"`
	}
	if err := c.call(callCtx, http.MethodPost, "/v1/contents/generations/tasks", body, &parsed); err != nil {
		if errors.Is(err, errTransportLost) {
			// The async task may or may not exist; without an external
			// identity there is nothing safe to poll or retry.
			return domain.SubmitOutcome{}, domain.ErrSubmitIndeterminate
		}
		return domain.SubmitOutcome{}, err
	}
	if parsed.ID == "" {
		// A response without an external identity is a lost outcome: the
		// request may have executed, so guessing a retry is forbidden.
		return domain.SubmitOutcome{}, domain.ErrSubmitIndeterminate
	}
	return domain.SubmitOutcome{ExternalRef: parsed.ID}, nil
}

// Poll queries one external job. Polling is provably side-effect free, so
// every transport failure here is transient, never indeterminate.
func (c *GenerationsClient) Poll(ctx context.Context, ref string) (domain.PollOutcome, error) {
	callCtx, cancel := context.WithTimeout(ctx, c.pollTimeout)
	defer cancel()
	var parsed struct {
		Status  string `json:"status"`
		Content struct {
			VideoURL string `json:"video_url"`
		} `json:"content"`
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := c.call(callCtx, http.MethodGet, "/v1/contents/generations/tasks/"+ref, nil, &parsed); err != nil {
		if errors.Is(err, errTransportLost) {
			return domain.PollOutcome{}, domain.ErrProviderUnavailable
		}
		return domain.PollOutcome{}, err
	}
	switch parsed.Status {
	case "succeeded", "completed":
		outcome := domain.PollOutcome{Status: domain.PollCompleted}
		if parsed.Content.VideoURL != "" {
			outcome.Outputs = append(outcome.Outputs, domain.GatewayOutput{URL: parsed.Content.VideoURL})
		}
		if len(outcome.Outputs) == 0 {
			outcome.Status = domain.PollFailed
			reason := domain.ReasonInternalError
			outcome.Reason = &reason
		}
		return outcome, nil
	case "failed":
		return domain.PollOutcome{Status: domain.PollFailed, Reason: classifyRejection(parsed.Error)}, nil
	case "cancelled":
		return domain.PollOutcome{Status: domain.PollCancelled}, nil
	case "expired", "timeout", "timed_out":
		return domain.PollOutcome{Status: domain.PollTimedOut}, nil
	default:
		// queued/running/unknown non-terminal shapes stay processing.
		return domain.PollOutcome{Status: domain.PollProcessing}, nil
	}
}

// Cancel asks the provider to stop one accepted job. Convergence stays
// authoritative: the worker polls after every cancel request.
func (c *GenerationsClient) Cancel(ctx context.Context, ref string) error {
	callCtx, cancel := context.WithTimeout(ctx, c.cancelTimeout)
	defer cancel()
	if err := c.call(callCtx, http.MethodPost, "/v1/contents/generations/tasks/"+ref,
		map[string]any{"action": "cancel"}, nil); err != nil {
		if errors.Is(err, errTransportLost) {
			return domain.ErrProviderUnavailable
		}
		return err
	}
	return nil
}

// errTransportLost marks a round trip that never produced a classified HTTP
// answer: connection failure, timeout, or an unreadable body. Submit paths
// treat it as an unidentified outcome; idempotent paths treat it as
// transient.
var errTransportLost = errors.New("kapon: transport lost")

// call performs one classified HTTP round trip. The error mapping is the
// adapter's whole opinion about the provider: 402 is the definitive credit
// block, 429 carries Retry-After, 5xx/timeouts are transient, and the
// decoded payload (when the caller wants one) is parsed only on 200.
func (c *GenerationsClient) call(ctx context.Context, method, path string, body any, decode any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("kapon: encode request: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return fmt.Errorf("kapon: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return errTransportLost
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusOK:
	case resp.StatusCode == http.StatusPaymentRequired:
		return domain.ErrProviderCreditBlocked
	case resp.StatusCode == http.StatusTooManyRequests:
		var retryAfter *time.Duration
		if raw := resp.Header.Get("Retry-After"); raw != "" {
			if seconds, parseErr := strconv.Atoi(raw); parseErr == nil && seconds >= 0 {
				wait := time.Duration(seconds) * time.Second
				retryAfter = &wait
			}
		}
		return &domain.RateLimitedError{RetryAfter: retryAfter}
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		// A credential that passed admission but is now rejected stays a
		// transient condition for in-flight jobs: bounded retry, alarm, and
		// the admin's recheck owns the credential verdict.
		return domain.ErrProviderUnavailable
	case resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusUnprocessableEntity:
		// Read the error code only to classify the rejection reason; the
		// raw body never leaves this frame.
		code := readErrorCodeField(resp.Body)
		return &domain.ProviderRejectedError{Reason: classifyByCode(code)}
	case resp.StatusCode >= 500:
		return domain.ErrProviderUnavailable
	default:
		return domain.ErrProviderUnavailable
	}
	if decode != nil {
		if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(decode); err != nil {
			return errTransportLost
		}
	}
	return nil
}

// classifyRejection maps a poll failure's structured error onto the stable
// taxonomy; unknown codes stay internal_error rather than guessing policy.
func classifyRejection(err *struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}) *domain.FailureReason {
	if err == nil {
		reason := domain.ReasonInternalError
		return &reason
	}
	reason := classifyByCode(err.Code)
	return &reason
}

func classifyByCode(code string) domain.FailureReason {
	switch {
	case strings.Contains(code, "output"):
		return domain.ReasonOutputPolicyRejected
	case strings.Contains(code, "policy") || strings.Contains(code, "content") ||
		strings.Contains(code, "input") || strings.Contains(code, "sensitive"):
		return domain.ReasonInputPolicyRejected
	default:
		return domain.ReasonInternalError
	}
}

// readErrorCodeField reads {"error":{"code":...}} (or a bare string) from a
// rejection body without retaining the payload.
func readErrorCodeField(body io.Reader) string {
	limited, ok := body.(io.Reader)
	if !ok {
		return ""
	}
	var parsed struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	data, err := io.ReadAll(io.LimitReader(limited, 64<<10))
	if err != nil || json.Unmarshal(data, &parsed) != nil {
		return ""
	}
	return parsed.Error.Code
}
