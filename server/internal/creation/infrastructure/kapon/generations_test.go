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
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// Slice-10 image adapter conformance (issue #160): the pinned vendor wire
// contract — Authorization on every generation call, the explicit
// (model, ratio, resolution) → pixel size mapping over the accepted manifest
// cross product, ordered reference payloads, and the classified error
// mapping. These tests stand in for the release gate's real-invocation
// acceptance until real Kapon evidence exists (spec #150 切片交付).

func newGenerationsClient(t *testing.T, handler http.HandlerFunc) *GenerationsClient {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return NewGenerationsClient(server.URL)
}

// imageSizeCase is one accepted (model, ratio, resolution) combination.
type imageSizeCase struct {
	model      string
	ratio      string
	resolution string
}

// acceptedCrossProduct derives the manifest's accepted image values from the
// domain itself, so a model, ratio, or tier added there makes this
// conformance test demand a mapping entry (the adapter table cannot drift
// silently).
var acceptedCrossProduct = buildAcceptedCrossProduct()

func buildAcceptedCrossProduct() []imageSizeCase {
	cases := make([]imageSizeCase, 0)
	for _, model := range domain.AcceptedImageModels() {
		for _, ratio := range domain.AcceptedImageRatios() {
			for _, resolution := range model.Resolutions {
				cases = append(cases, imageSizeCase{model: model.Model, ratio: ratio, resolution: resolution})
			}
		}
	}
	return cases
}

// TestImageSizeTableCoversAcceptedCrossProduct: Kapon requires the pixel
// size ("宽x高"), and the tables are per model — the overlapping tier labels
// resolve to different pixels (2K at 16:9 is 2816x1584 on pro but 2848x1600
// on n). Every manifest-validated triple stays accepted; unknown triples
// fail closed.
func TestImageSizeTableCoversAcceptedCrossProduct(t *testing.T) {
	for _, combo := range acceptedCrossProduct {
		model, ratio, resolution := combo.model, combo.ratio, combo.resolution
		req := domain.SubmitRequest{
			Media:      domain.MediaImage,
			Model:      model,
			Ratio:      &ratio,
			Resolution: &resolution,
		}
		size, err := imageSize(req)
		if err != nil {
			t.Fatalf("%s %s %s: %v", model, ratio, resolution, err)
		}
		width, height, ok := strings.Cut(size, "x")
		if !ok || width == "" || height == "" {
			t.Fatalf("%s %s %s: size %q is not a WxH pixel string", model, ratio, resolution, size)
		}
	}
	// The vendor doc's distinguishing examples stay pinned: one tier label,
	// different pixels per model.
	proRatio, proTier := "16:9", "2K"
	proSize, err := imageSize(domain.SubmitRequest{Media: domain.MediaImage, Model: domain.ImageModelID, Ratio: &proRatio, Resolution: &proTier})
	if err != nil || proSize != "2816x1584" {
		t.Fatalf("pro 16:9 2K = %q, %v; want 2816x1584", proSize, err)
	}
	nRatio, nTier := "16:9", "2K"
	nSize, err := imageSize(domain.SubmitRequest{Media: domain.MediaImage, Model: domain.ImageModelBaseID, Ratio: &nRatio, Resolution: &nTier})
	if err != nil || nSize != "2848x1600" {
		t.Fatalf("n 16:9 2K = %q, %v; want 2848x1600", nSize, err)
	}

	// Unknown and missing combinations fail closed.
	if _, err := imageSize(domain.SubmitRequest{Media: domain.MediaImage}); err == nil {
		t.Fatal("missing ratio/resolution must fail closed")
	}
	ratio, resolution := "7:5", "2K"
	if _, err := imageSize(domain.SubmitRequest{Model: domain.ImageModelID, Ratio: &ratio, Resolution: &resolution}); err == nil {
		t.Fatal("combination outside the accepted cross product must fail closed")
	}
	// A tier another model publishes still fails closed on a model whose own
	// set lacks it.
	foreignRatio, foreignTier := "1:1", "4K"
	if _, err := imageSize(domain.SubmitRequest{Model: domain.ImageModelID, Ratio: &foreignRatio, Resolution: &foreignTier}); err == nil {
		t.Fatal("4K on pro must fail closed: the tier belongs to n only")
	}
}

