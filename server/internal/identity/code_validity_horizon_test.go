// Integration tests for the code-validity retry horizon: a code-carrying
// email is retried only while its code remains usable. Superseding the code
// terminally cancels the queued email in the issuance transaction; a code
// expiring mid-retry takes the row terminal at its horizon instead of being
// delivered; and a still-valid code retries to delivery once the mail path
// recovers. 'cancelled' (code invalidated) and 'failed' (retry budget spent)
// are the two distinguishable terminal failure states.
//
// Tests touch only the agreed seams: the external HTTP command, Mailpit
// availability (docker stop/start), the Mailpit HTTP API, table row states,
// and the transactional write seam for aging rows. No worker internals, no
// mocked SMTP, no fake clocks.
//
// Opt-in like the retry tests: requires the harness
// (scripts/test-mail-smoke.sh) to export NEVIX_OUTBOX_RETRY_DELAYS (a
// compressed schedule) and NEVIX_MAILPIT_CONTAINER.
package identity_test

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"
)

// outboxCodeRows returns every Outbox row for a recipient, oldest first, so
// a resend's old and new rows can be told apart.
func (h *harness) outboxCodeRows(t *testing.T, ctx context.Context, recipient string) []outboxRowState {
	t.Helper()
	rows, err := h.pool.Query(ctx,
		`SELECT status, attempts FROM identity.outbox_messages
		 WHERE recipient = $1 ORDER BY created_at`, recipient)
	if err != nil {
		t.Fatalf("read outbox rows: %v", err)
	}
	defer rows.Close()
	var out []outboxRowState
	for rows.Next() {
		var row outboxRowState
		if err := rows.Scan(&row.status, &row.attempts); err != nil {
			t.Fatalf("scan outbox row: %v", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate outbox rows: %v", err)
	}
	return out
}

// waitForOutboxCodeRows polls the recipient's rows until the predicate holds
// or ctx expires.
func (h *harness) waitForOutboxCodeRows(t *testing.T, ctx context.Context, recipient string, ok func([]outboxRowState) bool) []outboxRowState {
	t.Helper()
	for {
		rows := h.outboxCodeRows(t, ctx, recipient)
		if ok(rows) {
			return rows
		}
		select {
		case <-ctx.Done():
			t.Fatalf("outbox rows for %s never reached expected state; last = %+v: %v", recipient, rows, ctx.Err())
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// activeCodeHash returns the stored hash of the recipient's only active
// verification code.
func (h *harness) activeCodeHash(t *testing.T, ctx context.Context, email string) string {
	t.Helper()
	var hash string
	if err := h.pool.QueryRow(ctx,
		`SELECT code_hash FROM identity.verification_codes WHERE email = $1 AND status = 'active'`, email,
	).Scan(&hash); err != nil {
		t.Fatalf("read active code row: %v", err)
	}
	return hash
}

func TestSupersededCodeEmailStopsRetrying(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	container := requireEnv(t, "NEVIX_MAILPIT_CONTAINER")
	stop := h.startWorker(t)
	handler := h.commandRouter(t)

	stopMailpit(t, ctx, container)

	email := fmt.Sprintf("horizon-supersede-%d@nevix.test", time.Now().UnixNano())
	ip := "203.0.113.40"
	if status, body := issueCode(t, handler, ip, email); status != http.StatusAccepted {
		t.Fatalf("first issuance status = %d, want %d (body %q)", status, http.StatusAccepted, body)
	}

	// The code-carrying email is mid-retry behind the SMTP outage.
	h.waitForOutboxCodeRows(t, ctx, email, func(rows []outboxRowState) bool {
		return len(rows) == 1 && rows[0].status == "pending" && rows[0].attempts >= 1
	})

	// Age the first issuance beyond the resend cooldown through the write
	// seam, then resend: the new code supersedes the old one.
	if _, err := h.pool.Exec(ctx,
		`UPDATE identity.verification_codes
		 SET created_at = now() - make_interval(secs => 61)
		 WHERE email = $1`, email,
	); err != nil {
		t.Fatalf("age first issuance: %v", err)
	}
	if status, body := issueCode(t, handler, ip, email); status != http.StatusAccepted {
		t.Fatalf("resend status = %d, want %d (body %q)", status, http.StatusAccepted, body)
	}

	// The email carrying the old code is terminal immediately — the issuance
	// transaction cancels it, it never waits for the next retry tick.
	h.waitForOutboxCodeRows(t, ctx, email, func(rows []outboxRowState) bool {
		return len(rows) == 2 && rows[0].status == "cancelled"
	})

	// Recover the mail path: only the email carrying the current code may
	// ever arrive.
	startMailpit(t, ctx, container)
	h.waitMailpitUp(t, ctx)
	messages := waitForMessageCount(t, ctx, h.mailpit, fmt.Sprintf("to:%q", email), 1)
	detail, err := h.mailpit.Message(ctx, messages[0].ID)
	if err != nil {
		t.Fatalf("read captured message: %v", err)
	}
	if got, want := h.codeHash(extractCode(t, detail.Text)), h.activeCodeHash(t, ctx, email); got != want {
		t.Fatalf("delivered email carries a code whose hash does not match the active code row")
	}

	// Graceful shutdown before asserting terminal row states.
	stop()
	rows := h.outboxCodeRows(t, ctx, email)
	if len(rows) != 2 {
		t.Fatalf("%d outbox rows for %s, want 2", len(rows), email)
	}
	if rows[0].status != "cancelled" {
		t.Fatalf("old code email row status = %q, want cancelled", rows[0].status)
	}
	if rows[1].status != "delivered" {
		t.Fatalf("new code email row status = %q, want delivered", rows[1].status)
	}
}

func TestExpiredCodeEmailGoesTerminal(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	container := requireEnv(t, "NEVIX_MAILPIT_CONTAINER")
	stop := h.startWorker(t)
	handler := h.commandRouter(t)

	stopMailpit(t, ctx, container)

	email := fmt.Sprintf("horizon-expire-%d@nevix.test", time.Now().UnixNano())
	if status, body := issueCode(t, handler, "203.0.113.50", email); status != http.StatusAccepted {
		t.Fatalf("issuance status = %d, want %d (body %q)", status, http.StatusAccepted, body)
	}

	// The code expires while its email is mid-retry: move the expiry to just
	// ahead through the write seam, spanning one more in-horizon attempt.
	h.waitForOutboxCodeRows(t, ctx, email, func(rows []outboxRowState) bool {
		return len(rows) == 1 && rows[0].status == "pending" && rows[0].attempts >= 1
	})
	if _, err := h.pool.Exec(ctx,
		`UPDATE identity.verification_codes SET expires_at = now() + make_interval(secs => 2.5) WHERE email = $1`, email,
	); err != nil {
		t.Fatalf("shorten code validity: %v", err)
	}

	// Once no further retry can land inside the code's remaining validity, the
	// row takes its cancelled terminal state — and a terminal row never spends
	// retry budget again.
	terminal := h.waitForOutboxCodeRows(t, ctx, email, func(rows []outboxRowState) bool {
		return len(rows) == 1 && rows[0].status == "cancelled"
	})
	time.Sleep(2 * time.Second) // span several poll ticks and retry slots
	if after := h.outboxCodeRows(t, ctx, email); after[0].attempts != terminal[0].attempts {
		t.Fatalf("terminal row spent attempts %d -> %d, want frozen at %d", terminal[0].attempts, after[0].attempts, terminal[0].attempts)
	}

	// The mail never arrives, even after the mail path recovers.
	startMailpit(t, ctx, container)
	h.waitMailpitUp(t, ctx)
	time.Sleep(2 * time.Second) // span several poll ticks, so a wrongful delivery would surface
	if messages, err := h.mailpit.Search(ctx, fmt.Sprintf("to:%q", email)); err != nil || len(messages) != 0 {
		t.Fatalf("email carrying an expired code was delivered: messages=%+v err=%v", messages, err)
	}

	stop()
}

func TestValidCodeEmailDeliveredAfterRecovery(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	container := requireEnv(t, "NEVIX_MAILPIT_CONTAINER")
	stop := h.startWorker(t)
	handler := h.commandRouter(t)

	stopMailpit(t, ctx, container)

	email := fmt.Sprintf("horizon-valid-%d@nevix.test", time.Now().UnixNano())
	if status, body := issueCode(t, handler, "203.0.113.60", email); status != http.StatusAccepted {
		t.Fatalf("issuance status = %d, want %d (body %q)", status, http.StatusAccepted, body)
	}
	h.waitForOutboxCodeRows(t, ctx, email, func(rows []outboxRowState) bool {
		return len(rows) == 1 && rows[0].status == "pending" && rows[0].attempts >= 1
	})

	// The code is still valid when the mail path recovers: a scheduled retry
	// delivers the email, exactly as a codeless row would.
	startMailpit(t, ctx, container)
	h.waitMailpitUp(t, ctx)
	messages := waitForMessageCount(t, ctx, h.mailpit, fmt.Sprintf("to:%q", email), 1)
	detail, err := h.mailpit.Message(ctx, messages[0].ID)
	if err != nil {
		t.Fatalf("read captured message: %v", err)
	}
	if got, want := h.codeHash(extractCode(t, detail.Text)), h.activeCodeHash(t, ctx, email); got != want {
		t.Fatalf("delivered email carries a code whose hash does not match the active code row")
	}

	stop()
	rows := h.outboxCodeRows(t, ctx, email)
	if len(rows) != 1 || rows[0].status != "delivered" {
		t.Fatalf("outbox rows = %+v, want a single delivered row", rows)
	}
	if rows[0].attempts < 2 {
		t.Fatalf("outbox row attempts = %d, want >= 2 (delivered via retry)", rows[0].attempts)
	}
}
