// The user reads (issue #102): the team directory every active user sees,
// the admin management list, and the admin-only audit pagination — the
// visibility model of the deployment (ADR-0015) observed through the HTTP
// surface: what each audience may see, search, and page through.
package integrationtest

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// directoryUser is one directory entry as the API shapes it.
type directoryUser struct {
	ID          string `json:"id"`
	Email       string `json:"email"`
	DisplayName string `json:"display_name"`
}

type directoryResponse struct {
	Users   []directoryUser `json:"users"`
	Page    int             `json:"page"`
	PerPage int             `json:"per_page"`
	Total   int             `json:"total"`
}

// managementListUser mirrors the management list entry.
type managementListUser struct {
	ID                 string     `json:"id"`
	Email              string     `json:"email"`
	DisplayName        string     `json:"display_name"`
	Role               string     `json:"role"`
	Status             string     `json:"status"`
	MustChangePassword bool       `json:"must_change_password"`
	LastLoginAt        *time.Time `json:"last_login_at"`
}

type managementListResponse struct {
	Users   []managementListUser `json:"users"`
	Page    int                  `json:"page"`
	PerPage int                  `json:"per_page"`
	Total   int                  `json:"total"`
}

// setDisplayName points a fixture account's display name at a chosen value.
func (h *harness) setDisplayName(t *testing.T, email, name string) {
	t.Helper()
	if _, err := h.fixturePool.Exec(context.Background(),
		`UPDATE public.users SET display_name = $2 WHERE email = $1`, email, name,
	); err != nil {
		t.Fatalf("set display name for %s: %v", email, err)
	}
}

// directoryWorld seeds one admin plus three named members (one disabled) and
// logs the admin and one active member in.
func directoryWorld(t *testing.T, ctx context.Context) (h *harness, handler http.Handler, adminToken, memberToken string) {
	t.Helper()
	h = newHarness(t, ctx)
	h.resetUserState(t)
	h.insertUser(t, "admin@nevix.test", "admin-password-1", "admin", "active", false)
	h.insertUser(t, "alice@nevix.test", "alice-password-1", "member", "active", false)
	h.insertUser(t, "bob@nevix.test", "bob-password-1", "member", "active", false)
	h.insertUser(t, "ghost@nevix.test", "ghost-password-1", "member", "disabled", false)
	h.setDisplayName(t, "admin@nevix.test", "Elio Admin")
	h.setDisplayName(t, "alice@nevix.test", "Alice Alpine")
	h.setDisplayName(t, "bob@nevix.test", "Bob Basin")
	h.setDisplayName(t, "ghost@nevix.test", "Ghost Gone")
	cfg := h.cfg
	_, handler = h.moduleWithConfig(t, cfg)
	_, _, adminLogin := doLogin(t, handler, "admin@nevix.test", "admin-password-1")
	_, _, memberLogin := doLogin(t, handler, "alice@nevix.test", "alice-password-1")
	return h, handler, adminLogin.Token, memberLogin.Token
}

func TestDirectoryShowsActiveUsersToEveryActiveUser(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	_, handler, adminToken, memberToken := directoryWorld(t, ctx)

	// A member sees exactly the three active accounts (admin included) with
	// only id, email, and display name — nothing else leaks.
	status, raw := doAuthenticated(t, handler, http.MethodGet, "/identity/users", memberToken)
	assertContractResponse(t, http.MethodGet, "/identity/users", status, raw)
	if status != http.StatusOK {
		t.Fatalf("directory as member: status %d body %s", status, raw)
	}
	var directory directoryResponse
	if err := json.Unmarshal(raw, &directory); err != nil {
		t.Fatalf("decode directory: %v (%s)", err, raw)
	}
	if directory.Total != 3 || len(directory.Users) != 3 {
		t.Fatalf("directory total/len = %d/%d, want 3/3 (disabled hidden)", directory.Total, len(directory.Users))
	}
	if directory.Users[0].Email != "admin@nevix.test" || directory.Users[0].DisplayName != "Elio Admin" {
		t.Fatalf("directory order = %v, want email-ascending starting with the admin", directory.Users)
	}
	for _, fragment := range []string{`"role"`, `"status"`, `"must_change_password"`, `"last_login_at"`, "ghost"} {
		if contains(raw, fragment) {
			t.Fatalf("directory body leaks %q beyond the id/email/display_name visibility model: %s", fragment, raw)
		}
	}

	// The admin sees the same directory — the visibility rule does not fork
	// by audience here, only the admin list does.
	status, raw = doAuthenticated(t, handler, http.MethodGet, "/identity/users", adminToken)
	assertContractResponse(t, http.MethodGet, "/identity/users", status, raw)
	if status != http.StatusOK {
		t.Fatalf("directory as admin: status %d body %s", status, raw)
	}

	// Unauthenticated reads never reach the query.
	status, raw = doAuthenticated(t, handler, http.MethodGet, "/identity/users", "")
	assertContractResponse(t, http.MethodGet, "/identity/users", status, raw)
	if status != http.StatusUnauthorized {
		t.Fatalf("directory without a session: status %d body %s, want 401", status, raw)
	}
}

