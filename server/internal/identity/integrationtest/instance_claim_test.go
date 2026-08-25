// The Instance Claim (issue #128, ADR-0015 2026-08-24 revision): an empty
// instance is claimed by its first administrator through the public
// initialize command — open by default, or behind a one-time setup code the
// process generates and discloses once in the operations log when the
// deployment sets NEVIX_SETUP_CODE_REQUIRED=true. Observed through the
// Module's HTTP surface against real PostgreSQL: the status probe's shape in
// both modes, the claim contract (open success, protected success, missing
// and wrong code, already-initialized, rate limit, restart rotation, cleared
// code), concurrent first-wins races, and the single instance_claimed audit
// row committed with the admin. The setup code is captured exactly the way an
// operator gets it — from the log line construction prints.
package integrationtest

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"log/slog"

	"github.com/go-chi/chi/v5"
	"github.com/nevix-ai/server/internal/event"
	"github.com/nevix-ai/server/internal/identity"
)

// setupCodeLogPattern matches the log-disclosed code (setup_code=XXXX-XXXX);
// the grouped form carries no characters the pattern could misread.
var setupCodeLogPattern = regexp.MustCompile(`setup_code=([0-9A-Z]{4}-[0-9A-Z]{4})`)

// syncBuffer is a mutex-guarded log sink: slog handlers may write from any
// goroutine.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// captureSetupLog swaps the default slog for a text handler writing into a
// buffer, for the window a caller name, and restores the previous default.
func captureSetupLog() (*syncBuffer, func()) {
	sink := &syncBuffer{}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(sink, nil)))
	return sink, func() { slog.SetDefault(previous) }
}

// setupCodesIn extracts the disclosed codes, in log order.
func setupCodesIn(logs string) []string {
	matches := setupCodeLogPattern.FindAllStringSubmatch(logs, -1)
	codes := make([]string, 0, len(matches))
	for _, match := range matches {
		codes = append(codes, strings.ReplaceAll(match[1], "-", ""))
	}
	return codes
}

// openClaimConfig is the default deployment shape: no credential demanded
// for the claim, so no code exists.
func openClaimConfig(h *harness) identity.Config {
	return identity.Config{CORSAllowedOrigins: h.cfg.CORSAllowedOrigins}
}

// protectedClaimConfig arms the optional setup-code protection.
func protectedClaimConfig(h *harness) identity.Config {
	return identity.Config{CORSAllowedOrigins: h.cfg.CORSAllowedOrigins, SetupCodeRequired: true}
}

// constructClaimInstance constructs and mounts a Module while capturing the
// operations log, returning the mounted handler and the disclosed setup
// codes. The log capture window is construction only — the same window an
// operator reads.
func constructClaimInstance(t *testing.T, h *harness, cfg identity.Config) (http.Handler, []string) {
	t.Helper()
	sink, restore := captureSetupLog()
	m, err := identity.NewModule(context.Background(), h.runtimePool, cfg)
	restore()
	if err != nil {
		t.Fatalf("construct identity module: %v", err)
	}
	return mountedRouter(t, m), setupCodesIn(sink.String())
}

// mountedRouter mounts a constructed Module exactly as the composition root
// mounts it (a chi Group), so captured-construction tests assert the same
// transport the production process serves.
func mountedRouter(t *testing.T, m *identity.Module) http.Handler {
	t.Helper()
	router := chi.NewRouter()
	router.Group(func(r chi.Router) { m.Register(r, event.NewInMemoryBus()) })
	return router
}

// doSetupStatus probes the public status endpoint.
func doSetupStatus(t *testing.T, handler http.Handler) (int, []byte) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/identity/setup/status", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes()
}

// doSetupInitialize posts a claim attempt and returns status and body.
func doSetupInitialize(t *testing.T, handler http.Handler, body []byte) (int, []byte) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/identity/setup/initialize", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes()
}

