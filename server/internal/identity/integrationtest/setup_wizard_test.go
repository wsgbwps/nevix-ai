// First-run setup-code wizard (issue #122, ADR-0015 2026-08-23 revision):
// an empty instance generates a one-time setup code disclosed once in the
// operations log; the holder initializes the instance as the first admin
// with a session straight into the application. Observed through the
// Module's HTTP surface against real PostgreSQL: the status probe's shape,
// the initialize contract (success, wrong code, already-initialized, rate
// limit, restart rotation, first-wins races against both itself and the
// environment bootstrap channel), and the audit row committed with the
// admin. The setup code is captured exactly the way an operator gets it —
// from the log line construction prints.
package integrationtest

import (
	"bytes"
	"context"
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

// emptyInstanceConfig is the deployment shape of an uninitialized instance:
// no bootstrap variables, so no first-admin channel runs at construction.
func emptyInstanceConfig(h *harness) identity.Config {
	return identity.Config{CORSAllowedOrigins: h.cfg.CORSAllowedOrigins}
}

// constructSetupInstance constructs and mounts a Module while capturing the
// operations log, returning the mounted handler and the disclosed setup
// codes. The log capture window is construction only — the same window an
// operator reads.
func constructSetupInstance(t *testing.T, h *harness, cfg identity.Config) (http.Handler, []string) {
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

// doSetupInitialize posts an initialize attempt and returns status and body.
func doSetupInitialize(t *testing.T, handler http.Handler, body []byte) (int, []byte) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/identity/setup/initialize", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes()
}

// setupInitializeBody builds the initialize request shape.
func setupInitializeBody(email, password, setupCode, displayName string) []byte {
	body, _ := json.Marshal(map[string]string{
		"email":        email,
		"password":     password,
		"setup_code":   setupCode,
		"display_name": displayName,
	})
	return body
}

// TestSetupCodeGeneratedAndLoggedOnceOnEmptyDatabase: construction on an
// empty instance generates the code and discloses exactly one grouped form
// in the operations log; construction against a populated instance neither
// generates nor prints anything.
func TestSetupCodeGeneratedAndLoggedOnceOnEmptyDatabase(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)

	// No bootstrap variables: the empty instance stays uninitialized, and
	// construction still arms the setup-code channel.
	h.resetUserState(t)
	handler, codes := constructSetupInstance(t, h, emptyInstanceConfig(h))
	if len(codes) != 1 {
		t.Fatalf("setup codes disclosed on empty database = %v, want exactly one", codes)
	}
	if status, raw := doSetupStatus(t, handler); status != http.StatusOK || !bytes.Contains(raw, []byte(`"initialized":false`)) {
		t.Fatalf("status after empty construction: %d %s, want 200 initialized=false", status, raw)
	}

	// A populated instance answers the other way and never prints a code.
	h.resetUserState(t)
	h.insertUser(t, "existing@nevix.test", "existing-password", "member", "active", false)
	handler, codes = constructSetupInstance(t, h, emptyInstanceConfig(h))
	if len(codes) != 0 {
		t.Fatalf("setup codes disclosed on populated database = %v, want none", codes)
	}
	if status, raw := doSetupStatus(t, handler); status != http.StatusOK || !bytes.Contains(raw, []byte(`"initialized":true`)) {
		t.Fatalf("status after populated construction: %d %s, want 200 initialized=true", status, raw)
	}
}

// TestSetupStatusReturnsOnlyTheInitializedBoolean: the probe's body carries
// the one boolean and nothing else — the contract's whole disclosure.
func TestSetupStatusReturnsOnlyTheInitializedBoolean(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	h.resetUserState(t)
	handler, _ := constructSetupInstance(t, h, emptyInstanceConfig(h))

	status, raw := doSetupStatus(t, handler)
	assertContractResponse(t, http.MethodGet, "/identity/setup/status", status, raw)
	if status != http.StatusOK {
		t.Fatalf("setup status: %d %s, want 200", status, raw)
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("setup status body is not JSON: %v (%s)", err, raw)
	}
	initialized, isBool := body["initialized"].(bool)
	if len(body) != 1 || !isBool || initialized {
		t.Fatalf("setup status body = %s, want exactly {initialized:false}", raw)
	}
}

