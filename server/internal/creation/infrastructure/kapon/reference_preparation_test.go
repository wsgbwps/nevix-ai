package kapon

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

type referencePrepareCall struct {
	jobID   domain.UUID
	ordinal int
	source  domain.ReferenceSource
	body    string
}

type recordingReferenceTransport struct {
	calls        []referencePrepareCall
	releaseCalls []struct {
		jobID   domain.UUID
		ordinal int
	}
	urls []string
}

func (t *recordingReferenceTransport) Prepare(ctx context.Context, jobID domain.UUID, ordinal int, source domain.ReferenceSource) (domain.ProviderTransferObject, error) {
	reader, err := source.Open(ctx)
	if err != nil {
		return domain.ProviderTransferObject{}, err
	}
	defer reader.Close()
	body, err := io.ReadAll(reader)
	if err != nil {
		return domain.ProviderTransferObject{}, err
	}
	t.calls = append(t.calls, referencePrepareCall{jobID: jobID, ordinal: ordinal, source: source, body: string(body)})
	return domain.ProviderTransferObject{URL: t.urls[ordinal], ExpiresAt: time.Now().Add(domain.ProviderTransferLifetime)}, nil
}

func (t *recordingReferenceTransport) Release(_ context.Context, jobID domain.UUID, ordinal int) error {
	t.releaseCalls = append(t.releaseCalls, struct {
		jobID   domain.UUID
		ordinal int
	}{jobID: jobID, ordinal: ordinal})
	return nil
}

type scriptedReferenceTransport struct {
	prepareErrors map[int][]error
	prepareCalls  []int
	releaseErrors map[int]error
	releaseCalls  []int
}

func (t *scriptedReferenceTransport) Prepare(ctx context.Context, jobID domain.UUID, ordinal int, source domain.ReferenceSource) (domain.ProviderTransferObject, error) {
	reader, err := source.Open(ctx)
	if err != nil {
		return domain.ProviderTransferObject{}, err
	}
	_, readErr := io.Copy(io.Discard, reader)
	closeErr := reader.Close()
	if readErr != nil {
		return domain.ProviderTransferObject{}, readErr
	}
	if closeErr != nil {
		return domain.ProviderTransferObject{}, closeErr
	}
	t.prepareCalls = append(t.prepareCalls, ordinal)
	errorsForOrdinal := t.prepareErrors[ordinal]
	if attempt := countOrdinal(t.prepareCalls, ordinal); attempt <= len(errorsForOrdinal) && errorsForOrdinal[attempt-1] != nil {
		return domain.ProviderTransferObject{}, errorsForOrdinal[attempt-1]
	}
	return domain.ProviderTransferObject{
		URL:       "https://provider-transfer.example/" + jobID.String() + "/" + string(rune('0'+ordinal)),
		ExpiresAt: time.Date(9999, time.December, 31, 0, 0, 0, 0, time.UTC),
	}, nil
}

func (t *scriptedReferenceTransport) Release(_ context.Context, _ domain.UUID, ordinal int) error {
	t.releaseCalls = append(t.releaseCalls, ordinal)
	return t.releaseErrors[ordinal]
}

func countOrdinal(ordinals []int, want int) int {
	count := 0
	for _, ordinal := range ordinals {
		if ordinal == want {
			count++
		}
	}
	return count
}

type staticReferenceTransportResolver struct{ transport domain.ReferenceTransport }

func (r staticReferenceTransportResolver) ResolveReferenceTransport(context.Context) (domain.ReferenceTransport, error) {
	return r.transport, nil
}

type recordingReferenceTransportResolver struct {
	transport domain.ReferenceTransport
	err       error
	calls     int
}

func (r *recordingReferenceTransportResolver) ResolveReferenceTransport(context.Context) (domain.ReferenceTransport, error) {
	r.calls++
	return r.transport, r.err
}