func TestDirectorySearchesByEmailAndDisplayName(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	_, handler, _, memberToken := directoryWorld(t, ctx)

	for name, q := range map[string]string{
		"by email local":    "alice@nevix",
		"by display name":   "Alpine",
		"case-insensitive":  "ALPINE",
		"substring in mail": "nevix.test",
	} {
		status, raw := doAuthenticated(t, handler, http.MethodGet, "/identity/users?q="+q, memberToken)
		assertContractResponse(t, http.MethodGet, "/identity/users", status, raw)
		if status != http.StatusOK {
			t.Fatalf("%s: status %d body %s", name, status, raw)
		}
		var directory directoryResponse
		json.Unmarshal(raw, &directory)
		if name == "substring in mail" {
			if directory.Total != 3 {
				t.Fatalf("%s: total = %d, want all three active users", name, directory.Total)
			}
			continue
		}
		if directory.Total != 1 || directory.Users[0].Email != "alice@nevix.test" {
			t.Fatalf("%s: result = %+v, want exactly Alice", name, directory.Users)
		}
	}

	// LIKE wildcards in the search term are literal, not patterns (the term
	// travels URL-escaped: a raw % would vanish as an invalid escape).
	status, raw := doAuthenticated(t, handler, http.MethodGet, "/identity/users?q="+url.QueryEscape("%_"), memberToken)
	assertContractResponse(t, http.MethodGet, "/identity/users", status, raw)
	if status != http.StatusOK {
		t.Fatalf("wildcard search: status %d body %s", status, raw)
	}
	var wildcards directoryResponse
	json.Unmarshal(raw, &wildcards)
	if wildcards.Total != 0 {
		t.Fatalf("wildcard-only search matched %d users; %% and _ must be literal", wildcards.Total)
	}
}

func TestDirectoryPaginates(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	_, handler, _, memberToken := directoryWorld(t, ctx)

	status, raw := doAuthenticated(t, handler, http.MethodGet, "/identity/users?per_page=2&page=1", memberToken)
	assertContractResponse(t, http.MethodGet, "/identity/users", status, raw)
	if status != http.StatusOK {
		t.Fatalf("page 1: status %d body %s", status, raw)
	}
	var page1 directoryResponse
	json.Unmarshal(raw, &page1)
	if len(page1.Users) != 2 || page1.Total != 3 || page1.Page != 1 || page1.PerPage != 2 {
		t.Fatalf("page 1 = %+v, want 2 rows of 3 at page 1 size 2", page1)
	}

	status, raw = doAuthenticated(t, handler, http.MethodGet, "/identity/users?per_page=2&page=2", memberToken)
	assertContractResponse(t, http.MethodGet, "/identity/users", status, raw)
	var page2 directoryResponse
	json.Unmarshal(raw, &page2)
	if len(page2.Users) != 1 || page2.Users[0].Email != "bob@nevix.test" {
		t.Fatalf("page 2 = %+v, want the remaining bob row", page2.Users)
	}
	if page2.Users[0].ID == page1.Users[0].ID || page2.Users[0].ID == page1.Users[1].ID {
		t.Fatal("page 2 repeats page 1 rows; pagination overlaps")
	}

	// Query-shape violations are named 400s.
	for name, query := range map[string]string{
		"page zero":     "page=0",
		"page junk":     "page=abc",
		"per_page over": "per_page=101",
		"per_page zero": "per_page=0",
		"search overly": "q=" + strings.Repeat("x", 257),
	} {
		status, raw = doAuthenticated(t, handler, http.MethodGet, "/identity/users?"+query, memberToken)
		assertContractResponse(t, http.MethodGet, "/identity/users", status, raw)
		if status != http.StatusBadRequest {
			t.Fatalf("%s: status %d body %s, want 400", name, status, raw)
		}
	}
}

