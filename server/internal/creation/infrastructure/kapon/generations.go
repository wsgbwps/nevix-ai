package kapon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// GenerationsClient is the Kapon adapter for real generation calls. It
// speaks the domain's classified outcomes plus the bounded standard Kapon
// error envelope used to explain creator-private slot failures. Raw bodies,
// arbitrary fields, output URLs, keys, headers, and prompts never leave this
// package's error paths.
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

// imageSizeKey is one accepted (model, ratio, resolution) combination. The
// frozen specification's manifest-validated cross product is the key set.
type imageSizeKey struct {
	model      string
	ratio      string
	resolution string
}

// imageSizes pins the Kapon wire size ("宽x高" pixels, apifox 2026-09) for
// every declared (model, ratio, resolution) pair. The tables are per model —
// pro publishes 1K/1.5K/2K, n publishes 2K/3K/4K, and the overlapping tier
// labels resolve to different pixels (2K at 16:9 is 2816x1584 on pro but
// 2848x1600 on n) — so the key never drops the model. The pair table still
// fails closed outside the manifest's accepted cross product.
var imageSizes = map[imageSizeKey]string{
	// doubao-seedream-5.0-pro
	{domain.ImageModelID, "1:1", "1K"}:    "1024x1024",
	{domain.ImageModelID, "1:1", "1.5K"}:  "1536x1536",
	{domain.ImageModelID, "1:1", "2K"}:    "2048x2048",
	{domain.ImageModelID, "4:3", "1K"}:    "1152x864",
	{domain.ImageModelID, "4:3", "1.5K"}:  "1792x1344",
	{domain.ImageModelID, "4:3", "2K"}:    "2368x1776",
	{domain.ImageModelID, "3:4", "1K"}:    "864x1152",
	{domain.ImageModelID, "3:4", "1.5K"}:  "1344x1792",
	{domain.ImageModelID, "3:4", "2K"}:    "1776x2368",
	{domain.ImageModelID, "16:9", "1K"}:   "1424x800",
	{domain.ImageModelID, "16:9", "1.5K"}: "2048x1152",
	{domain.ImageModelID, "16:9", "2K"}:   "2816x1584",
	{domain.ImageModelID, "9:16", "1K"}:   "800x1424",
	{domain.ImageModelID, "9:16", "1.5K"}: "1152x2048",
	{domain.ImageModelID, "9:16", "2K"}:   "1584x2816",
	{domain.ImageModelID, "3:2", "1K"}:    "1248x832",
	{domain.ImageModelID, "3:2", "1.5K"}:  "1872x1248",
	{domain.ImageModelID, "3:2", "2K"}:    "2496x1664",
	{domain.ImageModelID, "2:3", "1K"}:    "832x1248",
	{domain.ImageModelID, "2:3", "1.5K"}:  "1248x1872",
	{domain.ImageModelID, "2:3", "2K"}:    "1664x2496",
	{domain.ImageModelID, "21:9", "1K"}:   "1568x672",
	{domain.ImageModelID, "21:9", "1.5K"}: "2352x1008",
	{domain.ImageModelID, "21:9", "2K"}:   "3136x1344",

	// doubao-seedream-5.0-n
	{domain.ImageModelNID, "1:1", "2K"}:  "2048x2048",
	{domain.ImageModelNID, "1:1", "3K"}:  "3072x3072",
	{domain.ImageModelNID, "1:1", "4K"}:  "4096x4096",
	{domain.ImageModelNID, "4:3", "2K"}:  "2304x1728",
	{domain.ImageModelNID, "4:3", "3K"}:  "3456x2592",
	{domain.ImageModelNID, "4:3", "4K"}:  "4704x3520",
	{domain.ImageModelNID, "3:4", "2K"}:  "1728x2304",
	{domain.ImageModelNID, "3:4", "3K"}:  "2592x3456",
	{domain.ImageModelNID, "3:4", "4K"}:  "3520x4704",
	{domain.ImageModelNID, "16:9", "2K"}: "2848x1600",
	{domain.ImageModelNID, "16:9", "3K"}: "4096x2304",
	{domain.ImageModelNID, "16:9", "4K"}: "5504x3040",
	{domain.ImageModelNID, "9:16", "2K"}: "1600x2848",
	{domain.ImageModelNID, "9:16", "3K"}: "2304x4096",
	{domain.ImageModelNID, "9:16", "4K"}: "3040x5504",
	{domain.ImageModelNID, "3:2", "2K"}:  "2496x1664",
	{domain.ImageModelNID, "3:2", "3K"}:  "3744x2496",
	{domain.ImageModelNID, "3:2", "4K"}:  "4992x3328",
	{domain.ImageModelNID, "2:3", "2K"}:  "1664x2496",
	{domain.ImageModelNID, "2:3", "3K"}:  "2496x3744",
	{domain.ImageModelNID, "2:3", "4K"}:  "3328x4992",
	{domain.ImageModelNID, "21:9", "2K"}: "3136x1344",
	{domain.ImageModelNID, "21:9", "3K"}: "4704x2016",
	{domain.ImageModelNID, "21:9", "4K"}: "6240x2656",
}

