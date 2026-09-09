package application

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"path/filepath"
	"strings"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

const materialCopyBufferLen = 256 << 10

// MaterialService ingests, lists, streams, and deletes creator-private
// reference materials. Blob placement never happens inside a locked
// transaction: storage I/O runs first or after commit, per ADR-0016.
type MaterialService struct {
	repos    domain.MaterialRepository
	sessions domain.SessionRepository
	uploads  domain.ReferenceMaterialUploadRepository
	tasks    domain.GenerationTaskRepository
	results  domain.BlobStore
	storage  *ObjectStorageConnectionService
	prober   domain.MediaProber
	runner   domain.WriteRunner
}

func NewMaterialService(
	repos domain.MaterialRepository,
	sessions domain.SessionRepository,
	uploads domain.ReferenceMaterialUploadRepository,
	tasks domain.GenerationTaskRepository,
	results domain.BlobStore,
	storage *ObjectStorageConnectionService,
	prober domain.MediaProber,
	runner domain.WriteRunner,
) *MaterialService {
	return &MaterialService{
		repos: repos, sessions: sessions, uploads: uploads, tasks: tasks,
		results: results, storage: storage, prober: prober, runner: runner,
	}
}

// List pages one session's pile oldest-first. The creator-scoped session
// probe runs first so a deleted or foreign session answers not_found even
// when its pile is empty — an empty page alone cannot distinguish those.
func (s *MaterialService) List(ctx context.Context, owner, sessionID domain.UUID, cursor *domain.CompoundCursor, limit int) ([]domain.ReferenceMaterial, *domain.CompoundCursor, error) {
	if _, err := s.sessions.Get(ctx, owner, sessionID); err != nil {
		return nil, nil, err
	}
	return s.repos.ListBySession(ctx, owner, sessionID, cursor, limit)
}

type ReferenceMaterialUploadInput struct {
	IdempotencyKey   string
	FileName         string
	DeclaredKind     domain.Kind
	DeclaredMIMEType string
	DeclaredByteSize int64
}

type ReferenceMaterialUploadAuthorization struct {
	Upload  domain.ReferenceMaterialUpload
	Request *domain.PresignedPut
	Created bool
}

type ReferenceMaterialUploadStatus struct {
	Upload   domain.ReferenceMaterialUpload
	Material *domain.ReferenceMaterial
}

func (s *MaterialService) CreateUpload(ctx context.Context, owner, sessionID domain.UUID, input ReferenceMaterialUploadInput) (ReferenceMaterialUploadAuthorization, error) {
	fileName, mimeType, err := validateUploadInput(input)
	if err != nil {
		return ReferenceMaterialUploadAuthorization{}, err
	}
	if _, err := s.sessions.Get(ctx, owner, sessionID); err != nil {
		return ReferenceMaterialUploadAuthorization{}, err
	}
	now := time.Now().UTC()
	payload, _ := json.Marshal(struct {
		SessionID        string      `json:"session_id"`
		FileName         string      `json:"file_name"`
		DeclaredKind     domain.Kind `json:"declared_kind"`
		DeclaredMIMEType string      `json:"declared_mime_type"`
		DeclaredByteSize int64       `json:"declared_byte_size"`
	}{sessionID.String(), fileName, input.DeclaredKind, mimeType, input.DeclaredByteSize})
	payloadHash := sha256.Sum256(payload)
	idempotencyKey := strings.TrimSpace(input.IdempotencyKey)
	if existing, err := s.uploads.GetByIdempotency(ctx, owner, idempotencyKey); err == nil {
		return s.authorizeUpload(ctx, existing, payloadHash[:], false, nil)
	} else if !errors.Is(err, domain.ErrReferenceMaterialUploadNotFound) {
		return ReferenceMaterialUploadAuthorization{}, err
	}
	store, connection, err := s.storage.ResolveStore(ctx)
	if err != nil {
		return ReferenceMaterialUploadAuthorization{}, err
	}
	materialID := domain.NewUUID()
	candidate := domain.ReferenceMaterialUpload{
		ID: domain.NewUUID(), OwnerID: owner, SessionID: sessionID,
		MaterialID: materialID, ObjectKey: domain.ReferenceBlobKey(materialID),
		FileName: fileName, DeclaredKind: input.DeclaredKind,
		DeclaredMIMEType: mimeType, DeclaredByteSize: input.DeclaredByteSize,
		ClaimsVersion: domain.ClaimsVersion, IdempotencyKey: idempotencyKey,
		PayloadHash: payloadHash[:], ConnectionRevision: connection.Revision,
		PutDeadline:      now.Add(domain.ReferenceMaterialPutLifetime),
		FinalizeDeadline: now.Add(domain.ReferenceMaterialFinalizeLifetime),
		Status:           domain.ReferenceMaterialUploadPending, CreatedAt: now,
	}
	var upload domain.ReferenceMaterialUpload
	err = s.runner.Run(ctx, func(scope domain.WriteScope) error {
		if _, err := s.sessions.GetInTx(ctx, scope.Tx(), owner, sessionID); err != nil {
			return err
		}
		stored, err := s.uploads.UpsertByIdempotency(ctx, scope.Tx(), &candidate)
		if err != nil {
			return err
		}
		if !bytes.Equal(stored.PayloadHash, candidate.PayloadHash) {
			return domain.ErrIdempotencyPayloadConflict
		}
		if !now.Before(stored.FinalizeDeadline) {
			return domain.ErrReferenceMaterialUploadExpired
		}
		upload = stored
		return nil
	})
	if err != nil {
		return ReferenceMaterialUploadAuthorization{}, err
	}
	return s.authorizeUpload(ctx, upload, candidate.PayloadHash, upload.ID == candidate.ID, store)
}

