package kapon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// GenerationsClient is the Kapon adapter for real generation calls. It
// speaks the domain's classified outcomes plus the bounded standard Kapon
// error envelope used to explain creator-private slot failures. Raw bodies,
// arbitrary fields, output URLs, keys, headers, and prompts never leave this
// package's error paths; a redacted request SHAPE (creator content and
// references replaced) may reach server logs and the failure diagnostic per
// ADR-0016, so a provider rejection can be diagnosed without the payload.
//
// The wire shapes below (OpenAI-style /v1/images/generations and the async
// /v1/contents/generations/tasks family) are the kernel's adapter contract,
// pinned by the fake-Kapon tests; the video slice (#161) refines the exact
// vendor payload mapping during its real-invocation acceptance.
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

// imageSize resolves the frozen (model, ratio, resolution) triple onto the
// vendor pixel size from the shared domain table — the same table the
// manifest publishes as display sizes, so the wire value can never drift
// from what the Workbench showed. A missing combination is an internal
// contract violation, never a silent downgrade.
func imageSize(req domain.SubmitRequest) (string, error) {
	if req.Ratio == nil || req.Resolution == nil {
		return "", &domain.ProviderRejectedError{Reason: domain.ReasonInternalError}
	}
	size, ok := domain.ImageSizeFor(req.Model, *req.Ratio, *req.Resolution)
	if !ok {
		return "", &domain.ProviderRejectedError{Reason: domain.ReasonInternalError}
	}
	return fmt.Sprintf("%dx%d", size.Width, size.Height), nil
}

// imageWireModels maps a manifest model id onto the request model id the
// gateway actually accepts. The pro manifest id needs its versioned backend
// id: the dotted catalog alias resolves per-request across backend pools and
// intermittently answers invalid_request_error 400 on an identical body
// (field report 2026-09-01, both hosts; the versioned id 3/3 stable). The
// base manifest id is a display name the vendor does not list at all — its
// catalog alias doubao-seedream-5.0-n is the accepted request id, while the
// versioned id its successes echo (doubao-seedream-5-0-260128) is rejected
// as an input (user-verified 2026-09-01). Unmapped models travel under their
// own id. Remove this mapping when Kapon fixes alias routing.
var imageWireModels = map[string]string{
	domain.ImageModelID:     "doubao-seedream-5-0-pro-260628",
	domain.ImageModelBaseID: "doubao-seedream-5.0-n",
}