func TestPrepareReferencesKeepsStorageGateWithoutCreatingTransferObject(t *testing.T) {
	transport := &recordingReferenceTransport{}
	resolver := &recordingReferenceTransportResolver{transport: transport}
	client := NewGenerationsClient("https://models.kapon.test", resolver)
	prepared, err := client.PrepareReferences(context.Background(), domain.NewUUID(), domain.SubmitRequest{Media: domain.MediaImage})
	if err != nil {
		t.Fatalf("prepare reference-free request: %v", err)
	}
	if resolver.calls != 1 || len(transport.calls) != 0 || len(prepared.References) != 0 {
		t.Fatalf("reference-free gate calls=%d prepares=%d references=%d", resolver.calls, len(transport.calls), len(prepared.References))
	}

	resolver.err = domain.ErrObjectStorageUnavailable
	if _, err := client.PrepareReferences(context.Background(), domain.NewUUID(), domain.SubmitRequest{Media: domain.MediaImage}); !errors.Is(err, domain.ErrObjectStorageUnavailable) {
		t.Fatalf("unavailable reference-free gate error = %v, want ErrObjectStorageUnavailable", err)
	}
}

func TestPrepareReferencesPreservesFactsAndBuildsURLOnlyRequest(t *testing.T) {
	transport := &recordingReferenceTransport{urls: []string{
		"https://bucket.oss-cn-hangzhou.aliyuncs.com/provider-transfer/1/0?signature=redacted",
		"https://bucket.oss-cn-hangzhou.aliyuncs.com/provider-transfer/1/1?signature=redacted",
	}}
	client := NewGenerationsClient("https://models.kapon.test", staticReferenceTransportResolver{transport: transport})
	jobID := domain.NewUUID()
	firstBody, secondBody := "first-reference", "second-reference"
	firstSum, secondSum := sha256.Sum256([]byte(firstBody)), sha256.Sum256([]byte(secondBody))
	prepared, err := client.PrepareReferences(context.Background(), jobID, domain.SubmitRequest{
		Media: domain.MediaVideo,
		References: []domain.ReferenceSource{
			{Role: domain.RoleFirstFrame, Kind: domain.KindImage, MIMEType: "image/png", ByteSize: int64(len(firstBody)), SHA256Sum: firstSum, Open: stringSource(firstBody)},
			{Role: domain.RoleOmni, Kind: domain.KindVideo, MIMEType: "video/mp4", ByteSize: int64(len(secondBody)), SHA256Sum: secondSum, Open: stringSource(secondBody)},
		},
	})
	if err != nil {
		t.Fatalf("prepare references: %v", err)
	}
	if len(transport.calls) != 2 {
		t.Fatalf("prepare calls = %d, want 2", len(transport.calls))
	}
	for ordinal, call := range transport.calls {
		if call.jobID != jobID || call.ordinal != ordinal {
			t.Fatalf("prepare call %d lost deterministic identity: %+v", ordinal, call)
		}
	}
	if transport.calls[0].body != firstBody || transport.calls[1].body != secondBody {
		t.Fatalf("reference streams changed order or content: %+v", transport.calls)
	}
	if len(prepared.References) != 2 || prepared.References[0].Role != domain.RoleFirstFrame ||
		prepared.References[0].Kind != domain.KindImage || prepared.References[0].URL != transport.urls[0] ||
		prepared.References[1].Role != domain.RoleOmni || prepared.References[1].Kind != domain.KindVideo ||
		prepared.References[1].URL != transport.urls[1] || prepared.References[0].ExpiresAt.IsZero() || prepared.References[1].ExpiresAt.IsZero() {
		t.Fatalf("prepared request lost reference facts: %+v", prepared.References)
	}
}

