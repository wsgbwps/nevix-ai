package integrationtest

import (
	"encoding/json"
	"net/http"
	"testing"
)

type sessionView struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type sessionList struct {
	Sessions   []sessionView `json:"sessions"`
	NextCursor *string       `json:"next_cursor"`
}

func (h *harness) createSession(t *testing.T, token, name string) sessionView {
	t.Helper()
	status, body := h.doRequest(t, "POST", "/creation/sessions", token, map[string]any{"name": name})
	if status != http.StatusCreated {
		t.Fatalf("create session: status=%d body=%s", status, body)
	}
	assertContractResponse(t, "POST", "/creation/sessions", status, body)
	var view sessionView
	if err := json.Unmarshal(body, &view); err != nil {
		t.Fatalf("decode created session: %v (%s)", err, body)
	}
	return view
}

func TestCreationSessionLifecycleCreatorPrivateMatrix(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	adminToken := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	creatorToken := h.loginToken(t, creatorEmail, harnessPassword)
	otherToken := h.loginToken(t, otherCreatorEmail, harnessPassword)

	session := h.createSession(t, creatorToken, "creator session")

	// The creator reads their own session.
	status, ownBody := h.doRequest(t, "GET", "/creation/sessions/"+session.ID, creatorToken, nil)
	if status != http.StatusOK {
		t.Fatalf("creator read own session: status=%d", status)
	}
	assertContractResponse(t, "GET", "/creation/sessions/"+session.ID, status, ownBody)
	// Another member and the Admin receive the same 404 a fabricated id gets.
	for name, token := range map[string]string{"other-member": otherToken, "admin": adminToken} {
		if status, body := h.doRequest(t, "GET", "/creation/sessions/"+session.ID, token, nil); status != http.StatusNotFound {
			t.Fatalf("%s guessed id: status=%d body=%s", name, status, body)
		}
		if status, body := h.doRequest(t, "PATCH", "/creation/sessions/"+session.ID, token, map[string]any{"name": "hijacked"}); status != http.StatusNotFound {
			t.Fatalf("%s rename: status=%d body=%s", name, status, body)
		}
		if status, body := h.doRequest(t, "DELETE", "/creation/sessions/"+session.ID, token, nil); status != http.StatusNotFound {
			t.Fatalf("%s delete: status=%d body=%s", name, status, body)
		}
	}
	var missingID = "11111111-2222-3333-4444-555555555555"
	if status, body := h.doRequest(t, "GET", "/creation/sessions/"+missingID, adminToken, nil); status != http.StatusNotFound {
		t.Fatalf("admin on fabricated id: status=%d body=%s", status, body)
	}

	// The list endpoint only ever surfaces the caller's active sessions.
	h.createSession(t, creatorToken, "creator second")
	h.createSession(t, otherToken, "other session")
	var mine sessionList
	status, body := h.doRequest(t, "GET", "/creation/sessions?limit=200", creatorToken, nil)
	if status != http.StatusOK {
		t.Fatalf("list own: %d %s", status, body)
	}
	assertContractResponse(t, "GET", "/creation/sessions", status, body)
	mustDecode(t, body, &mine)
	if len(mine.Sessions) < 2 {
		t.Fatalf("expected both creator sessions, got %+v", mine.Sessions)
	}
	for _, s := range mine.Sessions {
		if s.Name == "other session" {
			t.Fatalf("list leaked another member's session: %+v", mine.Sessions)
		}
	}

	// Rename touches only the named session and returns its fresh state.
	renameStatus, renameBody := h.doRequest(t, "PATCH", "/creation/sessions/"+session.ID, creatorToken, map[string]any{"name": "renamed once"})
	if renameStatus != http.StatusOK {
		t.Fatalf("rename: %d %s", renameStatus, renameBody)
	}
	assertContractResponse(t, "PATCH", "/creation/sessions/"+session.ID, renameStatus, renameBody)
	var renamed sessionView
	mustDecode(t, renameBody, &renamed)
	if renamed.Name != "renamed once" {
		t.Fatalf("rename ignored: %+v", renamed)
	}
}

func TestSessionDeletionHidesAndBlocksMaterialRoutes(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	token := h.loginToken(t, creatorEmail, harnessPassword)
	session := h.createSession(t, token, sessionName("doomed"))

	deletedPath := "/creation/sessions/" + session.ID
	if status, body := h.doRequest(t, "DELETE", deletedPath, token, nil); status != http.StatusNoContent {
		t.Fatalf("delete: %d %s", status, body)
	}
	assertContractResponse(t, "DELETE", deletedPath, http.StatusNoContent, nil)
	// Every follow-up path — read, rename, re-delete, list-materials — sees
	// the same 404 an absent id would answer; no resurrect-by-retry.
	if status, body := h.doRequest(t, "GET", deletedPath, token, nil); status != http.StatusNotFound {
		t.Fatalf("get after delete: %d %s", status, body)
	}
	if status, body := h.doRequest(t, "DELETE", deletedPath, token, nil); status != http.StatusNotFound {
		t.Fatalf("repeat delete: %d %s", status, body)
	}
	if status, body := h.doRequest(t, "GET", deletedPath+"/materials", token, nil); status != http.StatusNotFound {
		t.Fatalf("materials of deleted session: %d %s", status, body)
	}
	if status, body := h.doUpload(t, "POST", deletedPath+"/materials", token, "gone.png", pngBytes(t)); status != http.StatusNotFound {
		t.Fatalf("upload into deleted session: %d %s", status, body)
	}

	var listing sessionList
	status, body := h.doRequest(t, "GET", "/creation/sessions?limit=200", token, nil)
	if status != http.StatusOK {
		t.Fatalf("list after delete: %d %s", status, body)
	}
	mustDecode(t, body, &listing)
	for _, s := range listing.Sessions {
		if s.ID == session.ID {
			t.Fatal("logically deleted session still appears in the list")
		}
	}
}

func TestSessionListKeysetPaginationIsStableAndCompound(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	token := h.loginToken(t, creatorEmail, harnessPassword)

	ids := make([]string, 0, 7)
	base := sessionName("paged")
	for i := 0; i < 7; i++ {
		s := h.createSession(t, token, base+"-"+string(rune('a'+i)))
		ids = append(ids, s.ID)
	}
	fetch := func(url string) sessionList {
		t.Helper()
		status, body := h.doRequest(t, "GET", url, token, nil)
		if status != http.StatusOK {
			t.Fatalf("page fetch %s: %d %s", url, status, body)
		}
		var page sessionList
		mustDecode(t, body, &page)
		return page
	}
	first := fetch("/creation/sessions?limit=3")
	if len(first.Sessions) != 3 || first.NextCursor == nil {
		t.Fatalf("first page shape: %+v cursor=%v", first.Sessions, first.NextCursor)
	}
	second := fetch("/creation/sessions?limit=3&cursor=" + *first.NextCursor)
	third := fetch("/creation/sessions?limit=3&cursor=" + *second.NextCursor)
	total := append(append(first.Sessions, second.Sessions...), third.Sessions...)
	seen := map[string]int{}
	for _, s := range total {
		seen[s.ID]++
	}
	for _, s := range total {
		if seen[s.ID] != 1 {
			t.Fatalf("duplicate row across keyset pages: %+v", s)
		}
	}
}

func mustDecode(t *testing.T, body []byte, dst any) {
	t.Helper()
	if err := json.Unmarshal(body, dst); err != nil {
		t.Fatalf("decode json %s: %v", body, err)
	}
}