// TestInitializeCreatesFirstAdminAndSession: the correct code, a chosen
// email and password, and an optional display name become the first admin
// with a working session and no forced password change; the audit row
// commits with the account.
func TestInitializeCreatesFirstAdminAndSession(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	h.resetUserState(t)
	handler, codes := constructSetupInstance(t, h, emptyInstanceConfig(h))
	code := codes[len(codes)-1]

	status, raw := doSetupInitialize(t, handler, setupInitializeBody("First.Admin@Nevix.Test", "self-chosen-pass-1", code, "  First Admin  "))
	assertContractResponse(t, http.MethodPost, "/identity/setup/initialize", status, raw)
	if status != http.StatusCreated {
		t.Fatalf("initialize: status %d body %s, want 201", status, raw)
	}
	var initialized loginResponse
	if err := json.Unmarshal(raw, &initialized); err != nil {
		t.Fatalf("initialize 201 body is not the login shape: %v (%s)", err, raw)
	}
	if initialized.Token == "" || initialized.ExpiresAt.IsZero() {
		t.Fatalf("initialize response lacks token/expires_at: %s", raw)
	}
	if initialized.User.Role != "admin" || initialized.User.MustChangePassword {
		t.Fatalf("initialized user = %s/mcp=%v, want admin/false (body %s)", initialized.User.Role, initialized.User.MustChangePassword, raw)
	}
	if initialized.User.Email != "first.admin@nevix.test" || initialized.User.DisplayName != "First Admin" {
		t.Fatalf("initialized email/display = %s/%s, want normalized email and trimmed name", initialized.User.Email, initialized.User.DisplayName)
	}

	// The account row is the sole, active admin with the first login
	// stamped: the account entered the application with the issued session.
	var role, accountStatus string
	var lastLoginAt *time.Time
	if err := h.fixturePool.QueryRow(context.Background(),
		`SELECT role, status, last_login_at FROM public.users WHERE id = $1`, initialized.User.ID,
	).Scan(&role, &accountStatus, &lastLoginAt); err != nil {
		t.Fatalf("read setup admin: %v", err)
	}
	if role != "admin" || accountStatus != "active" || lastLoginAt == nil {
		t.Fatalf("setup admin account = %s/%s/last_login=%v, want admin/active/stamped", role, accountStatus, lastLoginAt)
	}
	if got := h.countUsers(t); got != 1 {
		t.Fatalf("users after initialize = %d, want exactly the first admin", got)
	}
	if got := h.sessionsForUser(t, initialized.User.ID); got != 1 {
		t.Fatalf("setup admin sessions = %d, want exactly the issued one", got)
	}

	// The issued session works on its very next request, and the admin
	// reads the management surface its role unlocks.
	if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", initialized.Token); status != http.StatusOK {
		t.Fatalf("me with setup session: status %d body %s, want 200", status, body)
	}
	if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/admin/users", initialized.Token); status != http.StatusOK {
		t.Fatalf("admin users with setup session: status %d body %s, want 200", status, body)
	}

	// The audit row commits with the account: the actor is the new admin,
	// the action names the setup channel, the metadata names the email.
	actorID, _, targetID, _, metadata := h.latestAuditEntry(t, "setup_admin_created")
	if actorID != initialized.User.ID {
		t.Fatalf("setup_admin_created actor = %s, want the new admin %s", actorID, initialized.User.ID)
	}
	if targetID != nil {
		t.Fatalf("setup_admin_created target = %v, want none: the actor is the subject", *targetID)
	}
	if metadata["email"] != "first.admin@nevix.test" {
		t.Fatalf("setup_admin_created metadata email = %q, want the chosen email", metadata["email"])
	}

	// A lowercase, grouped typing of a rotated code still initializes (the
	// server canonicalizes exactly what its log disclosed: case-insensitive,
	// hyphen-stripped), and an omitted display name derives from the local part.
	h.resetUserState(t)
	handler, codes = constructSetupInstance(t, h, emptyInstanceConfig(h))
	lower := strings.ToLower(codes[len(codes)-1])
	if lower == codes[len(codes)-1] {
		t.Fatalf("test setup: generated code %q has no lowercase form", codes[len(codes)-1])
	}
	grouped := lower[:4] + "-" + lower[4:]
	status, raw = doSetupInitialize(t, handler, setupInitializeBody("second.boot@nevix.test", "another-self-pass-1", grouped, ""))
	assertContractResponse(t, http.MethodPost, "/identity/setup/initialize", status, raw)
	if status != http.StatusCreated {
		t.Fatalf("lowercase code initialize: status %d body %s, want 201", status, raw)
	}
	var second loginResponse
	json.Unmarshal(raw, &second)
	if second.User.Role != "admin" || second.User.DisplayName != "second.boot" {
		t.Fatalf("second initialize user = %s/%q, want admin/email-local display name", second.User.Role, second.User.DisplayName)
	}
}