// claimBody builds the initialize request shape; setupCode may be omitted
// entirely (open-mode claims never send one).
func claimBody(email, password, setupCode, displayName string) []byte {
	payload := map[string]string{
		"email":    email,
		"password": password,
	}
	if setupCode != "" {
		payload["setup_code"] = setupCode
	}
	if displayName != "" {
		payload["display_name"] = displayName
	}
	body, _ := json.Marshal(payload)
	return body
}

// claimBodyWithCode builds the request shape with an explicit, possibly
// empty setup_code field (protected-mode shape tests).
func claimBodyWithCode(email, password, setupCode, displayName string) []byte {
	body, _ := json.Marshal(map[string]string{
		"email":        email,
		"password":     password,
		"setup_code":   setupCode,
		"display_name": displayName,
	})
	return body
}

// TestOpenClaimStatusAndSilentConstruction: the default deployment generates
// and logs no code, the status probe answers the two booleans an empty open
// instance has, and a populated instance answers initialized.
func TestOpenClaimStatusAndSilentConstruction(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)

	h.resetUserState(t)
	handler, codes := constructClaimInstance(t, h, openClaimConfig(h))
	if len(codes) != 0 {
		t.Fatalf("setup codes disclosed on open empty instance = %v, want none", codes)
	}
	status, raw := doSetupStatus(t, handler)
	assertContractResponse(t, http.MethodGet, "/identity/setup/status", status, raw)
	if status != http.StatusOK || !bytes.Contains(raw, []byte(`"initialized":false`)) || !bytes.Contains(raw, []byte(`"setup_code_required":false`)) {
		t.Fatalf("open empty status: %d %s, want 200 initialized=false setup_code_required=false", status, raw)
	}

	h.resetUserState(t)
	h.insertUser(t, "existing@nevix.test", "existing-password", "member", "active", false)
	handler, codes = constructClaimInstance(t, h, openClaimConfig(h))
	if len(codes) != 0 {
		t.Fatalf("setup codes disclosed on populated instance = %v, want none", codes)
	}
	status, raw = doSetupStatus(t, handler)
	if status != http.StatusOK || !bytes.Contains(raw, []byte(`"initialized":true`)) || !bytes.Contains(raw, []byte(`"setup_code_required":false`)) {
		t.Fatalf("populated open status: %d %s, want 200 initialized=true setup_code_required=false", status, raw)
	}
}

// TestProtectedClaimStatusAndCodeDisclosure: with the protection armed, an
// empty instance discloses exactly one code in the operations log and the
// probe demands it; a populated instance generates nothing and the flag
// answers false — the code no longer exists once any user does.
func TestProtectedClaimStatusAndCodeDisclosure(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)

	h.resetUserState(t)
	handler, codes := constructClaimInstance(t, h, protectedClaimConfig(h))
	if len(codes) != 1 {
		t.Fatalf("setup codes disclosed on protected empty instance = %v, want exactly one", codes)
	}
	status, raw := doSetupStatus(t, handler)
	assertContractResponse(t, http.MethodGet, "/identity/setup/status", status, raw)
	if status != http.StatusOK || !bytes.Contains(raw, []byte(`"initialized":false`)) || !bytes.Contains(raw, []byte(`"setup_code_required":true`)) {
		t.Fatalf("protected empty status: %d %s, want 200 initialized=false setup_code_required=true", status, raw)
	}

	h.resetUserState(t)
	h.insertUser(t, "existing@nevix.test", "existing-password", "member", "active", false)
	handler, codes = constructClaimInstance(t, h, protectedClaimConfig(h))
	if len(codes) != 0 {
		t.Fatalf("setup codes disclosed on populated protected instance = %v, want none", codes)
	}
	status, raw = doSetupStatus(t, handler)
	if status != http.StatusOK || !bytes.Contains(raw, []byte(`"initialized":true`)) || !bytes.Contains(raw, []byte(`"setup_code_required":false`)) {
		t.Fatalf("populated protected status: %d %s, want 200 initialized=true setup_code_required=false", status, raw)
	}
}

