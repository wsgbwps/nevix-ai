// Package reauth owns the exact-action Reauthentication Proof lifecycle
// (issue #154, ADR-0016): an active admin re-verifies their current password
// and receives one high-entropy opaque proof bound to a closed exact action,
// valid for five minutes and consumable exactly once with no restore. The
// caller holds only the token body; PostgreSQL stores only its SHA-256 hash.
// Issuance and consumption are each one Write Transaction Module run with
// their audit row in the same transaction (ADR-0009); consumption commits on
// its own, so a later downstream failure can never restore a spent proof —
// the admin re-verifies and retries (the fail-closed contract).
package reauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/nevix-ai/server/internal/auditlog"
	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/identity/auth"
	"github.com/nevix-ai/server/internal/identity/command"
	"github.com/nevix-ai/server/internal/identity/writetx"
)

// Validity is the proof's fixed lifetime: five minutes from issuance.
const Validity = 5 * time.Minute

// proofTokenBytes is the entropy of an opaque proof token.
const proofTokenBytes = 32

// The closed exact-action set (issue #154): the only high-risk actions V1
// declares. No other action is pre-built; extending the set is a deliberate
// contract change plus migration (reauth_proofs_action_allowed), never drift.
const (
	// ActionProviderConnectionCreate authorizes first-time Provider Key
	// configuration.
	ActionProviderConnectionCreate = "provider_connection.create"
	// ActionProviderConnectionReplace authorizes replacing the Provider Key.
	ActionProviderConnectionReplace = "provider_connection.replace"
	// ActionProviderConnectionDelete authorizes deleting the Provider
	// Connection.
	ActionProviderConnectionDelete = "provider_connection.delete"
)

var validActions = map[string]struct{}{
	ActionProviderConnectionCreate:  {},
	ActionProviderConnectionReplace: {},
	ActionProviderConnectionDelete:  {},
}

// ValidAction reports whether action belongs to the closed exact-action set.
func ValidAction(action string) bool {
	_, ok := validActions[action]
	return ok
}

// Domain errors: MapError carries each to its documented status and machine
// code. Every consumption failure is fail-closed and leaves the proof row
// exactly as it was.
var (
	// ErrInsecureTransport reports issuance or consumption arrived without
	// proven HTTPS transport.
	ErrInsecureTransport = errors.New("reauth: secure transport not proven")
	// ErrProofInvalid reports a token with no matching row: unknown, already
	// swept, or issued to a different admin than the caller.
	ErrProofInvalid = errors.New("reauth: proof is invalid")
	// ErrProofExpired reports the five-minute window has passed.
	ErrProofExpired = errors.New("reauth: proof has expired")
	// ErrProofActionMismatch reports the proof is bound to a different exact
	// action than the one presented; the proof stays consumable for its own
	// action.
	ErrProofActionMismatch = errors.New("reauth: proof action mismatch")
	// ErrProofAlreadyConsumed reports the proof's single use has happened;
	// it is never restored.
	ErrProofAlreadyConsumed = errors.New("reauth: proof already consumed")
)

// SecureTransportProven reports whether one request's transport is proven
// HTTPS: a direct TLS connection, or exactly the X-Forwarded-Proto: https
// marker the official private proxy writes after stripping every
// client-supplied Forwarded header (deploy/nginx, issue #152). The Go server
// is reachable only inside the private network in the official Compose
// topology, so that marker — and nothing else on the public path — can
// certify HTTPS to these endpoints.
func SecureTransportProven(r *http.Request) bool {
	return r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
}

// Service is the proof lifecycle over the Write Transaction Module and the
// auth package's single credential-verification owner.
type Service struct {
	runner      *writetx.Runner
	credentials *auth.Service
}

// NewService builds the proof service over the Module's shared write
// transaction runner and the auth service that owns password reverification.
func NewService(runner *writetx.Runner, credentials *auth.Service) *Service {
	return &Service{runner: runner, credentials: credentials}
}

// NewProofToken returns a fresh opaque proof token (base64url) and the
// SHA-256 hash persisted in the reauth_proofs table. The token itself is
// never stored.
func NewProofToken() (string, []byte, error) {
	raw := make([]byte, proofTokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, fmt.Errorf("reauth: generate proof token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	return token, hashToken(token), nil
}

// hashToken is the one-way mapping from proof token to stored hash.
func hashToken(token string) []byte {
	digest := sha256.Sum256([]byte(token))
	return digest[:]
}

// IssueRequest is the issuance command body. Action and Password are pointers
// so the contract's shape rule is enforceable: a body missing either field is
// invalid_request (400), while a present-but-wrong password is a credential
// failure (401).
type IssueRequest struct {
	Action   *string `json:"action"`
	Password *string `json:"password"`
}

// Validate checks the request shape: present fields and an action inside the
// closed exact-action set.
func (r *IssueRequest) Validate() *command.Error {
	if r.Action == nil || r.Password == nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: "Request body must be JSON with action and password."}
	}
	if !ValidAction(*r.Action) {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_action", Message: "Unknown reauthentication action."}
	}
	return nil
}