// TestImageWireModelsPinsFieldReportedRequestIds: the wire mappings are pure
// field-report data — drop one and the vendor starts answering 400s for a
// model the manifest still publishes. They stay pinned here until Kapon's
// alias routing is fixed and the mapping can be removed.
func TestImageWireModelsPinsFieldReportedRequestIds(t *testing.T) {
	if got := imageWireModel(domain.ImageModelID); got != "doubao-seedream-5-0-pro-260628" {
		t.Fatalf("pro must travel as its versioned backend id (flaky alias), got %q", got)
	}
	if got := imageWireModel(domain.ImageModelBaseID); got != "doubao-seedream-5.0-n" {
		t.Fatalf("the base display id must travel as its catalog alias, got %q", got)
	}
}

// documentedImageRequestKeys is the vendor 豆包生图 OpenAPI request schema
// (2026-09): exactly these body keys exist — notably there is no batch
// parameter, so a quantity of Q must fan out into Q single-image requests.
var documentedImageRequestKeys = map[string]bool{
	"model": true, "prompt": true, "size": true, "response_format": true,
	"image": true, "stream": true, "watermark": true,
}

// specFaithfulImageVendor stands in for the vendor endpoint with its
// documented contract enforced: any body key outside the schema — such as
// the "n" field the adapter once sent, which caused the provider's
// invalid_request_error 400 — or a size outside the model's x-size-map enum
// is rejected exactly like the real route rejects it. Each accepted model
// answers under its manifest alias AND its mapped versioned backend id.
func specFaithfulImageVendor(t *testing.T, onRequest func(seq int, auth string, body map[string]any)) *GenerationsClient {
	specSizes := map[string]map[string]bool{}
	for _, model := range domain.AcceptedImageModels() {
		sizes := map[string]bool{}
		for _, ratio := range domain.AcceptedImageRatios() {
			for _, resolution := range model.Resolutions {
				if size, ok := domain.ImageSizeFor(model.Model, ratio, resolution); ok {
					sizes[fmt.Sprintf("%dx%d", size.Width, size.Height)] = true
				}
			}
		}
		specSizes[model.Model] = sizes
		specSizes[imageWireModel(model.Model)] = sizes
	}
	var mu sync.Mutex
	seq := 0
	return newGenerationsClient(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"error":{"code":"invalid_request_error","message":"malformed body"}}`))
			return
		}
		for key := range body {
			if !documentedImageRequestKeys[key] {
				w.WriteHeader(http.StatusBadRequest)
				w.Write([]byte(`{"error":{"code":"invalid_request_error","type":"invalid_request_error","message":"The request parameters or model capability are not supported."},"request_id":"spec-faithful-rejection"}`))
				return
			}
		}
		model, _ := body["model"].(string)
		size, _ := body["size"].(string)
		if !specSizes[model][size] {
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"error":{"code":"invalid_request_error","message":"size is not in the model's x-size-map"}}`))
			return
		}
		mu.Lock()
		current := seq
		seq++
		mu.Unlock()
		if onRequest != nil {
			onRequest(current, r.Header.Get("Authorization"), body)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(fmt.Sprintf(`{"data":[{"url":"https://cdn.example/spec-out-%d.png"}]}`, current)))
	})
}