// TestSetupStatusReturnsOnlyTheTwoBooleans: the probe's body carries exactly
// initialized and setup_code_required — the contract's whole disclosure.
func TestSetupStatusReturnsOnlyTheTwoBooleans(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	h.resetUserState(t)
	handler, _ := constructClaimInstance(t, h, openClaimConfig(h))

	status, raw := doSetupStatus(t, handler)
	assertContractResponse(t, http.MethodGet, "/identity/setup/status", status, raw)
	if status != http.StatusOK {
		t.Fatalf("setup status: %d %s, want 200", status, raw)
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("setup status body is not JSON: %v (%s)", err, raw)
	}
	initialized, initializedIsBool := body["initialized"].(bool)
	codeRequired, codeRequiredIsBool := body["setup_code_required"].(bool)
	if len(body) != 2 || !initializedIsBool || !codeRequiredIsBool || initialized || codeRequired {
		t.Fatalf("setup status body = %s, want exactly {initialized:false, setup_code_required:false}", raw)
	}
}

// TestOpenClaimCreatesFirstAdminWithoutACredential: the default claim needs
// no setup code — the claimer's chosen email, password, and display name
// become the first admin with a working session, a stamped first login, and
// one instance_claimed audit row recording setup_code_required=false; a
// stray setup_code in the body is simply ignored.
func TestOpenClaimCreatesFirstAdminWithoutACredential(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	h.resetUserState(t)
	handler, _ := constructClaimInstance(t, h, openClaimConfig(h))

	status, raw := doSetupInitialize(t, handler, claimBody("First.Admin@Nevix.Test", "self-chosen-pass-1", "NOT-A-CODE", "  First Admin  "))
	assertContractResponse(t, http.MethodPost, "/identity/setup/initialize", status, raw)
	if status != http.StatusCreated {
		t.Fatalf("open claim: status %d body %s, want 201", status, raw)
	}
	var claimed loginResponse
	if err := json.Unmarshal(raw, &claimed); err != nil {
		t.Fatalf("claim 201 body is not the login shape: %v (%s)", err, raw)
	}
	if claimed.Token == "" || claimed.ExpiresAt.IsZero() {
		t.Fatalf("claim response lacks token/expires_at: %s", raw)
	}
	if claimed.User.Role != "admin" || claimed.User.MustChangePassword {
		t.Fatalf("claimed user = %s/mcp=%v, want admin/false (body %s)", claimed.User.Role, claimed.User.MustChangePassword, raw)
	}
	if claimed.User.Email != "first.admin@nevix.test" || claimed.User.DisplayName != "First Admin" {
		t.Fatalf("claimed email/display = %s/%s, want normalized email and trimmed name", claimed.User.Email, claimed.User.DisplayName)
	}

	// The account row is the sole, active admin with the first login
	// stamped: the account entered the application with the issued session.
	var role, accountStatus string
	var lastLoginAt *time.Time
	if err := h.fixturePool.QueryRow(context.Background(),
		`SELECT role, status, last_login_at FROM public.users WHERE id = $1`, claimed.User.ID,
	).Scan(&role, &accountStatus, &lastLoginAt); err != nil {
		t.Fatalf("read claiming admin: %v", err)
	}
	if role != "admin" || accountStatus != "active" || lastLoginAt == nil {
		t.Fatalf("claiming admin account = %s/%s/last_login=%v, want admin/active/stamped", role, accountStatus, lastLoginAt)
	}
	if got := h.countUsers(t); got != 1 {
		t.Fatalf("users after open claim = %d, want exactly the first admin", got)
	}
	if got := h.sessionsForUser(t, claimed.User.ID); got != 1 {
		t.Fatalf("claiming admin sessions = %d, want exactly the issued one", got)
	}

	// The issued session is stored only as its SHA-256 hash: the bearer
	// token exists once, in the response.
	digest := sha256.Sum256([]byte(claimed.Token))
	var storedHash string
	if err := h.fixturePool.QueryRow(context.Background(),
		`SELECT encode(token_hash, 'hex') FROM public.sessions WHERE user_id = $1`, claimed.User.ID,
	).Scan(&storedHash); err != nil {
		t.Fatalf("read stored claim token hash: %v", err)
	}
	if storedHash != hex.EncodeToString(digest[:]) {
		t.Fatal("stored claim session hash is not the SHA-256 of the issued token")
	}
	// The claim is one business command, so it writes exactly one audit row:
	// instance_claimed, never an additional low-level session_created.
	if actions := h.auditActions(t); len(actions) != 1 || actions[0] != "instance_claimed" {
		t.Fatalf("audit actions after claim = %v, want exactly one instance_claimed (no session_created)", actions)
	}

	// The issued session works on its very next request, and the admin
	// reads the management surface its role unlocks.
	if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", claimed.Token); status != http.StatusOK {
		t.Fatalf("me with claim session: status %d body %s, want 200", status, body)
	}
	if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/admin/users", claimed.Token); status != http.StatusOK {
		t.Fatalf("admin users with claim session: status %d body %s, want 200", status, body)
	}

	// The audit row commits with the account: the actor is the new admin,
	// the action names the claim, the metadata records the email and the
	// protection mode.
	actorID, _, targetID, _, metadata := h.latestAuditEntry(t, "instance_claimed")
	if actorID != claimed.User.ID {
		t.Fatalf("instance_claimed actor = %s, want the new admin %s", actorID, claimed.User.ID)
	}
	if targetID != nil {
		t.Fatalf("instance_claimed target = %v, want none: the actor is the subject", *targetID)
	}
	if metadata["email"] != "first.admin@nevix.test" || metadata["setup_code_required"] != "false" {
		t.Fatalf("instance_claimed metadata = %v, want email and setup_code_required=false", metadata)
	}

	// An omitted display name derives from the email local part.
	h.resetUserState(t)
	handler, _ = constructClaimInstance(t, h, openClaimConfig(h))
	status, raw = doSetupInitialize(t, handler, claimBody("second.boot@nevix.test", "another-self-pass-1", "", ""))
	assertContractResponse(t, http.MethodPost, "/identity/setup/initialize", status, raw)
	if status != http.StatusCreated {
		t.Fatalf("codeless open claim: status %d body %s, want 201", status, raw)
	}
	var second loginResponse
	json.Unmarshal(raw, &second)
	if second.User.Role != "admin" || second.User.DisplayName != "second.boot" {
		t.Fatalf("second claim user = %s/%q, want admin/email-local display name", second.User.Role, second.User.DisplayName)
	}
}

