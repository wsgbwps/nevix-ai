// The integration-suite harness: environment gating (requireEnv), the two
// database credentials with their distinct identities, and the Module /
// Outbox-Worker lifecycle. fixturePool is the owner credential: it applies
// fixtures and makes authoritative assertions, and is never handed to the
// identity Module except where a test explicitly proves such a credential is
// rejected. runtimePool authenticates directly as identity_app — the
// production runtime credential — and is the only pool Module construction
// sees.
package integrationtest

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/identity"
)

// requireEnv returns one harness-provided environment value, or skips/fails
// per the integration request flag: plain `go test ./...` skips so it stays
// green with no stack running, while NEVIX_IDENTITY_INTEGRATION_REQUESTED=1
// (set by the dedicated harness entry) makes a missing value fatal.
func requireEnv(t *testing.T, key string) string {
	t.Helper()
	value := os.Getenv(key)
	if value == "" {
		if os.Getenv("NEVIX_IDENTITY_INTEGRATION_REQUESTED") == "1" {
			t.Fatalf("identity integration was requested, but %s is not set; run ./scripts/test-identity-integration.sh from the repository root to start the supported harness", key)
		}
		t.Skipf("identity integration was not requested: %s is not set (run ./scripts/test-identity-integration.sh)", key)
	}
	return value
}

// harness wires one test to the running local stack, or skips.
type harness struct {
	fixturePool *pgxpool.Pool
	runtimePool *pgxpool.Pool
	mailpit     *mailpitClient
	mailpitURL  string
	cfg         identity.Config
}

func newHarness(t *testing.T, ctx context.Context) *harness {
	t.Helper()
	databaseURL := requireEnv(t, "NEVIX_DATABASE_URL")
	runtimeDatabaseURL := requireEnv(t, "NEVIX_IDENTITY_DATABASE_URL")
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
	fixturePool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect owner fixture database: %v", err)
	}
	t.Cleanup(fixturePool.Close)
	runtimePool, err := pgxpool.New(ctx, runtimeDatabaseURL)
	if err != nil {
		t.Fatalf("connect identity_app runtime database: %v", err)
	}
	t.Cleanup(runtimePool.Close)
	return &harness{
		fixturePool: fixturePool,
		runtimePool: runtimePool,
		mailpit:     newMailpitClient(mailpitURL),
		mailpitURL:  mailpitURL,
		cfg:         cfg,
	}
}

// startWorker runs one Module's background workers for the duration of the
// test and returns a stop function that cancels them and asserts they exit
// gracefully.
func (h *harness) startWorker(t *testing.T) (stop func()) {
	t.Helper()
	m, err := identity.NewModule(context.Background(), h.runtimePool, h.cfg)
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
