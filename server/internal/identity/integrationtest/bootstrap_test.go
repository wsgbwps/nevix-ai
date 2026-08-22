// Bootstrap behavior (ADR-0015): the ADMIN_EMAIL / ADMIN_INITIAL_PASSWORD
// pair creates the first admin only on an empty users table, is ignored with
// a warning once any user exists, and never overwrites existing accounts.
package integrationtest

import (
	"context"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/identity"
	"golang.org/x/crypto/bcrypt"
)

const (
	bootstrapEmail    = "bootstrap.admin@nevix.test"
	bootstrapPassword = "initial-password-123"
)

// bootstrapConfig mirrors the harness deployment variables for a clean
// bootstrap run.
func (h *harness) bootstrapConfig(t *testing.T) identity.Config {
	return identity.Config{
		AdminEmail:           bootstrapEmail,
		AdminInitialPassword: bootstrapPassword,
		CORSAllowedOrigins:   h.cfg.CORSAllowedOrigins,
	}
}

func TestBootstrapCreatesFirstAdminOnEmptyDatabase(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	h.resetUserState(t)

	// Uppercase email must be canonicalized to the stored login identifier.
	cfg := h.bootstrapConfig(t)
	cfg.AdminEmail = "Bootstrap.Admin@Nevix.Test"
	if _, err := identity.NewModule(ctx, h.runtimePool, cfg); err != nil {
		t.Fatalf("construct module on empty database: %v", err)
	}

	if got := h.countUsers(t); got != 1 {
		t.Fatalf("users after bootstrap = %d, want exactly 1", got)
	}
	var passwordHash, displayName, role, status string
	var mustChange bool
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT password_hash, display_name, role, status, must_change_password
		 FROM public.users WHERE email = $1`, bootstrapEmail,
	).Scan(&passwordHash, &displayName, &role, &status, &mustChange); err != nil {
		t.Fatalf("read bootstrapped admin: %v", err)
	}
	if bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(bootstrapPassword)) != nil {
		t.Fatal("bootstrapped admin hash does not verify against ADMIN_INITIAL_PASSWORD")
	}
	if displayName == "" {
		t.Fatal("bootstrapped admin has an empty display name")
	}
	if role != "admin" || status != "active" {
		t.Fatalf("bootstrapped admin role=%q status=%q, want admin/active", role, status)
	}
	if !mustChange {
		t.Fatal("bootstrapped admin must carry must_change_password so the initial credential is forced to rotate")
	}
	if actions := h.auditActions(t); len(actions) != 1 || actions[0] != "bootstrap_admin_created" {
		t.Fatalf("audit actions after bootstrap = %v, want exactly bootstrap_admin_created", actions)
	}
}

func TestBootstrapIgnoresVariablesWhenUsersExist(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	h.resetUserState(t)
	h.insertUser(t, "existing@nevix.test", "existing-password", "member", "active", false)

	cfg := h.bootstrapConfig(t)
	cfg.AdminEmail = "env2@nevix.test"
	if _, err := identity.NewModule(ctx, h.runtimePool, cfg); err != nil {
		t.Fatalf("construct module on non-empty database: %v", err)
	}

	if got := h.countUsers(t); got != 1 {
		t.Fatalf("users after ignored bootstrap = %d, want the single pre-existing user", got)
	}
	var count int
	if err := h.fixturePool.QueryRow(ctx, `SELECT count(*) FROM public.users WHERE email = $1`, "env2@nevix.test").Scan(&count); err != nil {
		t.Fatalf("count would-be bootstrap admin: %v", err)
	}
	if count != 0 {
		t.Fatal("bootstrap variables overwrote or extended a populated deployment")
	}
	if actions := h.auditActions(t); len(actions) != 0 {
		t.Fatalf("ignored bootstrap wrote audit rows %v", actions)
	}
}

func TestEmptyDatabaseWithoutBootstrapVariablesConstructsWithNoUsers(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	h.resetUserState(t)

	cfg := h.bootstrapConfig(t)
	cfg.AdminEmail = ""
	cfg.AdminInitialPassword = ""
	if _, err := identity.NewModule(ctx, h.runtimePool, cfg); err != nil {
		t.Fatalf("construct module without bootstrap variables: %v", err)
	}
	if got := h.countUsers(t); got != 0 {
		t.Fatalf("users without bootstrap variables = %d, want 0", got)
	}
}

func TestBootstrapRejectsInvalidPairOnEmptyDatabase(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)

	cases := []struct {
		name     string
		email    string
		password string
	}{
		{"short password", bootstrapEmail, "short"},
		{"malformed email", "not-an-email", bootstrapPassword},
		{"email without password", bootstrapEmail, ""},
		{"password without email", "", bootstrapPassword},
	}
	for _, tc := range cases {
		h.resetUserState(t)
		cfg := h.bootstrapConfig(t)
		cfg.AdminEmail = tc.email
		cfg.AdminInitialPassword = tc.password
		if _, err := identity.NewModule(ctx, h.runtimePool, cfg); err == nil {
			t.Fatalf("%s: construction succeeded, want failure", tc.name)
		}
		if got := h.countUsers(t); got != 0 {
			t.Fatalf("%s: users = %d, want 0 (a rejected bootstrap writes nothing)", tc.name, got)
		}
		if actions := h.auditActions(t); len(actions) != 0 {
			t.Fatalf("%s: rejected bootstrap wrote audit rows %v", tc.name, actions)
		}
	}
}
