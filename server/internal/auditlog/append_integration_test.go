// Real-PostgreSQL evidence for the shared Audit Append seam's transactional
// contract, opt-in through the harness in harness_test.go. Vocabulary
// validation beyond the SQL layer and the Identity Module's audit contract
// are covered by the identity integration suite.
package auditlog

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// A successful caller transaction commits the business fact and the audit row
// together: while the transaction is in flight another connection sees
// neither, and after the commit both are visible. SnapshotSubject must read
// the write-time display name from inside the same transaction.
func TestAppendCommitsWithTheCallerBusinessWrite(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	h := newAppendHarness(t)

	if err := func() error {
		tx, err := h.runtime.Begin(ctx)
		if err != nil {
			return fmt.Errorf("begin caller transaction: %w", err)
		}
		defer tx.Rollback(ctx)
		userID, err := seedUser(ctx, tx, 1)
		if err != nil {
			return err
		}
		actor, err := SnapshotSubject(ctx, tx, userID)
		if err != nil {
			return err
		}
		if actor.DisplayName != "Append Subject 1" {
			return fmt.Errorf("snapshot read display name %q, want the write-time name", actor.DisplayName)
		}
		if err := Append(ctx, tx, Entry{Actor: actor, Action: UserCreated, Metadata: map[string]string{"email": "append-1@example.test"}}); err != nil {
			return err
		}
		// Neither the business fact nor the audit row is visible outside the
		// open transaction: there is no committed split state.
		if got := h.userCount(t, ctx); got != 0 {
			return fmt.Errorf("in-flight transaction exposed %d users, want 0", got)
		}
		if got := h.auditRowCount(t, ctx); got != 0 {
			return fmt.Errorf("in-flight transaction exposed %d audit rows, want 0", got)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit caller transaction: %w", err)
		}
		return nil
	}(); err != nil {
		t.Fatal(err)
	}
	if got := h.userCount(t, ctx); got != 1 {
		t.Fatalf("committed transaction left %d users, want 1", got)
	}
	if got := h.auditRowCount(t, ctx); got != 1 {
		t.Fatalf("committed transaction left %d audit rows, want 1", got)
	}
	var action, actorName string
	var metadata map[string]any
	if err := h.owner.QueryRow(ctx,
		`SELECT action, actor_display_name, metadata FROM public.audit_logs`,
	).Scan(&action, &actorName, &metadata); err != nil {
		t.Fatalf("read appended row: %v", err)
	}
	if action != string(UserCreated) || actorName != "Append Subject 1" || metadata["email"] != "append-1@example.test" {
		t.Fatalf("appended row action=%q actor=%q metadata=%v, want user_created with the snapshotted actor and metadata", action, actorName, metadata)
	}
}

// The append fails at the database itself (the INSERT privilege is taken
// from identity_app), and the caller's rollback leaves no business row
// behind.
func TestAppendFailureRollsBackTheCallerBusinessWrite(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	h := newAppendHarness(t)

	if _, err := h.owner.Exec(ctx, `REVOKE INSERT ON public.audit_logs FROM identity_app`); err != nil {
		t.Fatalf("revoke audit insert for the failure injection: %v", err)
	}
	t.Cleanup(func() {
		_, _ = h.owner.Exec(context.Background(), `GRANT SELECT, INSERT, DELETE ON public.audit_logs TO identity_app`)
	})

	tx, err := h.runtime.Begin(ctx)
	if err != nil {
		t.Fatalf("begin caller transaction: %v", err)
	}
	defer tx.Rollback(ctx)
	userID, err := seedUser(ctx, tx, 2)
	if err != nil {
		t.Fatalf("%v", err)
	}
	actor, err := SnapshotSubject(ctx, tx, userID)
	if err != nil {
		t.Fatalf("snapshot subject: %v", err)
	}
	if err := Append(ctx, tx, Entry{Actor: actor, Action: UserCreated}); err == nil {
		t.Fatal("append succeeded without the INSERT privilege")
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatalf("roll the failed caller transaction back: %v", err)
	}
	if got := h.userCount(t, ctx); got != 0 {
		t.Fatalf("failed append left %d users behind, want the business write rolled back", got)
	}
	if got := h.auditRowCount(t, ctx); got != 0 {
		t.Fatalf("failed append left %d audit rows, want 0", got)
	}
}