// TestInitializeRejectsWrongCode: a code that does not match the one this
// process generated is the uniform 403 invalid_setup_code, and it feeds the
// shared per-email limiter until the lockout answers.
func TestInitializeRejectsWrongCodeAndRateLimits(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	h.resetUserState(t)
	handler, codes := constructSetupInstance(t, h, emptyInstanceConfig(h))

	for attempt := 0; attempt < 5; attempt++ {
		status, raw := doSetupInitialize(t, handler, setupInitializeBody("operator@nevix.test", "some-self-pass-1", "00000000", ""))
		assertContractResponse(t, http.MethodPost, "/identity/setup/initialize", status, raw)
		if status != http.StatusForbidden || !contains(raw, "invalid_setup_code") {
			t.Fatalf("wrong code attempt %d: status %d body %s, want 403 invalid_setup_code", attempt, status, raw)
		}
	}
	// The sixth attempt on the same email answers the lockout before the
	// code is evaluated — even with the correct code.
	status, raw := doSetupInitialize(t, handler, setupInitializeBody("operator@nevix.test", "some-self-pass-1", codes[len(codes)-1], ""))
	assertContractResponse(t, http.MethodPost, "/identity/setup/initialize", status, raw)
	if status != http.StatusTooManyRequests || !contains(raw, "setup_rate_limited") {
		t.Fatalf("locked-out initialize: status %d body %s, want 429 setup_rate_limited", status, raw)
	}
	if got := h.countUsers(t); got != 0 {
		t.Fatalf("users after rejected attempts = %d, want 0", got)
	}
	if actions := h.auditActions(t); len(actions) != 0 {
		t.Fatalf("rejected initialize wrote audit rows %v", actions)
	}

	// The lockout is per email: another email still reaches the code check.
	status, raw = doSetupInitialize(t, handler, setupInitializeBody("other.operator@nevix.test", "some-self-pass-1", "00000000", ""))
	if status != http.StatusForbidden || !contains(raw, "invalid_setup_code") {
		t.Fatalf("other email wrong code: status %d body %s, want 403 invalid_setup_code", status, raw)
	}
}

// TestInitializeAnswersConflictOnceInitialized: after either first-admin
// channel wins — the environment pair or an initialize that got there first
// — every later attempt answers 409 instance_already_initialized.
func TestInitializeAnswersConflictOnceInitialized(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)

	// The environment channel wins: construction bootstraps the first
	// admin, no setup code is disclosed, and initialize answers 409.
	h.resetUserState(t)
	handler, codes := constructSetupInstance(t, h, h.bootstrapConfig(t))
	if len(codes) != 0 {
		t.Fatalf("setup codes with bootstrap variables = %v, want none", codes)
	}
	status, raw := doSetupInitialize(t, handler, setupInitializeBody("late.operator@nevix.test", "some-self-pass-1", "ABCD2345", ""))
	assertContractResponse(t, http.MethodPost, "/identity/setup/initialize", status, raw)
	if status != http.StatusConflict || !contains(raw, "instance_already_initialized") {
		t.Fatalf("initialize after env bootstrap: status %d body %s, want 409 instance_already_initialized", status, raw)
	}

	// The setup channel wins first: a second initialize with the same
	// (still in-memory) code answers the same 409.
	h.resetUserState(t)
	handler, codes = constructSetupInstance(t, h, emptyInstanceConfig(h))
	status, raw = doSetupInitialize(t, handler, setupInitializeBody("winner@nevix.test", "self-chosen-pass-1", codes[len(codes)-1], ""))
	if status != http.StatusCreated {
		t.Fatalf("first initialize: status %d body %s, want 201", status, raw)
	}
	status, raw = doSetupInitialize(t, handler, setupInitializeBody("loser@nevix.test", "another-self-pass-1", codes[len(codes)-1], ""))
	assertContractResponse(t, http.MethodPost, "/identity/setup/initialize", status, raw)
	if status != http.StatusConflict || !contains(raw, "instance_already_initialized") {
		t.Fatalf("second initialize: status %d body %s, want 409 instance_already_initialized", status, raw)
	}
	if got := h.countUsers(t); got != 1 {
		t.Fatalf("users after the initialize pair = %d, want only the first admin", got)
	}
}

