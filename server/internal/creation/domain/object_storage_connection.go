package domain

import (
	"context"
	"errors"
	"strings"
	"time"
)

type ObjectStorageProvider string

const (
	ObjectStorageProviderOSS ObjectStorageProvider = "oss"
	ObjectStorageProviderCOS ObjectStorageProvider = "cos"
)

type ObjectStorageState string

const (
	ObjectStorageStateUnconfigured          ObjectStorageState = "unconfigured"
	ObjectStorageStateReady                 ObjectStorageState = "ready"
	ObjectStorageStateCredentialUnavailable ObjectStorageState = "credential_unavailable"
)

type ObjectStorageCredentialEnvelope ProviderCredentialEnvelope

type ObjectStorageLocation struct {
	Provider ObjectStorageProvider
	Region   string
	Bucket   string
}

// Origin returns the allowlisted virtual-host origin for this canonical location.
func (l ObjectStorageLocation) Origin() string {
	return "https://" + l.Host()
}

func (l ObjectStorageLocation) Host() string {
	if l.Provider == ObjectStorageProviderOSS {
		return l.Bucket + ".oss-" + l.Region + ".aliyuncs.com"
	}
	return l.Bucket + ".cos." + l.Region + ".myqcloud.com"
}

type ObjectStorageCredentials struct {
	AccessKeyID     string
	SecretAccessKey string
}

type ObjectStorageCandidate struct {
	Location    ObjectStorageLocation
	Credentials ObjectStorageCredentials
}

// ObjectStorageVerifier performs all cloud I/O outside Creation write
// transactions and returns only a canonical location or a sanitized error.
type ObjectStorageVerifier interface {
	Verify(ctx context.Context, candidate ObjectStorageCandidate) (ObjectStorageLocation, error)
}

type ObjectStorageConnection struct {
	ID UUID
	ObjectStorageLocation
	Revision          int64
	State             ObjectStorageState
	Envelope          *ObjectStorageCredentialEnvelope
	AccessKeyIDMasked string
	LastCheckedAt     time.Time
	LastCheckOutcome  CheckOutcome
	CreatedByUserID   UUID
	CreatedAt         time.Time
	UpdatedAt         time.Time
	TerminatedAt      *time.Time
}

func MaskObjectStorageAccessKeyID(accessKeyID string) string {
	runes := []rune(strings.TrimSpace(accessKeyID))
	if len(runes) > 4 {
		runes = runes[len(runes)-4:]
	}
	return "****" + string(runes)
}

var (
	ErrObjectStorageConnectionNotConfigured = errors.New("object storage connection not configured")
	ErrObjectStorageConnectionExists        = errors.New("object storage connection already exists")
	ErrInvalidObjectStorageCandidate        = errors.New("invalid object storage candidate")
)

// ObjectStorageConnectionRepository persists only verified encrypted
// connections; callers provide the short write scope that also owns audit.
type ObjectStorageConnectionRepository interface {
	Insert(ctx context.Context, tx TxExecutor, connection *ObjectStorageConnection) error
	GetActive(ctx context.Context) (ObjectStorageConnection, error)
	MarkCredentialUnavailable(ctx context.Context, tx TxExecutor, id UUID) error
}

// ObjectStorageCredentialVault keeps the master key outside PostgreSQL and
// binds every stored credential envelope to its connection, provider, purpose,
// and format version as required by ADR-0016.
type ObjectStorageCredentialVault interface {
	EnsureKey() (CredentialKey, error)
	LoadKey() (CredentialKey, error)
	SealObjectStorage(key CredentialKey, connectionID UUID, provider ObjectStorageProvider, plaintext []byte) (ObjectStorageCredentialEnvelope, error)
	OpenObjectStorage(key CredentialKey, connectionID UUID, provider ObjectStorageProvider, envelope ObjectStorageCredentialEnvelope) ([]byte, error)
}
