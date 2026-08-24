// The module's background maintenance: a daily sweep that deletes expired
// sessions, prunes the login limiter, and re-logs the standing reminder while
// any user still carries a pending initial password an admin issued
// (ADR-0015: the log keeps nagging until the initial credential is changed).
package auth

import (
	"context"
	"log/slog"
	"time"
)

// sweepInterval is the maintenance cadence. Once a day matches the retention
// job's urgency: expired sessions are already invalid at lookup; the sweep
// only reclaims rows.
const sweepInterval = 24 * time.Hour

// RunSweepLoop runs the maintenance sweep immediately and then once per
// interval until ctx is canceled, returning nil. Sweep failures are logged
// and retried on the next tick; they never stop the loop.
func (s *Service) RunSweepLoop(ctx context.Context) error {
	s.sweepOnce(ctx)
	ticker := time.NewTicker(sweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			s.sweepOnce(ctx)
		}
	}
}

// warnPendingInitialPasswords re-logs the reminder for unchanged initial
// passwords.
func (s *Service) warnPendingInitialPasswords(ctx context.Context) {
	var pending int
	if err := s.db.QueryRow(ctx,
		`SELECT count(*) FROM public.users WHERE must_change_password`,
	).Scan(&pending); err != nil {
		slog.Error("identity: count pending initial passwords failed", "error", err)
		return
	}
	if pending > 0 {
		slog.Warn("identity: initial password change still pending for some users; have an admin reset or the user change it", "users", pending)
	}
}
