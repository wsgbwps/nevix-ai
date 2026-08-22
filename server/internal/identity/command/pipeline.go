// The shared command pipeline: one decode/validate/map/encode choke point
// behind two public entry points. Handle serves pure domain functions;
// HandleWithRequest lets a route adapter derive per-request transport values
// before calling one. The request is bound per invocation, never captured at
// registration time.
package command

import (
	"bytes"
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

// HandleWithRequest is Handle for route adapters that must derive values from
// the request before invoking a pure domain function. The request is bound
// when the handler runs, not at registration time.
func HandleWithRequest[Req, Resp any](fn func(context.Context, *http.Request, Req) (Resp, error), mapError func(error) *Error, successStatus int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serve(w, r, func(ctx context.Context, req Req) (Resp, error) {
			return fn(ctx, r, req)
		}, mapError, successStatus)
	}
}

// HandleNoBody adapts a request-only function — the reads that carry no
// request body — through the same map/encode tail as the decoding
// adapters.
func HandleNoBody[Resp any](fn func(context.Context, *http.Request) (Resp, error), mapError func(error) *Error, successStatus int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		resp, err := fn(r.Context(), r)
		respond(w, r, resp, err, mapError, successStatus)
	}
}

// serve runs the shared pipeline. Request-shape failures (decode, Validate)
// are answered with their own status and never pass through mapError; domain
// errors are mapped by mapError, and an unmapped error is logged and
// collapsed to 500 internal_error.
func serve[Req, Resp any](w http.ResponseWriter, r *http.Request, fn func(context.Context, Req) (Resp, error), mapError func(error) *Error, successStatus int) {
	// A JSON `null` body is a shape failure: every command takes a JSON object.
	var body json.RawMessage
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes)).Decode(&body); err != nil || len(body) == 0 || bytes.Equal(body, []byte("null")) {
		WriteError(w, &Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: "Request body must be JSON."})
		return
	}
	var req Req
	if err := json.Unmarshal(body, &req); err != nil {
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
	respond(w, r, resp, err, mapError, successStatus)
}

// respond is the shared tail of every adapter: map domain errors through
// mapError (an unmapped error is logged and collapsed to 500 internal_error),
// then encode the success response with the declared status.
func respond[Resp any](w http.ResponseWriter, r *http.Request, resp Resp, err error, mapError func(error) *Error, successStatus int) {
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