func imageWireModel(model string) string {
	if wire, ok := imageWireModels[model]; ok {
		return wire
	}
	return model
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
func (c *GenerationsClient) Submit(ctx context.Context, credential string, req domain.SubmitRequest) (domain.SubmitOutcome, error) {
	if req.Media == domain.MediaImage {
		return c.submitImage(ctx, credential, req)
	}
	return c.submitVideo(ctx, credential, req)
}

func (c *GenerationsClient) submitImage(ctx context.Context, credential string, req domain.SubmitRequest) (domain.SubmitOutcome, error) {
	size, err := imageSize(req)
	if err != nil {
		return domain.SubmitOutcome{}, err
	}
	// The vendor 豆包生图 contract (OpenAPI 2026-09) has no batch parameter:
	// every request generates exactly one image, so a quantity of Q fans out
	// into Q identical single-image requests, each slot receiving exactly
	// its own request's answer. The submit stays all-or-nothing — any
	// definitive rejection fails it, and a lost transport outcome dominates
	// as indeterminate because those requests may have executed.
	body := map[string]any{
		"model":           imageWireModel(req.Model),
		"prompt":          req.Prompt,
		"size":            size,
		"response_format": "url",
		"watermark":       false,
	}
	if len(req.References) > 0 {
		images := make([]string, 0, len(req.References))
		for _, reference := range req.References {
			images = append(images, reference.Data)
		}
		body["image"] = images
	}
	quantity := req.Quantity
	if quantity < 1 {
		quantity = 1
	}
	urls := make([][]string, quantity)
	errs := make([]error, quantity)
	var wg sync.WaitGroup
	for i := 0; i < quantity; i++ {
		wg.Add(1)
		go func(slot int) {
			defer wg.Done()
			callCtx, cancel := context.WithTimeout(ctx, c.imageSubmitTimeout)
			defer cancel()
			var parsed struct {
				Data []struct {
					URL string `json:"url"`
				} `json:"data"`
			}
			errs[slot] = c.call(callCtx, credential, http.MethodPost, "/v1/images/generations", body, &parsed)
			if errs[slot] != nil {
				return
			}
			for _, item := range parsed.Data {
				if item.URL != "" {
					urls[slot] = append(urls[slot], item.URL)
				}
			}
		}(i)
	}
	wg.Wait()
	for _, err := range errs {
		if errors.Is(err, errTransportLost) {
			// A lost synchronous answer cannot be distinguished from an
			// executed generation: the outcome is indeterminate and the
			// system must never guess a re-submit.
			return domain.SubmitOutcome{}, domain.WithFailureDiagnostic(domain.ErrSubmitIndeterminate, domain.FailureDiagnosticOf(err))
		}
	}
	for _, err := range errs {
		if err != nil {
			return domain.SubmitOutcome{}, err
		}
	}
	outcome := domain.SubmitOutcome{}
	for _, slot := range urls {
		for _, url := range slot {
			outcome.Outputs = append(outcome.Outputs, domain.GatewayOutput{URL: url})
		}
	}
	if len(outcome.Outputs) == 0 {
		diagnostic := domain.NewFailureDiagnostic(
			domain.DiagnosticSourceProvider,
			"provider_output_missing",
			"Kapon returned a successful image response without an output URL",
			nil, "", "",
		)
		return domain.SubmitOutcome{}, domain.WithFailureDiagnostic(
			&domain.ProviderRejectedError{Reason: domain.ReasonInternalError},
			diagnostic,
		)
	}
	return outcome, nil
}

func (c *GenerationsClient) submitVideo(ctx context.Context, credential string, req domain.SubmitRequest) (domain.SubmitOutcome, error) {
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
	if err := c.call(callCtx, credential, http.MethodPost, "/v1/contents/generations/tasks", body, &parsed); err != nil {
		if errors.Is(err, errTransportLost) {
			// The async task may or may not exist; without an external
			// identity there is nothing safe to poll or retry.
			return domain.SubmitOutcome{}, domain.WithFailureDiagnostic(domain.ErrSubmitIndeterminate, domain.FailureDiagnosticOf(err))
		}
		return domain.SubmitOutcome{}, err
	}
	if parsed.ID == "" {
		// A response without an external identity is a lost outcome: the
		// request may have executed, so guessing a retry is forbidden.
		diagnostic := domain.NewFailureDiagnostic(
			domain.DiagnosticSourceProvider,
			"provider_job_id_missing",
			"Kapon accepted the video request without returning a task ID",
			nil, "", "",
		)
		return domain.SubmitOutcome{}, domain.WithFailureDiagnostic(domain.ErrSubmitIndeterminate, diagnostic)
	}
	return domain.SubmitOutcome{ExternalRef: parsed.ID}, nil
}

// Poll queries one external job. Polling is provably side-effect free, so
// every transport failure here is transient, never indeterminate.
func (c *GenerationsClient) Poll(ctx context.Context, credential string, ref string) (domain.PollOutcome, error) {
	callCtx, cancel := context.WithTimeout(ctx, c.pollTimeout)
	defer cancel()
	var parsed struct {
		Status  string `json:"status"`
		Content struct {
			VideoURL string `json:"video_url"`
		} `json:"content"`
		Error *providerJobError `json:"error"`
	}
	if err := c.call(callCtx, credential, http.MethodGet, "/v1/contents/generations/tasks/"+ref, nil, &parsed); err != nil {
		if errors.Is(err, errTransportLost) {
			return domain.PollOutcome{}, domain.WithFailureDiagnostic(domain.ErrProviderUnavailable, domain.FailureDiagnosticOf(err))
		}
		return domain.PollOutcome{}, err
	}
	diagnosticRedactions := providerDiagnosticRedactions(credential, nil)
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
			outcome.Diagnostic = domain.NewFailureDiagnostic(
				domain.DiagnosticSourceProvider,
				"provider_output_missing",
				"Kapon completed the generation without an output URL",
				nil, "", "",
			)
		}
		return outcome, nil
	case "failed":
		reason, diagnostic := classifyRejection(parsed.Error, diagnosticRedactions)
		return domain.PollOutcome{Status: domain.PollFailed, Reason: reason, Diagnostic: diagnostic}, nil
	case "cancelled":
		return domain.PollOutcome{Status: domain.PollCancelled}, nil
	case "expired", "timeout", "timed_out":
		return domain.PollOutcome{
			Status: domain.PollTimedOut,
			Diagnostic: providerJobDiagnostic(
				parsed.Error,
				"provider_job_timed_out",
				"Kapon reported that the generation timed out",
				diagnosticRedactions,
			),
		}, nil
	default:
		// queued/running/unknown non-terminal shapes stay processing.
		return domain.PollOutcome{Status: domain.PollProcessing}, nil
	}
}

