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
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/identity"
	"github.com/nevix-ai/server/internal/identity/mailpittest"
)

// harness wires one test to the running local stack, or skips.
type harness struct {
	pool    *pgxpool.Pool
	mailpit *mailpittest.Client
	cfg     identity.Config
}

func newHarness(t *testing.T, ctx context.Context) *harness {
	t.Helper()
	databaseURL := requireEnv(t, "NEVIX_DATABASE_URL")
	mailpitURL := requireEnv(t, "NEVIX_MAILPIT_URL")
	for _, key := range []string{
		"NEVIX_SMTP_HOST", "NEVIX_SMTP_PORT", "NEVIX_SMTP_USER", "NEVIX_SMTP_PASSWORD",
		"NEVIX_VERIFICATION_CODE_HASH_KEY", "NEVIX_SMTP_FROM",
		"NEVIX_AUTH_JWKS_URL", "NEVIX_CORS_ALLOWED_ORIGINS",
	} {
		requireEnv(t, key)
	}
	// The harness assembles the Module through the same seam as the
	// composition root: LoadConfig + NewModule + Register/RunWorkers.
	cfg, err := identity.LoadConfig(func(key string) string { return os.Getenv("NEVIX_" + key) })
	if err != nil {
		t.Fatalf("load identity module config from NEVIX_-prefixed environment: %v", err)
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect to database: %v", err)
	}
	t.Cleanup(pool.Close)
	return &harness{pool: pool, mailpit: mailpittest.NewClient(mailpitURL), cfg: cfg}
}

// insertOutboxRowCommitted writes one Outbox row inside its own database
// transaction and commits — the transactional write seam.
func (h *harness) insertOutboxRowCommitted(t *testing.T, ctx context.Context, recipient string) {
	t.Helper()
	tx, err := h.pool.Begin(ctx)
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

// startWorker runs one Module's background workers for the duration of the
// test and returns a stop function that cancels them and asserts they exit
// gracefully.
func (h *harness) startWorker(t *testing.T) (stop func()) {
	t.Helper()
	m, err := identity.NewModule(h.pool, h.cfg)
	if err != nil {
		t.Fatalf("construct identity module: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- m.RunWorkers(ctx) }()
	var once sync.Once
	stop = func() {
		once.Do(func() {
			cancel()
			select {
			case err := <-done:
				if err != nil {
					t.Errorf("worker did not shut down cleanly: %v", err)
				}
			case <-time.After(10 * time.Second):
				t.Errorf("worker did not stop within 10s of context cancellation")
			}
		})
	}
	t.Cleanup(stop)
	return stop
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
	err = h.pool.QueryRow(ctx,
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
		if err := h.pool.QueryRow(ctx,
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