// TestRestartRotatesTheSetupCode: a later process over an empty table gets a
// fresh code and the earlier code no longer initializes anything — the
// latest log line is the only live code, and the winner stays the first
// admin.
func TestRestartRotatesTheSetupCode(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	h.resetUserState(t)

	_, firstCodes := constructSetupInstance(t, h, emptyInstanceConfig(h))
	secondHandler, secondCodes := constructSetupInstance(t, h, emptyInstanceConfig(h))
	first, second := firstCodes[len(firstCodes)-1], secondCodes[len(secondCodes)-1]
	if first == second {
		t.Fatalf("restart disclosed the same code %q, want rotation", first)
	}

	status, raw := doSetupInitialize(t, secondHandler, setupInitializeBody("restart.admin@nevix.test", "self-chosen-pass-1", first, ""))
	assertContractResponse(t, http.MethodPost, "/identity/setup/initialize", status, raw)
	if status != http.StatusForbidden || !contains(raw, "invalid_setup_code") {
		t.Fatalf("stale code after restart: status %d body %s, want 403 invalid_setup_code", status, raw)
	}

	status, raw = doSetupInitialize(t, secondHandler, setupInitializeBody("restart.admin@nevix.test", "self-chosen-pass-1", second, ""))
	assertContractResponse(t, http.MethodPost, "/identity/setup/initialize", status, raw)
	if status != http.StatusCreated {
		t.Fatalf("rotated code initialize: status %d body %s, want 201", status, raw)
	}
	if got := h.countUsers(t); got != 1 {
		t.Fatalf("users after restart rotation = %d, want exactly 1", got)
	}
}

// TestConcurrentInitializeIsFirstWins: simultaneous initialize attempts with
// the correct code serialize on the first-admin advisory lock; exactly one
// commits the admin and the others answer 409.
func TestConcurrentInitializeIsFirstWins(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	h.resetUserState(t)
	handler, codes := constructSetupInstance(t, h, emptyInstanceConfig(h))

	const attempts = 4
	results := make(chan int, attempts)
	var start sync.WaitGroup
	start.Add(1)
	for i := 0; i < attempts; i++ {
		go func(i int) {
			email := "racer-" + string(rune('a'+i)) + "@nevix.test"
			start.Wait()
			status, _ := doSetupInitialize(t, handler, setupInitializeBody(email, "self-chosen-pass-1", codes[len(codes)-1], ""))
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
			t.Fatalf("concurrent initialize answered %d, want only 201/409", status)
		}
	}
	if created != 1 || conflict != attempts-1 {
		t.Fatalf("concurrent initialize outcomes created=%d conflict=%d, want 1/%d", created, conflict, attempts-1)
	}
	if got := h.countUsers(t); got != 1 {
		t.Fatalf("users after concurrent initialize = %d, want exactly the one winner", got)
	}
	if actions := h.auditActions(t); len(actions) != 1 || actions[0] != "setup_admin_created" {
		t.Fatalf("audit actions after concurrent initialize = %v, want exactly one setup_admin_created", actions)
	}
}

// TestBootstrapAndInitializeRaceCreatesExactlyOneAdmin: the environment
// channel and the setup channel race on one empty instance; whichever wins,
// the instance ends with exactly one admin and one audit row naming the
// winning channel.
func TestBootstrapAndInitializeRaceCreatesExactlyOneAdmin(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)

	for round := 0; round < 3; round++ {
		h.resetUserState(t)
		setupHandler, codes := constructSetupInstance(t, h, emptyInstanceConfig(h))
		code := codes[len(codes)-1]

		// Environment bootstrap (module construction) races the setup
		// initialize against the same empty table.
		outcomes := make(chan int, 1)
		go func() {
			if _, err := identity.NewModule(context.Background(), h.runtimePool, h.bootstrapConfig(t)); err != nil {
				t.Errorf("bootstrap construction lost the race with an error: %v", err)
			}
			outcomes <- 0
		}()
		initializeStatus, _ := doSetupInitialize(t, setupHandler, setupInitializeBody("race-winner@nevix.test", "self-chosen-pass-1", code, ""))
		<-outcomes

		if initializeStatus != http.StatusCreated && initializeStatus != http.StatusConflict {
			t.Fatalf("round %d: initialize answered %d, want 201 or 409", round, initializeStatus)
		}
		if got := h.countUsers(t); got != 1 {
			t.Fatalf("round %d: users after the channel race = %d, want exactly one first admin", round, got)
		}
		actions := h.auditActions(t)
		if len(actions) != 1 || (actions[0] != "setup_admin_created" && actions[0] != "bootstrap_admin_created") {
			t.Fatalf("round %d: audit actions after the channel race = %v, want exactly one first-admin row", round, actions)
		}
	}
}
