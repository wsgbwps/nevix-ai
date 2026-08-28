// Package creationhttp is the Creation Module's transport seam: the static
// route table with its guards and OPTIONS twins, the single error envelope,
// and the JSON command adapters. The wire mechanics deliberately mirror the
// Identity Module's command skeleton byte-for-byte — the {"error","message"}
// envelope is a cross-runtime contract — without importing another Module's
// internals (AGENTS.md: business Modules never import each other).
package creationhttp

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/creation/domain"
)

// Error is one error response: HTTP status plus the snake_case machine code
// clients branch on.
type Error struct {
	Status  int
	Code    string
	Message string
}

// WriteError emits the Module's only error envelope, byte-for-byte the
// established `{"error":...,"message":...}` shape.
func WriteError(w http.ResponseWriter, e *Error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(e.Status)
	fmt.Fprintf(w, `{"error":%q,"message":%q}`, e.Code, e.Message)
}

// Stable error codes documented in contracts/creation.yaml. The machine
// vocabulary lives beside its only emitter so contract drift fails review
// visibly.
const (
	CodeInvalidRequest      = "invalid_request"
	CodeInvalidCursor       = "invalid_cursor"
	CodeUploadMalformed     = "upload_malformed"
	CodeUnauthorized        = "unauthorized"
	CodePasswordChangeReq   = "password_change_required"
	CodeNotFound            = "not_found"
	CodeTooLarge            = "material_too_large"
	CodeUnsupportedMedia    = "material_unsupported_media"
	CodeUnreadableMedia     = "material_unreadable_media"
	CodeRangeNotSatisfiable = "range_not_satisfiable"
	CodeInternalError       = "internal_error"

	CodeNotConfigured               = "provider_connection_not_configured"
	CodeConnectionExists            = "provider_connection_exists"
	CodeCredentialInvalid           = "provider_credential_invalid"
	CodeCheckTemporarilyUnavailable = "provider_check_temporarily_unavailable"
	CodeSecureTransportRequired     = "secure_transport_required"
	CodeReauthProofInvalid          = "reauth_proof_invalid"
	CodeReauthProofExpired          = "reauth_proof_expired"
	CodeReauthProofActionMismatch   = "reauth_proof_action_mismatch"
	CodeReauthProofAlreadyConsumed  = "reauth_proof_already_consumed"
)

// MapError translates domain outcomes onto the stable codes; nil collapses
// to the logged 500 fallback.
func MapError(err error) *Error {
	switch {
	case err == nil:
		return nil
	case isError(err, domain.ErrSessionNotFound), isError(err, domain.ErrMaterialNotFound):
		return &Error{Status: http.StatusNotFound, Code: CodeNotFound, Message: "The requested resource was not found."}
	case isError(err, domain.ErrInvalidCursor):
		return &Error{Status: http.StatusBadRequest, Code: CodeInvalidCursor, Message: "The pagination cursor is not valid."}
	case isError(err, domain.ErrMalformedUpload):
		return &Error{Status: http.StatusBadRequest, Code: CodeUploadMalformed, Message: "The upload could not be read as multipart form data."}
	case isError(err, domain.ErrTooLarge):
		return &Error{Status: http.StatusRequestEntityTooLarge, Code: CodeTooLarge, Message: "The file exceeds the size limit for its media kind."}
	case isError(err, domain.ErrUnsupportedMedia):
		return &Error{Status: http.StatusUnsupportedMediaType, Code: CodeUnsupportedMedia, Message: "The media kind or file extension is not supported."}
	case isError(err, domain.ErrUnreadableMedia):
		return &Error{Status: http.StatusUnprocessableEntity, Code: CodeUnreadableMedia, Message: "The media could not be decoded by the server."}
	case isError(err, domain.ErrRangeNotSatisfiable):
		return &Error{Status: http.StatusRequestedRangeNotSatisfiable, Code: CodeRangeNotSatisfiable, Message: "The requested range cannot be satisfied."}
	case isError(err, domain.ErrInvalidDraft):
		return &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "The draft violates the structural envelope or references materials outside the session."}
	case isError(err, domain.ErrConnectionNotConfigured):
		return &Error{Status: http.StatusNotFound, Code: CodeNotConfigured, Message: "No AI provider connection is configured."}
	case isError(err, domain.ErrConnectionExists):
		return &Error{Status: http.StatusConflict, Code: CodeConnectionExists, Message: "An AI provider connection already exists."}
	case isError(err, domain.ErrCandidateCredentialInvalid):
		return &Error{Status: http.StatusBadRequest, Code: CodeCredentialInvalid, Message: "The provider key was rejected; nothing was changed."}
	case isError(err, domain.ErrCheckTemporarilyUnavailable):
		return &Error{Status: http.StatusServiceUnavailable, Code: CodeCheckTemporarilyUnavailable, Message: "The provider check could not complete; try again later."}
	case isError(err, authz.ErrProofInsecureTransport):
		return &Error{Status: http.StatusBadRequest, Code: CodeSecureTransportRequired, Message: "A proven HTTPS transport is required for this command."}
	case isError(err, domain.ErrInvalidAdminState):
		return &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "Request body must be JSON with admin_state of enabled or paused."}
	case isError(err, authz.ErrProofInvalid):
		return &Error{Status: http.StatusBadRequest, Code: CodeReauthProofInvalid, Message: "The reauthentication proof is invalid."}
	case isError(err, authz.ErrProofExpired):
		return &Error{Status: http.StatusGone, Code: CodeReauthProofExpired, Message: "The reauthentication proof has expired."}
	case isError(err, authz.ErrProofActionMismatch):
		return &Error{Status: http.StatusConflict, Code: CodeReauthProofActionMismatch, Message: "The reauthentication proof authorizes a different action."}
	case isError(err, authz.ErrProofAlreadyConsumed):
		return &Error{Status: http.StatusConflict, Code: CodeReauthProofAlreadyConsumed, Message: "The reauthentication proof has already been used."}
	default:
		return nil
	}
}

