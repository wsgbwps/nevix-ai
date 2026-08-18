// Integration tests for the startup execution-identity invariant
// (identity-execution ticket 01): Module construction succeeds only when the
// runtime pool authenticates directly as identity_app, and an owner (or any
// other role) is rejected even when it is permitted to SET ROLE identity_app.
// Real PostgreSQL roles are the evidence: the harness supplies a runtime pool
// that logged in as identity_app and an owner pool that only touches fixtures,
// catalog inspection, and assertions.
//
// Opt-in like the rest of the suite: requires the harness
// (scripts/test-mail-smoke.sh) to export the NEVIX_* variables.
package integrationtest

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/identity"
)

// constructModule is the Module-construction seam under test.
func constructModule(t *testing.T, ctx context.Context, pool *pgxpool.Pool, cfg identity.Config) (*identity.Module, error) {
	t.Helper()
	return identity.NewModule(ctx, pool, cfg)
}

func TestIdentityModuleConstructionAcceptsDirectIdentityAppCredential(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)

	// newTransportHandler constructs the Module on the runtime pool through
	// the same seam as the composition root; a constructed Module must also
	// be the usable product surface — the guarded command stays reachable.
	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	status, body, _ := createOrganizationRequest(handler, "", newRLSOrgID(t), "Startup Identity Org", "")
	if status != http.StatusUnauthorized {
		t.Fatalf("guarded probe through the accepted Module: status %d body %s, want the guard's 401", status, body)
	}
}

func TestIdentityModuleConstructionRejectsOwnerCredential(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)

	// The owner credential is genuinely permitted to assume identity_app, so
	// its rejection proves the direct-login requirement rather than a
	// missing membership.
	var ownerCanAssume bool
	if err := h.pool.QueryRow(ctx,
		`SELECT pg_has_role(session_user, 'identity_app', 'MEMBER')`,
	).Scan(&ownerCanAssume); err != nil {
		t.Fatalf("read owner role membership: %v", err)
	}
	if !ownerCanAssume {
		t.Fatal("owner cannot assume identity_app; the rejection evidence is meaningless")
	}

	_, err := constructModule(t, ctx, h.pool, h.cfg)
	if !errors.Is(err, identity.ErrUnexpectedDatabaseIdentity) {
		t.Fatalf("owner credential accepted or wrong error: %v", err)
	}
	if strings.Contains(err.Error(), "://") || strings.Contains(err.Error(), "password") {
		t.Fatalf("construction error leaks connection details: %v", err)
	}
}

func TestIdentityModuleConstructionRejectsAssumedIdentityAppRole(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)

	// An owner pool that downgrades to identity_app on every connection
	// presents current_user = identity_app while session_user stays the
	// authenticated owner. Authentication identity cannot be replaced by an
	// in-transaction role switch, so construction must still fail.
	cfg, err := pgxpool.ParseConfig(requireEnv(t, "NEVIX_DATABASE_URL"))
	if err != nil {
		t.Fatalf("parse owner database url: %v", err)
	}
	cfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		_, err := conn.Exec(ctx, "SET ROLE identity_app")
		return err
	}
	assumed, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("connect owner pool with assumed role: %v", err)
	}
	t.Cleanup(assumed.Close)

	var sessionUser, currentUser string
	if err := assumed.QueryRow(ctx, "SELECT session_user, current_user").Scan(&sessionUser, &currentUser); err != nil {
		t.Fatalf("observe assumed-role pool identity: %v", err)
	}
	if sessionUser == "identity_app" || currentUser != "identity_app" {
		t.Fatalf("assumed-role pool presents session_user=%q current_user=%q, want owner session with identity_app execution", sessionUser, currentUser)
	}

	if _, err := constructModule(t, ctx, assumed, h.cfg); !errors.Is(err, identity.ErrUnexpectedDatabaseIdentity) {
		t.Fatalf("assumed-role pool accepted or wrong error: %v", err)
	}
}

func TestIdentityModuleConstructionFailsOnUnreachableDatabase(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)

	unreachable, err := pgxpool.New(ctx, "postgresql://127.0.0.1:1/postgres?sslmode=disable&connect_timeout=1")
	if err != nil {
		t.Fatalf("parse unreachable database url: %v", err)
	}
	t.Cleanup(unreachable.Close)

	_, err = constructModule(t, ctx, unreachable, h.cfg)
	if err == nil {
		t.Fatal("unreachable database produced a usable Module")
	}
	// An infrastructure failure is distinct from an identity mismatch: the
	// operator must be able to tell a broken database from a wrong
	// credential.
	if errors.Is(err, identity.ErrUnexpectedDatabaseIdentity) {
		t.Fatalf("unreachable database reported as an identity mismatch: %v", err)
	}
}

// TestIdentityAppRoleAttributes proves the runtime role contract
// independently of runtime identity: identity_app stays a plain LOGIN role
// with no administrative attributes, so the correct role name cannot conceal
// accidental privilege (grants are proven behaviorally by the RLS write
// boundary tests). Catalog inspection runs on the owner credential.
func TestIdentityAppRoleAttributes(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)

	var canLogin, super, bypassRLS, createRole, createDB, replication bool
	err := h.pool.QueryRow(ctx, `SELECT
		   rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
		 FROM pg_roles WHERE rolname = 'identity_app'`,
	).Scan(&canLogin, &super, &bypassRLS, &createRole, &createDB, &replication)
	if err != nil {
		t.Fatalf("read identity_app role attributes: %v", err)
	}
	if !canLogin {
		t.Error("identity_app must stay a LOGIN role (direct authentication is the runtime contract)")
	}
	for name, flag := range map[string]bool{
		"rolsuper": super, "rolbypassrls": bypassRLS, "rolcreaterole": createRole,
		"rolcreatedb": createDB, "rolreplication": replication,
	} {
		if flag {
			t.Errorf("identity_app must not hold administrative attribute %s", name)
		}
	}
}