// TestImageSubmitWireContract: the generation call authenticates with the
// provided key, transmits only vendor-documented parameters (frozen values
// verbatim, references in order), fans the quantity out into ordered
// single-image requests, and never sends the undocumented batch field.
func TestImageSubmitWireContract(t *testing.T) {
	var mu sync.Mutex
	var bodies []map[string]any
	auths := []string{}
	client := specFaithfulImageVendor(t, func(seq int, auth string, body map[string]any) {
		mu.Lock()
		defer mu.Unlock()
		bodies = append(bodies, body)
		auths = append(auths, auth)
	})
	ratio, resolution := "4:3", "2K"
	outcome, err := client.Submit(context.Background(), "kapon-key-1", domain.SubmitRequest{
		Media:      domain.MediaImage,
		Model:      "doubao-seedream-5.0-pro",
		Prompt:     "商品主图",
		Quantity:   2,
		Ratio:      &ratio,
		Resolution: &resolution,
		References: []domain.GatewayReference{
			{Data: "data:image/png;base64,AAA"},
			{Data: "data:image/jpeg;base64,BBB"},
		},
	})
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	if gotAuth := "Bearer kapon-key-1"; len(auths) != 2 || auths[0] != gotAuth || auths[1] != gotAuth {
		t.Fatalf("every fan-out request must authenticate, got %v", auths)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 2 {
		t.Fatalf("quantity 2 must fan out into 2 single-image requests, got %d", len(bodies))
	}
	for _, body := range bodies {
		if body["model"] != imageWireModel("doubao-seedream-5.0-pro") || body["prompt"] != "商品主图" {
			t.Fatalf("the manifest alias must travel as its deterministic versioned backend id: %+v", body)
		}
		if body["size"] != "2368x1776" {
			t.Fatalf("pro 4:3 2K must send the pixel size, got %v", body["size"])
		}
		if body["response_format"] != "url" {
			t.Fatalf("V1 transfers temporary URLs, got response_format %v", body["response_format"])
		}
		// No batch parameter ever; watermark rides explicitly because the
		// vendor default watermarks outputs and the product ships clean
		// images.
		if _, exists := body["n"]; exists {
			t.Fatalf("the vendor schema has no batch parameter; got key n in %+v", body)
		}
		if body["watermark"] != false {
			t.Fatalf("watermark must stay explicitly false, got %v", body["watermark"])
		}
		for key := range body {
			if !documentedImageRequestKeys[key] {
				t.Fatalf("undocumented request key %q in %+v", key, body)
			}
		}
		image, ok := body["image"].([]any)
		if !ok || len(image) != 2 ||
			image[0] != "data:image/png;base64,AAA" || image[1] != "data:image/jpeg;base64,BBB" {
			t.Fatalf("reference order must be preserved: %v", body["image"])
		}
	}
	if len(outcome.Outputs) != 2 {
		t.Fatalf("fan-out must yield one output per request: %+v", outcome)
	}
	urls := map[string]bool{}
	for _, output := range outcome.Outputs {
		urls[output.URL] = true
	}
	if len(urls) != 2 || !urls["https://cdn.example/spec-out-0.png"] || !urls["https://cdn.example/spec-out-1.png"] {
		t.Fatalf("each sub-request's answer must become one output: %+v", outcome)
	}
}

// TestImageSubmitClassifiedErrors: the adapter's whole provider opinion —
// 402 credit, 429 with Retry-After, 5xx transient, policy rejections, and a
// lost synchronous answer converging as indeterminate.
func TestImageSubmitClassifiedErrors(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		body    string
		assert  func(t *testing.T, err error)
		retryIn *time.Duration
	}{
		{"credit blocked", http.StatusPaymentRequired, "", func(t *testing.T, err error) {
			if !domain.IsCreditBlocked(err) {
				t.Fatalf("402 must classify credit blocked, got %v", err)
			}
		}, nil},
		{"rate limited", http.StatusTooManyRequests, "", func(t *testing.T, err error) {
			if !domain.IsRateLimited(err) {
				t.Fatalf("429 must classify rate limited, got %v", err)
			}
			if got := domain.RetryAfterOf(err); got == nil || *got != 7*time.Second {
				t.Fatalf("Retry-After must carry 7s, got %v", got)
			}
		}, retryAfter(7 * time.Second)},
		{"unavailable", http.StatusServiceUnavailable, "", func(t *testing.T, err error) {
			if !domain.IsProviderUnavailable(err) {
				t.Fatalf("5xx must classify transient, got %v", err)
			}
		}, nil},
		{"model route unavailable", http.StatusServiceUnavailable, `{"error":{"code":"MODEL_GROUP_ALL_UNAVAILABLE","type":"model_routing_error","message":"provider-private-detail","request_id":"kapon-private-request-id","arbitrary_secret":"must-not-cross"}}`, func(t *testing.T, err error) {
			if !domain.IsProviderUnavailable(err) {
				t.Fatalf("model-route 503 must remain retryable, got %v", err)
			}
			if got := domain.ClassifyFailureReason(err); got != domain.ReasonProviderRouteUnavailable {
				t.Fatalf("model-route 503 reason = %s, want provider_route_unavailable", got)
			}
			diagnostic := domain.FailureDiagnosticOf(err)
			if diagnostic == nil || diagnostic.Source != domain.DiagnosticSourceProvider ||
				diagnostic.Code != "MODEL_GROUP_ALL_UNAVAILABLE" ||
				!strings.HasPrefix(diagnostic.Message, "provider-private-detail") ||
				!strings.Contains(diagnostic.Message, `"model":"doubao-seedream-5-0-pro-260628"`) ||
				!strings.Contains(diagnostic.Message, `"size":"2048x2048"`) ||
				diagnostic.ProviderType == nil || *diagnostic.ProviderType != "model_routing_error" ||
				diagnostic.RequestID == nil || *diagnostic.RequestID != "kapon-private-request-id" ||
				diagnostic.HTTPStatus == nil || *diagnostic.HTTPStatus != http.StatusServiceUnavailable {
				t.Fatalf("standard Kapon envelope was not preserved: %+v", diagnostic)
			}
			if strings.Contains(fmt.Sprintf("%+v", diagnostic), "must-not-cross") {
				t.Fatalf("arbitrary provider response field crossed the adapter: %+v", diagnostic)
			}
		}, nil},
		{"unrecognized route error", http.StatusServiceUnavailable, `{"error":{"code":"MODEL_GROUP_SOME_UNAVAILABLE","type":"model_routing_error","message":"provider-private-detail","request_id":"kapon-private-request-id"}}`, func(t *testing.T, err error) {
			if !domain.IsProviderUnavailable(err) {
				t.Fatalf("unknown 503 must remain retryable, got %v", err)
			}
			if got := domain.ClassifyFailureReason(err); got != domain.ReasonTemporarilyUnavailable {
				t.Fatalf("unknown 503 reason = %s, want temporarily_unavailable", got)
			}
			diagnostic := domain.FailureDiagnosticOf(err)
			if diagnostic == nil || diagnostic.Code != "MODEL_GROUP_SOME_UNAVAILABLE" ||
				!strings.HasPrefix(diagnostic.Message, "provider-private-detail") ||
				!strings.Contains(diagnostic.Message, `"size":"2048x2048"`) || diagnostic.RequestID == nil ||
				*diagnostic.RequestID != "kapon-private-request-id" {
				t.Fatalf("unrecognized provider code must still remain diagnosable: %+v", diagnostic)
			}
		}, nil},
		{"unsupported model capability", http.StatusBadRequest, `{"error":{"code":"invalid_request_error","type":"invalid_request_error","message":"The request parameters or model capability are not supported."},"request_id":"kapon-top-level-request-id"}`, func(t *testing.T, err error) {
			var rejected *domain.ProviderRejectedError
			if !errors.As(err, &rejected) || rejected.Reason != domain.ReasonInternalError {
				t.Fatalf("unknown 400 must keep the stable internal reason, got %v", err)
			}
			diagnostic := domain.FailureDiagnosticOf(err)
			if diagnostic == nil || diagnostic.Code != "invalid_request_error" ||
				!strings.HasPrefix(diagnostic.Message, "The request parameters or model capability are not supported.") ||
				!strings.Contains(diagnostic.Message, `"size":"2048x2048"`) ||
				diagnostic.ProviderType == nil || *diagnostic.ProviderType != "invalid_request_error" ||
				diagnostic.RequestID == nil || *diagnostic.RequestID != "kapon-top-level-request-id" ||
				diagnostic.HTTPStatus == nil || *diagnostic.HTTPStatus != http.StatusBadRequest {
				t.Fatalf("Kapon 400 diagnostic was not preserved verbatim: %+v", diagnostic)
			}
		}, nil},
		{"input policy", http.StatusBadRequest, `{"error":{"code":"input_content_policy","message":"x"}}`, func(t *testing.T, err error) {
			var rejected *domain.ProviderRejectedError
			if !errors.As(err, &rejected) || rejected.Reason != domain.ReasonInputPolicyRejected {
				t.Fatalf("input code must classify input_policy_rejected, got %v", err)
			}
		}, nil},
		{"output policy", http.StatusUnprocessableEntity, `{"error":{"code":"output_blocked","message":"x"}}`, func(t *testing.T, err error) {
			var rejected *domain.ProviderRejectedError
			if !errors.As(err, &rejected) || rejected.Reason != domain.ReasonOutputPolicyRejected {
				t.Fatalf("output code must classify output_policy_rejected, got %v", err)
			}
		}, nil},
	}
	ratio, resolution := "1:1", "2K"
	req := domain.SubmitRequest{Media: domain.MediaImage, Model: "doubao-seedream-5.0-pro", Ratio: &ratio, Resolution: &resolution}
	for _, testCase := range cases {
		client := newGenerationsClient(t, func(w http.ResponseWriter, r *http.Request) {
			if testCase.retryIn != nil {
				w.Header().Set("Retry-After", strconv.Itoa(int(*testCase.retryIn/time.Second)))
			}
			w.WriteHeader(testCase.status)
			w.Write([]byte(testCase.body))
		})
		_, err := client.Submit(context.Background(), "k", req)
		if err == nil {
			t.Fatalf("%s: error expected", testCase.name)
		}
		testCase.assert(t, err)
	}

	// A connection dropped without an HTTP answer is an unidentifiable
	// outcome: the adapter reports indeterminate, never a retryable guess.
	client := newGenerationsClient(t, func(w http.ResponseWriter, r *http.Request) {
		panic(http.ErrAbortHandler)
	})
	_, err := client.Submit(context.Background(), "k", req)
	if !domain.IsSubmitIndeterminate(err) {
		t.Fatalf("lost synchronous answer must be indeterminate, got %v", err)
	}
}

