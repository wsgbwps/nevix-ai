// Package command is the identity Module's trusted-command skeleton: the
// single error envelope writer, the shared decode-validate-map pipeline
// (Handle, HandleWithRequest, HandleNoBody), and the static route table
// machinery (Route, GuardPolicy, Guards, Mount, MethodsByPath, AllowMethods)
// from which every path's guard, OPTIONS preflight twin, and Allow-Methods
// value derive. Domain sub-packages keep only their business functions and
// request/response types; HTTP mechanics live here, so adding a trusted
// command never touches CORS, preflight, or the error envelope again.
package command

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/nevix-ai/server/internal/authz"
)

// Error is the command layer's single error representation: the HTTP status,
// the snake_case machine code that clients branch on, a human-readable
// message, and any extra response headers (e.g. Retry-After).
type Error struct {
	Status  int
	Code    string
	Message string
	Headers map[string]string
}

// Validator is implemented by request types (pointer receiver) that must
// normalize then validate before the command runs. The returned Error is
// written as-is with its own status, bypassing mapError: request-shape
// failures and domain failures stay layered.
type Validator interface {
	Validate() *Error
}

// GuardPolicy names the authorization a route requires (ADR-0015 vocabulary).
// GuardActiveUser is the zero value: a route that does not declare its guard
// is mounted behind RequireActiveUser, the default for new commands.
type GuardPolicy string

const (
	// GuardActiveUser requires a session resolving to an active user.
	GuardActiveUser GuardPolicy = ""
	// GuardAdmin additionally requires the admin role.
	GuardAdmin GuardPolicy = "admin"
	// GuardPublic is open without a session; use only where the command is
	// itself an authentication step (login).
	GuardPublic GuardPolicy = "public"
)

// Guards carries the mountable guard middlewares; the Module builds them from
// the authz vocabulary and hands them to Mount, so the route table stays
// declarative.
type Guards struct {
	ActiveUser func(http.Handler) http.Handler
	Admin      func(http.Handler) http.Handler
}

// PasswordGatePolicy declares how the must-change-password gate treats one
// route. The zero value PasswordGateEnforce is the safe default: a guarded
// route stays unusable while the caller's account still owes the forced
// first-login password change, so every future business command is gated
// without declaring anything. Only the auth-scoped routes that the forced
// change flow itself needs declare PasswordGateOpen. The gate is account
// hygiene resolved from the guard's principal — deliberately not a third
// authz guard, keeping ADR-0015's vocabulary at exactly two.
type PasswordGatePolicy string

const (
	// PasswordGateEnforce answers 403 password_change_required while the
	// account owes the forced change. The zero value.
	PasswordGateEnforce PasswordGatePolicy = ""
	// PasswordGateOpen keeps a route usable while the change is owed: me,
	// logout, and the change itself.
	PasswordGateOpen PasswordGatePolicy = "open"
)

// Route declares one trusted command in the Module's static table.
type Route struct {
	Method string
	Path   string
	Guard  GuardPolicy
	// PasswordGate declares the route's must-change-password gate policy;
	// see PasswordGatePolicy.
	PasswordGate PasswordGatePolicy
	Handler      http.HandlerFunc
}

// WriteError writes the Module's only error envelope, byte-for-byte the
// established `{"error":...,"message":...}` shape, plus any Headers the
// error carries.
func WriteError(w http.ResponseWriter, e *Error) {
	w.Header().Set("Content-Type", "application/json")
	for key, value := range e.Headers {
		w.Header().Set(key, value)
	}
	w.WriteHeader(e.Status)
	fmt.Fprintf(w, `{"error":%q,"message":%q}`, e.Code, e.Message)
}

// Mount registers the route table: each entry gets its method route behind
// the declared guard and an automatic OPTIONS twin, so browser preflights
// stay reachable when the Module is mounted inside a chi Group, where
// route-scoped middleware never runs for unmatched methods. A route whose
// guard has no middleware is a wiring bug and fails loudly at mount time.
func Mount(r chi.Router, routes []Route, guards Guards) {
	for _, route := range routes {
		handler := http.Handler(route.Handler)
		switch route.Guard {
		case GuardActiveUser:
			requireMiddleware(route, guards.ActiveUser, "ActiveUser")
			handler = guards.ActiveUser(rejectPendingPasswordChange(route, handler))
		case GuardAdmin:
			requireMiddleware(route, guards.Admin, "Admin")
			handler = guards.Admin(rejectPendingPasswordChange(route, handler))
		case GuardPublic:
			// open route
		default:
			panic(fmt.Sprintf("command: route %s %s declares unknown guard %q", route.Method, route.Path, route.Guard))
		}
		r.Method(route.Method, route.Path, handler)
		r.Options(route.Path, preflightEndpoint)
	}
}

// rejectPendingPasswordChange wraps an already-guarded handler with the
// must-change-password gate when the route enforces it: a session whose
// account still owes the forced first-login change answers 403
// password_change_required before the command runs. The gate runs inside the
// guard, so the principal — resolved fresh per request — is already in the
// context; a cleared flag takes effect on the very next request.
func rejectPendingPasswordChange(route Route, next http.Handler) http.Handler {
	if route.PasswordGate == PasswordGateOpen {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if principal, ok := authz.PrincipalFrom(r.Context()); ok && principal.MustChangePassword {
			WriteError(w, &Error{
				Status:  http.StatusForbidden,
				Code:    "password_change_required",
				Message: "The initial password must be changed before using this command.",
			})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// requireMiddleware panics with the route context when a guarded route lacks
// its middleware, so a forgotten guard wiring cannot silently open a route.
func requireMiddleware(route Route, middleware func(http.Handler) http.Handler, name string) {
	if middleware == nil {
		panic(fmt.Sprintf("command: route %s %s needs the %s guard but Mount received none", route.Method, route.Path, name))
	}
}

// MethodsByPath aggregates every method each path supports — the single
// source the CORS middleware derives Allow-Methods from.
func MethodsByPath(routes []Route) map[string][]string {
	byPath := map[string][]string{}
	for _, route := range routes {
		byPath[route.Path] = append(byPath[route.Path], route.Method)
	}
	return byPath
}

// AllowMethods derives the Allow-Methods value for one path: the table's
// methods plus the OPTIONS preflight every path receives. An unknown path
// yields only OPTIONS.
func AllowMethods(methodsByPath map[string][]string, path string) string {
	methods := append([]string{}, methodsByPath[path]...)
	methods = append(methods, http.MethodOptions)
	return strings.Join(methods, ", ")
}

// preflightEndpoint answers preflights the CORS middleware passed through —
// the origin is outside the whitelist, so the response carries no CORS
// headers and the browser still enforces the denial.
func preflightEndpoint(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusNoContent)
}
