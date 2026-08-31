// Package postgres implements the Creation repositories over PostgreSQL.
// Every query carries creator-scoped predicates itself — ownership and
// logical deletion are decided by SQL, not by hoping callers remember them —
// and every cursor stays a compound keyset so deep pages never decay the way
// OFFSET does.
package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// SessionRepository reads off the pool and writes through caller-provided
// verified transactions.
type SessionRepository struct {
	pool *pgxpool.Pool
}

func NewSessionRepository(pool *pgxpool.Pool) *SessionRepository {
	return &SessionRepository{pool: pool}
}

const sessionColumns = "id, name, created_at, updated_at"

const sessionDraftColumns = `draft_prompt, draft_media_type, draft_manifest_version,
	draft_model, draft_mode, draft_ratio, draft_resolution, draft_quantity,
	draft_duration_seconds, draft_updated_at`

// Create inserts one session inside the provided write transaction.
func (r *SessionRepository) Create(ctx context.Context, tx domain.TxExecutor, owner domain.UUID, name string) (domain.Session, error) {
	row := tx.QueryRow(ctx,
		`INSERT INTO creation_sessions (owner_user_id, name) VALUES ($1, $2) RETURNING `+sessionColumns,
		owner, name)
	var s domain.Session
	if err := row.Scan(&s.ID, &s.Name, &s.CreatedAt, &s.UpdatedAt); err != nil {
		return domain.Session{}, fmt.Errorf("creation: insert session: %w", err)
	}
	s.OwnerID = owner
	return s, nil
}

// Get resolves one active session for its owner; any miss collapses into
// ErrSessionNotFound without distinguishing absence from foreign ownership.
func (r *SessionRepository) Get(ctx context.Context, owner, id domain.UUID) (domain.Session, error) {
	row := r.pool.QueryRow(ctx,
		`SELECT `+sessionColumns+`, owner_user_id FROM creation_sessions WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`,
		id, owner)
	return scanSession(row)
}

// draftReadExec is the statement surface a session+draft read needs; both
// the pool and a caller's write transaction satisfy it.
type draftReadExec interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// readSessionWithDraft resolves the session plus its recoverable draft over
// any executor. Callers guarantee the snapshot discipline: GetWithDraft
// wraps a read transaction, admission passes its write transaction so the
// frozen specification and the revision check share one snapshot.
func readSessionWithDraft(ctx context.Context, exec draftReadExec, owner, id domain.UUID) (domain.Session, *domain.SessionDraft, error) {
	row := exec.QueryRow(ctx,
		`SELECT `+sessionColumns+`, owner_user_id, `+sessionDraftColumns+`
		 FROM creation_sessions WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`,
		id, owner)
	var s domain.Session
	// Nullable draft columns scan into pointer locals first; the domain value
	// keeps typed pointers so unset and zero stay distinct draft facts.
	var (
		mediaType       *string
		manifestVersion *int
		model           *string
		mode            *string
		ratio           *string
		resolution      *string
		quantity        *int
		durationSeconds *int
		updatedAt       *time.Time
	)
	draft := &domain.SessionDraft{}
	err := row.Scan(&s.ID, &s.Name, &s.CreatedAt, &s.UpdatedAt, &s.OwnerID,
		&draft.Prompt, &mediaType, &manifestVersion, &model, &mode, &ratio,
		&resolution, &quantity, &durationSeconds, &updatedAt)
	if errors.Is(err, noRowsErr) {
		return domain.Session{}, nil, domain.ErrSessionNotFound
	}
	if err != nil {
		return domain.Session{}, nil, fmt.Errorf("creation: get session draft: %w", err)
	}
	if mediaType != nil {
		media := domain.DraftMediaType(*mediaType)
		draft.MediaType = &media
	}
	if manifestVersion != nil {
		draft.ManifestVersion = *manifestVersion
	}
	draft.Model, draft.Mode, draft.Ratio, draft.Resolution = model, mode, ratio, resolution
	draft.Quantity, draft.DurationSeconds = quantity, durationSeconds
	// draft_updated_at is the save marker: NULL means the creator never saved
	// a draft here, and the wire must answer draft: null — not a zero draft.
	if updatedAt == nil {
		return s, nil, nil
	}
	draft.Revision = *updatedAt

	draft.References = []domain.DraftReference{}
	bindingRows, err := exec.Query(ctx, `
		SELECT material_id, role FROM creation_session_draft_references
		WHERE session_id = $1 ORDER BY position ASC`, id)
	if err != nil {
		return domain.Session{}, nil, fmt.Errorf("creation: list draft references: %w", err)
	}
	defer bindingRows.Close()
	for bindingRows.Next() {
		var materialID domain.UUID
		var role string
		if err := bindingRows.Scan(&materialID, &role); err != nil {
			return domain.Session{}, nil, fmt.Errorf("creation: scan draft reference: %w", err)
		}
		draft.References = append(draft.References, domain.DraftReference{MaterialID: materialID, Role: domain.DraftRole(role)})
	}
	if err := bindingRows.Err(); err != nil {
		return domain.Session{}, nil, fmt.Errorf("creation: list draft references rows: %w", err)
	}
	return s, draft, nil
}