// IssueResponse is the issuance result: the opaque proof to present and the
// server-computed expiry.
type IssueResponse struct {
	Proof     string    `json:"proof"`
	Action    string    `json:"action"`
	ExpiresAt time.Time `json:"expires_at"`
}

// Issue verifies the admin's current password and inserts one proof bound to
// the exact action, with its audit row, in a single write transaction. The
// five-minute expiry is computed from the database clock so issuance and
// consumption share one time authority.
func (s *Service) Issue(ctx context.Context, principal authz.Principal, req IssueRequest) (IssueResponse, error) {
	if req.Action == nil || req.Password == nil {
		// Unreachable through the HTTP pipeline (Validate rejects it first);
		// guards direct callers against a nil dereference.
		return IssueResponse{}, fmt.Errorf("reauth: issue request missing action or password")
	}
	if err := s.credentials.ReverifyCurrentPassword(ctx, principal, *req.Password); err != nil {
		return IssueResponse{}, err
	}
	action := *req.Action
	token, tokenHash, err := NewProofToken()
	if err != nil {
		return IssueResponse{}, err
	}
	var expiresAt time.Time
	err = s.runner.Run(ctx, func(sc *writetx.Scope) error {
		tx := sc.Tx()
		if err := tx.QueryRow(ctx,
			`INSERT INTO public.reauth_proofs (user_id, action, token_hash, expires_at)
			 VALUES ($1, $2, $3, now() + make_interval(secs => $4))
			 RETURNING expires_at`,
			principal.UserID, action, tokenHash, Validity.Seconds(),
		).Scan(&expiresAt); err != nil {
			return fmt.Errorf("reauth: insert proof: %w", err)
		}
		actor, err := auditlog.SnapshotSubject(ctx, tx, principal.UserID)
		if err != nil {
			return err
		}
		return auditlog.Append(ctx, tx, auditlog.Entry{
			Actor:    actor,
			Action:   auditlog.ReauthProofIssued,
			Metadata: map[string]string{"action": action},
		})
	})
	if err != nil {
		return IssueResponse{}, err
	}
	return IssueResponse{Proof: token, Action: action, ExpiresAt: expiresAt}, nil
}

// ConsumeRequest is the consumption command body. Proof and Action are
// pointers for the same shape rule as issuance.
type ConsumeRequest struct {
	Proof  *string `json:"proof"`
	Action *string `json:"action"`
}

// Validate checks the request shape: present fields and an action inside the
// closed exact-action set.
func (r *ConsumeRequest) Validate() *command.Error {
	if r.Proof == nil || r.Action == nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: "Request body must be JSON with proof and action."}
	}
	if !ValidAction(*r.Action) {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_action", Message: "Unknown reauthentication action."}
	}
	return nil
}

// ConsumeResponse confirms the single consumption.
type ConsumeResponse struct {
	Status     string    `json:"status"`
	Action     string    `json:"action"`
	ConsumedAt time.Time `json:"consumed_at"`
}

