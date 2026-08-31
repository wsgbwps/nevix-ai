package creationhttp

import (
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/creation/domain"
)

// InvalidationHub fans the module's post-commit generation invalidations out
// to the creator's open SSE streams. Events carry no payload beyond the fact
// that the owner's creation state changed — never prompts, media, or task
// bodies (spec #150 SSE contract).
type InvalidationHub struct {
	mu    sync.Mutex
	subs  map[string]map[chan struct{}]struct{}
	clock func() time.Time
}

// NewInvalidationHub builds the hub.
func NewInvalidationHub() *InvalidationHub {
	return &InvalidationHub{subs: map[string]map[chan struct{}]struct{}{}}
}

// NotifyGenerationChanged implements the application InvalidationSink port:
// persistence has already committed when this runs.
func (h *InvalidationHub) NotifyGenerationChanged(owner domain.UUID) {
	h.notify(owner.String())
}

func (h *InvalidationHub) notify(owner string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs[owner] {
		select {
		case ch <- struct{}{}:
		default: // one pending invalidation per stream is enough
		}
	}
}

// subscribe registers one stream for the owner; the returned cancel removes
// it exactly once.
func (h *InvalidationHub) subscribe(owner string) (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	h.mu.Lock()
	if h.subs[owner] == nil {
		h.subs[owner] = map[chan struct{}]struct{}{}
	}
	h.subs[owner][ch] = struct{}{}
	h.mu.Unlock()
	cancel := func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if streams, ok := h.subs[owner]; ok {
			delete(streams, ch)
			if len(streams) == 0 {
				delete(h.subs, owner)
			}
		}
	}
	return ch, cancel
}

// heartbeatInterval is the SSE keepalive cadence (~20s per contract).
const heartbeatInterval = 20 * time.Second

// StreamEvents answers GET /creation/events with the creator-scoped
// text/event-stream. Every write is flushed immediately so the desktop
// fetch-stream parser sees invalidations and heartbeats as they happen; the
// stream carries no Last-Event-ID semantics — clients refetch on loss.
func (h *InvalidationHub) StreamEvents(w http.ResponseWriter, r *http.Request) {
	principal, ok := authz.PrincipalFrom(r.Context())
	if !ok || principal.UserID == "" {
		WriteError(w, &Error{Status: http.StatusUnauthorized, Code: CodeUnauthorized, Message: "Authentication is required."})
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		WriteError(w, &Error{Status: http.StatusInternalServerError, Code: CodeInternalError, Message: "Streaming is not supported."})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	events, cancel := h.subscribe(principal.UserID)
	defer cancel()

	// Immediate hello so the client can distinguish a live stream from a
	// dead one before the first heartbeat.
	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	heartbeat := time.NewTicker(heartbeatInterval)
	defer heartbeat.Stop()
	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case <-events:
			// The only event type: this creator's creation state changed.
			fmt.Fprint(w, "event: creation-invalidation\ndata: {}\n\n")
			flusher.Flush()
		case <-heartbeat.C:
			fmt.Fprint(w, ": heartbeat\n\n")
			flusher.Flush()
		}
	}
}