// GetWithDraft resolves the session plus its recoverable draft inside one
// read transaction, so a concurrent save can never pair stale scalars with
// new reference bindings: the two reads share one snapshot.
func (r *SessionRepository) GetWithDraft(ctx context.Context, owner, id domain.UUID) (domain.Session, *domain.SessionDraft, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return domain.Session{}, nil, fmt.Errorf("creation: begin draft read: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	return readSessionWithDraft(ctx, tx, owner, id)
}

// SaveDraft atomically replaces the draft: scalars update first (which also
// proves ownership and liveness, and serializes concurrent saves on the same
// session), then the reference bindings are rewritten row by row. Any failure
// rolls the whole replacement back in the caller's transaction.
func (r *SessionRepository) SaveDraft(ctx context.Context, tx domain.TxExecutor, owner, id domain.UUID, draft *domain.SessionDraft) (time.Time, error) {
	row := tx.QueryRow(ctx, `
		UPDATE creation_sessions SET
			draft_prompt = $3, draft_media_type = $4, draft_manifest_version = $5,
			draft_model = $6, draft_mode = $7, draft_ratio = $8, draft_resolution = $9,
			draft_quantity = $10, draft_duration_seconds = $11,
			draft_updated_at = now(), updated_at = now()
		WHERE id = $2 AND owner_user_id = $1 AND deleted_at IS NULL
		RETURNING draft_updated_at`,
		owner, id, draft.Prompt, mediaTypeArg(draft.MediaType), draft.ManifestVersion,
		draft.Model, draft.Mode, draft.Ratio, draft.Resolution,
		draft.Quantity, draft.DurationSeconds)
	var revision time.Time
	if err := row.Scan(&revision); err != nil {
		if errors.Is(err, noRowsErr) {
			return time.Time{}, domain.ErrSessionNotFound
		}
		return time.Time{}, fmt.Errorf("creation: save session draft: %w", err)
	}

	if _, err := execTx(tx, ctx,
		`DELETE FROM creation_session_draft_references WHERE session_id = $1`, id); err != nil {
		return time.Time{}, fmt.Errorf("creation: clear draft references: %w", err)
	}
	for position, reference := range draft.References {
		if _, err := execTx(tx, ctx, `
			INSERT INTO creation_session_draft_references (session_id, position, material_id, role)
			VALUES ($1, $2, $3, $4)`,
			id, position, reference.MaterialID, string(reference.Role)); err != nil {
			return time.Time{}, fmt.Errorf("creation: insert draft reference: %w", err)
		}
	}
	return revision, nil
}

// mediaTypeArg keeps the typed draft media pointer column-honest: a nil
// pointer stores NULL, a value stores its wire text.
func mediaTypeArg(media *domain.DraftMediaType) any {
	if media == nil {
		return nil
	}
	return string(*media)
}

// List pages active sessions newest-first under the compound keyset.
func (r *SessionRepository) List(ctx context.Context, owner domain.UUID, cursor *domain.CompoundCursor, limit int) ([]domain.Session, *domain.CompoundCursor, error) {
	args := []any{owner, cursorTime(cursor), cursorID(cursor), limit + 1}
	rows, err := r.pool.Query(ctx, `
		SELECT `+sessionColumns+` FROM creation_sessions
		WHERE owner_user_id = $1 AND deleted_at IS NULL
		  AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
		ORDER BY created_at DESC, id DESC
		LIMIT $4`, args...)
	if err != nil {
		return nil, nil, fmt.Errorf("creation: list sessions: %w", err)
	}
	defer rows.Close()
	sessions := make([]domain.Session, 0, limit)
	for rows.Next() {
		var s domain.Session
		if err := rows.Scan(&s.ID, &s.Name, &s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, nil, fmt.Errorf("creation: scan session row: %w", err)
		}
		s.OwnerID = owner
		sessions = append(sessions, s)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("creation: list sessions rows: %w", err)
	}
	next := nextCursor(len(sessions), limit, func(i int) (time.Time, domain.UUID) {
		return sessions[i].CreatedAt, sessions[i].ID
	})
	sessions = truncatePage(sessions, limit)
	return sessions, next, nil
}

// Rename updates only an active owned session inside the write transaction.
func (r *SessionRepository) Rename(ctx context.Context, tx domain.TxExecutor, owner, id domain.UUID, name string) (domain.Session, error) {
	row := tx.QueryRow(ctx,
		`UPDATE creation_sessions SET name = $3, updated_at = now()
		 WHERE id = $2 AND owner_user_id = $1 AND deleted_at IS NULL
		 RETURNING `+sessionColumns,
		owner, id, name)
	s, err := scanSessionRow(row)
	if errors.Is(err, noRowsErr) {
		return domain.Session{}, domain.ErrSessionNotFound
	}
	return s, err
}

// Delete soft-deletes; repeating it observes nothing to delete, per contract.
func (r *SessionRepository) Delete(ctx context.Context, tx domain.TxExecutor, owner, id domain.UUID) error {
	tag, err := execTx(tx, ctx, `
		UPDATE creation_sessions SET deleted_at = now(), updated_at = now()
		WHERE id = $2 AND owner_user_id = $1 AND deleted_at IS NULL`,
		owner, id)
	if err != nil {
		return fmt.Errorf("creation: delete session: %w", err)
	}
	if tag == 0 {
		return domain.ErrSessionNotFound
	}
	return nil
}

type rowScanner interface{ Scan(dest ...any) error }

// scanSession adapts QueryRow results carrying a trailing owner column.
func scanSession(row rowScanner) (domain.Session, error) {
	var s domain.Session
	err := row.Scan(&s.ID, &s.Name, &s.CreatedAt, &s.UpdatedAt, &s.OwnerID)
	if errors.Is(err, noRowsErr) {
		return domain.Session{}, domain.ErrSessionNotFound
	}
	if err != nil {
		return domain.Session{}, fmt.Errorf("creation: get session: %w", err)
	}
	return s, nil
}

func scanSessionRow(row rowScanner) (domain.Session, error) {
	var s domain.Session
	err := row.Scan(&s.ID, &s.Name, &s.CreatedAt, &s.UpdatedAt)
	if errors.Is(err, noRowsErr) {
		return domain.Session{}, domain.ErrSessionNotFound
	}
	if err != nil {
		return domain.Session{}, fmt.Errorf("creation: session write: %w", err)
	}
	return s, nil
}