func TestSuccessfulSubmitWithoutOutputIdentityKeepsDiagnostic(t *testing.T) {
	ratio, resolution := "1:1", "1K"
	tests := []struct {
		name    string
		request domain.SubmitRequest
		code    string
		assert  func(error) bool
	}{
		{
			name: "image output URL missing",
			request: domain.SubmitRequest{
				Media: domain.MediaImage, Model: domain.ImageModelID,
				Ratio: &ratio, Resolution: &resolution, Quantity: 1,
			},
			code: "provider_output_missing",
			assert: func(err error) bool {
				var rejected *domain.ProviderRejectedError
				return errors.As(err, &rejected) && rejected.Reason == domain.ReasonInternalError
			},
		},
		{
			name: "video task ID missing",
			request: domain.SubmitRequest{
				Media: domain.MediaVideo, Model: domain.VideoModelID, Quantity: 1,
			},
			code:   "provider_job_id_missing",
			assert: domain.IsSubmitIndeterminate,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := newGenerationsClient(t, func(w http.ResponseWriter, r *http.Request) {
				w.Write([]byte(`{}`))
			})
			_, err := client.Submit(context.Background(), "k", test.request)
			if err == nil || !test.assert(err) {
				t.Fatalf("classified error expected, got %v", err)
			}
			diagnostic := domain.FailureDiagnosticOf(err)
			if diagnostic == nil || diagnostic.Code != test.code || diagnostic.Message == "" {
				t.Fatalf("missing concrete response diagnostic: %+v", diagnostic)
			}
		})
	}
}