// Cancel asks the provider to stop one accepted job. Convergence stays
// authoritative: the worker polls after every cancel request.
func (c *GenerationsClient) Cancel(ctx context.Context, credential string, ref string) error {
	callCtx, cancel := context.WithTimeout(ctx, c.cancelTimeout)
	defer cancel()
	if err := c.call(callCtx, credential, http.MethodPost, "/v1/contents/generations/tasks/"+ref,
		map[string]any{"action": "cancel"}, nil); err != nil {
		if errors.Is(err, errTransportLost) {
			return domain.WithFailureDiagnostic(domain.ErrProviderUnavailable, domain.FailureDiagnosticOf(err))
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

// call performs one classified HTTP round trip carrying the call's Provider
// Key in the Authorization header only — the credential is never persisted,
// logged, or wrapped into an error. The error mapping is the adapter's whole
// opinion about the provider: 402 is the definitive credit block, 429
// carries Retry-After, 5xx/timeouts are transient, and the decoded payload
// (when the caller wants one) is parsed only on 200.
func (c *GenerationsClient) call(ctx context.Context, credential, method, path string, body any, decode any) error {
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
		diagnostic := domain.NewFailureDiagnostic(
			domain.DiagnosticSourceProvider,
			"request_build_failed",
			"Kapon request could not be constructed",
			nil, "", "",
		)
		return domain.WithFailureDiagnostic(fmt.Errorf("kapon: build request: %w", err), diagnostic)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if credential != "" {
		req.Header.Set("Authorization", "Bearer "+credential)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		summary := redactedRequestSummary(body)
		if summary != "" {
			slog.Warn("creation: kapon request lost before a response",
				"method", method, "path", path, "host", c.baseURL, "request", summary,
			)
		}
		diagnostic := domain.NewFailureDiagnostic(
			domain.DiagnosticSourceProvider,
			"transport_error",
			"Kapon request failed before a response was received"+shapeSuffix(summary, c.baseURL),
			nil, "", "",
		)
		return domain.WithFailureDiagnostic(errTransportLost, diagnostic)
	}
	defer resp.Body.Close()

	var providerFailure providerErrorEnvelope
	if resp.StatusCode != http.StatusOK {
		providerFailure = readProviderErrorEnvelope(resp.Body)
	}
	redactions := providerDiagnosticRedactions(credential, body)
	summary := redactedRequestSummary(body)
	if resp.StatusCode != http.StatusOK && summary != "" {
		// ADR-0016: the redacted request shape — never the creator content —
		// explains a rejection in server logs and the creator diagnostic. The
		// target host rides along: the same body can behave differently per
		// vendor route, and the host is configuration, not a secret.
		slog.Warn("creation: kapon request rejected",
			"method", method,
			"path", path,
			"host", c.baseURL,
			"status", resp.StatusCode,
			"code", redactProviderDiagnosticText(providerFailure.Code, redactions),
			"provider_request_id", redactProviderDiagnosticText(providerFailure.RequestID, redactions),
			"request", summary,
		)
	}
	diagnostic := providerFailure.diagnostic(resp.StatusCode, redactions, shapeSuffix(summary, c.baseURL))

	switch {
	case resp.StatusCode == http.StatusOK:
	case resp.StatusCode == http.StatusPaymentRequired:
		return domain.WithFailureDiagnostic(domain.ErrProviderCreditBlocked, diagnostic)
	case resp.StatusCode == http.StatusTooManyRequests:
		var retryAfter *time.Duration
		if raw := resp.Header.Get("Retry-After"); raw != "" {
			if seconds, parseErr := strconv.Atoi(raw); parseErr == nil && seconds >= 0 {
				wait := time.Duration(seconds) * time.Second
				retryAfter = &wait
			}
		}
		return domain.WithFailureDiagnostic(&domain.RateLimitedError{RetryAfter: retryAfter}, diagnostic)
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		// A credential that passed admission but is now rejected stays a
		// transient condition for in-flight jobs: bounded retry, alarm, and
		// the admin's recheck owns the credential verdict.
		return domain.WithFailureDiagnostic(domain.ErrProviderUnavailable, diagnostic)
	case resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusUnprocessableEntity:
		return domain.WithFailureDiagnostic(
			&domain.ProviderRejectedError{Reason: classifyByCode(providerFailure.Code)},
			diagnostic,
		)
	case resp.StatusCode >= 500:
		if providerFailure.Code == "MODEL_GROUP_ALL_UNAVAILABLE" {
			return domain.WithFailureDiagnostic(
				&domain.ProviderUnavailableError{Reason: domain.ReasonProviderRouteUnavailable},
				diagnostic,
			)
		}
		return domain.WithFailureDiagnostic(domain.ErrProviderUnavailable, diagnostic)
	default:
		return domain.WithFailureDiagnostic(domain.ErrProviderUnavailable, diagnostic)
	}
	if decode != nil {
		if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(decode); err != nil {
			diagnostic := domain.NewFailureDiagnostic(
				domain.DiagnosticSourceProvider,
				"invalid_success_response",
				"Kapon returned an unreadable success response",
				nil, "", "",
			)
			return domain.WithFailureDiagnostic(errTransportLost, diagnostic)
		}
	}
	return nil
}

// classifyRejection maps a poll failure's structured error onto the stable
// taxonomy; unknown codes stay internal_error rather than guessing policy.
type providerJobError struct {
	Code      string `json:"code"`
	Type      string `json:"type"`
	Message   string `json:"message"`
	RequestID string `json:"request_id"`
}

func classifyRejection(err *providerJobError, redactions []string) (*domain.FailureReason, *domain.FailureDiagnostic) {
	if err == nil {
		reason := domain.ReasonInternalError
		diagnostic := providerJobDiagnostic(err, "provider_job_failed", "Kapon reported a failed generation without an error envelope", redactions)
		return &reason, diagnostic
	}
	reason := classifyByCode(err.Code)
	return &reason, providerJobDiagnostic(err, "provider_job_failed", "Kapon reported a failed generation", redactions)
}

func providerJobDiagnostic(err *providerJobError, fallbackCode, fallbackMessage string, redactions []string) *domain.FailureDiagnostic {
	if err == nil {
		return domain.NewFailureDiagnostic(
			domain.DiagnosticSourceProvider,
			fallbackCode,
			fallbackMessage,
			nil, "", "",
		)
	}
	code := err.Code
	if strings.TrimSpace(code) == "" {
		code = fallbackCode
	}
	message := err.Message
	if strings.TrimSpace(message) == "" {
		message = fallbackMessage
	}
	diagnostic := domain.NewFailureDiagnostic(
		domain.DiagnosticSourceProvider,
		redactProviderDiagnosticText(code, redactions),
		redactProviderDiagnosticText(message, redactions),
		nil,
		redactProviderDiagnosticText(err.Type, redactions),
		redactProviderDiagnosticText(err.RequestID, redactions),
	)
	return diagnostic
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

type providerErrorEnvelope struct {
	Code      string
	Type      string
	Message   string
	RequestID string
}

func (e providerErrorEnvelope) diagnostic(status int, redactions []string, requestShape string) *domain.FailureDiagnostic {
	code := e.Code
	if code == "" {
		code = fmt.Sprintf("http_%d", status)
	}
	return domain.NewFailureDiagnostic(
		domain.DiagnosticSourceProvider,
		redactProviderDiagnosticText(code, redactions),
		redactProviderDiagnosticText(providerMessage(e.Message, status), redactions)+requestShape,
		&status,
		redactProviderDiagnosticText(e.Type, redactions),
		redactProviderDiagnosticText(e.RequestID, redactions),
	)
}

// providerRequestSummaryMax bounds the redacted request shape so the
// diagnostic message it rides stays inside the domain's message budget.
const providerRequestSummaryMax = 1024

// shapeSuffix renders " | request: {…} | host: …" for the failure
// diagnostic message. The host is the vendor route configuration, not a
// secret, and the same body can be accepted on one route and rejected on
// another — without it a reported shape cannot be attributed to a route.
func shapeSuffix(summary, host string) string {
	if summary == "" {
		return ""
	}
	return " | request: " + summary + " | host: " + host
}

// redactedRequestSummary renders the outbound request body with every
// sensitive value replaced, so a provider rejection can be diagnosed from
// the request shape alone. Creator content (prompts, reference images,
// URLs) never appears; the output is deterministic because encoding/json
// sorts map keys.
func redactedRequestSummary(body any) string {
	if body == nil {
		return ""
	}
	encoded, err := json.Marshal(redactRequestBody(body, false))
	if err != nil {
		return ""
	}
	if len(encoded) > providerRequestSummaryMax {
		encoded = append(encoded[:providerRequestSummaryMax], "..."...)
	}
	return string(encoded)
}

// redactRequestBody copies the request, replacing every string under a
// sensitive key (prompt, reference images, URLs) with a marker while keeping
// the shape — map keys, slice lengths, flags, numbers — intact.
func redactRequestBody(value any, sensitive bool) any {
	switch typed := value.(type) {
	case map[string]any:
		redacted := make(map[string]any, len(typed))
		for key, item := range typed {
			redacted[key] = redactRequestBody(item, sensitive || providerDiagnosticSensitiveKey(key))
		}
		return redacted
	case map[string]string:
		redacted := make(map[string]any, len(typed))
		for key, item := range typed {
			redacted[key] = redactRequestBody(item, sensitive || providerDiagnosticSensitiveKey(key))
		}
		return redacted
	case []string:
		redacted := make([]any, len(typed))
		for i, item := range typed {
			redacted[i] = redactRequestBody(item, sensitive)
		}
		return redacted
	case []map[string]any:
		redacted := make([]any, len(typed))
		for i, item := range typed {
			redacted[i] = redactRequestBody(item, sensitive)
		}
		return redacted
	case string:
		if sensitive {
			return "[redacted]"
		}
		return typed
	default:
		return value
	}
}

var providerDiagnosticURLPattern = regexp.MustCompile(`(?i)(?:https?://|data:)[^\s"'<>]+`)

func providerDiagnosticRedactions(credential string, body any) []string {
	unique := map[string]struct{}{}
	add := func(value string) {
		if value != "" {
			unique[value] = struct{}{}
		}
	}
	add(credential)
	if credential != "" {
		add("Bearer " + credential)
	}
	var collect func(value any, sensitive bool)
	collect = func(value any, sensitive bool) {
		switch typed := value.(type) {
		case string:
			if sensitive {
				add(typed)
			}
		case []string:
			for _, item := range typed {
				collect(item, sensitive)
			}
		case []map[string]any:
			for _, item := range typed {
				collect(item, sensitive)
			}
		case map[string]string:
			for key, item := range typed {
				collect(item, sensitive || providerDiagnosticSensitiveKey(key))
			}
		case map[string]any:
			for key, item := range typed {
				collect(item, sensitive || providerDiagnosticSensitiveKey(key))
			}
		}
	}
	collect(body, false)
	values := make([]string, 0, len(unique))
	for value := range unique {
		values = append(values, value)
	}
	sort.Slice(values, func(i, j int) bool { return len(values[i]) > len(values[j]) })
	return values
}

func providerDiagnosticSensitiveKey(key string) bool {
	switch key {
	case "prompt", "image", "text", "image_url", "url":
		return true
	default:
		return false
	}
}

func redactProviderDiagnosticText(value string, redactions []string) string {
	for _, redaction := range redactions {
		if value == redaction {
			value = "[redacted]"
			continue
		}
		if len(redaction) >= 8 {
			value = strings.ReplaceAll(value, redaction, "[redacted]")
		}
	}
	return providerDiagnosticURLPattern.ReplaceAllString(value, "[redacted-url]")
}

func providerMessage(message string, status int) string {
	if strings.TrimSpace(message) != "" {
		return message
	}
	if status > 0 {
		return fmt.Sprintf("Kapon request returned HTTP %d", status)
	}
	return "Kapon reported a generation failure"
}

// readProviderErrorEnvelope retains only Kapon's reviewed standard error
// fields. The bounded raw body is decoded in this frame and then discarded;
// arbitrary sibling fields never enter the domain diagnostic.
func readProviderErrorEnvelope(body io.Reader) providerErrorEnvelope {
	var parsed struct {
		Error struct {
			Code      string `json:"code"`
			Type      string `json:"type"`
			Message   string `json:"message"`
			RequestID string `json:"request_id"`
		} `json:"error"`
		RequestID string `json:"request_id"`
	}
	data, err := io.ReadAll(io.LimitReader(body, 64<<10))
	if err != nil || json.Unmarshal(data, &parsed) != nil {
		return providerErrorEnvelope{}
	}
	requestID := parsed.Error.RequestID
	if requestID == "" {
		requestID = parsed.RequestID
	}
	return providerErrorEnvelope{
		Code: parsed.Error.Code, Type: parsed.Error.Type,
		Message: parsed.Error.Message, RequestID: requestID,
	}
}
