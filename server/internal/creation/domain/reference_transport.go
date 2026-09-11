package domain

import (
	"context"
	"io"
	"time"
)

// ProviderTransferLifetime is the fixed fetch window granted to a provider.
const ProviderTransferLifetime = 24 * time.Hour

// ReferenceSource is the minimum provider-neutral contract for one immutable
// Reference Material. Every Open call returns a fresh sequential stream of
// the same bytes and the caller closes it promptly.
type ReferenceSource struct {
	Role      DraftRole
	Kind      Kind
	MIMEType  string
	ByteSize  int64
	SHA256Sum [32]byte
	Open      func(context.Context) (io.ReadCloser, error)
}

// ProviderTransferObject is the temporary fetch authority returned by a
// ReferenceTransport. URL is sensitive and must remain in the provider call.
type ProviderTransferObject struct {
	URL string
}

// ReferenceTransport prepares and releases one exact Provider Transfer
// Object without exposing BlobStore, bucket, key, or signing details.
type ReferenceTransport interface {
	Prepare(ctx context.Context, providerJobID UUID, ordinal int, source ReferenceSource) (ProviderTransferObject, error)
	Release(ctx context.Context, providerJobID UUID, ordinal int) error
}

// ReferenceTransportResolver opens the current connection's narrow transfer
// adapter at preparation time. Provider gateways depend on this contract,
// never on Object Storage credentials or BlobStore.
type ReferenceTransportResolver interface {
	ResolveReferenceTransport(context.Context) (ReferenceTransport, error)
}