// The vocabulary refusal happens before the audit INSERT, so the caller's
// rollback leaves no partial state.
func TestAppendRejectsActionsOutsideTheVocabulary(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	h := newAppendHarness(t)

	tx, err := h.runtime.Begin(ctx)
	if err != nil {
		t.Fatalf("begin caller transaction: %v", err)
	}
	defer tx.Rollback(ctx)
	if _, err := seedUser(ctx, tx, 3); err != nil {
		t.Fatalf("%v", err)
	}
	if err := Append(ctx, tx, Entry{Action: Action("forged_action")}); err == nil {
		t.Fatal("append accepted an action outside the vocabulary")
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatalf("roll the refused caller transaction back: %v", err)
	}
	if got := h.userCount(t, ctx); got != 0 {
		t.Fatalf("refused append left %d users, want 0", got)
	}
	if got := h.auditRowCount(t, ctx); got != 0 {
		t.Fatalf("refused append left %d audit rows, want 0", got)
	}
}

// The append itself succeeds; the row still dies with the caller's aborted
// transaction.
func TestCallerRollbackDiscardsTheAppendedRow(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	h := newAppendHarness(t)

	tx, err := h.runtime.Begin(ctx)
	if err != nil {
		t.Fatalf("begin caller transaction: %v", err)
	}
	userID, err := seedUser(ctx, tx, 4)
	if err != nil {
		t.Fatalf("%v", err)
	}
	actor, err := SnapshotSubject(ctx, tx, userID)
	if err != nil {
		t.Fatalf("snapshot subject: %v", err)
	}
	if err := Append(ctx, tx, Entry{Actor: actor, Action: UserCreated}); err != nil {
		t.Fatalf("append inside the doomed transaction: %v", err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatalf("roll the caller transaction back: %v", err)
	}
	if got := h.userCount(t, ctx); got != 0 {
		t.Fatalf("rolled-back caller left %d users, want 0", got)
	}
	if got := h.auditRowCount(t, ctx); got != 0 {
		t.Fatalf("rolled-back caller left %d audit rows, want the append discarded with it", got)
	}
}

// Each concurrent appender owns its transaction; no row is lost, doubled, or
// attributed to another appender's actor snapshot.
func TestConcurrentAppendsAllLand(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	h := newAppendHarness(t)

	const appenders = 8
	errs := make(chan error, appenders)
	for i := 1; i <= appenders; i++ {
		go func(seq int) {
			errs <- func() error {
				tx, err := h.runtime.Begin(ctx)
				if err != nil {
					return fmt.Errorf("begin caller transaction: %w", err)
				}
				defer tx.Rollback(ctx)
				userID, err := seedUser(ctx, tx, seq)
				if err != nil {
					return err
				}
				actor, err := SnapshotSubject(ctx, tx, userID)
				if err != nil {
					return err
				}
				if err := Append(ctx, tx, Entry{Actor: actor, Action: SessionCreated}); err != nil {
					return err
				}
				if err := tx.Commit(ctx); err != nil {
					return fmt.Errorf("commit caller transaction: %w", err)
				}
				return nil
			}()
		}(i)
	}
	for i := 0; i < appenders; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("concurrent appender failed: %v", err)
		}
	}
	if got := h.userCount(t, ctx); got != appenders {
		t.Fatalf("concurrent appends left %d users, want %d", got, appenders)
	}
	if got := h.auditRowCount(t, ctx); got != appenders {
		t.Fatalf("concurrent appends landed %d audit rows, want %d", got, appenders)
	}
	var distinctActors int
	if err := h.owner.QueryRow(ctx,
		`SELECT count(DISTINCT actor_user_id) FROM public.audit_logs`,
	).Scan(&distinctActors); err != nil {
		t.Fatalf("count distinct actors: %v", err)
	}
	if distinctActors != appenders {
		t.Fatalf("audit rows carry %d distinct actors, want %d", distinctActors, appenders)
	}
}

// An unknown user is refused rather than inventing an empty audit actor.
func TestSnapshotSubjectRefusesUnknownUsers(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	h := newAppendHarness(t)

	tx, err := h.runtime.Begin(ctx)
	if err != nil {
		t.Fatalf("begin caller transaction: %v", err)
	}
	defer tx.Rollback(ctx)
	if _, err := SnapshotSubject(ctx, tx, "00000000-0000-0000-0000-000000000000"); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("snapshot of an unknown user returned %v, want %v", err, pgx.ErrNoRows)
	}
}
