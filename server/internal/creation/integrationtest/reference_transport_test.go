package integrationtest

import (
	"context"
	"crypto/sha256"
	"io"
	"sync"

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

type fakeReferenceTransport struct {
	mu            sync.Mutex
	records       []preparedReferenceRecord
	beforePrepare func(creation.UUID, int) error
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
	t.mu.Unlock()
	return creation.ProviderTransferObject{URL: referenceURL(jobID, ordinal)}, nil
}

func (*fakeReferenceTransport) Release(context.Context, creation.UUID, int) error { return nil }

func (t *fakeReferenceTransport) prepared() []preparedReferenceRecord {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]preparedReferenceRecord(nil), t.records...)
}

func referenceURL(jobID creation.UUID, ordinal int) string {
	return "https://provider-transfer.example/" + jobID.String() + "/" + itoaFixture(ordinal) + "?signature=redacted"
}
