// Package joincodes owns the join-code governance surface (issue #120): the
// admin commands that issue, list, and revoke the registration credentials
// members-to-be redeem at self-registration (ADR-0015 2026-08-23 revision).
// A code is a shared, reusable secret — only revocation ends it, and with no
// active code self-registration is closed; there is no separate registration
// toggle. Every write runs through the Write Transaction Module and commits
// its audit row in that same transaction (ADR-0009 snapshots); the surface is
// admin-only through the RequireAdmin route guard, declared in the Module's
// route table.
package joincodes

import (
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/identity/command"
	"github.com/nevix-ai/server/internal/identity/writetx"
)

// Domain errors of the join-code surface. The unmapped-default path answers
// 500; every sentinel here has an HTTP shape in MapError.
var (
	// errTooManyActiveJoinCodes answers a create past the active cap: three
	// codes already cover every onboarding wave one deployment runs.
	errTooManyActiveJoinCodes = errors.New("joincodes: too many active join codes")
	// errJoinCodeNotFound answers an unknown, already-revoked, or malformed
	// join-code id: the three are indistinguishable to the client, and none
	// reaches the database.
	errJoinCodeNotFound = errors.New("joincodes: join code not found")
)

// MapError maps the join-code surface's domain errors to the public error
// envelope. Request-shape failures never pass through here; they answer 400
// directly from Validate.
func MapError(err error) *command.Error {
	switch {
	case errors.Is(err, errTooManyActiveJoinCodes):
		return &command.Error{Status: http.StatusConflict, Code: "too_many_active_join_codes", Message: "At most three join codes may be active at once."}
	case errors.Is(err, errJoinCodeNotFound):
		return &command.Error{Status: http.StatusNotFound, Code: "join_code_not_found", Message: "No such active join code."}
	default:
		return nil
	}
}

// Service owns the join-code commands. The list reads through the pool; every
// write runs through the Write Transaction Module.
type Service struct {
	db     *pgxpool.Pool
	runner *writetx.Runner
}

// NewService builds the service over the runtime pool and the shared write
// transaction runner.
func NewService(db *pgxpool.Pool, runner *writetx.Runner) *Service {
	return &Service{db: db, runner: runner}
}

// CreateRequest is the issue command body. Label is optional — a short note
// saying where the code was posted (e.g. which team group chat).
type CreateRequest struct {
	Label string `json:"label,omitempty"`
}

// maxLabelLength bounds an explicit label, counted in characters to match the
// contract's maxLength semantics.
const maxLabelLength = 128

// Validate checks the request shape: a present label must be bounded.
func (r *CreateRequest) Validate() *command.Error {
	if len([]rune(r.Label)) > maxLabelLength {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_label", Message: "Label is too long."}
	}
	return nil
}

// JoinCodeEntry is one active code in the admin list: the plaintext code the
// admin reads out to share, with its note and provenance.
type JoinCodeEntry struct {
	ID        string    `json:"id"`
	Code      string    `json:"code"`
	Label     string    `json:"label"`
	CreatedBy string    `json:"created_by"`
	CreatedAt time.Time `json:"created_at"`
}

// CreateResponse is the issue command's success body: the freshly issued code
// in the same shape the list will keep showing it.
type CreateResponse struct {
	JoinCode JoinCodeEntry `json:"join_code"`
}

// ListResponse is the active-codes list body.
type ListResponse struct {
	JoinCodes []JoinCodeEntry `json:"join_codes"`
}

// RevokeResponse confirms the revocation.
type RevokeResponse struct {
	Status string `json:"status"`
}
