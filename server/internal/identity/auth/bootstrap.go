// First-admin bootstrap (ADR-0015): on an empty users table the deployment
// variables ADMIN_EMAIL / ADMIN_INITIAL_PASSWORD create the first admin with
// must_change_password set; a non-empty table ignores the variables with a
// warning so existing accounts are never overwritten by the environment.
// The insert serializes with the setup-code initialize channel on the
// first-admin advisory lock and re-proves emptiness inside the transaction
// (issue #122): whichever channel commits first creates the only first
// admin, and this channel's loss keeps the inert-with-warning semantics.
package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/nevix-ai/server/internal/identity/audit"
)

// errBootstrapPreempted reports that users appeared between the
// construction-time emptiness read and the write transaction — the setup-code
// channel won the first-admin race. It maps to the same warn-and-ignore
// outcome as a populated table, never an error.
var errBootstrapPreempted = errors.New("auth: bootstrap preempted by a first admin")

// Bootstrap runs once at Module construction. A partially configured pair on
// an empty table is a deployment error and fails construction; on a non-empty
// table every bootstrap variable is inert.
func (s *Service) Bootstrap(ctx context.Context, adminEmail, adminPassword string) error {
	empty, err := s.usersEmpty(ctx)
	if err != nil {
		return err
	}
	if !empty {
		if adminEmail != "" || adminPassword != "" {
			slog.Warn("identity: bootstrap variables ignored because users already exist", "admin_email", adminEmail)
		}
		return nil
	}
	if adminEmail == "" && adminPassword == "" {
		slog.Warn("identity: users table is empty and no bootstrap credentials are set; configure ADMIN_EMAIL and ADMIN_INITIAL_PASSWORD to create the first admin")
		return nil
	}
	if adminEmail == "" || adminPassword == "" {
		return errors.New("identity: bootstrap requires both ADMIN_EMAIL and ADMIN_INITIAL_PASSWORD")
	}

	email, err := NormalizeEmail(adminEmail)
	if err != nil {
		return fmt.Errorf("identity: bootstrap ADMIN_EMAIL: %w", err)
	}
	passwordHash, err := HashPassword(adminPassword)
	if err != nil {
		return fmt.Errorf("identity: bootstrap ADMIN_INITIAL_PASSWORD: %w", err)
	}
	displayName := bootstrapDisplayName(email)

	var userID string
	err = s.runner.Run(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, setupAdvisoryLockKey); err != nil {
			return fmt.Errorf("auth: serialize bootstrap: %w", err)
		}
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM public.users)`).Scan(&exists); err != nil {
			return fmt.Errorf("auth: re-check users for bootstrap: %w", err)
		}
		if exists {
			// The setup-code channel won the first-admin race while this
			// module constructed; the environment pair stays inert.
			return errBootstrapPreempted
		}
		if err := tx.QueryRow(ctx,
			`INSERT INTO public.users (email, password_hash, display_name, role, status, must_change_password)
			 VALUES ($1, $2, $3, 'admin', 'active', true)
			 RETURNING id`,
			email, passwordHash, displayName,
		).Scan(&userID); err != nil {
			return fmt.Errorf("identity: bootstrap insert admin: %w", err)
		}
		return audit.Write(ctx, tx, audit.Entry{
			Actor:    audit.Subject{UserID: userID, DisplayName: displayName},
			Action:   audit.BootstrapAdminCreated,
			Metadata: map[string]string{"email": email},
		})
	})
	if errors.Is(err, errBootstrapPreempted) {
		slog.Warn("identity: bootstrap variables ignored because users already exist", "admin_email", adminEmail)
		return nil
	}
	if err != nil {
		return err
	}
	slog.Warn("identity: bootstrap admin created from deployment variables; the initial password must be changed", "email", email)
	return nil
}

// usersEmpty reports whether the users table has no rows.
func (s *Service) usersEmpty(ctx context.Context) (bool, error) {
	var exists bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM public.users)`).Scan(&exists); err != nil {
		return false, fmt.Errorf("identity: bootstrap read users: %w", err)
	}
	return !exists, nil
}

// bootstrapDisplayName derives the initial display name from the email local
// part; the user renames it later at will.
func bootstrapDisplayName(email string) string {
	local, _, _ := strings.Cut(email, "@")
	return local
}