// TestProtectedClaimDemandsTheCode: with protection armed, a body without
// setup_code answers the 400 shape failure, a wrong code answers the uniform
// 403 and feeds the shared per-email limiter until the lockout, and the
// lowercase grouped typing of the correct code claims (the server
// canonicalizes exactly what its log disclosed).
func TestProtectedClaimDemandsTheCode(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	h.resetUserState(t)
	handler, codes := constructClaimInstance(t, h, protectedClaimConfig(h))
	code := codes[len(codes)-1]

	// No code at all: a shape failure for this deployment mode.
	status, raw := doSetupInitialize(t, handler, claimBody("operator@nevix.test", "some-self-pass-1", "", ""))
	assertContractResponse(t, http.MethodPost, "/identity/setup/initialize", status, raw)
	if status != http.StatusBadRequest || !contains(raw, "invalid_request") {
		t.Fatalf("missing code claim: status %d body %s, want 400 invalid_request", status, raw)
	}
	// An explicit but empty field counts as a wrong code (the uniform 403)
	// and feeds the limiter like any other failed attempt.
	status, raw = doSetupInitialize(t, handler, claimBodyWithCode("operator@nevix.test", "some-self-pass-1", "", ""))
	assertContractResponse(t, http.MethodPost, "/identity/setup/initialize", status, raw)
	if status != http.StatusForbidden || !contains(raw, "invalid_setup_code") {
		t.Fatalf("empty code claim: status %d body %s, want 403 invalid_setup_code", status, raw)
	}

	for attempt := 0; attempt < 4; attempt++ {
		status, raw := doSetupInitialize(t, handler, claimBodyWithCode("operator@nevix.test", "some-self-pass-1", "00000000", ""))
		assertContractResponse(t, http.MethodPost, "/identity/setup/initialize", status, raw)
		if status != http.StatusForbidden || !contains(raw, "invalid_setup_code") {
			t.Fatalf("wrong code attempt %d: status %d body %s, want 403 invalid_setup_code", attempt, status, raw)
		}
	}
	// The next attempt on the same email answers the lockout before the
	// code is evaluated — even with the correct code (five failures: the
	// empty one plus four wrong ones).
	status, raw = doSetupInitialize(t, handler, claimBodyWithCode("operator@nevix.test", "some-self-pass-1", code, ""))
	assertContractResponse(t, http.MethodPost, "/identity/setup/initialize", status, raw)
	if status != http.StatusTooManyRequests || !contains(raw, "setup_rate_limited") {
		t.Fatalf("locked-out claim: status %d body %s, want 429 setup_rate_limited", status, raw)
	}
	if got := h.countUsers(t); got != 0 {
		t.Fatalf("users after rejected attempts = %d, want 0", got)
	}
	if actions := h.auditActions(t); len(actions) != 0 {
		t.Fatalf("rejected claim wrote audit rows %v", actions)
	}

	// The lockout is per email: another email claims with the code as the
	// log disclosed it — lowercase and grouped still canonicalizes.
	lower := strings.ToLower(code)
	grouped := lower[:4] + "-" + lower[4:]
	status, raw = doSetupInitialize(t, handler, claimBodyWithCode("winner@nevix.test", "self-chosen-pass-1", grouped, ""))
	assertContractResponse(t, http.MethodPost, "/identity/setup/initialize", status, raw)
	if status != http.StatusCreated {
		t.Fatalf("lowercase grouped code claim: status %d body %s, want 201", status, raw)
	}
	_, _, _, _, metadata := h.latestAuditEntry(t, "instance_claimed")
	if metadata["setup_code_required"] != "true" {
		t.Fatalf("protected claim metadata = %v, want setup_code_required=true", metadata)
	}
}