func (s *MaterialService) authorizeUpload(ctx context.Context, upload domain.ReferenceMaterialUpload, payloadHash []byte, created bool, store domain.DirectUploadBlobStore) (ReferenceMaterialUploadAuthorization, error) {
	if !bytes.Equal(upload.PayloadHash, payloadHash) {
		return ReferenceMaterialUploadAuthorization{}, domain.ErrIdempotencyPayloadConflict
	}
	now := time.Now().UTC()
	authorization := ReferenceMaterialUploadAuthorization{Upload: upload, Created: created}
	if upload.Status == domain.ReferenceMaterialUploadFinalized {
		return authorization, nil
	}
	if !now.Before(upload.FinalizeDeadline) {
		return ReferenceMaterialUploadAuthorization{}, domain.ErrReferenceMaterialUploadExpired
	}
	if !now.Before(upload.PutDeadline) {
		// The remaining 30-minute finalize-only window never renews write authority.
		return authorization, nil
	}
	if store == nil {
		var err error
		store, _, err = s.storage.ResolveStore(ctx)
		if err != nil {
			return ReferenceMaterialUploadAuthorization{}, err
		}
	}
	presigned, err := store.PresignPut(ctx, domain.PresignPutRequest{
		Key: upload.ObjectKey, ContentType: upload.DeclaredMIMEType,
		UploadID: upload.ID.String(), ExpiresIn: time.Until(upload.PutDeadline),
	})
	if err != nil {
		return ReferenceMaterialUploadAuthorization{}, domain.ErrObjectStorageUnavailable
	}
	presigned.ExpiresAt = upload.PutDeadline
	authorization.Request = &presigned
	return authorization, nil
}

func validateUploadInput(input ReferenceMaterialUploadInput) (string, string, error) {
	key := strings.TrimSpace(input.IdempotencyKey)
	if len(key) == 0 || len([]rune(key)) > 128 || strings.ContainsRune(key, '\x00') || input.DeclaredByteSize < 1 || input.DeclaredByteSize > input.DeclaredKind.SizeLimit() {
		if input.DeclaredByteSize > 0 && input.DeclaredKind.SizeLimit() > 0 && input.DeclaredByteSize > input.DeclaredKind.SizeLimit() {
			return "", "", domain.ErrTooLarge
		}
		return "", "", domain.ErrReferenceMaterialUploadInvalid
	}
	fileName, err := normalizeMaterialFileName(input.FileName)
	if err != nil {
		return "", "", err
	}
	mimeType, params, err := mime.ParseMediaType(strings.TrimSpace(input.DeclaredMIMEType))
	mimeType = strings.ToLower(mimeType)
	if err != nil || len(params) != 0 || len([]rune(mimeType)) > 255 || !kindAcceptsMIME(input.DeclaredKind, mimeType) {
		return "", "", domain.ErrReferenceMaterialUploadInvalid
	}
	return fileName, mimeType, nil
}