func TestReleaseReferenceDelegatesDeterministicIdentity(t *testing.T) {
	transport := &recordingReferenceTransport{}
	resolver := &recordingReferenceTransportResolver{transport: transport}
	client := NewGenerationsClient("https://models.kapon.test", resolver)
	jobID := domain.NewUUID()

	if err := client.ReleaseReference(context.Background(), jobID, 3); err != nil {
		t.Fatalf("release reference: %v", err)
	}
	if resolver.calls != 1 || len(transport.releaseCalls) != 1 ||
		transport.releaseCalls[0].jobID != jobID || transport.releaseCalls[0].ordinal != 3 {
		t.Fatalf("release lost deterministic identity: resolver=%d calls=%+v", resolver.calls, transport.releaseCalls)
	}
}

func TestPrepareReferencesRetriesOneReferenceAtMostFourTimes(t *testing.T) {
	transport := &scriptedReferenceTransport{prepareErrors: map[int][]error{
		0: {
			domain.ErrObjectStorageUnavailable,
			domain.ErrObjectStorageRateLimited,
			domain.ErrObjectStorageUnavailable,
			domain.ErrObjectStorageUnavailable,
		},
	}}
	now := time.Date(2026, 9, 11, 0, 0, 0, 0, time.UTC)
	var waits, jitterBases []time.Duration
	client := NewGenerationsClient("https://models.kapon.test", staticReferenceTransportResolver{transport: transport}, ReferencePreparationTiming{
		Now: func() time.Time { return now },
		Wait: func(_ context.Context, delay time.Duration) error {
			waits = append(waits, delay)
			now = now.Add(delay)
			return nil
		},
		Jitter: func(base time.Duration) time.Duration {
			jitterBases = append(jitterBases, base)
			return base
		},
	})
	opens := 0
	_, err := client.PrepareReferences(context.Background(), domain.NewUUID(), domain.SubmitRequest{
		Media: domain.MediaImage,
		References: []domain.ReferenceSource{{
			Role: domain.RoleReference, Kind: domain.KindImage, MIMEType: "image/png",
			ByteSize: 1, SHA256Sum: sha256.Sum256([]byte("x")),
			Open: func(context.Context) (io.ReadCloser, error) {
				opens++
				return io.NopCloser(strings.NewReader("x")), nil
			},
		}},
	})
	if !errors.Is(err, domain.ErrObjectStorageUnavailable) {
		t.Fatalf("PrepareReferences error = %v, want exhausted transient error", err)
	}
	if opens != 4 || len(transport.prepareCalls) != 4 {
		t.Fatalf("opens/prepares = %d/%d, want 4/4", opens, len(transport.prepareCalls))
	}
	wantWaits := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second}
	if !equalDurations(waits, wantWaits) || !equalDurations(jitterBases, wantWaits) {
		t.Fatalf("waits/jitter bases = %v/%v, want %v", waits, jitterBases, wantWaits)
	}
	if len(transport.releaseCalls) != 1 || transport.releaseCalls[0] != 0 {
		t.Fatalf("cleanup ordinals = %v, want [0]", transport.releaseCalls)
	}
}

func TestPrepareReferencesDoesNotRetryHardFailures(t *testing.T) {
	for _, hardFailure := range []error{
		domain.ErrObjectStorageConfiguration,
		domain.ErrBlobNotFound,
		domain.ErrInvalidReferenceSource,
		domain.ErrReferenceSourceSizeMismatch,
		domain.ErrReferenceSourceMetadataMismatch,
		domain.ErrReferenceSourceChecksumMismatch,
	} {
		t.Run(hardFailure.Error(), func(t *testing.T) {
			transport := &scriptedReferenceTransport{prepareErrors: map[int][]error{0: {hardFailure}}}
			client := NewGenerationsClient("https://models.kapon.test", staticReferenceTransportResolver{transport: transport}, ReferencePreparationTiming{
				Wait: func(context.Context, time.Duration) error {
					t.Fatal("hard failure waited for a retry")
					return nil
				},
			})
			_, err := client.PrepareReferences(context.Background(), domain.NewUUID(), domain.SubmitRequest{
				Media: domain.MediaImage,
				References: []domain.ReferenceSource{{
					Role: domain.RoleReference, Kind: domain.KindImage, MIMEType: "image/png",
					ByteSize: 1, SHA256Sum: sha256.Sum256([]byte("x")), Open: stringSource("x"),
				}},
			})
			if !errors.Is(err, hardFailure) || len(transport.prepareCalls) != 1 {
				t.Fatalf("PrepareReferences error/calls = %v/%v, want %v/one", err, transport.prepareCalls, hardFailure)
			}
		})
	}
}