func TestProviderDiagnosticsRedactCallSecrets(t *testing.T) {
	const (
		credential = "provider-secret-key-123"
		prompt     = "sensitive product prompt"
		reference  = "data:image/png;base64,SENSITIVE"
	)
	client := newGenerationsClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":{"code":"invalid_request_error","type":"invalid_request_error","message":"Bearer provider-secret-key-123 sensitive product prompt data:image/png;base64,SENSITIVE https://cdn.example/private","request_id":"provider-secret-key-123"}}`))
	})
	ratio, resolution := "1:1", "1K"
	_, err := client.Submit(context.Background(), credential, domain.SubmitRequest{
		Media: domain.MediaImage, Model: domain.ImageModelID, Prompt: prompt,
		Ratio: &ratio, Resolution: &resolution, Quantity: 1,
		References: []domain.GatewayReference{{Data: reference}},
	})
	if err == nil {
		t.Fatal("provider rejection expected")
	}
	diagnostic := domain.FailureDiagnosticOf(err)
	if diagnostic == nil || diagnostic.Code != "invalid_request_error" ||
		diagnostic.ProviderType == nil || *diagnostic.ProviderType != "invalid_request_error" {
		t.Fatalf("safe standard fields were lost: %+v", diagnostic)
	}
	serialized := fmt.Sprintf("%+v", diagnostic)
	for _, forbidden := range []string{credential, prompt, reference, "https://cdn.example/private"} {
		if strings.Contains(serialized, forbidden) {
			t.Fatalf("provider diagnostic leaked %q: %+v", forbidden, diagnostic)
		}
	}
	if diagnostic.RequestID == nil || *diagnostic.RequestID != "[redacted]" ||
		!strings.Contains(diagnostic.Message, "[redacted]") ||
		!strings.Contains(diagnostic.Message, "[redacted-url]") {
		t.Fatalf("diagnostic did not retain a visible redaction marker: %+v", diagnostic)
	}
}

