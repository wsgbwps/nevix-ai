// Integration tests for the verification code issuance command: issuing a
// code queues a code-carrying email delivered to the captured mailbox, and
// the command layer synchronously enforces the resend cooldown, the
// per-email hourly cap, and the independent per-IP hourly cap.
//
// Tests touch only the agreed seams: the external HTTP command (mounted
// exactly as the composition root mounts it), the transactional write seam
// for seeding prior issuance history, the Mailpit HTTP API, and table row
// states. No rate-limit internals, no mocked SMTP.
//
// Opt-in like the rest of the suite: requires the harness
// (scripts/test-mail-smoke.sh) to export the NEVIX_* variables.
package identity_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/nevix-ai/server/internal/identity"
	"github.com/nevix-ai/server/internal/identity/mailpittest"
	"github.com/nevix-ai/server/pkg/event"
)

var codePattern = regexp.MustCompile(`\b\d{6}\b`)

// commandRouter mounts the Module's external commands exactly as the
// composition root does, so tests assert only the HTTP contract.
func (h *harness) commandRouter(t *testing.T) http.Handler {
	t.Helper()
	router := chi.NewRouter()
	identity.NewModule(h.pool, h.codeConfig).Register(router, event.NewInMemoryBus())
	return router
}

// issueCode posts the issuance command over the Module's HTTP surface from
// the given client IP and returns the status code and raw response body.
func issueCode(t *testing.T, handler http.Handler, ip, email string) (int, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/identity/verification-codes",
		strings.NewReader(fmt.Sprintf(`{"email":%q}`, email)))
	req.RemoteAddr = ip + ":43210"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Code, rec.Body.String()
}

// codeHash recomputes the stored form of a code with the harness hash key,
// so tests can assert that only the hash — never the plaintext — is stored.
func (h *harness) codeHash(code string) string {
	mac := hmac.New(sha256.New, h.codeConfig.HashKey)
	mac.Write([]byte(code))
	return hex.EncodeToString(mac.Sum(nil))
}

// extractCode pulls the six-digit code out of a captured email body.
func extractCode(t *testing.T, body string) string {
	t.Helper()
	code := codePattern.FindString(body)
	if code == "" {
		t.Fatalf("email body carries no six-digit code: %q", body)
	}
	return code
}

// seedIssuance records a prior accepted issuance through the transactional
// write seam, backdated by ageSeconds.
func (h *harness) seedIssuance(t *testing.T, ctx context.Context, email, ip string, ageSeconds int) {
	t.Helper()
	if _, err := h.pool.Exec(ctx,
		`INSERT INTO identity.verification_codes (email, code_hash, request_ip, created_at, expires_at)
		 VALUES ($1, $2, $3, now() - make_interval(secs => $4), now())`,
		email, "seeded", ip, ageSeconds,
	); err != nil {
		t.Fatalf("seed issuance history: %v", err)
	}
}