// Consume performs the proof's atomic single-use transition in one write
// transaction: the row is locked by token hash and issuer, discriminated
// (unknown, expired, wrong action, already consumed all fail closed leaving
// the row untouched), and only then stamped consumed_at together with its
// audit row. Once this commits the proof is spent forever — a later failure
// of whatever downstream command requested it never restores it, and the
// admin must re-verify and obtain a new proof.
func (s *Service) Consume(ctx context.Context, principal authz.Principal, req ConsumeRequest) (ConsumeResponse, error) {
	if req.Proof == nil || req.Action == nil {
		// Unreachable through the HTTP pipeline (Validate rejects it first);
		// guards direct callers against a nil dereference.
		return ConsumeResponse{}, fmt.Errorf("reauth: consume request missing proof or action")
	}
	action := *req.Action
	var consumedAt time.Time
	err := s.runner.Run(ctx, func(sc *writetx.Scope) error {
		tx := sc.Tx()
		// The database clock decides expiry: expires_at was written from the
		// same authority, so no application clock skew can widen or narrow
		// the five-minute window.
		var proofID, issuerID, boundAction string
		var expiresAt, dbNow time.Time
		var spentAt *time.Time
		err := tx.QueryRow(ctx,
			`SELECT id, user_id, action, expires_at, consumed_at, now()
			 FROM public.reauth_proofs WHERE token_hash = $1 FOR UPDATE`,
			hashToken(*req.Proof),
		).Scan(&proofID, &issuerID, &boundAction, &expiresAt, &spentAt, &dbNow)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrProofInvalid
		}
		if err != nil {
			return fmt.Errorf("reauth: lock proof for consumption: %w", err)
		}
		// Issuer binding: a proof is consumable only through the issuing
		// admin's own authenticated command, so a token that leaks another
		// way is worthless.
		if issuerID != principal.UserID {
			return ErrProofInvalid
		}
		if spentAt != nil {
			return ErrProofAlreadyConsumed
		}
		if boundAction != action {
			return ErrProofActionMismatch
		}
		if !expiresAt.After(dbNow) {
			return ErrProofExpired
		}
		if err := tx.QueryRow(ctx,
			`UPDATE public.reauth_proofs SET consumed_at = now() WHERE id = $1 RETURNING consumed_at`,
			proofID,
		).Scan(&consumedAt); err != nil {
			return fmt.Errorf("reauth: stamp consumption: %w", err)
		}
		actor, err := auditlog.SnapshotSubject(ctx, tx, principal.UserID)
		if err != nil {
			return err
		}
		return auditlog.Append(ctx, tx, auditlog.Entry{
			Actor:    actor,
			Action:   auditlog.ReauthProofConsumed,
			Metadata: map[string]string{"action": action},
		})
	})
	if err != nil {
		return ConsumeResponse{}, err
	}
	return ConsumeResponse{Status: "consumed", Action: action, ConsumedAt: consumedAt}, nil
}

// SweepExpired removes expired rows through the Write Transaction Module.
// Logical expiry is enforced at consumption, so cleanup failure cannot extend
// a proof's validity; the caller owns retry policy.
func (s *Service) SweepExpired(ctx context.Context) error {
	err := s.runner.Run(ctx, func(sc *writetx.Scope) error {
		_, err := sc.Tx().Exec(ctx, `DELETE FROM public.reauth_proofs WHERE expires_at < now()`)
		return err
	})
	if err != nil {
		return fmt.Errorf("reauth: sweep expired proofs: %w", err)
	}
	return nil
}

// sweepInterval is the maintenance cadence, matching the session sweep:
// expired proofs are already invalid at consumption; the sweep only reclaims
// rows.
const sweepInterval = 24 * time.Hour

// RunSweepLoop sweeps immediately and then once per interval until ctx is
// canceled, returning nil. Sweep failures are logged and retried on the next
// tick; they never stop the loop.
func (s *Service) RunSweepLoop(ctx context.Context) error {
	if err := s.SweepExpired(ctx); err != nil {
		slog.Error("identity: reauth proof sweep failed; will retry on next tick", "error", err)
	}
	ticker := time.NewTicker(sweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := s.SweepExpired(ctx); err != nil {
				slog.Error("identity: reauth proof sweep failed; will retry on next tick", "error", err)
			}
		}
	}
}

// MapError maps the command's domain errors to the public error envelope.
// Credential failures keep auth.MapError's answers (the shared verification
// path returns auth's sentinels), and anything unmapped falls through to the
// pipeline's 500.
func MapError(err error) *command.Error {
	switch {
	case errors.Is(err, ErrInsecureTransport):
		return &command.Error{Status: http.StatusBadRequest, Code: "secure_transport_required", Message: "A proven HTTPS transport is required for this command."}
	case errors.Is(err, ErrProofInvalid):
		return &command.Error{Status: http.StatusBadRequest, Code: "reauth_proof_invalid", Message: "The reauthentication proof is invalid."}
	case errors.Is(err, ErrProofActionMismatch):
		return &command.Error{Status: http.StatusConflict, Code: "reauth_proof_action_mismatch", Message: "The reauthentication proof authorizes a different action."}
	case errors.Is(err, ErrProofAlreadyConsumed):
		return &command.Error{Status: http.StatusConflict, Code: "reauth_proof_already_consumed", Message: "The reauthentication proof has already been used."}
	case errors.Is(err, ErrProofExpired):
		return &command.Error{Status: http.StatusGone, Code: "reauth_proof_expired", Message: "The reauthentication proof has expired."}
	default:
		return auth.MapError(err)
	}
}
