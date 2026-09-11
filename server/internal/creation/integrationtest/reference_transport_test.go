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
	mu            sync.Mutex
	records       []preparedReferenceRecord
	releases      []releasedReferenceRecord
	objects       map[string]bool
	releaseErrors map[int]error
	releasePanics map[int]any
	beforePrepare func(creation.UUID, int) error
	afterPrepare  func(creation.UUID, int) error
	beforeRelease func(context.Context, creation.UUID, int) error
}

func (t *fakeReferenceTransport) Prepare(ctx context.Context, jobID creation.UUID, ordinal int, source creation.ReferenceSource) (creation.ProviderTransferObject, error) {
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
	t.mu.Lock()
	t.records = append(t.records, preparedReferenceRecord{
		jobID: jobID, ordinal: ordinal, role: string(source.Role), kind: string(source.Kind),
		mimeType: source.MIMEType, byteSize: source.ByteSize, checksum: source.SHA256Sum,
		readSize: readSize, readSum: readSum,
	})
	if t.objects == nil {
		t.objects = map[string]bool{}
	}
	t.objects[referenceIdentity(jobID.String(), ordinal)] = true
	t.mu.Unlock()
	if t.afterPrepare != nil {
		if err := t.afterPrepare(jobID, ordinal); err != nil {
			return creation.ProviderTransferObject{}, err
		}
	}
	return creation.ProviderTransferObject{URL: referenceURL(jobID, ordinal)}, nil
}

func (t *fakeReferenceTransport) Release(ctx context.Context, jobID creation.UUID, ordinal int) error {
	if t.beforeRelease != nil {
		if err := t.beforeRelease(ctx, jobID, ordinal); err != nil {
			return err
		}
	}
	_, hasDeadline := ctx.Deadline()
	t.mu.Lock()
	t.releases = append(t.releases, releasedReferenceRecord{
		jobID: jobID, ordinal: ordinal, hasDeadline: hasDeadline, contextErr: ctx.Err(),
	})
	panicValue := t.releasePanics[ordinal]
	err := t.releaseErrors[ordinal]
	if panicValue == nil && err == nil {
		delete(t.objects, referenceIdentity(jobID.String(), ordinal))
	}
	t.mu.Unlock()
	if panicValue != nil {
		panic(panicValue)
	}
	return err
}

func (t *fakeReferenceTransport) prepared() []preparedReferenceRecord {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]preparedReferenceRecord(nil), t.records...)
}

func (t *fakeReferenceTransport) released() []releasedReferenceRecord {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]releasedReferenceRecord(nil), t.releases...)
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
		t.objects = map[string]bool{}
	}
	for ordinal := range referenceCount {
		t.objects[referenceIdentity(jobID, ordinal)] = true
	}
}

func (t *fakeReferenceTransport) exists(jobID string, ordinal int) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.objects[referenceIdentity(jobID, ordinal)]
}

func referenceIdentity(jobID string, ordinal int) string {
	return jobID + "/" + itoaFixture(ordinal)
}

func referenceURL(jobID creation.UUID, ordinal int) string {
	return "https://provider-transfer.example/" + jobID.String() + "/" + itoaFixture(ordinal) + "?signature=redacted"
}
