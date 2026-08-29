// Package creation is the AI Creation Module's composition contract
// (ADR-0012): external callers use only LoadConfig, NewModule, Register, and
// RunWorkers. Its domain, application, infrastructure, and interface layers
// stay internal — aggregates, SQL, Storage adapters, and HTTP mechanics are
// implementation, never public surface.
package creation

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/creation/application"
	"github.com/nevix-ai/server/internal/creation/domain"
	"github.com/nevix-ai/server/internal/creation/infrastructure/kapon"
	"github.com/nevix-ai/server/internal/creation/infrastructure/media"
	"github.com/nevix-ai/server/internal/creation/infrastructure/postgres"
	"github.com/nevix-ai/server/internal/creation/infrastructure/readiness"
	"github.com/nevix-ai/server/internal/creation/infrastructure/secrets"
	"github.com/nevix-ai/server/internal/creation/infrastructure/storage"
	"github.com/nevix-ai/server/internal/creation/infrastructure/writetx"
	creationhttp "github.com/nevix-ai/server/internal/creation/interface/http"
	"github.com/nevix-ai/server/internal/event"
)

// ErrUnexpectedDatabaseIdentity reports that the runtime database connection
// did not prove the expected identity_app execution identity; it is never
// part of a public HTTP response.
var ErrUnexpectedDatabaseIdentity = writetx.ErrUnexpectedDatabaseIdentity

// Config is the Module's deployment configuration: which blob adapter backs
// reference materials, where the Provider Credential master key lives, the
// process-wide Kapon route, and the browser-origin whitelist shared with
// Identity.
type Config struct {
	StorageDriver      string // "filesystem" or "s3"
	StorageRoot        string // filesystem driver: absolute blob root
	S3Endpoint         string
	S3Region           string
	S3Bucket           string
	S3AccessKeyID      string
	S3SecretAccessKey  string
	S3Secure           bool
	SecretsDir         string // secrets volume root holding the master key file
	KaponBaseURL       string // reviewed fixed route; unset means the default
	CORSAllowedOrigins []string
	ReadinessFile      string // optional Production Readiness evidence document
}

// LoadConfig validates the Module's deployment variables strictly: unknown
// values fail startup rather than guess an adapter, and S3 settings are only
// required when that driver is selected. The storage variable names are the
// deployment-wide ones ADR-0013 fixes (STORAGE_BACKEND, STORAGE_FS_ROOT,
// S3_*). CORS reads the same variable Identity consumes — one deployment
// whitelist, read per Module because Modules do not share wiring code.
func LoadConfig(lookup func(string) (string, bool)) (Config, error) {
	origins, err := loadCORSAllowedOrigins(lookupValue(lookup, "CORS_ALLOWED_ORIGINS"))
	if err != nil {
		return Config{}, err
	}
	cfg := Config{CORSAllowedOrigins: origins}

	driver, _ := lookup("STORAGE_BACKEND")
	switch driver {
	case "filesystem":
		cfg.StorageDriver = driver
		root, ok := lookup("STORAGE_FS_ROOT")
		if !ok || strings.TrimSpace(root) == "" {
			return Config{}, errors.New("creation: missing required deployment variable: STORAGE_FS_ROOT")
		}
		cfg.StorageRoot = root
	case "s3":
		cfg.StorageDriver = driver
		for _, required := range []struct {
			varName string
			target  *string
		}{
			{"S3_ENDPOINT", &cfg.S3Endpoint},
			{"S3_BUCKET", &cfg.S3Bucket},
			{"S3_ACCESS_KEY_ID", &cfg.S3AccessKeyID},
			{"S3_SECRET_ACCESS_KEY", &cfg.S3SecretAccessKey},
		} {
			value, present := lookup(required.varName)
			if !present || value == "" {
				return Config{}, fmt.Errorf("creation: missing required deployment variable: %s", required.varName)
			}
			*required.target = value
		}
		cfg.S3Region = lookupValue(lookup, "S3_REGION")
		if cfg.S3Region == "" {
			cfg.S3Region = "us-east-1"
		}
		switch raw := lookupValue(lookup, "S3_SECURE"); raw {
		case "", "true":
			cfg.S3Secure = true
		case "false":
			cfg.S3Secure = false
		default:
			return Config{}, fmt.Errorf("creation: S3_SECURE must be true or false, got %q", raw)
		}
	case "":
		return Config{}, errors.New("creation: missing required deployment variable: STORAGE_BACKEND")
	default:
		return Config{}, fmt.Errorf("creation: STORAGE_BACKEND must be filesystem or s3, got %q", driver)
	}
	secretsDir, ok := lookup("NEVIX_CREATION_SECRETS_DIR")
	if !ok || strings.TrimSpace(secretsDir) == "" {
		return Config{}, errors.New("creation: missing required deployment variable: NEVIX_CREATION_SECRETS_DIR (the secrets volume holding the Provider Credential master key)")
	}
	cfg.SecretsDir = secretsDir
	// Optional: an unset variable (or a not-yet-existing file) is the valid
	// factory state where nothing is Production Ready; a present-but-invalid
	// document fails startup loudly instead.
	if readinessFile, ok := lookup("NEVIX_CREATION_READINESS_FILE"); ok && strings.TrimSpace(readinessFile) != "" {
		cfg.ReadinessFile = readinessFile
	}
	kaponBaseURL, ok := lookup("KAPON_BASE_URL")
	if ok && strings.TrimSpace(kaponBaseURL) != "" {
		if err := kapon.ValidateBaseURL(kaponBaseURL); err != nil {
			return Config{}, err
		}
		cfg.KaponBaseURL = kaponBaseURL
	} else {
		cfg.KaponBaseURL = kapon.DefaultBaseURL
	}
	return cfg, nil
}