func TestManagementListShowsEveryAccountToAdminsOnly(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	_, handler, adminToken, memberToken := directoryWorld(t, ctx)

	// The member is behind the RequireAdmin guard.
	status, raw := doAuthenticated(t, handler, http.MethodGet, "/identity/admin/users", memberToken)
	assertContractResponse(t, http.MethodGet, "/identity/admin/users", status, raw)
	if status != http.StatusForbidden || !contains(raw, `"forbidden"`) {
		t.Fatalf("management list as member: status %d body %s, want 403 forbidden", status, raw)
	}

	// The admin sees all four accounts — disabled included — with the full
	// governance field set.
	status, raw = doAuthenticated(t, handler, http.MethodGet, "/identity/admin/users", adminToken)
	assertContractResponse(t, http.MethodGet, "/identity/admin/users", status, raw)
	if status != http.StatusOK {
		t.Fatalf("management list as admin: status %d body %s", status, raw)
	}
	var list managementListResponse
	if err := json.Unmarshal(raw, &list); err != nil {
		t.Fatalf("decode management list: %v (%s)", err, raw)
	}
	if list.Total != 4 || len(list.Users) != 4 {
		t.Fatalf("management total/len = %d/%d, want 4/4 (disabled included)", list.Total, len(list.Users))
	}
	byEmail := map[string]managementListUser{}
	for _, u := range list.Users {
		byEmail[u.Email] = u
	}
	if u := byEmail["ghost@nevix.test"]; u.Status != "disabled" || u.DisplayName != "Ghost Gone" {
		t.Fatalf("disabled account in management list = %+v, want status/display fields", u)
	}
	if u := byEmail["admin@nevix.test"]; u.Role != "admin" || u.Status != "active" {
		t.Fatalf("admin account in management list = %+v", u)
	}
	// The logged-in accounts carry a login timestamp; the never-logged-in
	// bob exposes the null marker deletion keys on.
	if u := byEmail["admin@nevix.test"]; u.LastLoginAt == nil {
		t.Fatal("logged-in admin has null last_login_at")
	}
	if u := byEmail["bob@nevix.test"]; u.LastLoginAt != nil {
		t.Fatal("never-logged-in bob has a last_login_at; the delete rule keys on null")
	}

	// Search applies to the management list too.
	status, raw = doAuthenticated(t, handler, http.MethodGet, "/identity/admin/users?q=ghost", adminToken)
	assertContractResponse(t, http.MethodGet, "/identity/admin/users", status, raw)
	var filtered managementListResponse
	json.Unmarshal(raw, &filtered)
	if filtered.Total != 1 || filtered.Users[0].Email != "ghost@nevix.test" {
		t.Fatalf("management search result = %+v, want ghost", filtered.Users)
	}

	// The never-logged-in marker is real: after bob logs in, his row flips.
	if status, _, _ := doLogin(t, handler, "bob@nevix.test", "bob-password-1"); status != http.StatusOK {
		t.Fatalf("bob login: status %d", status)
	}
	status, raw = doAuthenticated(t, handler, http.MethodGet, "/identity/admin/users?q=bob@nevix.test", adminToken)
	assertContractResponse(t, http.MethodGet, "/identity/admin/users", status, raw)
	json.Unmarshal(raw, &filtered)
	if filtered.Total != 1 || filtered.Users[0].LastLoginAt == nil {
		t.Fatalf("bob after login = %+v, want a non-null last_login_at", filtered.Users)
	}
}

type auditEntryResponse struct {
	ID                string         `json:"id"`
	Action            string         `json:"action"`
	ActorUserID       string         `json:"actor_user_id"`
	ActorDisplayName  string         `json:"actor_display_name"`
	TargetUserID      *string        `json:"target_user_id"`
	TargetDisplayName *string        `json:"target_display_name"`
	Metadata          map[string]any `json:"metadata"`
	CreatedAt         time.Time      `json:"created_at"`
}

type auditListResponse struct {
	Entries []auditEntryResponse `json:"entries"`
	Page    int                  `json:"page"`
	PerPage int                  `json:"per_page"`
	Total   int                  `json:"total"`
}

