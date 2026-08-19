// Integration tests for the walking skeleton: a committed Outbox row must be
// claimed by the Outbox Worker and delivered to the captured mailbox (Mailpit).
//
// Tests touch only the agreed seams: the transactional write into
// identity.outbox_messages, the Mailpit HTTP API, and the row's terminal
// status. No worker internals, no mocked SMTP.
//
// Opt-in like the GoTrue smoke: requires the harness (scripts/test-mail-smoke.sh)
// to export NEVIX_DATABASE_URL, NEVIX_MAILPIT_URL, and NEVIX_SMTP_* variables.
package integrationtest

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// insertOutboxRowCommitted writes one Outbox row inside its own database
// transaction and commits — the transactional write seam.
func (h *harness) insertOutboxRowCommitted(t *testing.T, ctx context.Context, recipient string) {
	t.Helper()
	tx, err := h.fixturePool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin transaction: %v", err)
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx,
		`INSERT INTO identity.outbox_messages (sender, recipient, subject, body)
		 VALUES ($1, $2, $3, $4)`,
		"identity@nevix.test", recipient, "Walking skeleton", "Outbox row → Worker → Mailpit")
	if err != nil {
		t.Fatalf("insert outbox row: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit outbox row: %v", err)
	}
}

func TestCommittedOutboxRowIsDeliveredToMailpit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	stop := h.startWorker(t)

	recipient := fmt.Sprintf("outbox-%d@nevix.test", time.Now().UnixNano())
	h.insertOutboxRowCommitted(t, ctx, recipient)

	messages, err := h.mailpit.WaitForMessages(ctx, fmt.Sprintf("to:%q", recipient))
	if err != nil {
		t.Fatalf("outbox email never reached Mailpit: %v", err)
	}
	if len(messages) != 1 {
		t.Fatalf("expected exactly 1 captured email for %s, got %d", recipient, len(messages))
	}
	if messages[0].Subject != "Walking skeleton" {
		t.Fatalf("captured subject %q, want %q", messages[0].Subject, "Walking skeleton")
	}

	// Graceful shutdown: cancel and wait for a clean exit before asserting the
	// terminal row state, so no delivery is left half-finished.
	stop()

	var status string
	err = h.fixturePool.QueryRow(ctx,
		`SELECT status FROM identity.outbox_messages WHERE recipient = $1`, recipient,
	).Scan(&status)
	if err != nil {
		t.Fatalf("read outbox row status: %v", err)
	}
	if status != "delivered" {
		t.Fatalf("outbox row status = %q, want %q", status, "delivered")
	}
}

func TestConcurrentPollersDoNotDuplicateDelivery(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)

	// Two competing pollers over the same table: SKIP LOCKED must ensure each
	// row is delivered exactly once.
	h.startWorker(t)
	h.startWorker(t)

	const rows = 8
	runID := time.Now().UnixNano()
	recipients := make([]string, 0, rows)
	for i := 0; i < rows; i++ {
		recipient := fmt.Sprintf("concurrent-%d-%d@nevix.test", runID, i)
		recipients = append(recipients, recipient)
		h.insertOutboxRowCommitted(t, ctx, recipient)
	}

	for _, recipient := range recipients {
		messages, err := h.mailpit.WaitForMessages(ctx, fmt.Sprintf("to:%q", recipient))
		if err != nil {
			t.Fatalf("email for %s never reached Mailpit: %v", recipient, err)
		}
		if len(messages) != 1 {
			t.Fatalf("recipient %s received %d emails, want exactly 1 (SKIP LOCKED violated)", recipient, len(messages))
		}
	}

	// All rows must reach the delivered terminal state; give the workers a
	// moment to commit the last claims after Mailpit already shows the mail.
	deadline := time.Now().Add(15 * time.Second)
	for {
		var pending int
		if err := h.fixturePool.QueryRow(ctx,
			`SELECT count(*) FROM identity.outbox_messages
			 WHERE recipient LIKE $1 AND status <> 'delivered'`,
			fmt.Sprintf("concurrent-%d-%%@nevix.test", runID),
		).Scan(&pending); err != nil {
			t.Fatalf("count undelivered rows: %v", err)
		}
		if pending == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d outbox rows never reached status delivered", pending)
		}
		time.Sleep(500 * time.Millisecond)
	}
}