// TestClaimAnswersConflictOnceInitialized: after a claim wins — open or
// protected — every later attempt answers 409 instance_already_initialized,
// and the protected code is cleared: even a manual users-table wipe cannot
// resurrect the spent code.
func TestClaimAnswersConflictOnceInitialized(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)

	// An open claim wins; a later protected-shaped attempt answers 409.
	h.resetUserState(t)
	handler, _ := constructClaimInstance(t, h, openClaimConfig(h))
	status, raw := doSetupInitialize(t, handler, claimBody("winner@nevix.test", "self-chosen-pass-1", "", ""))
	if status != http.StatusCreated {
		t.Fatalf("first open claim: status %d body %s, want 201", status, raw)
	}
	status, raw = doSetupInitialize(t, handler, claimBody("late.operator@nevix.test", "some-self-pass-1", "ABCD2345", ""))
	assertContractResponse(t, http.MethodPost, "/identity/setup/initialize", status, raw)
	if status != http.StatusConflict || !contains(raw, "instance_already_initialized") {
		t.Fatalf("claim after open claim: status %d body %s, want 409 instance_already_initialized", status, raw)
	}

	// A protected claim wins; once any user exists the deployment's demand
	// has no effect: codeless and wrong-code attempts both answer the same
	// 409, never the protected shape failure.
	h.resetUserState(t)
	handler, codes := constructClaimInstance(t, h, protectedClaimConfig(h))
	code := codes[len(codes)-1]
	status, raw = doSetupInitialize(t, handler, claimBodyWithCode("winner@nevix.test", "self-chosen-pass-1", code, ""))
	if status != http.StatusCreated {
		t.Fatalf("first protected claim: status %d body %s, want 201", status, raw)
	}
	status, raw = doSetupInitialize(t, handler, claimBody("late.operator@nevix.test", "some-self-pass-1", "", ""))
	assertContractResponse(t, http.MethodPost, "/identity/setup/initialize", status, raw)
	if status != http.StatusConflict || !contains(raw, "instance_already_initialized") {
		t.Fatalf("codeless claim after protected claim: status %d body %s, want 409 instance_already_initialized", status, raw)
	}
	status, raw = doSetupInitialize(t, handler, claimBodyWithCode("late.operator@nevix.test", "some-self-pass-1", "00000000", ""))
	assertContractResponse(t, http.MethodPost, "/identity/setup/initialize", status, raw)
	if status != http.StatusConflict || !contains(raw, "instance_already_initialized") {
		t.Fatalf("wrong-code claim after protected claim: status %d body %s, want 409 instance_already_initialized", status, raw)
	}

	// The spent code is also cleared from memory, so a manual table wipe
	// (the only way users can vanish) cannot redeem it.
	h.resetUserState(t)
	status, raw = doSetupInitialize(t, handler, claimBodyWithCode("ghost@nevix.test", "some-self-pass-1", code, ""))
	assertContractResponse(t, http.MethodPost, "/identity/setup/initialize", status, raw)
	if status != http.StatusForbidden || !contains(raw, "invalid_setup_code") {
		t.Fatalf("spent code after claim: status %d body %s, want 403 invalid_setup_code (cleared on success)", status, raw)
	}
	// Without the code the protected instance still refuses the shape.
	status, raw = doSetupInitialize(t, handler, claimBody("ghost@nevix.test", "some-self-pass-1", "", ""))
	if status != http.StatusBadRequest || !contains(raw, "invalid_request") {
		t.Fatalf("codeless protected claim after wipe: status %d body %s, want 400 invalid_request", status, raw)
	}
}