func TestAuditListIsAdminOnlyAndNewestFirst(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken, memberToken := directoryWorld(t, ctx)

	// Generate governance history: one creation, one disable.
	status, raw := doJSON(t, handler, http.MethodPost, "/identity/users", adminToken,
		[]byte(`{"email":"new@nevix.test","initial_password":"initial-pass-1"}`))
	if status != http.StatusCreated {
		t.Fatalf("create user: status %d body %s", status, raw)
	}
	bobID := h.userIDByEmail(t, "bob@nevix.test")
	status, raw = doJSON(t, handler, http.MethodPost, "/identity/users/"+bobID+"/disable", adminToken, []byte(`{}`))
	if status != http.StatusOK {
		t.Fatalf("disable bob: status %d body %s", status, raw)
	}

	// Members never see the audit log: the RequireAdmin guard answers 403.
	status, raw = doAuthenticated(t, handler, http.MethodGet, "/identity/audit-logs", memberToken)
	assertContractResponse(t, http.MethodGet, "/identity/audit-logs", status, raw)
	if status != http.StatusForbidden || !contains(raw, `"forbidden"`) {
		t.Fatalf("audit list as member: status %d body %s, want 403 forbidden", status, raw)
	}

	// The admin reads newest-first pages with snapshots and metadata.
	status, raw = doAuthenticated(t, handler, http.MethodGet, "/identity/audit-logs?per_page=2&page=1", adminToken)
	assertContractResponse(t, http.MethodGet, "/identity/audit-logs", status, raw)
	if status != http.StatusOK {
		t.Fatalf("audit list as admin: status %d body %s", status, raw)
	}
	var page auditListResponse
	if err := json.Unmarshal(raw, &page); err != nil {
		t.Fatalf("decode audit page: %v (%s)", err, raw)
	}
	// History so far: 2 logins (setup), 1 create, 1 disable = 4 rows minimum.
	if page.Total < 4 {
		t.Fatalf("audit total = %d, want at least the four seeded events", page.Total)
	}
	if len(page.Entries) != 2 || page.PerPage != 2 || page.Page != 1 {
		t.Fatalf("audit page = %+v, want 2 rows at page 1 size 2", page)
	}
	// Newest first: the disable, then the creation.
	if page.Entries[0].Action != "user_disabled" || page.Entries[1].Action != "user_created" {
		t.Fatalf("audit order = [%s, %s], want newest-first user_disabled then user_created",
			page.Entries[0].Action, page.Entries[1].Action)
	}
	if !page.Entries[0].CreatedAt.After(page.Entries[1].CreatedAt) {
		t.Fatal("audit timestamps are not descending")
	}
	// Snapshots: the admin acted on Bob; the metadata carries the email.
	disabled := page.Entries[0]
	if disabled.ActorDisplayName != "Elio Admin" || disabled.TargetDisplayName == nil || *disabled.TargetDisplayName != "Bob Basin" {
		t.Fatalf("user_disabled snapshots = %q -> %v, want Elio Admin -> Bob Basin", disabled.ActorDisplayName, disabled.TargetDisplayName)
	}
	created := page.Entries[1]
	if created.TargetDisplayName == nil || *created.TargetDisplayName != "new" {
		t.Fatalf("user_created target snapshot = %v, want the derived display name", created.TargetDisplayName)
	}
	if created.Metadata["email"] != "new@nevix.test" {
		t.Fatalf("user_created metadata = %v, want the email", created.Metadata)
	}

	// Page 2 continues strictly backward without overlap.
	status, raw = doAuthenticated(t, handler, http.MethodGet, "/identity/audit-logs?per_page=2&page=2", adminToken)
	assertContractResponse(t, http.MethodGet, "/identity/audit-logs", status, raw)
	var page2 auditListResponse
	json.Unmarshal(raw, &page2)
	if len(page2.Entries) == 0 || page2.Entries[0].ID == page.Entries[0].ID || page2.Entries[0].ID == page.Entries[1].ID {
		t.Fatalf("audit page 2 = %+v, want fresh rows", page2.Entries)
	}
	if page2.Entries[0].CreatedAt.After(page.Entries[1].CreatedAt) {
		t.Fatal("audit pages are not strictly ordered")
	}

	// Query-shape violations are named 400s.
	status, raw = doAuthenticated(t, handler, http.MethodGet, "/identity/audit-logs?page=0", adminToken)
	assertContractResponse(t, http.MethodGet, "/identity/audit-logs", status, raw)
	if status != http.StatusBadRequest || !contains(raw, `"invalid_pagination"`) {
		t.Fatalf("audit page=0: status %d body %s, want 400 invalid_pagination", status, raw)
	}
}
