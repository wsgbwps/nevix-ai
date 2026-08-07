// The shared command pipeline: one decode/validate/map/encode choke point
// behind the two public entry points. Handle serves commands that only need
// the context; HandleWithRequest additionally hands the *http.Request to the
// business function for commands that need per-request values (such as the
// client IP) at run time. The request is bound per invocation, never captured
// at registration time.
package command

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
)

// maxBodyBytes bounds a command request body, matching the bound the two
// existing commands already use.
const maxBodyBytes = 4096

// Handle adapts a pure business function into a command handler: decode the
// bounded request body, run the optional Validate hook, call the function,
// map domain errors through mapError, and write either the declared success
// status with the JSON response or the standard error envelope.
func Handle[Req, Resp any](fn func(context.Context, Req) (Resp, error), mapError func(error) *Error, successStatus int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serve(w, r, func(ctx context.Context, req Req) (Resp, error) {
			return fn(ctx, req)
		}, mapError, successStatus)
	}
}

// HandleWithRequest is Handle for commands whose business function needs the
// per-request *http.Request (for example the client IP). The request is bound
// when the handler runs, not at registration time.
func HandleWithRequest[Req, Resp any](fn func(context.Context, *http.Request, Req) (Resp, error), mapError func(error) *Error, successStatus int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serve(w, r, func(ctx context.Context, req Req) (Resp, error) {
			return fn(ctx, r, req)
		}, mapError, successStatus)
	}
}

// serve runs the shared pipeline. Request-shape failures (decode, Validate)
// are answered with their own status and never pass through mapError; domain
// errors are mapped by mapError, and an unmapped error is logged and
// collapsed to 500 internal_error.
func serve[Req, Resp any](w http.ResponseWriter, r *http.Request, fn func(context.Context, Req) (Resp, error), mapError func(error) *Error, successStatus int) {
	var req Req
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes)).Decode(&req); err != nil {
		WriteError(w, &Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: "Request body must be JSON."})
		return
	}
	if v, ok := any(&req).(Validator); ok {
		if err := v.Validate(); err != nil {
			WriteError(w, err)
			return
		}
	}
	resp, err := fn(r.Context(), req)
	if err != nil {
		if mapped := mapError(err); mapped != nil {
			WriteError(w, mapped)
			return
		}
		slog.Error("identity: trusted command failed", "path", r.URL.Path, "error", err)
		WriteError(w, &Error{Status: http.StatusInternalServerError, Code: "internal_error", Message: "The request could not be completed."})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(successStatus)
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		slog.Error("identity: encode command response", "path", r.URL.Path, "error", err)
	}
}