func kindAcceptsMIME(kind domain.Kind, mimeType string) bool {
	switch kind {
	case domain.KindImage, domain.KindVideo, domain.KindAudio:
		return strings.HasPrefix(mimeType, string(kind)+"/") && len(mimeType) > len(kind)+1 && !strings.HasSuffix(mimeType, "/*")
	default:
		return false
	}
}

func (s *MaterialService) GetUpload(ctx context.Context, owner, id domain.UUID) (ReferenceMaterialUploadStatus, error) {
	upload, err := s.uploads.GetForOwner(ctx, owner, id)
	if err != nil {
		return ReferenceMaterialUploadStatus{}, err
	}
	if upload.Status != domain.ReferenceMaterialUploadFinalized && !time.Now().UTC().Before(upload.FinalizeDeadline) {
		return ReferenceMaterialUploadStatus{}, domain.ErrReferenceMaterialUploadExpired
	}
	status := ReferenceMaterialUploadStatus{Upload: upload}
	if upload.Status == domain.ReferenceMaterialUploadFinalized {
		material, err := s.repos.GetForRead(ctx, owner, upload.MaterialID)
		if err != nil {
			return ReferenceMaterialUploadStatus{}, err
		}
		status.Material = &material
	}
	return status, nil
}

func (s *MaterialService) FinalizeUpload(ctx context.Context, owner, id domain.UUID) (ReferenceMaterialUploadStatus, error) {
	upload, err := s.uploads.GetForOwner(ctx, owner, id)
	if err != nil {
		return ReferenceMaterialUploadStatus{}, err
	}
	if upload.Status == domain.ReferenceMaterialUploadFinalized {
		return s.GetUpload(ctx, owner, id)
	}
	if !time.Now().UTC().Before(upload.FinalizeDeadline) {
		return ReferenceMaterialUploadStatus{}, domain.ErrReferenceMaterialUploadExpired
	}
	store, _, err := s.storage.ResolveStore(ctx)
	if err != nil {
		return ReferenceMaterialUploadStatus{}, err
	}
	info, err := store.Head(ctx, upload.ObjectKey)
	if err != nil {
		if errors.Is(err, domain.ErrBlobNotFound) {
			return ReferenceMaterialUploadStatus{}, domain.ErrReferenceMaterialUploadMetadataMismatch
		}
		return ReferenceMaterialUploadStatus{}, domain.ErrObjectStorageUnavailable
	}
	if info.ByteSize != upload.DeclaredByteSize {
		return ReferenceMaterialUploadStatus{}, domain.ErrReferenceMaterialUploadSizeMismatch
	}
	if info.ContentType != upload.DeclaredMIMEType || info.Metadata[domain.UploadIDMetadataKey] != upload.ID.String() {
		return ReferenceMaterialUploadStatus{}, domain.ErrReferenceMaterialUploadMetadataMismatch
	}
	material, err := s.formMaterial(ctx, store, upload.MaterialID, upload.SessionID, upload.FileName, upload.ObjectKey, upload.DeclaredByteSize, &upload.DeclaredKind, upload.ClaimsVersion)
	if err != nil {
		return ReferenceMaterialUploadStatus{}, err
	}
	var finalized domain.ReferenceMaterialUpload
	var persisted domain.ReferenceMaterial
	err = s.runner.Run(ctx, func(scope domain.WriteScope) error {
		locked, err := s.uploads.LockForFinalize(ctx, scope.Tx(), owner, id)
		if err != nil {
			return err
		}
		if locked.Status == domain.ReferenceMaterialUploadFinalized {
			persisted, err = s.repos.GetForReadInTx(ctx, scope.Tx(), owner, locked.MaterialID)
			finalized = locked
			return err
		}
		if _, err := s.sessions.GetInTx(ctx, scope.Tx(), owner, locked.SessionID); err != nil {
			return err
		}
		if !time.Now().UTC().Before(locked.FinalizeDeadline) {
			return domain.ErrReferenceMaterialUploadExpired
		}
		if err := s.repos.Insert(ctx, scope.Tx(), &material); err != nil {
			return err
		}
		finalizedAt := time.Now().UTC()
		if err := s.uploads.MarkFinalized(ctx, scope.Tx(), owner, id, finalizedAt); err != nil {
			return err
		}
		locked.Status = domain.ReferenceMaterialUploadFinalized
		locked.FinalizedAt = &finalizedAt
		finalized, persisted = locked, material
		return nil
	})
	if err != nil {
		return ReferenceMaterialUploadStatus{}, err
	}
	return ReferenceMaterialUploadStatus{Upload: finalized, Material: &persisted}, nil
}

