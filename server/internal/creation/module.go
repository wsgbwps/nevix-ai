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
	"github.com/nevix-ai/server/internal/creation/infrastructure/media"
	"github.com/nevix-ai/server/internal/creation/infrastructure/postgres"
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
// reference materials plus the browser-origin whitelist shared with Identity.
type Config struct {
	StorageDriver      string // "filesystem" or "s3"
	StorageRoot        string // filesystem driver: absolute blob root
	S3Endpoint         string
	S3Region           string
	S3Bucket           string
	S3AccessKeyID      string
	S3SecretAccessKey  string
	S3Secure           bool
	CORSAllowedOrigins []string
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
// Identity-owned session authenticator proves every caller's principal. It is
// deliberately narrow — Creation never touches credential verification.
type Deps struct {
	SessionAuthenticator authz.SessionAuthenticator
}

// Module is the Creation Module's composition surface.
type Module struct {
	sessions    *creationhttp.SessionHandler
	materials   *creationhttp.MaterialHandler
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
	sessionService := application.NewSessionService(sessionRepos, tx)
	materialService := application.NewMaterialService(materialRepos, sessionRepos, store, media.Prober{}, tx)
	return &Module{
		sessions:    creationhttp.NewSessionHandler(sessionService),
		materials:   creationhttp.NewMaterialHandler(materialService),
		guard:       authz.NewGuard(deps.SessionAuthenticator),
		corsOrigins: cfg.CORSAllowedOrigins,
		store:       store,
	}, nil
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
// Module's own CORS gate and OPTIONS twins. No Domain Events exist yet; the
// bus stays part of the lifecycle contract for later slices.
func (m *Module) Register(r chi.Router, _ event.Bus) {
	routes := m.routes()
	r.Use(corsMiddleware(m.corsOrigins, creationhttp.MethodsByPath(routes)))
	creationhttp.Mount(r, routes, httpGuards(m.guard))
}

// RunWorkers owns no asynchronous work in this slice, so it idles until
// context cancellation — the Module lifecycle contract keeps a workerless
// Module alive instead of returning while the server keeps serving.
func (m *Module) RunWorkers(ctx context.Context) error {
	<-ctx.Done()
	return nil
}

// httpGuards adapts the shared guard to the transport table.
func httpGuards(guard *authz.Guard) creationhttp.Guards {
	return creationhttp.Guards{ActiveUser: guard.RequireActiveUser}
}
