package creationhttp

import (
	"errors"
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
	mu        sync.Mutex
	sessions  authz.SessionAuthenticator
	byOwner   map[string]map[*streamSubscription]struct{}
	bySession map[string]map[*streamSubscription]struct{}
	clock     func() time.Time
}

type streamSubscription struct {
	owner         string
	sessionID     string
	invalidations chan struct{}
	revoked       chan struct{}
}

// NewInvalidationHub builds the hub over the Identity-owned revalidation seam.
func NewInvalidationHub(sessions authz.SessionAuthenticator) *InvalidationHub {
	return &InvalidationHub{
		sessions:  sessions,
		byOwner:   map[string]map[*streamSubscription]struct{}{},
		bySession: map[string]map[*streamSubscription]struct{}{},
	}
}

// NotifyGenerationChanged implements the application InvalidationSink port:
// persistence has already committed when this runs.
func (h *InvalidationHub) NotifyGenerationChanged(owner domain.UUID) {
	h.notify(owner.String())
}

func (h *InvalidationHub) notify(owner string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for subscription := range h.byOwner[owner] {
		select {
		case subscription.invalidations <- struct{}{}:
		default: // one pending invalidation per stream is enough
		}
	}
}

func (h *InvalidationHub) subscribe(owner, sessionID string) (<-chan struct{}, <-chan struct{}, func()) {
	subscription := &streamSubscription{
		owner:         owner,
		sessionID:     sessionID,
		invalidations: make(chan struct{}, 1),
		revoked:       make(chan struct{}),
	}
	h.mu.Lock()
	if h.byOwner[owner] == nil {
		h.byOwner[owner] = map[*streamSubscription]struct{}{}
	}
	if h.bySession[sessionID] == nil {
		h.bySession[sessionID] = map[*streamSubscription]struct{}{}
	}
	h.byOwner[owner][subscription] = struct{}{}
	h.bySession[sessionID][subscription] = struct{}{}
	h.mu.Unlock()
	cancel := func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		h.removeLocked(subscription)
	}
	return subscription.invalidations, subscription.revoked, cancel
}

func (h *InvalidationHub) removeLocked(subscription *streamSubscription) {
	delete(h.byOwner[subscription.owner], subscription)
	if len(h.byOwner[subscription.owner]) == 0 {
		delete(h.byOwner, subscription.owner)
	}
	delete(h.bySession[subscription.sessionID], subscription)
	if len(h.bySession[subscription.sessionID]) == 0 {
		delete(h.bySession, subscription.sessionID)
	}
}

// DisconnectSession closes only streams authenticated by the revoked Session.
func (h *InvalidationHub) DisconnectSession(sessionID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for subscription := range h.bySession[sessionID] {
		h.removeLocked(subscription)
		close(subscription.revoked)
	}
}

// heartbeatInterval is the SSE keepalive cadence (~20s per contract).
const heartbeatInterval = 20 * time.Second

// StreamEvents answers GET /creation/events with the creator-scoped
// text/event-stream. Every write is flushed immediately so the desktop
// fetch-stream parser sees invalidations and heartbeats as they happen; the
// stream carries no Last-Event-ID semantics — clients refetch on loss.
func (h *InvalidationHub) StreamEvents(w http.ResponseWriter, r *http.Request) {
	principal, ok := authz.PrincipalFrom(r.Context())
	if !ok || principal.UserID == "" || principal.SessionID == "" {
		WriteError(w, &Error{Status: http.StatusUnauthorized, Code: CodeUnauthorized, Message: "Authentication is required."})
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		WriteError(w, &Error{Status: http.StatusInternalServerError, Code: CodeInternalError, Message: "Streaming is not supported."})
		return
	}
	events, revoked, cancel := h.subscribe(principal.UserID, principal.SessionID)
	defer cancel()
	validated, err := h.sessions.Authenticate(r)
	if err != nil {
		if errors.Is(err, authz.ErrNotAuthenticated) {
			WriteError(w, &Error{Status: http.StatusUnauthorized, Code: CodeUnauthorized, Message: "Authentication is required."})
		} else {
			WriteError(w, &Error{Status: http.StatusInternalServerError, Code: CodeInternalError, Message: "The request could not be completed."})
		}
		return
	}
	if validated.UserID != principal.UserID || validated.SessionID != principal.SessionID {
		WriteError(w, &Error{Status: http.StatusUnauthorized, Code: CodeUnauthorized, Message: "Authentication is required."})
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

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
		case <-revoked:
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