// TestClaimRollsBackAccountSessionAuditAndLastLoginTogether: a failure at
// the transaction's last participant — the audit write, broken here by a
// fixture-installed trigger — rolls the whole claim back: no admin, no
// session, no last-login stamp, no audit row. The same command succeeds
// once the sink is repaired, proving the failure rolled back rather than
// left partial state behind.
func TestClaimRollsBackAccountSessionAuditAndLastLoginTogether(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	h.resetUserState(t)
	handler, _ := constructClaimInstance(t, h, openClaimConfig(h))

	restore := h.failAuditWritesFor(t, "instance_claimed")
	status, raw := doSetupInitialize(t, handler, claimBody("rollback.admin@nevix.test", "self-chosen-pass-1", "", ""))
	assertContractResponse(t, http.MethodPost, "/identity/setup/initialize", status, raw)
	if status != http.StatusInternalServerError || !contains(raw, "internal_error") {
		t.Fatalf("claim with a broken audit sink: status %d body %s, want 500 internal_error", status, raw)
	}
	if got := h.countUsers(t); got != 0 {
		t.Fatalf("users after rolled-back claim = %d, want 0", got)
	}
	if got := countSessions(t, h); got != 0 {
		t.Fatalf("sessions after rolled-back claim = %d, want 0", got)
	}
	if actions := h.auditActions(t); len(actions) != 0 {
		t.Fatalf("audit actions after rolled-back claim = %v, want none", actions)
	}

	// Repair the audit sink: the same claim now succeeds end to end, so the
	// earlier failure rolled everything back instead of poisoning the
	// instance.
	restore()
	status, raw = doSetupInitialize(t, handler, claimBody("rollback.admin@nevix.test", "self-chosen-pass-1", "", ""))
	assertContractResponse(t, http.MethodPost, "/identity/setup/initialize", status, raw)
	if status != http.StatusCreated {
		t.Fatalf("claim after audit repair: status %d body %s, want 201", status, raw)
	}
	var claimed loginResponse
	if err := json.Unmarshal(raw, &claimed); err != nil {
		t.Fatalf("repaired claim body is not the login shape: %v (%s)", err, raw)
	}
	if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", claimed.Token); status != http.StatusOK {
		t.Fatalf("me with the repaired claim session: status %d body %s, want 200", status, body)
	}
	if actions := h.auditActions(t); len(actions) != 1 || actions[0] != "instance_claimed" {
		t.Fatalf("audit actions after repaired claim = %v, want exactly one instance_claimed", actions)
	}
}

