// Integration tests for retry and terminal failure: with Mailpit stopped, a
// committed Outbox row is retried on the configured backoff schedule, is
// delivered after the mail path recovers, and takes its failed terminal
// state — retained in the table — once the retry budget is spent.
//
// Tests touch only the agreed seams: Mailpit availability (docker stop/start
// of the captured-mailbox container), the Mailpit HTTP API, and the Outbox
// row state. No mocked SMTP, no worker internals, no fake clocks.
//
// Opt-in like the walking skeleton: requires the harness
// (scripts/test-mail-smoke.sh) to additionally export NEVIX_OUTBOX_RETRY_DELAYS
// (a compressed schedule) and NEVIX_MAILPIT_CONTAINER.
package integrationtest

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// outboxRowState is the externally visible Outbox row state: the terminal
// status contract and the attempt count spent so far.
type outboxRowState struct {
	status   string
	attempts int
}

func (h *harness) outboxRowState(t *testing.T, ctx context.Context, recipient string) outboxRowState {
	t.Helper()
	var state outboxRowState
	err := h.pool.QueryRow(ctx,
		`SELECT status, attempts FROM identity.outbox_messages WHERE recipient = $1`, recipient,
	).Scan(&state.status, &state.attempts)
	if err != nil {
		t.Fatalf("read outbox row state: %v", err)
	}
	return state
}

