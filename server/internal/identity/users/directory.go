// The user reads: the team directory every active user sees (email and
// display name of exactly the active accounts — the v1 visibility model,
// ADR-0015) and the admin management list over every account. Both share one
// pagination and search contract; they differ only in guard and in the
// columns the visibility model releases to each audience.
package users

import (
	"context"
	"net/http"
	"strings"

	"github.com/nevix-ai/server/internal/identity/command"
)

// DirectoryEntry is one row of the team directory: the fields every active
// user may see about every other active user. Nothing else leaks — role,
// status, credential state, and login history stay behind the admin list.
type DirectoryEntry struct {
	ID          string `json:"id"`
	Email       string `json:"email"`
	DisplayName string `json:"display_name"`
}

// ListResponse is one page of the team directory.
type ListResponse struct {
	Users   []DirectoryEntry `json:"users"`
	Page    int              `json:"page"`
	PerPage int              `json:"per_page"`
	Total   int              `json:"total"`
}

// ManagementListResponse is one page of the admin management list.
type ManagementListResponse struct {
	Users   []ManagementEntry `json:"users"`
	Page    int               `json:"page"`
	PerPage int               `json:"per_page"`
	Total   int               `json:"total"`
}

// ListDirectory serves the team directory: active users only, ordered by
// email, filtered by the shared search contract over email and display name.
// The guard has already proved an active caller; this query is the
// visibility landing point for the directory (ADR-0015).
func (s *Service) ListDirectory(ctx context.Context, r *http.Request) (ListResponse, error) {
	pagination, search, err := parseListQuery(r)
	if err != nil {
		return ListResponse{}, err
	}

	var total int
	if err := s.db.QueryRow(ctx,
		`SELECT count(*) FROM public.users
		 WHERE status = 'active' AND (email ILIKE $1 ESCAPE '\' OR display_name ILIKE $1 ESCAPE '\')`,
		likePattern(search),
	).Scan(&total); err != nil {
		return ListResponse{}, err
	}

	rows, err := s.db.Query(ctx,
		`SELECT id, email, display_name FROM public.users
		 WHERE status = 'active' AND (email ILIKE $1 ESCAPE '\' OR display_name ILIKE $1 ESCAPE '\')
		 ORDER BY email
		 LIMIT $2 OFFSET $3`,
		likePattern(search), pagination.PerPage, pagination.Offset(),
	)
	if err != nil {
		return ListResponse{}, err
	}
	defer rows.Close()

	entries := []DirectoryEntry{}
	for rows.Next() {
		var entry DirectoryEntry
		if err := rows.Scan(&entry.ID, &entry.Email, &entry.DisplayName); err != nil {
			return ListResponse{}, err
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return ListResponse{}, err
	}
	return ListResponse{Users: entries, Page: pagination.Page, PerPage: pagination.PerPage, Total: total}, nil
}

// ListManagement serves the admin management list: every account regardless
// of status, with the full governance field set, ordered by email. The
// RequireAdmin guard is the visibility landing point; the query adds no
// further filtering because admins see the whole directory.
func (s *Service) ListManagement(ctx context.Context, r *http.Request) (ManagementListResponse, error) {
	pagination, search, err := parseListQuery(r)
	if err != nil {
		return ManagementListResponse{}, err
	}

	var total int
	if err := s.db.QueryRow(ctx,
		`SELECT count(*) FROM public.users
		 WHERE email ILIKE $1 ESCAPE '\' OR display_name ILIKE $1 ESCAPE '\'`,
		likePattern(search),
	).Scan(&total); err != nil {
		return ManagementListResponse{}, err
	}

	rows, err := s.db.Query(ctx,
		`SELECT id, email, password_hash, display_name, role, status, must_change_password, last_login_at, created_at, updated_at
		 FROM public.users
		 WHERE email ILIKE $1 ESCAPE '\' OR display_name ILIKE $1 ESCAPE '\'
		 ORDER BY email
		 LIMIT $2 OFFSET $3`,
		likePattern(search), pagination.PerPage, pagination.Offset(),
	)
	if err != nil {
		return ManagementListResponse{}, err
	}
	defer rows.Close()

	entries := []ManagementEntry{}
	for rows.Next() {
		user, err := scanUser(rows)
		if err != nil {
			return ManagementListResponse{}, err
		}
		entries = append(entries, managementEntry(user))
	}
	if err := rows.Err(); err != nil {
		return ManagementListResponse{}, err
	}
	return ManagementListResponse{Users: entries, Page: pagination.Page, PerPage: pagination.PerPage, Total: total}, nil
}

// parseListQuery reads the shared list contract from the query string.
func parseListQuery(r *http.Request) (command.Pagination, string, error) {
	pagination, err := command.ParsePagination(r.URL.Query())
	if err != nil {
		return command.Pagination{}, "", err
	}
	search, err := command.ParseSearch(r)
	if err != nil {
		return command.Pagination{}, "", err
	}
	return pagination, search, nil
}

// likePattern builds the case-insensitive substring pattern for one search
// term, escaping the LIKE wildcards inside the term so user input can never
// widen the match. An empty search matches every row.
func likePattern(search string) string {
	if search == "" {
		return "%"
	}
	escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(search)
	return "%" + escaped + "%"
}