func (s *MaterialService) CreateFromResult(ctx context.Context, owner, sessionID, taskID domain.UUID, slotIndex int, fileName string) (domain.ReferenceMaterial, error) {
	fileName, err := normalizeMaterialFileName(fileName)
	if err != nil || slotIndex < 0 || slotIndex > 3 {
		return domain.ReferenceMaterial{}, domain.ErrReferenceMaterialUploadInvalid
	}
	if _, err := s.sessions.Get(ctx, owner, sessionID); err != nil {
		return domain.ReferenceMaterial{}, err
	}
	_, slots, err := s.tasks.GetForOwner(ctx, owner, taskID)
	if err != nil {
		return domain.ReferenceMaterial{}, err
	}
	var slot *domain.GenerationSlot
	for i := range slots {
		if slots[i].Index == slotIndex {
			slot = &slots[i]
			break
		}
	}
	if slot == nil || slot.Status == nil || *slot.Status != domain.SlotSucceeded || slot.ResultBlobKey == nil || slot.ResultByteSize == nil {
		return domain.ReferenceMaterial{}, domain.ErrTaskNotFound
	}
	if *slot.ResultByteSize < 1 || *slot.ResultByteSize > domain.VideoMaxBytes {
		return domain.ReferenceMaterial{}, domain.ErrTooLarge
	}
	store, _, err := s.storage.ResolveStore(ctx)
	if err != nil {
		return domain.ReferenceMaterial{}, err
	}
	source, sourceSize, err := s.results.Open(ctx, *slot.ResultBlobKey, domain.FullBlobRange)
	if err != nil {
		return domain.ReferenceMaterial{}, domain.ErrObjectStorageUnavailable
	}
	defer source.Close()
	if sourceSize != *slot.ResultByteSize {
		return domain.ReferenceMaterial{}, domain.ErrUnreadableMedia
	}
	materialID := domain.NewUUID()
	objectKey := domain.ReferenceBlobKey(materialID)
	put, err := store.Put(ctx, objectKey, source, domain.VideoMaxBytes)
	if err != nil {
		if errors.Is(err, domain.ErrTooLarge) {
			return domain.ReferenceMaterial{}, domain.ErrTooLarge
		}
		return domain.ReferenceMaterial{}, domain.ErrObjectStorageUnavailable
	}
	cleanup := func() {
		if err := store.Delete(context.WithoutCancel(ctx), objectKey); err != nil {
			orphanLog(err)
		}
	}
	material, err := s.formMaterial(ctx, store, materialID, sessionID, fileName, objectKey, put.ByteSize, nil, domain.ClaimsVersion)
	if err != nil {
		cleanup()
		return domain.ReferenceMaterial{}, err
	}
	if !bytes.Equal(material.ChecksumSHA256, put.SHA256Sum[:]) {
		cleanup()
		return domain.ReferenceMaterial{}, domain.ErrUnreadableMedia
	}
	err = s.runner.Run(ctx, func(scope domain.WriteScope) error {
		if _, err := s.sessions.GetInTx(ctx, scope.Tx(), owner, sessionID); err != nil {
			return err
		}
		return s.repos.Insert(ctx, scope.Tx(), &material)
	})
	if err != nil {
		cleanup()
		return domain.ReferenceMaterial{}, err
	}
	return material, nil
}