// imageSize resolves the frozen (model, ratio, resolution) triple onto the
// vendor pixel size. A missing combination is an internal contract violation,
// never a silent downgrade.
func imageSize(req domain.SubmitRequest) (string, error) {
	if req.Ratio == nil || req.Resolution == nil {
		return "", &domain.ProviderRejectedError{Reason: domain.ReasonInternalError}
	}
	size, ok := imageSizes[imageSizeKey{model: req.Model, ratio: *req.Ratio, resolution: *req.Resolution}]
	if !ok {
		return "", &domain.ProviderRejectedError{Reason: domain.ReasonInternalError}
	}
	return size, nil
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
	body := map[string]any{
		"model":           req.Model,
		"prompt":          req.Prompt,
		"n":               req.Quantity,
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
	callCtx, cancel := context.WithTimeout(ctx, c.imageSubmitTimeout)
	defer cancel()
	var parsed struct {
		Data []struct {
			URL string `json:"url"`
		} `json:"data"`
	}
	if err := c.call(callCtx, credential, http.MethodPost, "/v1/images/generations", body, &parsed); err != nil {
		if errors.Is(err, errTransportLost) {
			// A lost synchronous answer cannot be distinguished from an
			// executed generation: the outcome is indeterminate and the
			// system must never guess a re-submit.
			return domain.SubmitOutcome{}, domain.WithFailureDiagnostic(domain.ErrSubmitIndeterminate, domain.FailureDiagnosticOf(err))
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
		diagnostic := domain.NewFailureDiagnostic(
			domain.DiagnosticSourceProvider,
			"transport_error",
			"Kapon request failed before a response was received",
			nil, "", "",
		)
		return domain.WithFailureDiagnostic(errTransportLost, diagnostic)
	}
	defer resp.Body.Close()

	var providerFailure providerErrorEnvelope
	if resp.StatusCode != http.StatusOK {
		providerFailure = readProviderErrorEnvelope(resp.Body)
	}
	diagnostic := providerFailure.diagnostic(
		resp.StatusCode,
		providerDiagnosticRedactions(credential, body),
	)

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

func (e providerErrorEnvelope) diagnostic(status int, redactions []string) *domain.FailureDiagnostic {
	code := e.Code
	if code == "" {
		code = fmt.Sprintf("http_%d", status)
	}
	return domain.NewFailureDiagnostic(
		domain.DiagnosticSourceProvider,
		redactProviderDiagnosticText(code, redactions),
		redactProviderDiagnosticText(providerMessage(e.Message, status), redactions),
		&status,
		redactProviderDiagnosticText(e.Type, redactions),
		redactProviderDiagnosticText(e.RequestID, redactions),
	)
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