// waitForRowState polls the row until the predicate holds or ctx expires.
func (h *harness) waitForRowState(t *testing.T, ctx context.Context, recipient string, ok func(outboxRowState) bool) outboxRowState {
	t.Helper()
	for {
		state := h.outboxRowState(t, ctx, recipient)
		if ok(state) {
			return state
		}
		select {
		case <-ctx.Done():
			t.Fatalf("outbox row for %s never reached expected state; last = %+v: %v", recipient, state, ctx.Err())
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// parseRetryDelays independently parses the NEVIX_OUTBOX_RETRY_DELAYS
// deployment value the worker was configured with, so schedule assertions do
// not inherit a parsing bug from the production loader.
func parseRetryDelays(t *testing.T, raw string) []time.Duration {
	t.Helper()
	parts := strings.Split(raw, ",")
	delays := make([]time.Duration, 0, len(parts))
	for _, part := range parts {
		delay, err := time.ParseDuration(strings.TrimSpace(part))
		if err != nil {
			t.Fatalf("parse NEVIX_OUTBOX_RETRY_DELAYS entry %q: %v", part, err)
		}
		delays = append(delays, delay)
	}
	return delays
}

// stopMailpit makes the captured mailbox unavailable, producing real SMTP
// failures for the worker; startMailpit restores it. Both go through the
// docker CLI — the same availability operator CI has, no test doubles.
func stopMailpit(t *testing.T, ctx context.Context, container string) {
	t.Helper()
	runDocker(t, ctx, "stop", container)
	// Return Mailpit to the stack even if the test fails midway, so later
	// tests in the same run are unaffected. docker start is idempotent here.
	t.Cleanup(func() { _ = exec.Command("docker", "start", container).Run() })
}

func startMailpit(t *testing.T, ctx context.Context, container string) {
	t.Helper()
	runDocker(t, ctx, "start", container)
}

func runDocker(t *testing.T, ctx context.Context, args ...string) {
	t.Helper()
	out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v: %s", strings.Join(args, " "), err, out)
	}
}

// waitMailpitUp polls the Mailpit HTTP API until the container serves again.
func (h *harness) waitMailpitUp(t *testing.T, ctx context.Context) {
	t.Helper()
	for {
		if _, err := h.mailpit.Search(ctx, `to:"mailpit-probe@nevix.test"`); err == nil {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("Mailpit did not come back: %v", ctx.Err())
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func TestOutboxRowDeliveredAfterMailpitRecovery(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	requireEnv(t, "NEVIX_OUTBOX_RETRY_DELAYS")
	container := requireEnv(t, "NEVIX_MAILPIT_CONTAINER")
	stop := h.startWorker(t)

	stopMailpit(t, ctx, container)

	recipient := fmt.Sprintf("retry-recovery-%d@nevix.test", time.Now().UnixNano())
	h.insertOutboxRowCommitted(t, ctx, recipient)

	// The committed row survives the SMTP outage: it stays in the table,
	// pending, while failed attempts are recorded against it.
	h.waitForRowState(t, ctx, recipient, func(s outboxRowState) bool {
		return s.status == "pending" && s.attempts >= 1
	})

	// Recover the mail path; a scheduled retry must deliver the row.
	startMailpit(t, ctx, container)
	h.waitMailpitUp(t, ctx)

	messages, err := h.mailpit.WaitForMessages(ctx, fmt.Sprintf("to:%q", recipient))
	if err != nil {
		t.Fatalf("outbox email never reached Mailpit after recovery: %v", err)
	}
	if len(messages) != 1 {
		t.Fatalf("expected exactly 1 captured email for %s, got %d", recipient, len(messages))
	}

	// Graceful shutdown before asserting terminal row state (walking-skeleton
	// pattern), then prove the delivery came through a retry.
	stop()
	state := h.outboxRowState(t, ctx, recipient)
	if state.status != "delivered" {
		t.Fatalf("outbox row status = %q, want delivered", state.status)
	}
	if state.attempts < 2 {
		t.Fatalf("outbox row attempts = %d, want >= 2 (delivered via retry)", state.attempts)
	}
}

func TestRetryExhaustionMarksRowFailedTerminally(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	delays := parseRetryDelays(t, requireEnv(t, "NEVIX_OUTBOX_RETRY_DELAYS"))
	container := requireEnv(t, "NEVIX_MAILPIT_CONTAINER")
	_ = h.startWorker(t)

	stopMailpit(t, ctx, container)

	recipient := fmt.Sprintf("retry-exhaustion-%d@nevix.test", time.Now().UnixNano())
	h.insertOutboxRowCommitted(t, ctx, recipient)

	// Watch the retry budget burn: record when each attempt count first
	// becomes visible, until the row goes terminal.
	attemptSeenAt := map[int]time.Time{}
	for {
		state := h.outboxRowState(t, ctx, recipient)
		if _, seen := attemptSeenAt[state.attempts]; !seen && state.attempts > 0 {
			attemptSeenAt[state.attempts] = time.Now()
		}
		if state.status == "failed" {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("outbox row never went terminal; last = %+v: %v", state, ctx.Err())
		case <-time.After(100 * time.Millisecond):
		}
	}

	// The retry budget is the schedule's length: one initial attempt plus one
	// retry per schedule entry.
	wantAttempts := 1 + len(delays)
	state := h.outboxRowState(t, ctx, recipient)
	if state.status != "failed" || state.attempts != wantAttempts {
		t.Fatalf("terminal row state = %+v, want status failed with %d attempts (1 initial + %d retries)",
			state, wantAttempts, len(delays))
	}
	for k := 1; k <= len(delays); k++ {
		start, okStart := attemptSeenAt[k]
		end, okEnd := attemptSeenAt[k+1]
		if !okStart || !okEnd {
			t.Fatalf("never observed attempt count %d and %d both; observed = %v", k, k+1, attemptSeenAt)
		}
		if gap := end.Sub(start); gap < delays[k-1]-300*time.Millisecond {
			t.Errorf("retry %d came %s after attempt %d, want at least %s (backoff schedule)", k, gap, k, delays[k-1])
		}
	}

	// Terminal rows are retained and never delivered, and the worker keeps
	// serving new rows afterwards.
	startMailpit(t, ctx, container)
	h.waitMailpitUp(t, ctx)
	fresh := fmt.Sprintf("retry-after-failed-%d@nevix.test", time.Now().UnixNano())
	h.insertOutboxRowCommitted(t, ctx, fresh)
	if _, err := h.mailpit.WaitForMessages(ctx, fmt.Sprintf("to:%q", fresh)); err != nil {
		t.Fatalf("worker did not deliver a fresh row after a terminal failure: %v", err)
	}
	if messages, err := h.mailpit.Search(ctx, fmt.Sprintf("to:%q", recipient)); err != nil || len(messages) != 0 {
		t.Fatalf("terminally failed row was delivered anyway: messages=%+v err=%v", messages, err)
	}
}