func (s *MaterialService) formMaterial(ctx context.Context, store domain.BlobStore, id, sessionID domain.UUID, fileName, objectKey string, expectedSize int64, declaredKind *domain.Kind, claimsVersion int) (domain.ReferenceMaterial, error) {
	reader, size, err := store.Open(ctx, objectKey, domain.FullBlobRange)
	if err != nil {
		return domain.ReferenceMaterial{}, domain.ErrObjectStorageUnavailable
	}
	defer reader.Close()
	if size != expectedSize {
		return domain.ReferenceMaterial{}, domain.ErrReferenceMaterialUploadSizeMismatch
	}
	hasher := sha256.New()
	buffer := make([]byte, materialCopyBufferLen)
	written, err := io.CopyBuffer(hasher, io.LimitReader(reader, expectedSize+1), buffer)
	if err != nil {
		return domain.ReferenceMaterial{}, domain.ErrObjectStorageUnavailable
	}
	if written != expectedSize {
		return domain.ReferenceMaterial{}, domain.ErrReferenceMaterialUploadSizeMismatch
	}
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		return domain.ReferenceMaterial{}, domain.ErrObjectStorageUnavailable
	}
	identified, err := s.prober.Identify(reader)
	if err != nil {
		return domain.ReferenceMaterial{}, err
	}
	if expectedSize > identified.Kind.SizeLimit() {
		return domain.ReferenceMaterial{}, domain.ErrTooLarge
	}
	if declaredKind != nil && identified.Kind != *declaredKind {
		return domain.ReferenceMaterial{}, domain.ErrUnsupportedMedia
	}
	if identified.Kind == domain.KindImage {
		if err := domain.CheckImageReferenceEnvelope(identified.Facts); err != nil {
			return domain.ReferenceMaterial{}, err
		}
	}
	if !identified.Kind.AcceptsExtension(strings.ToLower(filepath.Ext(fileName))) {
		return domain.ReferenceMaterial{}, domain.ErrUnsupportedMedia
	}
	material := domain.ReferenceMaterial{
		ID: id, SessionID: sessionID, Kind: identified.Kind, FileName: fileName,
		MimeType: identified.Facts.MimeType, ByteSize: expectedSize,
		ChecksumSHA256: hasher.Sum(nil), BlobKey: objectKey,
		WidthPx: identified.Facts.WidthPx, HeightPx: identified.Facts.HeightPx,
		PixelCount: identified.Facts.PixelCount, DurationMS: identified.Facts.DurationMS,
		ClaimsVersion: claimsVersion,
	}
	if !material.HasMediaFacts() {
		return domain.ReferenceMaterial{}, domain.ErrUnreadableMedia
	}
	return material, nil
}

func normalizeMaterialFileName(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if len([]rune(trimmed)) > 255 || strings.ContainsRune(trimmed, '\x00') {
		return "", domain.ErrReferenceMaterialUploadInvalid
	}
	base := filepath.Base(strings.ReplaceAll(trimmed, "\\", "/"))
	if base == "" || base == "." || base == ".." {
		return "", domain.ErrReferenceMaterialUploadInvalid
	}
	return base, nil
}

// OpenForDownload authorizes one material for its creator and opens the
// requested storage window; transport concerns (Range grammar, hashing on
// serve, header math) stay in the interface layer.
func (s *MaterialService) OpenForDownload(ctx context.Context, owner, id domain.UUID, rng domain.BlobRange) (domain.ReferenceMaterial, domain.ReadSeekCloser, int64, error) {
	material, err := s.repos.GetForRead(ctx, owner, id)
	if err != nil {
		return domain.ReferenceMaterial{}, nil, 0, err
	}
	store, _, err := s.storage.ResolveStore(ctx)
	if err != nil {
		return domain.ReferenceMaterial{}, nil, 0, err
	}
	window, size, err := store.Open(ctx, material.BlobKey, rng)
	if err != nil {
		return domain.ReferenceMaterial{}, nil, 0, domain.ErrObjectStorageUnavailable
	}
	return material, window, size, nil
}

// OrphanBlobLogWarning names the log channel cleanup failures share so a
// stale object never silently survives a failed ingest or delete.
const OrphanBlobLogWarning = "creation: orphan blob cleanup failed"

// orphanLog reports best-effort cleanup failures without failing requests:
// a leftover blob is invisible garbage (no row points at it), never user-
// visible data.
func orphanLog(_ error) {
	slog.Warn(OrphanBlobLogWarning, "code", "object_storage_unavailable")
}

// Delete drops the row inside a verified transaction and schedules blob
// cleanup strictly after commit.
func (s *MaterialService) Delete(ctx context.Context, owner, id domain.UUID) error {
	if _, err := s.repos.GetForRead(ctx, owner, id); err != nil {
		return err
	}
	store, _, err := s.storage.ResolveStore(ctx)
	if err != nil {
		return err
	}
	return s.runner.Run(ctx, func(scope domain.WriteScope) error {
		blobKey, err := s.repos.Delete(ctx, scope.Tx(), owner, id)
		if err != nil {
			return err
		}
		scope.AfterCommit(func() {
			if delErr := store.Delete(context.WithoutCancel(ctx), blobKey); delErr != nil {
				orphanLog(delErr)
			}
		})
		return nil
	})
}