// lookupValue collapses unset and set-to-empty to "".
func lookupValue(lookup func(string) (string, bool), key string) string {
	v, _ := lookup(key)
	return v
}

// loadCORSAllowedOrigins mirrors the Identity rule: at least one exact origin,
// wildcard forbidden, empty entries rejected.
func loadCORSAllowedOrigins(raw string) ([]string, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, errors.New("creation: missing required deployment variable: CORS_ALLOWED_ORIGINS")
	}
	origins := []string{}
	for _, entry := range strings.Split(raw, ",") {
		origin := strings.TrimSpace(entry)
		if origin == "*" {
			return nil, errors.New("creation: CORS_ALLOWED_ORIGINS must never contain a wildcard")
		}
		if origin == "" {
			return nil, fmt.Errorf("creation: CORS_ALLOWED_ORIGINS contains an empty entry: %q", raw)
		}
		origins = append(origins, origin)
	}
	return origins, nil
}

// Deps carries what the composition root injects (ADR-0016 认证注入): the
// Identity-owned session authenticator proves every caller's principal, and
// the Identity-owned proof verifier consumes the exact-action
// Reauthentication Proofs the high-risk connection commands require. Both
// are deliberately narrow — Creation never touches credential verification.
type Deps struct {
	SessionAuthenticator authz.SessionAuthenticator
	ReauthVerifier       authz.ReauthProofVerifier
}

// Module is the Creation Module's composition surface.
type Module struct {
	sessions    *creationhttp.SessionHandler
	materials   *creationhttp.MaterialHandler
	connection  *creationhttp.ProviderConnectionHandler
	manifest    *creationhttp.CapabilityManifestHandler
	tasks       *creationhttp.GenerationTaskHandler
	governance  *creationhttp.GovernanceHandler
	hub         *creationhttp.InvalidationHub
	worker      *application.TaskWorker
	guard       *authz.Guard
	corsOrigins []string
	store       domain.BlobStore
}