// isError unwraps to the target sentinel without pulling errors.Is's
// allocation-friendly but broader semantics into this mapping table.
func isError(err, target error) bool {
	for err != nil {
		if err == target {
			return true
		}
		unwrapper, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = unwrapper.Unwrap()
	}
	return false
}

// GuardPolicy selects the declared authorization vocabulary of one route
// (ADR-0015); it stays route-local so the static table remains the single
// place each command's guard is declared.
type GuardPolicy string

const (
	// GuardActiveUser is the zero value: a route that does not declare its
	// guard explicitly requires an active user session.
	GuardActiveUser GuardPolicy = ""
	// GuardAdmin additionally requires the admin role.
	GuardAdmin GuardPolicy = "admin"
)

// Route declares one trusted command in the Module's static table with its
// declared guard policy.
type Route struct {
	Method  string
	Path    string
	Guard   GuardPolicy
	Handler http.HandlerFunc
}

// Guards carries the mountable guard middlewares built by composition from
// the shared authz vocabulary.
type Guards struct {
	ActiveUser func(http.Handler) http.Handler
	Admin      func(http.Handler) http.Handler
}

// Mount registers the route table: each handler runs behind its declared
// guard plus the must-change-password gate, and every path receives an
// automatic OPTIONS twin so browser preflights stay answerable inside a chi
// Group.
func Mount(r chi.Router, routes []Route, guards Guards) {
	if guards.ActiveUser == nil {
		panic("creationhttp: Mount requires the ActiveUser guard")
	}
	if guards.Admin == nil {
		panic("creationhttp: Mount requires the Admin guard")
	}
	for _, route := range routes {
		guard := guards.ActiveUser
		if route.Guard == GuardAdmin {
			guard = guards.Admin
		}
		r.Method(route.Method, route.Path, guard(rejectPendingPasswordChange(route.Handler)))
		r.Options(route.Path, preflightEndpoint)
	}
}

// requireSecureTransport answers secure_transport_required before any proof
// is consumed: rejecting the command later would burn the admin's proof for
// a transport that could never carry it.
func requireSecureTransport(w http.ResponseWriter, r *http.Request) bool {
	if authz.SecureTransportProven(r) {
		return true
	}
	WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeSecureTransportRequired, Message: "A proven HTTPS transport is required for this command."})
	return false
}

// rejectPendingPasswordChange answers 403 password_change_required while the
// caller's account still owes the forced first-login change. The gate sits
// inside the guard so the principal is already resolved; clearing the flag
// takes effect on the very next request.
func rejectPendingPasswordChange(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if principal, ok := authz.PrincipalFrom(r.Context()); ok && principal.MustChangePassword {
			WriteError(w, &Error{
				Status:  http.StatusForbidden,
				Code:    CodePasswordChangeReq,
				Message: "The initial password must be changed before using this command.",
			})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// preflightEndpoint answers accepted preflights with no body.
func preflightEndpoint(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusNoContent)
}

// MethodsByPath aggregates each path's methods; CORS derives Allow-Methods
// from this table rather than any hardcoded list.
func MethodsByPath(routes []Route) map[string][]string {
	byPath := map[string][]string{}
	for _, route := range routes {
		byPath[route.Path] = append(byPath[route.Path], route.Method)
	}
	return byPath
}

// AllowMethods renders the per-path value including the OPTIONS twin.
func AllowMethods(methodsByPath map[string][]string, path string) string {
	methods := append([]string{}, methodsByPath[path]...)
	methods = append(methods, http.MethodOptions)
	return strings.Join(methods, ", ")
}

// encodeJSON writes one success payload.
func encodeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		slog.Error("creation: encode response", "error", err)
	}
}

// fail maps an error through MapError, logging unmapped failures before the
// internal_error collapse.
func fail(w http.ResponseWriter, r *http.Request, err error) {
	if mapped := MapError(err); mapped != nil {
		WriteError(w, mapped)
		return
	}
	slog.Error("creation: trusted command failed", "path", r.URL.Path, "error", err)
	WriteError(w, &Error{Status: http.StatusInternalServerError, Code: CodeInternalError, Message: "The request could not be completed."})
}

// decodeJSON reads one bounded object body; null and malformed shapes are
// rejected uniformly.
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	body := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxJSONBodyBytes))
	var raw json.RawMessage
	if err := body.Decode(&raw); err != nil || len(raw) == 0 || string(raw) == "null" {
		WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "Request body must be JSON."})
		return false
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "Request body must be JSON."})
		return false
	}
	return true
}

// The bound must carry the widest legal draft save: a 2000-Unicode-char
// prompt is up to 8 KiB of UTF-8 plus the envelope — 4 KiB would reject a
// contract-legal body.
const maxJSONBodyBytes = 16384
