package domain

import "time"

type ReferenceMaterialUploadStatus string

const (
	ReferenceMaterialUploadPending   ReferenceMaterialUploadStatus = "pending"
	ReferenceMaterialUploadVerifying ReferenceMaterialUploadStatus = "verifying"
	ReferenceMaterialUploadFinalized ReferenceMaterialUploadStatus = "finalized"
	ReferenceMaterialUploadTerminal  ReferenceMaterialUploadStatus = "terminal"

	ReferenceMaterialPutLifetime          = 60 * time.Minute
	ReferenceMaterialFinalizeLifetime     = 90 * time.Minute
	ReferenceMaterialVerificationLifetime = 30 * time.Minute
)

// ReferenceMaterialUpload is a creator-private, durable authority for one
// exact final object. ObjectKey and PayloadHash are trusted-only facts and
// never enter the HTTP resource.
type ReferenceMaterialUpload struct {
	ID                     UUID
	OwnerID                UUID
	SessionID              UUID
	MaterialID             UUID
	ObjectKey              string
	FileName               string
	DeclaredKind           Kind
	DeclaredMIMEType       string
	DeclaredByteSize       int64
	ClaimsVersion          int
	IdempotencyKey         string
	PayloadHash            []byte
	ConnectionRevision     int64
	PutDeadline            time.Time
	FinalizeDeadline       time.Time
	Status                 ReferenceMaterialUploadStatus
	CreatedAt              time.Time
	FinalizedAt            *time.Time
	VerificationToken      *UUID
	VerificationLeaseUntil *time.Time
	TerminalAt             *time.Time
	CleanupAttemptCount    int
	CleanupNextAttemptAt   *time.Time
	CleanupConfirmedAt     *time.Time
}

// ReferenceMaterialUploadCleanup is one exact-key cleanup claim. Attempt is
// the fenced durable attempt number that must match before confirmation.
type ReferenceMaterialUploadCleanup struct {
	UploadID         UUID
	ObjectKey        string
	Attempt          int
	FinalizeDeadline Time
}
