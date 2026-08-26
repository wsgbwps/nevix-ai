// Package audit is the Identity Module's Audit Log query surface: the
// admin-only paginated read (ADR-0009 revision), newest-first through the
// Go API. Audit appends go through the shared transactional seam in
// internal/auditlog; this package never gains a mutation seam.
package audit

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/identity/command"
)

// ReadService serves the Audit Log read path over the runtime pool.
type ReadService struct {
	db *pgxpool.Pool
}

// NewReadService builds the read service over the runtime pool.
func NewReadService(db *pgxpool.Pool) *ReadService {
	return &ReadService{db: db}
}

// EntryResponse is one audit row as clients see it: the actor and target
// snapshots exactly as written (ADR-0009 — no FK, no join-back), the action
// vocabulary value, the metadata object, and the row's creation time.
type EntryResponse struct {
	ID                string         `json:"id"`
	Action            string         `json:"action"`
	ActorUserID       string         `json:"actor_user_id"`
	ActorDisplayName  string         `json:"actor_display_name"`
	TargetUserID      *string        `json:"target_user_id"`
	TargetDisplayName *string        `json:"target_display_name"`
	Metadata          map[string]any `json:"metadata"`
	CreatedAt         time.Time      `json:"created_at"`
}

// ListResponse is the paginated audit page.
type ListResponse struct {
	Entries []EntryResponse `json:"entries"`
	Page    int             `json:"page"`
	PerPage int             `json:"per_page"`
	Total   int             `json:"total"`
}

// List returns one newest-first audit page. The guard vocabulary has already
// restricted the route to admins; the query itself is the single visibility
// landing point for the audit read (ADR-0015).
func (s *ReadService) List(ctx context.Context, r *http.Request) (ListResponse, error) {
	pagination, err := command.ParsePagination(r.URL.Query())
	if err != nil {
		return ListResponse{}, err
	}

	var total int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM public.audit_logs`).Scan(&total); err != nil {
		return ListResponse{}, fmt.Errorf("identity audit: count rows: %w", err)
	}

	rows, err := s.db.Query(ctx,
		`SELECT id, action, actor_user_id, actor_display_name,
		        target_user_id, target_display_name, metadata, created_at
		 FROM public.audit_logs
		 ORDER BY created_at DESC, id DESC
		 LIMIT $1 OFFSET $2`,
		pagination.PerPage, pagination.Offset(),
	)
	if err != nil {
		return ListResponse{}, fmt.Errorf("identity audit: read page: %w", err)
	}
	defer rows.Close()

	entries := []EntryResponse{}
	for rows.Next() {
		var entry EntryResponse
		var metadata []byte
		if err := rows.Scan(
			&entry.ID, &entry.Action, &entry.ActorUserID, &entry.ActorDisplayName,
			&entry.TargetUserID, &entry.TargetDisplayName, &metadata, &entry.CreatedAt,
		); err != nil {
			return ListResponse{}, fmt.Errorf("identity audit: scan row: %w", err)
		}
		if err := json.Unmarshal(metadata, &entry.Metadata); err != nil {
			return ListResponse{}, fmt.Errorf("identity audit: decode metadata: %w", err)
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return ListResponse{}, fmt.Errorf("identity audit: iterate rows: %w", err)
	}
	return ListResponse{Entries: entries, Page: pagination.Page, PerPage: pagination.PerPage, Total: total}, nil
}

// MapError maps the audit read's errors to the public error envelope. Only
// the shared query-shape sentinel maps to a 400; everything else is
// infrastructure noise answered as 500.
func MapError(err error) *command.Error {
	if errors.Is(err, command.ErrInvalidPagination) {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_pagination", Message: "page must be a positive integer and per_page an integer between 1 and 100."}
	}
	return nil
}
