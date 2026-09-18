package creationhttp

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/authz"
)

type blockingAuthenticator struct {
	entered chan struct{}
	release chan struct{}
}

func (a *blockingAuthenticator) Authenticate(*http.Request) (authz.Principal, error) {
	close(a.entered)
	<-a.release
	return authz.Principal{}, authz.ErrNotAuthenticated
}

func TestStreamSubscribesBeforeRevalidatingTheSession(t *testing.T) {
	authenticator := &blockingAuthenticator{entered: make(chan struct{}), release: make(chan struct{})}
	hub := NewInvalidationHub(authenticator)
	principal := authz.Principal{UserID: "user-1", SessionID: "session-1"}
	req := httptest.NewRequest(http.MethodGet, "/creation/events", nil)
	req = req.WithContext(authz.WithPrincipal(req.Context(), principal))
	recorder := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		hub.StreamEvents(recorder, req)
	}()

	select {
	case <-authenticator.entered:
	case <-time.After(time.Second):
		t.Fatal("session revalidation did not start")
	}
	hub.DisconnectSession(principal.SessionID)
	close(authenticator.release)

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("stream did not stop after the revoked session failed revalidation")
	}
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("revoked session race answered %d, want 401", recorder.Code)
	}
}
