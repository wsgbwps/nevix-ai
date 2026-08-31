package kapon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// Slice-10 image adapter conformance (issue #160): the pinned vendor wire
// contract — Authorization on every generation call, the explicit
// (ratio, resolution) → size mapping over the accepted manifest cross
// product, ordered reference payloads, and the classified error mapping.
// These tests stand in for the release gate's real-invocation acceptance
// until real Kapon evidence exists (spec #150 切片交付).

func newGenerationsClient(t *testing.T, handler http.HandlerFunc) *GenerationsClient {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return NewGenerationsClient(server.URL)
}

// imageSizeCase is one accepted (ratio, resolution) combination.
type imageSizeCase struct {
	ratio      string
	resolution string
}

// acceptedCrossProduct derives the manifest's accepted image values from the
// domain itself, so a ratio/resolution added there makes this conformance
// test demand a mapping entry (the adapter table cannot drift silently).
var acceptedCrossProduct = buildAcceptedCrossProduct()

func buildAcceptedCrossProduct() []imageSizeCase {
	cases := make([]imageSizeCase, 0)
	for _, ratio := range domain.AcceptedImageRatios() {
		for _, resolution := range domain.AcceptedImageResolutions() {
			cases = append(cases, imageSizeCase{ratio: ratio, resolution: resolution})
		}
	}
	return cases
}

// TestImageSizeTableCoversAcceptedCrossProduct: every manifest-validated
// (ratio, resolution) combination maps onto one deterministic pixel size
// whose aspect stays within 1% of the requested ratio; anything outside the
// cross product fails closed instead of guessing a substitute.
func TestImageSizeTableCoversAcceptedCrossProduct(t *testing.T) {
	for _, combo := range acceptedCrossProduct {
		ratio, resolution := combo.ratio, combo.resolution
		req := domain.SubmitRequest{
			Media:      domain.MediaImage,
			Ratio:      &ratio,
			Resolution: &resolution,
		}
		size, err := imageSize(req)
		if err != nil {
			t.Fatalf("%s %s: %v", ratio, resolution, err)
		}
		again, err := imageSize(req)
		if err != nil || again != size {
			t.Fatalf("%s %s: mapping must be deterministic (%q vs %q)", ratio, resolution, size, again)
		}
		parts := strings.SplitN(size, "x", 2)
		if len(parts) != 2 {
			t.Fatalf("%s %s: size %q must be WxH", ratio, resolution, size)
		}
		width, height := widthHeight(t, parts[0]), widthHeight(t, parts[1])
		wantW, wantH := ratioEdges(ratio)
		// Compare orientation-free short/long aspects within 1%.
		normalize := func(v float64) float64 {
			if v > 1 {
				return 1 / v
			}
			return v
		}
		got := normalize(float64(width) / float64(height))
		wanted := normalize(float64(wantW) / float64(wantH))
		if math.Abs(got-wanted)/wanted > 0.01 {
			t.Fatalf("%s %s: size %q aspect %.4f drifts from ratio %.4f", ratio, resolution, size, got, wanted)
		}
	}
	// Unknown and missing combinations fail closed.
	if _, err := imageSize(domain.SubmitRequest{Media: domain.MediaImage}); err == nil {
		t.Fatal("missing ratio/resolution must fail closed")
	}
	ratio, resolution := "7:5", "2K"
	if _, err := imageSize(domain.SubmitRequest{Ratio: &ratio, Resolution: &resolution}); err == nil {
		t.Fatal("combination outside the accepted cross product must fail closed")
	}
}

func widthHeight(t *testing.T, raw string) int {
	t.Helper()
	value, err := strconv.Atoi(raw)
	if err != nil {
		t.Fatalf("size edge %q: %v", raw, err)
	}
	return value
}

// ratioEdges normalizes "w:h" onto (long, short) edges.
func ratioEdges(ratio string) (int, int) {
	parts := strings.SplitN(ratio, ":", 2)
	w, _ := strconv.Atoi(parts[0])
	h, _ := strconv.Atoi(parts[1])
	if w < h {
		return h, w
	}
	return w, h
}

// TestImageSubmitWireContract: the generation call authenticates with the
// provided key, transmits the frozen parameters verbatim, and preserves the
// references' order.
func TestImageSubmitWireContract(t *testing.T) {
	var gotAuth, gotBody string
	client := newGenerationsClient(t, func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":[{"url":"https://cdn.example/out-0.png"}]}`))
	})
	ratio, resolution := "4:3", "2K"
	outcome, err := client.Submit(context.Background(), "kapon-key-1", domain.SubmitRequest{
		Media:      domain.MediaImage,
		Model:      "doubao-seedream-5.0-lite",
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
	if gotAuth != "Bearer kapon-key-1" {
		t.Fatalf("submit must authenticate, got %q", gotAuth)
	}
	if len(outcome.Outputs) != 1 || outcome.Outputs[0].URL != "https://cdn.example/out-0.png" {
		t.Fatalf("outputs must map onto gateway outputs: %+v", outcome)
	}
	var payload struct {
		Model          string   `json:"model"`
		Prompt         string   `json:"prompt"`
		N              int      `json:"n"`
		Size           string   `json:"size"`
		ResponseFormat string   `json:"response_format"`
		Image          []string `json:"image"`
	}
	if err := json.Unmarshal([]byte(gotBody), &payload); err != nil {
		t.Fatalf("decode submit body: %v", err)
	}
	if payload.Model != "doubao-seedream-5.0-lite" || payload.Prompt != "商品主图" || payload.N != 2 {
		t.Fatalf("frozen parameters must travel verbatim: %+v", payload)
	}
	if payload.Size != "2048x1536" {
		t.Fatalf("4:3 2K must map onto 2048x1536, got %q", payload.Size)
	}
	if payload.ResponseFormat != "url" {
		t.Fatalf("V1 transfers temporary URLs, got response_format %q", payload.ResponseFormat)
	}
	if len(payload.Image) != 2 || payload.Image[0] != "data:image/png;base64,AAA" || payload.Image[1] != "data:image/jpeg;base64,BBB" {
		t.Fatalf("reference order must be preserved: %v", payload.Image)
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
	req := domain.SubmitRequest{Media: domain.MediaImage, Model: "doubao-seedream-5.0-lite", Ratio: &ratio, Resolution: &resolution}
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
