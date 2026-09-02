package application

import (
	"bufio"
	"context"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"strings"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// sniffLeadBytes bounds how much of a stream is inspected before deciding
// the content family and its size ceiling.
const sniffLeadBytes = 512

// MaterialService ingests, lists, streams, and deletes creator-private
// reference materials. Blob placement never happens inside a locked
// transaction: storage I/O runs first or after commit, per ADR-0016.
type MaterialService struct {
	repos    domain.MaterialRepository
	sessions domain.SessionRepository
	store    domain.BlobStore
	prober   domain.MediaProber
	runner   domain.WriteRunner
}

func NewMaterialService(
	repos domain.MaterialRepository,
	sessions domain.SessionRepository,
	store domain.BlobStore,
	prober domain.MediaProber,
	runner domain.WriteRunner,
) *MaterialService {
	return &MaterialService{repos: repos, sessions: sessions, store: store, prober: prober, runner: runner}
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

// Upload is the V1 rights-confirmation act: streaming the bytes through Go,
// probing them authoritatively, and recording actor + time + claims version
// + material identity in one verified transaction. A failure anywhere after
// blob placement removes the orphan blob so no usable material survives
// without its record.
func (s *MaterialService) Upload(ctx context.Context, owner, sessionID domain.UUID, fileName string, body io.Reader) (domain.ReferenceMaterial, error) {
	if _, err := s.sessions.Get(ctx, owner, sessionID); err != nil {
		return domain.ReferenceMaterial{}, err
	}
	base := filepath.Base(strings.TrimSpace(filepath.ToSlash(fileName)))
	if base == "" || base == "." || len([]rune(base)) > 255 {
		return domain.ReferenceMaterial{}, domain.ErrMalformedUpload
	}

	sniffer := bufio.NewReaderSize(body, sniffLeadBytes)
	head, _ := sniffer.Peek(sniffLeadBytes)
	ceiling, known := s.prober.IngestCeiling(head)
	if !known {
		return domain.ReferenceMaterial{}, domain.ErrUnsupportedMedia
	}

	id := domain.NewUUID()
	blobKey := domain.ReferenceBlobKey(id)
	put, err := s.store.Put(ctx, blobKey, sniffer, ceiling)
	if err != nil {
		if errors.Is(err, context.Canceled) || ctx.Err() != nil {
			return domain.ReferenceMaterial{}, domain.ErrMalformedUpload
		}
		return domain.ReferenceMaterial{}, err
	}
	cleanup := func() {
		if cleanupErr := s.store.Delete(context.WithoutCancel(ctx), blobKey); cleanupErr != nil {
			orphanLog(cleanupErr, blobKey)
		}
	}

	reader, _, err := s.store.Open(ctx, blobKey, domain.FullBlobRange)
	if err != nil {
		cleanup()
		return domain.ReferenceMaterial{}, err
	}
	identified, probeErr := s.prober.Identify(reader)
	closeErr := reader.Close()
	if probeErr != nil || closeErr != nil {
		cleanup()
		// A canceled request can surface here as a probe or close failure
		// (watchClose already released the descriptor). That is client
		// abandonment, not media damage — the same verdict as a canceled Put.
		if ctx.Err() != nil {
			return domain.ReferenceMaterial{}, domain.ErrMalformedUpload
		}
		if probeErr != nil {
			return domain.ReferenceMaterial{}, probeErr
		}
		return domain.ReferenceMaterial{}, closeErr
	}
	// The streaming ceiling came from the sniffed container family; an
	// MP4-family audio (M4A) only resolves to its audio kind here, so the
	// authoritative kind's own ceiling must be re-checked after probing.
	if put.ByteSize > identified.Kind.SizeLimit() {
		cleanup()
		return domain.ReferenceMaterial{}, domain.ErrTooLarge
	}
	// The reference dimension envelope is authoritative at ingest: an image
	// outside the manifest's published bounds never becomes a material, so
	// no later gate can be bypassed by a stale or client-side check.
	if identified.Kind == domain.KindImage {
		if err := domain.CheckImageReferenceEnvelope(identified.Facts); err != nil {
			cleanup()
			return domain.ReferenceMaterial{}, err
		}
	}
	ext := strings.ToLower(filepath.Ext(base))
	if !identified.Kind.AcceptsExtension(ext) {
		cleanup()
		return domain.ReferenceMaterial{}, domain.ErrUnsupportedMedia
	}

	material := &domain.ReferenceMaterial{
		ID:             id,
		SessionID:      sessionID,
		Kind:           identified.Kind,
		FileName:       base,
		MimeType:       identified.Facts.MimeType,
		ByteSize:       put.ByteSize,
		ChecksumSHA256: put.SHA256Sum[:],
		BlobKey:        blobKey,
		WidthPx:        identified.Facts.WidthPx,
		HeightPx:       identified.Facts.HeightPx,
		PixelCount:     identified.Facts.PixelCount,
		DurationMS:     identified.Facts.DurationMS,
		ClaimsVersion:  domain.ClaimsVersion,
	}
	if !material.HasMediaFacts() {
		cleanup()
		return domain.ReferenceMaterial{}, domain.ErrUnreadableMedia
	}
	err = s.runner.Run(ctx, func(scope domain.WriteScope) error {
		return s.repos.Insert(ctx, scope.Tx(), material)
	})
	if err != nil {
		cleanup()
		// Same abandonment discipline as a canceled Put or probe: the row was
		// never committed, so removing the orphan blob keeps the invariant
		// that no usable material survives a failed ingest.
		if ctx.Err() != nil {
			return domain.ReferenceMaterial{}, domain.ErrMalformedUpload
		}
		return domain.ReferenceMaterial{}, err
	}
	return *material, nil
}

// OpenForDownload authorizes one material for its creator and opens the
// requested storage window; transport concerns (Range grammar, hashing on
// serve, header math) stay in the interface layer.
func (s *MaterialService) OpenForDownload(ctx context.Context, owner, id domain.UUID, rng domain.BlobRange) (domain.ReferenceMaterial, domain.ReadSeekCloser, int64, error) {
	material, err := s.repos.GetForRead(ctx, owner, id)
	if err != nil {
		return domain.ReferenceMaterial{}, nil, 0, err
	}
	window, size, err := s.store.Open(ctx, material.BlobKey, rng)
	if err != nil {
		return domain.ReferenceMaterial{}, nil, 0, err
	}
	return material, window, size, nil
}

// OrphanBlobLogWarning names the log channel cleanup failures share so a
// stale object never silently survives a failed ingest or delete.
const OrphanBlobLogWarning = "creation: orphan blob cleanup failed"

// orphanLog reports best-effort cleanup failures without failing requests:
// a leftover blob is invisible garbage (no row points at it), never user-
// visible data.
func orphanLog(err error, blobKey string) {
	slog.Warn(OrphanBlobLogWarning, "blob_key", blobKey, "error", err)
}

// Delete drops the row inside a verified transaction and schedules blob
// cleanup strictly after commit.
func (s *MaterialService) Delete(ctx context.Context, owner, id domain.UUID) error {
	return s.runner.Run(ctx, func(scope domain.WriteScope) error {
		blobKey, err := s.repos.Delete(ctx, scope.Tx(), owner, id)
		if err != nil {
			return err
		}
		scope.AfterCommit(func() {
			if delErr := s.store.Delete(context.WithoutCancel(ctx), blobKey); delErr != nil {
				orphanLog(delErr, blobKey)
			}
		})
		return nil
	})
}
