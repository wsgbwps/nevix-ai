// Package users owns the user-account surface beyond self-service: the team
// directory every active user reads, the admin management list, and the admin
// governance commands (create, disable, reset password, change email, change
// role, delete). Every governance write runs through the Write Transaction
// Module and commits its audit row in that same transaction (ADR-0009
// snapshots, ADR-0015 lifecycle rules); the deployment's visibility rules
// converge here and in the authz guard vocabulary, nowhere else.
package users

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/identity/command"
	"github.com/nevix-ai/server/internal/identity/writetx"
)

// Domain errors of the user surface. The unmapped-default path answers 500;
// every sentinel here has an HTTP shape in MapError.
var (
	// errUserNotFound answers an unknown (or malformed) user id: a malformed
	// id is indistinguishable from an absent one to the client.
	errUserNotFound = errors.New("users: user not found")
	// errEmailTaken answers a login email already owned by another account.
	errEmailTaken = errors.New("users: email already in use")
	// errLastAdminProtected answers a reduction (demotion or disable) of the
	// last active admin: the deployment must always keep a usable admin.
	errLastAdminProtected = errors.New("users: the last active admin cannot be demoted or disabled")
	// errUserHasLoggedIn answers deletion of an account that has ever logged
	// in: deletion is only for accounts created in error, never for history.
	errUserHasLoggedIn = errors.New("users: only accounts that never logged in can be deleted")
	// errPasswordTooShort answers an initial password below the policy bound
	// when it reaches the hashing seam (Validate normally catches it first).
	errPasswordTooShort = errors.New("users: password must be at least 8 characters")
)

// MapError maps the user surface's domain errors to the public error
// envelope. Request-shape failures never pass through here; they answer 400
// directly from Validate.
func MapError(err error) *command.Error {
	switch {
	case errors.Is(err, errUserNotFound):
		return &command.Error{Status: http.StatusNotFound, Code: "user_not_found", Message: "No such user."}
	case errors.Is(err, errEmailTaken):
		return &command.Error{Status: http.StatusConflict, Code: "email_taken", Message: "Another account already uses this email."}
	case errors.Is(err, errLastAdminProtected):
		return &command.Error{Status: http.StatusConflict, Code: "last_admin_protected", Message: "The last active admin cannot be demoted or disabled."}
	case errors.Is(err, errUserHasLoggedIn):
		return &command.Error{Status: http.StatusConflict, Code: "user_has_logged_in", Message: "Only accounts that never logged in can be deleted."}
	case errors.Is(err, errPasswordTooShort):
		return &command.Error{Status: http.StatusBadRequest, Code: "password_too_short", Message: "Initial password must be at least 8 characters."}
	case errors.Is(err, command.ErrInvalidPagination):
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_pagination", Message: "page must be a positive integer and per_page an integer between 1 and 100."}
	case errors.Is(err, command.ErrInvalidSearch):
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_search", Message: "Search text is too long."}
	default:
		return nil
	}
}

// Service owns the user-account reads and governance commands. Reads use the
// pool; every write runs through the Write Transaction Module.
type Service struct {
	db     *pgxpool.Pool
	runner *writetx.Runner
}

// NewService builds the service over the runtime pool and the shared write
// transaction runner.
func NewService(db *pgxpool.Pool, runner *writetx.Runner) *Service {
	return &Service{db: db, runner: runner}
}

// userRecord mirrors the users columns the user surface reads. A nil
// LastLoginAt is the durable "never logged in" marker (issue #102).
type userRecord struct {
	ID                 string
	Email              string
	PasswordHash       string
	DisplayName        string
	Role               string
	Status             string
	MustChangePassword bool
	LastLoginAt        *time.Time
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

// ManagementEntry is the admin-facing shape of one account: everything the
// governance surface needs, including the never-logged-in marker exposed as
// a null last_login_at.
type ManagementEntry struct {
	ID                 string     `json:"id"`
	Email              string     `json:"email"`
	DisplayName        string     `json:"display_name"`
	Role               string     `json:"role"`
	Status             string     `json:"status"`
	MustChangePassword bool       `json:"must_change_password"`
	LastLoginAt        *time.Time `json:"last_login_at"`
	CreatedAt          time.Time  `json:"created_at"`
}

func managementEntry(u userRecord) ManagementEntry {
	return ManagementEntry{
		ID:                 u.ID,
		Email:              u.Email,
		DisplayName:        u.DisplayName,
		Role:               u.Role,
		Status:             u.Status,
		MustChangePassword: u.MustChangePassword,
		LastLoginAt:        u.LastLoginAt,
		CreatedAt:          u.CreatedAt,
	}
}

// UserResponse wraps one account for the governance command bodies.
type UserResponse struct {
	User ManagementEntry `json:"user"`
}

// parseUserID validates a path parameter as a UUID. A malformed id answers
// errUserNotFound exactly like an absent one: the client cannot distinguish
// them, and neither reaches the database.
func parseUserID(raw string) (pgtype.UUID, error) {
	var id pgtype.UUID
	if err := id.Scan(raw); err != nil {
		return pgtype.UUID{}, errUserNotFound
	}
	return id, nil
}

// loadUserForUpdate reads one account inside the caller's write transaction,
// locking its row so the governance decision and its mutation serialize
// against every other writer on the same account.
func (s *Service) loadUserForUpdate(ctx context.Context, tx pgx.Tx, userID string) (userRecord, error) {
	id, err := parseUserID(userID)
	if err != nil {
		return userRecord{}, err
	}
	user, err := scanUser(tx.QueryRow(ctx,
		`SELECT id, email, password_hash, display_name, role, status, must_change_password, last_login_at, created_at, updated_at
		 FROM public.users WHERE id = $1 FOR UPDATE`, id,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return userRecord{}, errUserNotFound
	}
	return user, err
}

// rowScanner is the scanning capability a single-row query exposes.
type rowScanner interface {
	Scan(dest ...any) error
}

// scanUser decodes one users row into a userRecord.
func scanUser(row rowScanner) (userRecord, error) {
	var u userRecord
	err := row.Scan(&u.ID, &u.Email, &u.PasswordHash, &u.DisplayName, &u.Role, &u.Status,
		&u.MustChangePassword, &u.LastLoginAt, &u.CreatedAt, &u.UpdatedAt)
	return u, err
}

// countOtherActiveAdminsLocked counts the active admins other than userID
// with their rows locked FOR UPDATE inside the caller's transaction (row
// ids are selected and locked — an aggregate cannot carry a locking
// clause). Under READ COMMITTED the locks serialize concurrent
// admin-reducing transactions and re-evaluate the predicate after each lock
// wait, so a reduction decision can never run on a count another in-flight
// reduction is about to falsify: the last-active-admin invariant holds even
// when two admins are demoted or disabled at the same moment (one
// transaction then fails — a deadlock abort answered as a retryable 500,
// never a state break).
func countOtherActiveAdminsLocked(ctx context.Context, tx pgx.Tx, userID string) (int, error) {
	rows, err := tx.Query(ctx,
		`SELECT id FROM public.users
		 WHERE role = 'admin' AND status = 'active' AND id <> $1 FOR UPDATE`,
		userID,
	)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		count++
	}
	return count, rows.Err()
}