func TestPrepareReferencesSharesOneBudgetAndCleansEveryAttemptedOrdinal(t *testing.T) {
	transport := &scriptedReferenceTransport{
		prepareErrors: map[int][]error{1: {domain.ErrBlobNotFound}},
		releaseErrors: map[int]error{0: domain.ErrObjectStorageUnavailable},
	}
	now := time.Date(2026, 9, 11, 0, 0, 0, 0, time.UTC)
	client := NewGenerationsClient("https://models.kapon.test", staticReferenceTransportResolver{transport: transport}, ReferencePreparationTiming{
		Now:    func() time.Time { return now },
		Wait:   func(context.Context, time.Duration) error { return nil },
		Jitter: func(base time.Duration) time.Duration { return base },
	})
	_, err := client.PrepareReferences(context.Background(), domain.NewUUID(), domain.SubmitRequest{
		Media: domain.MediaImage,
		References: []domain.ReferenceSource{
			{Role: domain.RoleReference, Kind: domain.KindImage, MIMEType: "image/png", ByteSize: 1, SHA256Sum: sha256.Sum256([]byte("a")), Open: stringSource("a")},
			{Role: domain.RoleReference, Kind: domain.KindImage, MIMEType: "image/png", ByteSize: 1, SHA256Sum: sha256.Sum256([]byte("b")), Open: stringSource("b")},
		},
	})
	if !errors.Is(err, domain.ErrBlobNotFound) {
		t.Fatalf("PrepareReferences error = %v, want original hard failure", err)
	}
	if len(transport.prepareCalls) != 2 || transport.prepareCalls[0] != 0 || transport.prepareCalls[1] != 1 {
		t.Fatalf("prepare order = %v, want [0 1]", transport.prepareCalls)
	}
	if len(transport.releaseCalls) != 2 || transport.releaseCalls[0] != 0 || transport.releaseCalls[1] != 1 {
		t.Fatalf("cleanup after one release failure = %v, want [0 1]", transport.releaseCalls)
	}
}

func TestPrepareReferencesStopsWhenSharedBudgetExpires(t *testing.T) {
	transport := &scriptedReferenceTransport{prepareErrors: map[int][]error{0: {domain.ErrObjectStorageUnavailable}}}
	now := time.Date(2026, 9, 11, 0, 0, 0, 0, time.UTC)
	client := NewGenerationsClient("https://models.kapon.test", staticReferenceTransportResolver{transport: transport}, ReferencePreparationTiming{
		Now: func() time.Time { return now },
		Wait: func(_ context.Context, _ time.Duration) error {
			now = now.Add(10 * time.Minute)
			return nil
		},
		Jitter: func(base time.Duration) time.Duration { return base },
	})
	_, err := client.PrepareReferences(context.Background(), domain.NewUUID(), domain.SubmitRequest{
		Media: domain.MediaImage,
		References: []domain.ReferenceSource{{
			Role: domain.RoleReference, Kind: domain.KindImage, MIMEType: "image/png",
			ByteSize: 1, SHA256Sum: sha256.Sum256([]byte("x")), Open: stringSource("x"),
		}},
	})
	if !errors.Is(err, context.DeadlineExceeded) || len(transport.prepareCalls) != 1 {
		t.Fatalf("PrepareReferences error/calls = %v/%v, want budget exhaustion after one attempt", err, transport.prepareCalls)
	}
}

func equalDurations(got, want []time.Duration) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}