// TestRestartRotatesTheSetupCode: a later process over an empty protected
// instance gets a fresh code and the earlier code no longer claims anything —
// the latest log line is the only live code, and the winner stays the first
// admin.
func TestRestartRotatesTheSetupCode(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	h.resetUserState(t)

	_, firstCodes := constructClaimInstance(t, h, protectedClaimConfig(h))
	secondHandler, secondCodes := constructClaimInstance(t, h, protectedClaimConfig(h))
	first, second := firstCodes[len(firstCodes)-1], secondCodes[len(secondCodes)-1]
	if first == second {
		t.Fatalf("restart disclosed the same code %q, want rotation", first)
	}

	status, raw := doSetupInitialize(t, secondHandler, claimBodyWithCode("restart.admin@nevix.test", "self-chosen-pass-1", first, ""))
	assertContractResponse(t, http.MethodPost, "/identity/setup/initialize", status, raw)
	if status != http.StatusForbidden || !contains(raw, "invalid_setup_code") {
		t.Fatalf("stale code after restart: status %d body %s, want 403 invalid_setup_code", status, raw)
	}

	status, raw = doSetupInitialize(t, secondHandler, claimBodyWithCode("restart.admin@nevix.test", "self-chosen-pass-1", second, ""))
	assertContractResponse(t, http.MethodPost, "/identity/setup/initialize", status, raw)
	if status != http.StatusCreated {
		t.Fatalf("rotated code claim: status %d body %s, want 201", status, raw)
	}
	if got := h.countUsers(t); got != 1 {
		t.Fatalf("users after restart rotation = %d, want exactly 1", got)
	}
}

// TestConcurrentClaimIsFirstWins: simultaneous claims — open or with the
// correct code — serialize on the claim advisory lock; exactly one commits
// the admin and the others answer 409.
func TestConcurrentClaimIsFirstWins(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)

	for _, mode := range []struct {
		name      string
		cfg       identity.Config
		protected bool
		code      string
	}{
		{name: "open", cfg: openClaimConfig(h)},
		{name: "protected", cfg: protectedClaimConfig(h), protected: true},
	} {
		h.resetUserState(t)
		handler, codes := constructClaimInstance(t, h, mode.cfg)
		if mode.protected {
			mode.code = codes[len(codes)-1]
		}

		const attempts = 4
		results := make(chan int, attempts)
		var start sync.WaitGroup
		start.Add(1)
		for i := 0; i < attempts; i++ {
			go func(i int) {
				email := "racer-" + string(rune('a'+i)) + "@nevix.test"
				start.Wait()
				status, _ := doSetupInitialize(t, handler, claimBodyWithCode(email, "self-chosen-pass-1", mode.code, ""))
				results <- status
			}(i)
		}
		start.Done()

		created, conflict := 0, 0
		for i := 0; i < attempts; i++ {
			switch status := <-results; status {
			case http.StatusCreated:
				created++
			case http.StatusConflict:
				conflict++
			default:
				t.Fatalf("%s concurrent claim answered %d, want only 201/409", mode.name, status)
			}
		}
		if created != 1 || conflict != attempts-1 {
			t.Fatalf("%s concurrent claim outcomes created=%d conflict=%d, want 1/%d", mode.name, created, conflict, attempts-1)
		}
		if got := h.countUsers(t); got != 1 {
			t.Fatalf("%s users after concurrent claim = %d, want exactly the one winner", mode.name, got)
		}
		if actions := h.auditActions(t); len(actions) != 1 || actions[0] != "instance_claimed" {
			t.Fatalf("%s audit actions after concurrent claim = %v, want exactly one instance_claimed", mode.name, actions)
		}
	}
}
