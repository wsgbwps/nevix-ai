package integrationtest

import (
	"context"
	"crypto/sha256"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/creation"
)

type preparedReferenceRecord struct {
	jobID    creation.UUID
	ordinal  int
	role     string
	kind     string
	mimeType string
	byteSize int64
	checksum [32]byte
	readSize int64
	readSum  [32]byte
}

type releasedReferenceRecord struct {
	jobID       creation.UUID
	ordinal     int
	hasDeadline bool
	contextErr  error
}

type fakeReferenceTransport struct {
	mu              sync.Mutex
	records         []preparedReferenceRecord
	prepareCalls    []referencePrepareAttempt
	releaseCalls    []releasedReferenceRecord
	objects         map[string]string
	releaseErrors   map[int]error
	releasePanics   map[int]any
	beforePrepare   func(creation.UUID, int) error
	prepareError    func(creation.UUID, int, int) error
	afterPrepare    func(creation.UUID, int) error
	beforeRelease   func(context.Context, creation.UUID, int) error
	releaseError    func(creation.UUID, int) error
	freshURLs       bool
	freshURLVersion int
}

type referencePrepareAttempt struct {
	jobID   creation.UUID
	ordinal int
	attempt int
}

type referenceReleaseAttempt struct {
	jobID   creation.UUID
	ordinal int
}

func (t *fakeReferenceTransport) Prepare(ctx context.Context, jobID creation.UUID, ordinal int, source creation.ReferenceSource) (creation.ProviderTransferObject, error) {
	t.mu.Lock()
	attempt := 1
	for _, call := range t.prepareCalls {
		if call.jobID == jobID && call.ordinal == ordinal {
			attempt++
		}
	}
	t.prepareCalls = append(t.prepareCalls, referencePrepareAttempt{jobID: jobID, ordinal: ordinal, attempt: attempt})
	t.mu.Unlock()
	if t.beforePrepare != nil {
		if err := t.beforePrepare(jobID, ordinal); err != nil {
			return creation.ProviderTransferObject{}, err
		}
	}
	reader, err := source.Open(ctx)
	if err != nil {
		return creation.ProviderTransferObject{}, err
	}
	hash := sha256.New()
	readSize, readErr := io.CopyBuffer(hash, reader, make([]byte, 32<<10))
	closeErr := reader.Close()
	if readErr != nil {
		return creation.ProviderTransferObject{}, readErr
	}
	if closeErr != nil {
		return creation.ProviderTransferObject{}, closeErr
	}
	var readSum [32]byte
	copy(readSum[:], hash.Sum(nil))
	if readSize != source.ByteSize {
		return creation.ProviderTransferObject{}, creation.ErrReferenceSourceSizeMismatch
	}
	if readSum != source.SHA256Sum {
		return creation.ProviderTransferObject{}, creation.ErrReferenceSourceChecksumMismatch
	}
	if t.prepareError != nil {
		if err := t.prepareError(jobID, ordinal, attempt); err != nil {
			return creation.ProviderTransferObject{}, err
		}
	}
	t.mu.Lock()
	if t.objects == nil {
		t.objects = make(map[string]string)
	}
	url := referenceURL(jobID, ordinal)
	if t.freshURLs {
		t.freshURLVersion++
		url += "&version=" + itoaFixture(t.freshURLVersion)
	}
	t.objects[referenceObjectIdentity(jobID, ordinal)] = url
	t.records = append(t.records, preparedReferenceRecord{
		jobID: jobID, ordinal: ordinal, role: string(source.Role), kind: string(source.Kind),
		mimeType: source.MIMEType, byteSize: source.ByteSize, checksum: source.SHA256Sum,
		readSize: readSize, readSum: readSum,
	})
	t.mu.Unlock()
	if t.afterPrepare != nil {
		if err := t.afterPrepare(jobID, ordinal); err != nil {
			return creation.ProviderTransferObject{}, err
		}
	}
	return creation.ProviderTransferObject{
		URL: url, ExpiresAt: time.Now().Add(creation.ProviderTransferLifetime),
	}, nil
}

func (t *fakeReferenceTransport) Release(ctx context.Context, jobID creation.UUID, ordinal int) error {
	if t.beforeRelease != nil {
		if err := t.beforeRelease(ctx, jobID, ordinal); err != nil {
			return err
		}
	}
	_, hasDeadline := ctx.Deadline()
	t.mu.Lock()
	t.releaseCalls = append(t.releaseCalls, releasedReferenceRecord{
		jobID: jobID, ordinal: ordinal, hasDeadline: hasDeadline, contextErr: ctx.Err(),
	})
	panicValue := t.releasePanics[ordinal]
	err := t.releaseErrors[ordinal]
	t.mu.Unlock()
	if panicValue != nil {
		panic(panicValue)
	}
	if err != nil {
		return err
	}
	if t.releaseError != nil {
		if err := t.releaseError(jobID, ordinal); err != nil {
			return err
		}
	}
	t.mu.Lock()
	delete(t.objects, referenceObjectIdentity(jobID, ordinal))
	t.mu.Unlock()
	return nil
}

func (t *fakeReferenceTransport) prepared() []preparedReferenceRecord {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]preparedReferenceRecord(nil), t.records...)
}

func (t *fakeReferenceTransport) released() []releasedReferenceRecord {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]releasedReferenceRecord(nil), t.releaseCalls...)
}

func awaitReferenceReleases(t *testing.T, transport *fakeReferenceTransport, count int) []releasedReferenceRecord {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if releases := transport.released(); len(releases) == count {
			return releases
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("reference releases = %+v, want %d", transport.released(), count)
	return nil
}

func (t *fakeReferenceTransport) failRelease(ordinal int, err error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.releaseErrors == nil {
		t.releaseErrors = map[int]error{}
	}
	t.releaseErrors[ordinal] = err
}

func (t *fakeReferenceTransport) panicRelease(ordinal int, value any) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.releasePanics == nil {
		t.releasePanics = map[int]any{}
	}
	t.releasePanics[ordinal] = value
}

func (t *fakeReferenceTransport) seed(jobID string, referenceCount int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.objects == nil {
		t.objects = map[string]string{}
	}
	for ordinal := range referenceCount {
		t.objects[referenceIdentity(jobID, ordinal)] = "seeded"
	}
}

func (t *fakeReferenceTransport) exists(jobID string, ordinal int) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	_, ok := t.objects[referenceIdentity(jobID, ordinal)]
	return ok
}

func referenceIdentity(jobID string, ordinal int) string {
	return jobID + "/" + itoaFixture(ordinal)
}

func (t *fakeReferenceTransport) attempts() []referencePrepareAttempt {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]referencePrepareAttempt(nil), t.prepareCalls...)
}

func (t *fakeReferenceTransport) releases() []referenceReleaseAttempt {
	t.mu.Lock()
	defer t.mu.Unlock()
	releases := make([]referenceReleaseAttempt, len(t.releaseCalls))
	for index, call := range t.releaseCalls {
		releases[index] = referenceReleaseAttempt{jobID: call.jobID, ordinal: call.ordinal}
	}
	return releases
}

func (t *fakeReferenceTransport) objectCount() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.objects)
}

func referenceObjectIdentity(jobID creation.UUID, ordinal int) string {
	return referenceIdentity(jobID.String(), ordinal)
}

func referenceURL(jobID creation.UUID, ordinal int) string {
	return "https://provider-transfer.example/" + jobID.String() + "/" + itoaFixture(ordinal) + "?signature=redacted"
}