// NewModule constructs Creation over its own domain-local write transaction
// runner (identity_app round trip proven at construction), selects the blob
// adapter from configuration, and fails loudly on wiring gaps.
func NewModule(ctx context.Context, pool *pgxpool.Pool, cfg Config, deps Deps) (*Module, error) {
	if deps.SessionAuthenticator == nil {
		return nil, errors.New("creation: NewModule requires a SessionAuthenticator from the composition root")
	}
	if deps.ReauthVerifier == nil {
		return nil, errors.New("creation: NewModule requires a ReauthVerifier from the composition root")
	}
	tx := writetx.New(pool)
	if err := tx.VerifyStartupIdentity(ctx); err != nil {
		return nil, err
	}
	store, err := buildStore(ctx, cfg)
	if err != nil {
		return nil, err
	}
	sessionRepos := postgres.NewSessionRepository(pool)
	materialRepos := postgres.NewMaterialRepository(pool)
	connectionRepos := postgres.NewConnectionRepository(pool)
	taskRepos := postgres.NewGenerationTaskRepository(pool)
	governanceRepos := postgres.NewGovernanceRepository(pool)
	hub := creationhttp.NewInvalidationHub()
	sessionService := application.NewSessionService(sessionRepos, materialRepos, tx)
	materialService := application.NewMaterialService(materialRepos, sessionRepos, store, media.Prober{}, tx)
	connectionService := application.NewConnectionService(connectionRepos, taskRepos, connectionRepos, tx, secrets.NewVault(cfg.SecretsDir), kapon.NewModelsCheckClient(cfg.KaponBaseURL), deps.ReauthVerifier)
	// The readiness evidence is a startup-loaded deployment asset: an invalid
	// document refuses to boot rather than silently deactivating capabilities.
	evidence, err := readiness.LoadEvidenceFile(cfg.ReadinessFile)
	if err != nil {
		return nil, err
	}
	manifestService := application.NewManifestService(connectionRepos, evidence)
	taskService := application.NewTaskService(taskRepos, materialRepos, connectionRepos, governanceRepos, manifestService, tx, hub)
	governanceService := application.NewGovernanceService(governanceRepos, tx)
	// The worker shares the module's storage adapter and speaks the fixed
	// Kapon generation route; both stay behind the domain gateway seam.
	gateway := kapon.NewGenerationsClient(cfg.KaponBaseURL)
	worker := application.NewTaskWorker(taskRepos, materialRepos, connectionRepos, store, media.Prober{}, gateway, hub, tx, workerLeaseOwner())
	return &Module{
		sessions:    creationhttp.NewSessionHandler(sessionService),
		materials:   creationhttp.NewMaterialHandler(materialService),
		connection:  creationhttp.NewProviderConnectionHandler(connectionService),
		manifest:    creationhttp.NewCapabilityManifestHandler(manifestService),
		tasks:       creationhttp.NewGenerationTaskHandler(taskService, store),
		governance:  creationhttp.NewGovernanceHandler(governanceService, connectionService),
		hub:         hub,
		worker:      worker,
		guard:       authz.NewGuard(deps.SessionAuthenticator),
		corsOrigins: cfg.CORSAllowedOrigins,
		store:       store,
	}, nil
}

// workerLeaseOwner namespaces this process's queue leases so a restart's new
// leases never collide with a stale predecessor's.
func workerLeaseOwner() string {
	return "creation-worker-" + domain.NewUUID().String()[:8]
}

// buildStore instantiates the configured production adapter; nothing else in
// the Module knows which backend holds blobs.
func buildStore(ctx context.Context, cfg Config) (domain.BlobStore, error) {
	switch cfg.StorageDriver {
	case "filesystem":
		return storage.NewFilesystem(cfg.StorageRoot)
	case "s3":
		return storage.NewS3(ctx, cfg.S3Endpoint, cfg.S3AccessKeyID, cfg.S3SecretAccessKey, cfg.S3Region, cfg.S3Bucket, cfg.S3Secure)
	default:
		return nil, fmt.Errorf("creation: unsupported storage driver %q", cfg.StorageDriver)
	}
}

// Register mounts the static route table inside one chi group with this
// Module's own CORS gate and OPTIONS twins. The generation invalidation fan
// out stays intra-module through the SSE hub; the bus remains the seam for
// the cross-Module revocation stream (ADR-0016 跨 Module 断流).
func (m *Module) Register(r chi.Router, _ event.Bus) {
	routes := m.routes()
	r.Use(corsMiddleware(m.corsOrigins, creationhttp.MethodsByPath(routes)))
	creationhttp.Mount(r, routes, httpGuards(m.guard))
}

// RunWorkers drives the PostgreSQL generation queue until context
// cancellation; the worker's error (if any) is surfaced to the composition
// root's lifecycle contract.
func (m *Module) RunWorkers(ctx context.Context) error {
	return m.worker.Run(ctx)
}

// httpGuards adapts the shared guard to the transport table.
func httpGuards(guard *authz.Guard) creationhttp.Guards {
	return creationhttp.Guards{ActiveUser: guard.RequireActiveUser, Admin: guard.RequireAdmin}
}