func retryAfter(seconds time.Duration) *time.Duration { return &seconds }

// TestPollAndCancelCarryCredential: every generation-family call
// authenticates, and polling never turns transport loss into a verdict.
func TestPollAndCancelCarryCredential(t *testing.T) {
	var pollAuth, cancelAuth string
	client := newGenerationsClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/contents/generations/tasks/"):
			pollAuth = r.Header.Get("Authorization")
			w.Write([]byte(`{"id":"t","status":"succeeded","content":{"video_url":"https://cdn.example/v.mp4"}}`))
		case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/v1/contents/generations/tasks/"):
			cancelAuth = r.Header.Get("Authorization")
			w.Write([]byte(`{"id":"t","status":"cancelling"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	outcome, err := client.Poll(context.Background(), "poll-key", "cgtask-1")
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	if pollAuth != "Bearer poll-key" {
		t.Fatalf("poll must authenticate, got %q", pollAuth)
	}
	if outcome.Status != domain.PollCompleted || len(outcome.Outputs) != 1 {
		t.Fatalf("completed poll must carry outputs: %+v", outcome)
	}
	if err := client.Cancel(context.Background(), "cancel-key", "cgtask-1"); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if cancelAuth != "Bearer cancel-key" {
		t.Fatalf("cancel must authenticate, got %q", cancelAuth)
	}

	loss := newGenerationsClient(t, func(w http.ResponseWriter, r *http.Request) {
		panic(http.ErrAbortHandler)
	})
	if _, err := loss.Poll(context.Background(), "k", "cgtask-1"); !domain.IsProviderUnavailable(err) {
		t.Fatalf("lost poll must stay transient, got %v", err)
	}
}

func TestPollPreservesTerminalDiagnostics(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		status         domain.PollStatus
		code           string
		message        string
		providerType   string
		requestID      string
		failureReason  domain.FailureReason
		reasonExpected bool
	}{
		{
			name:   "failed envelope without code",
			body:   `{"status":"failed","error":{"message":"provider-specific failure","request_id":"poll-request-1"}}`,
			status: domain.PollFailed, code: "provider_job_failed", message: "provider-specific failure",
			requestID: "poll-request-1", failureReason: domain.ReasonInternalError, reasonExpected: true,
		},
		{
			name:   "provider timeout envelope",
			body:   `{"status":"timed_out","error":{"code":"generation_deadline","type":"provider_timeout","message":"provider deadline elapsed","request_id":"poll-request-2"}}`,
			status: domain.PollTimedOut, code: "generation_deadline", message: "provider deadline elapsed",
			providerType: "provider_timeout", requestID: "poll-request-2",
		},
		{
			name:   "completed without output",
			body:   `{"status":"completed","content":{}}`,
			status: domain.PollFailed, code: "provider_output_missing",
			message:       "Kapon completed the generation without an output URL",
			failureReason: domain.ReasonInternalError, reasonExpected: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := newGenerationsClient(t, func(w http.ResponseWriter, r *http.Request) {
				w.Write([]byte(test.body))
			})
			outcome, err := client.Poll(context.Background(), "k", "cgtask-terminal")
			if err != nil {
				t.Fatalf("poll: %v", err)
			}
			if outcome.Status != test.status {
				t.Fatalf("status = %s, want %s", outcome.Status, test.status)
			}
			if test.reasonExpected && (outcome.Reason == nil || *outcome.Reason != test.failureReason) {
				t.Fatalf("reason = %v, want %s", outcome.Reason, test.failureReason)
			}
			diagnostic := outcome.Diagnostic
			if diagnostic == nil || diagnostic.Code != test.code || diagnostic.Message != test.message {
				t.Fatalf("diagnostic = %+v, want code=%s message=%q", diagnostic, test.code, test.message)
			}
			if test.providerType != "" && (diagnostic.ProviderType == nil || *diagnostic.ProviderType != test.providerType) {
				t.Fatalf("provider type = %v, want %s", diagnostic.ProviderType, test.providerType)
			}
			if test.requestID != "" && (diagnostic.RequestID == nil || *diagnostic.RequestID != test.requestID) {
				t.Fatalf("request ID = %v, want %s", diagnostic.RequestID, test.requestID)
			}
		})
	}
}

// TestImageSubmitFanOutFailureSemantics: the submit stays all-or-nothing —
// one rejected sub-request fails the whole submit with its classified error,
// and one lost sub-request dominates as indeterminate because the requests
// may have executed.
func TestImageSubmitFanOutFailureSemantics(t *testing.T) {
	ratio, resolution := "1:1", "2K"
	req := domain.SubmitRequest{
		Media: domain.MediaImage, Model: domain.ImageModelID, Prompt: "p",
		Quantity: 3, Ratio: &ratio, Resolution: &resolution,
	}

	t.Run("one definitive rejection fails the whole submit", func(t *testing.T) {
		var calls atomic.Int64
		client := newGenerationsClient(t, func(w http.ResponseWriter, r *http.Request) {
			if calls.Add(1) == 2 {
				w.WriteHeader(http.StatusBadRequest)
				w.Write([]byte(`{"error":{"code":"invalid_request_error","message":"x"}}`))
				return
			}
			w.Write([]byte(`{"data":[{"url":"https://cdn.example/ok.png"}]}`))
		})
		_, err := client.Submit(context.Background(), "k", req)
		var rejected *domain.ProviderRejectedError
		if !errors.As(err, &rejected) {
			t.Fatalf("one 400 among the fan-out must fail the whole submit, got %v", err)
		}
	})

	t.Run("one lost sub-request stays indeterminate", func(t *testing.T) {
		var calls atomic.Int64
		client := newGenerationsClient(t, func(w http.ResponseWriter, r *http.Request) {
			if calls.Add(1) == 2 {
				panic(http.ErrAbortHandler)
			}
			w.Write([]byte(`{"data":[{"url":"https://cdn.example/ok.png"}]}`))
		})
		_, err := client.Submit(context.Background(), "k", req)
		if !domain.IsSubmitIndeterminate(err) {
			t.Fatalf("one lost answer must make the outcome indeterminate, got %v", err)
		}
	})

	t.Run("a lost answer dominates a definitive rejection", func(t *testing.T) {
		var calls atomic.Int64
		client := newGenerationsClient(t, func(w http.ResponseWriter, r *http.Request) {
			switch calls.Add(1) {
			case 1:
				panic(http.ErrAbortHandler)
			case 2:
				w.WriteHeader(http.StatusBadRequest)
				w.Write([]byte(`{"error":{"code":"invalid_request_error","message":"x"}}`))
			default:
				w.Write([]byte(`{"data":[{"url":"https://cdn.example/ok.png"}]}`))
			}
		})
		_, err := client.Submit(context.Background(), "k", req)
		if !domain.IsSubmitIndeterminate(err) {
			t.Fatalf("a possibly-executed request must win the classification, got %v", err)
		}
	})
}

// TestImageSubmitRejectionCarriesRedactedRequestShape: a provider rejection
// is diagnosable from the redacted request shape — in the server log and in
// the creator-facing diagnostic message — without the prompt or references
// ever leaving the adapter (ADR-0016).
func TestImageSubmitRejectionCarriesRedactedRequestShape(t *testing.T) {
	const prompt = "sensitive product prompt"
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	client := newGenerationsClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":{"code":"invalid_request_error","type":"invalid_request_error","message":"The request parameters or model capability are not supported."},"request_id":"replay-1"}`))
	})
	ratio, resolution := "9:16", "1K"
	_, err := client.Submit(context.Background(), "k", domain.SubmitRequest{
		Media: domain.MediaImage, Model: domain.ImageModelID, Prompt: prompt,
		Quantity: 2, Ratio: &ratio, Resolution: &resolution,
	})
	if err == nil {
		t.Fatal("provider rejection expected")
	}

	diagnostic := domain.FailureDiagnosticOf(err)
	if diagnostic == nil {
		t.Fatal("diagnostic expected")
	}
	if !strings.Contains(diagnostic.Message, `"size":"800x1424"`) ||
		!strings.Contains(diagnostic.Message, `"model":"doubao-seedream-5-0-pro-260628"`) ||
		!strings.Contains(diagnostic.Message, `"prompt":"[redacted]"`) {
		t.Fatalf("diagnostic must carry the redacted request shape: %s", diagnostic.Message)
	}
	if strings.Contains(diagnostic.Message, `"n"`) {
		t.Fatalf("the undocumented batch field must never reappear: %s", diagnostic.Message)
	}
	if strings.Contains(diagnostic.Message, prompt) {
		t.Fatalf("prompt leaked into the diagnostic: %s", diagnostic.Message)
	}

	logged := logs.String()
	// slog's text handler escapes the JSON attrs; assert on the stable
	// markers rather than the exact quoting.
	if !strings.Contains(logged, "creation: kapon request rejected") ||
		!strings.Contains(logged, `800x1424`) ||
		!strings.Contains(logged, `[redacted]`) ||
		strings.Contains(logged, prompt) {
		t.Fatalf("server log must carry the redacted request shape only: %s", logged)
	}
}