// waitForMessageCount polls Mailpit until exactly want messages match.
func waitForMessageCount(t *testing.T, ctx context.Context, client *mailpittest.Client, query string, want int) []mailpittest.MessageSummary {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		messages, err := client.Search(ctx, query)
		if err == nil && len(messages) == want {
			return messages
		}
		if time.Now().After(deadline) {
			t.Fatalf("Mailpit shows %d messages for %q, want %d: %v", len(messages), query, want, err)
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// assertIssuedRows counts the code and Outbox rows an email accumulated.
func (h *harness) assertIssuedRows(t *testing.T, ctx context.Context, email string, wantCodes, wantOutbox int) {
	t.Helper()
	var codeRows, outboxRows int
	if err := h.pool.QueryRow(ctx,
		`SELECT count(*) FROM identity.verification_codes WHERE email = $1`, email,
	).Scan(&codeRows); err != nil {
		t.Fatalf("count code rows: %v", err)
	}
	if err := h.pool.QueryRow(ctx,
		`SELECT count(*) FROM identity.outbox_messages WHERE recipient = $1`, email,
	).Scan(&outboxRows); err != nil {
		t.Fatalf("count outbox rows: %v", err)
	}
	if codeRows != wantCodes || outboxRows != wantOutbox {
		t.Fatalf("%s accumulated %d code rows and %d outbox rows, want %d and %d", email, codeRows, outboxRows, wantCodes, wantOutbox)
	}
}

func TestIssuedCodeEmailArrivesInMailpit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	h.startWorker(t)
	handler := h.commandRouter(t)

	email := fmt.Sprintf("code-%d@nevix.test", time.Now().UnixNano())
	status, respBody := issueCode(t, handler, "203.0.113.10", email)
	if status != http.StatusAccepted {
		t.Fatalf("issuance status = %d, want %d (body %q)", status, http.StatusAccepted, respBody)
	}

	messages := waitForMessageCount(t, ctx, h.mailpit, fmt.Sprintf("to:%q", email), 1)
	detail, err := h.mailpit.Message(ctx, messages[0].ID)
	if err != nil {
		t.Fatalf("read captured message: %v", err)
	}
	code := extractCode(t, detail.Text)

	// The response acknowledges acceptance only; the plaintext code travels
	// exclusively in the email.
	if strings.Contains(respBody, code) {
		t.Fatalf("response body leaks the plaintext code: %q", respBody)
	}

	// The server stores only the HMAC hash of the code.
	var storedHash, rowStatus string
	if err := h.pool.QueryRow(ctx,
		`SELECT code_hash, status FROM identity.verification_codes WHERE email = $1`, email,
	).Scan(&storedHash, &rowStatus); err != nil {
		t.Fatalf("read verification code row: %v", err)
	}
	if storedHash != h.codeHash(code) {
		t.Fatalf("stored code_hash does not match the emailed code's HMAC")
	}
	if strings.Contains(storedHash, code) {
		t.Fatalf("stored hash contains the plaintext code: %q", storedHash)
	}
	if rowStatus != "active" {
		t.Fatalf("code row status = %q, want %q", rowStatus, "active")
	}

	// The queued email carries the configured sender.
	var sender string
	if err := h.pool.QueryRow(ctx,
		`SELECT sender FROM identity.outbox_messages WHERE recipient = $1`, email,
	).Scan(&sender); err != nil {
		t.Fatalf("read outbox row: %v", err)
	}
	if sender != h.codeConfig.From {
		t.Fatalf("outbox sender = %q, want %q", sender, h.codeConfig.From)
	}
}

func TestResendWithinCooldownIsRejected(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	h.startWorker(t)
	handler := h.commandRouter(t)

	email := fmt.Sprintf("cooldown-%d@nevix.test", time.Now().UnixNano())
	ip := "203.0.113.20"
	if status, body := issueCode(t, handler, ip, email); status != http.StatusAccepted {
		t.Fatalf("first issuance status = %d, want %d (body %q)", status, http.StatusAccepted, body)
	}
	waitForMessageCount(t, ctx, h.mailpit, fmt.Sprintf("to:%q", email), 1)

	status, body := issueCode(t, handler, ip, email)
	if status != http.StatusTooManyRequests {
		t.Fatalf("resend within cooldown status = %d, want %d (body %q)", status, http.StatusTooManyRequests, body)
	}
	if !strings.Contains(body, "cooldown_active") {
		t.Fatalf("rejection body %q does not name cooldown_active", body)
	}

	// The rejected command wrote nothing. The Outbox count is the proof that
	// no second email can ever arrive: the Worker only delivers Outbox rows.
	h.assertIssuedRows(t, ctx, email, 1, 1)
	waitForMessageCount(t, ctx, h.mailpit, fmt.Sprintf("to:%q", email), 1)
}

func TestSixthCodeRequestWithinHourIsRejected(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	handler := h.commandRouter(t)

	email := fmt.Sprintf("hourly-%d@nevix.test", time.Now().UnixNano())
	// Five prior issuances inside the window, each older than the cooldown
	// and from distinct IPs, so only the per-email hourly cap can reject.
	for i, ageSeconds := range []int{350, 280, 210, 140, 70} {
		h.seedIssuance(t, ctx, email, fmt.Sprintf("198.51.100.%d", 10+i), ageSeconds)
	}

	status, body := issueCode(t, handler, "198.51.100.99", email)
	if status != http.StatusTooManyRequests {
		t.Fatalf("sixth request status = %d, want %d (body %q)", status, http.StatusTooManyRequests, body)
	}
	if !strings.Contains(body, "email_rate_limited") {
		t.Fatalf("rejection body %q does not name email_rate_limited", body)
	}

	// The rejected command wrote nothing beyond the five seeded rows.
	h.assertIssuedRows(t, ctx, email, 5, 0)
}

func TestIPRateLimitAppliesIndependently(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	handler := h.commandRouter(t)

	runID := time.Now().UnixNano()
	ipA, ipB := "198.51.100.7", "203.0.113.9"
	// Twenty prior issuances from ipA inside the window, one per distinct
	// email, so only the per-IP cap can reject a new request from ipA.
	for i := 0; i < 20; i++ {
		h.seedIssuance(t, ctx, fmt.Sprintf("ip-seeded-%d-%d@nevix.test", runID, i), ipA, 120+i)
	}

	email := fmt.Sprintf("ip-limit-%d@nevix.test", runID)
	status, body := issueCode(t, handler, ipA, email)
	if status != http.StatusTooManyRequests {
		t.Fatalf("request from saturated IP status = %d, want %d (body %q)", status, http.StatusTooManyRequests, body)
	}
	if !strings.Contains(body, "ip_rate_limited") {
		t.Fatalf("rejection body %q does not name ip_rate_limited", body)
	}

	// The IP pool is independent: another network issues for the same email.
	status, body = issueCode(t, handler, ipB, email)
	if status != http.StatusAccepted {
		t.Fatalf("request from fresh IP status = %d, want %d (body %q)", status, http.StatusAccepted, body)
	}
	var storedIP string
	if err := h.pool.QueryRow(ctx,
		`SELECT request_ip FROM identity.verification_codes WHERE email = $1`, email,
	).Scan(&storedIP); err != nil {
		t.Fatalf("read code row: %v", err)
	}
	if storedIP != ipB {
		t.Fatalf("accepted issuance recorded request_ip %q, want %q", storedIP, ipB)
	}
}

func TestResendSupersedesPreviousCode(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	h.startWorker(t)
	handler := h.commandRouter(t)

	email := fmt.Sprintf("supersede-%d@nevix.test", time.Now().UnixNano())
	ip := "203.0.113.30"
	if status, body := issueCode(t, handler, ip, email); status != http.StatusAccepted {
		t.Fatalf("first issuance status = %d, want %d (body %q)", status, http.StatusAccepted, body)
	}
	first := waitForMessageCount(t, ctx, h.mailpit, fmt.Sprintf("to:%q", email), 1)
	firstDetail, err := h.mailpit.Message(ctx, first[0].ID)
	if err != nil {
		t.Fatalf("read first captured message: %v", err)
	}
	oldCode := extractCode(t, firstDetail.Text)

	// Move the first issuance beyond the cooldown through the write seam.
	if _, err := h.pool.Exec(ctx,
		`UPDATE identity.verification_codes
		 SET created_at = now() - make_interval(secs => 61)
		 WHERE email = $1`, email,
	); err != nil {
		t.Fatalf("age first issuance: %v", err)
	}

	if status, body := issueCode(t, handler, ip, email); status != http.StatusAccepted {
		t.Fatalf("resend after cooldown status = %d, want %d (body %q)", status, http.StatusAccepted, body)
	}
	messages := waitForMessageCount(t, ctx, h.mailpit, fmt.Sprintf("to:%q", email), 2)
	var newCode string
	for _, summary := range messages {
		if summary.ID == first[0].ID {
			continue
		}
		detail, err := h.mailpit.Message(ctx, summary.ID)
		if err != nil {
			t.Fatalf("read second captured message: %v", err)
		}
		newCode = extractCode(t, detail.Text)
	}
	if newCode == "" {
		t.Fatalf("second email never arrived for %s", email)
	}

	// The old code is immediately superseded; the only active code is the
	// one in the newest email.
	rows, err := h.pool.Query(ctx,
		`SELECT code_hash, status, superseded_at IS NOT NULL
		 FROM identity.verification_codes WHERE email = $1 ORDER BY created_at`, email)
	if err != nil {
		t.Fatalf("read code rows: %v", err)
	}
	defer rows.Close()
	type codeRow struct {
		hash       string
		status     string
		superseded bool
	}
	var codes []codeRow
	for rows.Next() {
		var row codeRow
		if err := rows.Scan(&row.hash, &row.status, &row.superseded); err != nil {
			t.Fatalf("scan code row: %v", err)
		}
		codes = append(codes, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate code rows: %v", err)
	}
	if len(codes) != 2 {
		t.Fatalf("%d code rows for %s, want 2", len(codes), email)
	}
	oldRow, newRow := codes[0], codes[1]
	if oldRow.hash != h.codeHash(oldCode) || oldRow.status != "superseded" || !oldRow.superseded {
		t.Fatalf("old code row = %+v, want hash of the first email's code with status superseded", oldRow)
	}
	if newRow.hash != h.codeHash(newCode) || newRow.status != "active" {
		t.Fatalf("new code row = %+v, want hash of the newest email's code with status active", newRow)
	}
}
