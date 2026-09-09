package domain

import "time"

type ReferenceMaterialUploadStatus string

const (
	ReferenceMaterialUploadPending    ReferenceMaterialUploadStatus = "pending"
	ReferenceMaterialUploadFinalized  ReferenceMaterialUploadStatus = "finalized"
	ReferenceMaterialPutLifetime                                    = 60 * time.Minute
	ReferenceMaterialFinalizeLifetime                               = 90 * time.Minute
)

// ReferenceMaterialUpload is a creator-private, durable authority for one
// exact final object. ObjectKey and PayloadHash are trusted-only facts and
// never enter the HTTP resource.
type ReferenceMaterialUpload struct {
	ID                 UUID
	OwnerID            UUID
	SessionID          UUID
	MaterialID         UUID
	ObjectKey          string
	FileName           string
	DeclaredKind       Kind
	DeclaredMIMEType   string
	DeclaredByteSize   int64
	ClaimsVersion      int
	IdempotencyKey     string
	PayloadHash        []byte
	ConnectionRevision int64
	PutDeadline        time.Time
	FinalizeDeadline   time.Time
	Status             ReferenceMaterialUploadStatus
	CreatedAt          time.Time
	FinalizedAt        *time.Time
}