func TestVideoSubmitMapsPreparedReferenceKindsAndRolesToURLs(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Write([]byte(`{"id":"video-task-1"}`))
	}))
	t.Cleanup(server.Close)
	client := NewGenerationsClient(server.URL, nil)
	_, err := client.Submit(context.Background(), "credential", domain.PreparedSubmitRequest{
		Media: domain.MediaVideo, Model: domain.VideoModelID, Prompt: "prompt", Quantity: 1,
		References: []domain.GatewayReference{
			{Role: domain.RoleFirstFrame, Kind: domain.KindImage, URL: "https://objects.example/first", ExpiresAt: time.Now().Add(time.Hour)},
			{Role: domain.RoleLastFrame, Kind: domain.KindImage, URL: "https://objects.example/last", ExpiresAt: time.Now().Add(time.Hour)},
			{Role: domain.RoleOmni, Kind: domain.KindVideo, URL: "https://objects.example/video", ExpiresAt: time.Now().Add(time.Hour)},
			{Role: domain.RoleOmni, Kind: domain.KindAudio, URL: "https://objects.example/audio", ExpiresAt: time.Now().Add(time.Hour)},
		},
	})
	if err != nil {
		t.Fatalf("submit video: %v", err)
	}
	content, ok := body["content"].([]any)
	if !ok || len(content) != 5 {
		t.Fatalf("video content = %#v, want text plus four references", body["content"])
	}
	assertVideoReference := func(index int, kind, role, wantURL string) {
		t.Helper()
		item, ok := content[index].(map[string]any)
		urlField, okURL := item[kind+"_url"].(map[string]any)
		if !ok || !okURL || item["type"] != kind+"_url" || item["role"] != role || urlField["url"] != wantURL {
			t.Fatalf("video content[%d] = %#v", index, content[index])
		}
	}
	assertVideoReference(1, "image", "first_frame", "https://objects.example/first")
	assertVideoReference(2, "image", "last_frame", "https://objects.example/last")
	assertVideoReference(3, "video", "reference_video", "https://objects.example/video")
	assertVideoReference(4, "audio", "reference_audio", "https://objects.example/audio")
	encoded, err := json.Marshal(content)
	if err != nil {
		t.Fatalf("marshal content: %v", err)
	}
	serialized := string(encoded)
	if strings.Contains(serialized, "data:") || strings.Contains(serialized, "base64") || strings.Contains(serialized, "asset://") {
		t.Fatalf("video request contains a non-HTTPS reference authority: %s", serialized)
	}
}

func TestPrepareReferencesRejectsNonPublicHTTPSAuthority(t *testing.T) {
	body := "reference"
	sum := sha256.Sum256([]byte(body))
	for _, invalidURL := range []string{
		"data:image/png;base64,AAAA",
		"http://objects.example/reference",
		"https://127.0.0.1/reference",
		"https://localhost/reference",
	} {
		t.Run(invalidURL, func(t *testing.T) {
			transport := &recordingReferenceTransport{urls: []string{invalidURL}}
			client := NewGenerationsClient("https://models.kapon.test", staticReferenceTransportResolver{transport: transport})
			_, err := client.PrepareReferences(context.Background(), domain.NewUUID(), domain.SubmitRequest{
				Media: domain.MediaImage,
				References: []domain.ReferenceSource{{
					Role: domain.RoleReference, Kind: domain.KindImage, MIMEType: "image/png",
					ByteSize: int64(len(body)), SHA256Sum: sum, Open: stringSource(body),
				}},
			})
			if !errors.Is(err, domain.ErrInvalidReferenceSource) {
				t.Fatalf("PrepareReferences error = %v, want ErrInvalidReferenceSource", err)
			}
		})
	}
}

func stringSource(body string) func(context.Context) (io.ReadCloser, error) {
	return func(context.Context) (io.ReadCloser, error) {
		return io.NopCloser(strings.NewReader(body)), nil
	}
}
