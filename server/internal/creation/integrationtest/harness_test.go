// Package integrationtest drives the Creation Module through its only public
// seams — LoadConfig/NewModule/Register/RunWorkers plus the mounted HTTP
// surface — against real PostgreSQL, the real Identity Module (mounted like
// the composition root does, so principals come from actual logins), and the
// production filesystem Storage adapter. Without
// NEVIX_CREATION_INTEGRATION_REQUESTED every test skips when its environment
// is missing; with it set, a missing environment is fatal and the run must
// finish with zero skips.
package integrationtest

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/creation"
	"github.com/nevix-ai/server/internal/event"
	"github.com/nevix-ai/server/internal/identity"
	"github.com/nevix-ai/server/internal/migration"
)

const requestedEnvVar = "NEVIX_CREATION_INTEGRATION_REQUESTED"

var (
	migrationOnce sync.Once
	migrationErr  error
)

// requireEnv returns one mandatory harness variable; ordinary runs skip,
// requested runs fail loudly so nothing silently half-runs.
func requireEnv(t *testing.T, key string) string {
	t.Helper()
	value, ok := os.LookupEnv(key)
	if !ok || strings.TrimSpace(value) == "" {
		if integrationRequested() {
			t.Fatalf("requested Creation integration is missing %s; run ./scripts/test-creation-integration.sh", key)
		}
		t.Skipf("skipping: %s is not set (run scripts/test-creation-integration.sh for the real harness)", key)
	}
	return value
}

func integrationRequested() bool { return os.Getenv(requestedEnvVar) == "1" }

// harness owns one isolated runtime: production migrations, a superuser pool
// for assertions and repairs, the identity_app runtime pool both Modules
// share, and an HTTP surface mounted exactly like cmd/server/main.go.
type harness struct {
	t           *testing.T
	ctx         context.Context
	ownerPool   *pgxpool.Pool // DDL credential — fixtures/assertions only (ADR-0014)
	runtimePool *pgxpool.Pool // authenticates directly as identity_app
	serverURL   string
	closeServer func()
	secretsDir  string
	kapon       *fakeKapon
	identity    *identity.Module // narrow seams injected into Creation, exposed for direct NewModule scenarios
	// Bounded client for smoke flows so an accidental server stall fails
	// fast instead of hanging the whole package past the go-test alarm.
	smokeClient *http.Client
}

// harnessOptions selects per-scenario module configuration.
type harnessOptions struct {
	// readinessPath points at a scenario's Production Readiness evidence
	// file; empty keeps the deployment default of nothing activated.
	readinessPath string
	// runWorkers starts the module's queue worker alongside the HTTP
	// surface so task-lifecycle scenarios observe real convergence.
	runWorkers bool
}

func newHarness(t *testing.T) *harness {
	return newHarnessWithOptions(t, harnessOptions{})
}

func newHarnessWithOptions(t *testing.T, opts harnessOptions) *harness {
	t.Helper()
	ctx := context.Background()

	ownerURL := requireEnv(t, "NEVIX_DATABASE_URL")
	runtimeURL := requireEnv(t, "NEVIX_IDENTITY_DATABASE_URL")
	corsOrigin := requireEnv(t, "NEVIX_CORS_ALLOWED_ORIGINS")
	storageRoot := requireEnv(t, "STORAGE_FS_ROOT")
	secretsDir := requireEnv(t, "NEVIX_CREATION_SECRETS_DIR")

	ownerPool, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect owner pool: %v", err)
	}
	t.Cleanup(ownerPool.Close)

	migrationOnce.Do(func() { _, migrationErr = migration.Apply(ctx, ownerURL) })
	if migrationErr != nil {
		t.Fatalf("apply migrations: %v", migrationErr)
	}

	runtimePool, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatalf("connect identity_app pool: %v", err)
	}
	t.Cleanup(runtimePool.Close)

	identityConfig := identity.Config{CORSAllowedOrigins: []string{corsOrigin}}
	kapon := newFakeKapon(t)
	creationConfig := creation.Config{
		StorageDriver:      "filesystem",
		StorageRoot:        storageRoot,
		SecretsDir:         secretsDir,
		KaponBaseURL:       kapon.URL(),
		CORSAllowedOrigins: []string{corsOrigin},
		ReadinessFile:      opts.readinessPath,
	}
	// The identity Module is constructed before both registrations so its
	// narrow SessionAuthenticator seam can be injected into Creation, exactly
	// like cmd/server/main.go does.
	identityModule, err := identity.NewModule(ctx, runtimePool, identityConfig)
	if err != nil {
		t.Fatalf("construct identity module: %v", err)
	}

	_, err = creation.LoadConfig(func(key string) (string, bool) {
		switch key {
		case "CORS_ALLOWED_ORIGINS":
			return corsOrigin, true
		case "STORAGE_BACKEND":
			return "filesystem", true
		case "STORAGE_FS_ROOT":
			return storageRoot, true
		case "NEVIX_CREATION_SECRETS_DIR":
			return secretsDir, true
		case "KAPON_BASE_URL":
			return kapon.URL(), true
		case "NEVIX_CREATION_READINESS_FILE":
			if opts.readinessPath != "" {
				return opts.readinessPath, true
			}
			return "", false
		default:
			return "", false
		}
	})
	if err != nil {
		t.Fatalf("harness config must pass LoadConfig: %v", err)
	}
	creationConfigDeps := creation.Deps{
		SessionAuthenticator: identityModule.SessionAuthenticator(),
		ReauthVerifier:       identityModule.ReauthProofs(),
	}

	bus := event.NewInMemoryBus()
	router := chi.NewRouter()
	router.Group(func(r chi.Router) { identityModule.Register(r, bus) })
	router.Group(func(r chi.Router) {
		creationModule, err := creation.NewModule(ctx, runtimePool, creationConfig, creationConfigDeps)
		if err != nil {
			t.Fatalf("construct creation module: %v", err)
		}
		creationModule.Register(r, bus)
		if opts.runWorkers {
			workerCtx, cancelWorker := context.WithCancel(ctx)
			workersDone := make(chan struct{})
			go func() {
				defer close(workersDone)
				_ = creationModule.RunWorkers(workerCtx)
			}()
			t.Cleanup(func() {
				cancelWorker()
				<-workersDone
			})
		}
	})

	h := &harness{t: t, ctx: ctx, ownerPool: ownerPool, runtimePool: runtimePool, secretsDir: secretsDir, kapon: kapon, identity: identityModule}
	h.startServer(router)
	t.Cleanup(h.closeServer)
	return h
}

// startServer binds the mounted modules to one httptest server, mirroring
// how production traffic reaches them through a single HTTP surface.
func (h *harness) startServer(handler http.Handler) {
	server := httptest.NewServer(handler)
	h.serverURL = server.URL
	h.closeServer = server.Close
}
