// Package authz is the Server's authorization vocabulary (ADR-0015): exactly
// two route guards — RequireActiveUser (Session → users.status = active) and
// RequireAdmin (additionally users.role = admin) — resolved from an opaque
// session token. Row-level ownership checks stay inside handlers; this package
// deliberately never grows a policy engine or allow-table. The visibility rules
// of the deployment converge here and in the query layer, so a future
// department-isolation change is a vocabulary change, not a sweep.
package authz

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
)

// ErrNotAuthenticated reports that a request carries no session that resolves
// to an active user: missing, malformed, unknown, expired, or revoked token,
// or a disabled account. It is the only error a SessionAuthenticator needs to
// signal; guards answer it with 401 and never distinguish the cause to the
// client.
var ErrNotAuthenticated = errors.New("authz: no active session")

// Principal is the authenticated user a guard resolves from the session token.
// It exists only for active users; a disabled account never becomes a
// Principal.
type Principal struct {
	// SessionID is the session row's identity (sessions.id) — the
	// non-sensitive key logout and revocation route on. The bearer-derived
	// token hash never crosses this seam (spec #138).
	SessionID   string
	UserID      string
	Email       string
	DisplayName string
	Role        string // "admin" | "member"
	// MustChangePassword reports that the account still owes the forced
	// first-login password change. It is account state resolved with the
	// session — not authorization vocabulary: the two guards below never
	// branch on it; the identity Module's route table gates business
	// endpoints on it separately.
	MustChangePassword bool
}

// SessionAuthenticator resolves a request's Bearer token to a Principal. The
// identity Module provides the production implementation; anything else is a
// test double.
type SessionAuthenticator interface {
	Authenticate(r *http.Request) (Principal, error)
}

// Guard is the mountable guard vocabulary. Construct it once per process with
// the identity Module's authenticator and declare it on routes.
type Guard struct {
	sessions SessionAuthenticator
}

// NewGuard builds the guard vocabulary over one session authenticator.
func NewGuard(sessions SessionAuthenticator) *Guard {
	return &Guard{sessions: sessions}
}

// RequireActiveUser admits requests whose session resolves to an active user
// and exposes the Principal to the handler through the request context.
func (g *Guard) RequireActiveUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, err := g.sessions.Authenticate(r)
		if err != nil {
			writeAuthenticationError(w, err)
			return
		}
		next.ServeHTTP(w, r.WithContext(WithPrincipal(r.Context(), principal)))
	})
}

// RequireAdmin admits only active admins; every other outcome matches
// RequireActiveUser, with members and non-admins answered by 403 forbidden.
func (g *Guard) RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, err := g.sessions.Authenticate(r)
		if err != nil {
			writeAuthenticationError(w, err)
			return
		}
		if principal.Role != "admin" {
			writeError(w, http.StatusForbidden, "forbidden", "Administrator role is required.")
			return
		}
		next.ServeHTTP(w, r.WithContext(WithPrincipal(r.Context(), principal)))
	})
}

type principalContextKey struct{}

// WithPrincipal returns a context carrying the guard-resolved Principal.
func WithPrincipal(ctx context.Context, principal Principal) context.Context {
	return context.WithValue(ctx, principalContextKey{}, principal)
}

// PrincipalFrom reads the guard-resolved Principal; false means the handler
// ran without an authenticating guard.
func PrincipalFrom(ctx context.Context) (Principal, bool) {
	principal, ok := ctx.Value(principalContextKey{}).(Principal)
	return principal, ok
}

// writeAuthenticationError answers an authentication failure: the sentinel is
// the documented 401; anything else is infrastructure noise that must not be
// disguised as a client problem.
func writeAuthenticationError(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrNotAuthenticated) {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Authentication required.")
		return
	}
	slog.Error("authz: authenticate session", "error", err)
	writeError(w, http.StatusInternalServerError, "internal_error", "The request could not be completed.")
}

// writeError emits the Server-wide error envelope — the byte-for-byte
// `{"error":...,"message":...}` shape every command uses (contracts/openapi.yaml
// components.schemas/Error). The shape is duplicated here because the command
// envelope writer belongs to the identity Module; keep both writers in sync.
func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"error":%q,"message":%q}`, code, message)
}
