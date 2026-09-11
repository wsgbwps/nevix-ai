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
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/creation/application"
	"github.com/nevix-ai/server/internal/creation/domain"
	"github.com/nevix-ai/server/internal/creation/infrastructure/kapon"
	"github.com/nevix-ai/server/internal/creation/infrastructure/media"
	"github.com/nevix-ai/server/internal/creation/infrastructure/postgres"
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

// Config carries process-level Creation configuration. Object Storage is an
// instance product fact loaded from PostgreSQL, never a deployment variable.
type Config struct {
	SecretsDir         string // secrets volume root holding the master key file
	KaponBaseURL       string // reviewed fixed route; unset means the default
	CORSAllowedOrigins []string
}

// LoadConfig validates the Module's process-level deployment variables. CORS
// reads the same variable Identity consumes — one deployment whitelist, read
// per Module because Modules do not share wiring code.
func LoadConfig(lookup func(string) (string, bool)) (Config, error) {
	origins, err := loadCORSAllowedOrigins(lookupValue(lookup, "CORS_ALLOWED_ORIGINS"))
	if err != nil {
		return Config{}, err
	}
	cfg := Config{CORSAllowedOrigins: origins}

	secretsDir, ok := lookup("NEVIX_CREATION_SECRETS_DIR")
	if !ok || strings.TrimSpace(secretsDir) == "" {
		return Config{}, errors.New("creation: missing required deployment variable: NEVIX_CREATION_SECRETS_DIR (the secrets volume holding the Provider Credential master key)")
	}
	cfg.SecretsDir = secretsDir
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
	SessionAuthenticator       authz.SessionAuthenticator
	ReauthVerifier             authz.ReauthProofVerifier
	ObjectStorageVerifier      ObjectStorageVerifier
	DirectUploadStoreFactory   DirectUploadStoreFactory
	ReferenceTransportFactory  ReferenceTransportFactory
	Now                        func() time.Time
	ReferencePreparationWait   func(context.Context, time.Duration) error
	ReferencePreparationJitter func(time.Duration) time.Duration
}

type ObjectStorageCandidate = domain.ObjectStorageCandidate
type ObjectStorageLocation = domain.ObjectStorageLocation
type ObjectStorageVerifier func(context.Context, ObjectStorageCandidate) (ObjectStorageLocation, error)
type ObjectStorageCredentials = domain.ObjectStorageCredentials
type ObjectStorageProvider = domain.ObjectStorageProvider
type DirectUploadBlobStore = domain.DirectUploadBlobStore
type DirectUploadStoreFactory = domain.DirectUploadStoreFactory
type ReferenceTransport = domain.ReferenceTransport
type ReferenceTransportFactory = domain.ReferenceTransportFactory
type ReferenceSource = domain.ReferenceSource
type ProviderTransferObject = domain.ProviderTransferObject
type UUID = domain.UUID
type BlobInfo = domain.BlobInfo
type PresignPutRequest = domain.PresignPutRequest
type PresignedPut = domain.PresignedPut
type PutResult = domain.PutResult
type BlobRange = domain.BlobRange
type ReadSeekCloser = domain.ReadSeekCloser

const (
	ObjectStorageProviderOSS = domain.ObjectStorageProviderOSS
	ObjectStorageProviderCOS = domain.ObjectStorageProviderCOS
	UploadIDMetadataKey      = domain.UploadIDMetadataKey
)

var (
	FullBlobRange                      = domain.FullBlobRange
	ErrTooLarge                        = domain.ErrTooLarge
	ErrBlobConflict                    = domain.ErrBlobConflict
	ErrBlobNotFound                    = domain.ErrBlobNotFound
	ErrRangeNotSatisfiable             = domain.ErrRangeNotSatisfiable
	ErrObjectStorageUnavailable        = domain.ErrObjectStorageUnavailable
	ErrObjectStorageRateLimited        = domain.ErrObjectStorageRateLimited
	ErrObjectStorageConfiguration      = domain.ErrObjectStorageConfiguration
	ErrReferenceSourceSizeMismatch     = domain.ErrReferenceSourceSizeMismatch
	ErrReferenceSourceMetadataMismatch = domain.ErrReferenceSourceMetadataMismatch
	ErrReferenceSourceChecksumMismatch = domain.ErrReferenceSourceChecksumMismatch
)

func (f ObjectStorageVerifier) Verify(ctx context.Context, candidate domain.ObjectStorageCandidate) (domain.ObjectStorageLocation, error) {
	return f(ctx, candidate)
}

// Module is the Creation Module's composition surface.
type Module struct {
	sessions      *creationhttp.SessionHandler
	materials     *creationhttp.MaterialHandler
	connection    *creationhttp.ProviderConnectionHandler
	objectStorage *creationhttp.ObjectStorageConnectionHandler
	manifest      *creationhttp.CapabilityManifestHandler
	tasks         *creationhttp.GenerationTaskHandler
	governance    *creationhttp.GovernanceHandler
	hub           *creationhttp.InvalidationHub
	worker        *application.TaskWorker
	uploadCleanup *application.ReferenceMaterialUploadCleanupWorker
	guard         *authz.Guard
	corsOrigins   []string
}

// NewModule constructs Creation over its domain-local write transaction
// runner and the call-time Object Storage resolver.
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
	sessionRepos := postgres.NewSessionRepository(pool)
	materialRepos := postgres.NewMaterialRepository(pool)
	uploadRepos := postgres.NewReferenceMaterialUploadRepository(pool)
	connectionRepos := postgres.NewConnectionRepository(pool)
	objectStorageRepos := postgres.NewObjectStorageConnectionRepository(pool)
	taskRepos := postgres.NewGenerationTaskRepository(pool)
	governanceRepos := postgres.NewGovernanceRepository(pool)
	assetRepos := postgres.NewMediaAssetRepository(pool)
	credentialVault := secrets.NewVault(cfg.SecretsDir)
	hub := creationhttp.NewInvalidationHub()
	sessionService := application.NewSessionService(sessionRepos, tx)
	connectionService := application.NewConnectionService(connectionRepos, objectStorageRepos, taskRepos, connectionRepos, tx, credentialVault, kapon.NewModelsCheckClient(cfg.KaponBaseURL), deps.ReauthVerifier)
	objectStorageVerifier := deps.ObjectStorageVerifier
	if objectStorageVerifier == nil {
		objectStorageVerifier = storage.VerifyConnection
	}
	directStoreFactory := deps.DirectUploadStoreFactory
	if directStoreFactory == nil {
		directStoreFactory = domain.DirectUploadStoreFactory(storage.NewBlobStore)
	}
	referenceTransportFactory := deps.ReferenceTransportFactory
	if referenceTransportFactory == nil {
		referenceTransportFactory = domain.ReferenceTransportFactory(storage.NewReferenceTransport)
	}
	now := deps.Now
	if now == nil {
		now = time.Now
	}
	objectStorageService := application.NewObjectStorageConnectionService(objectStorageRepos, connectionRepos, tx, credentialVault, objectStorageVerifier, directStoreFactory, referenceTransportFactory, deps.ReauthVerifier)
	materialService := application.NewMaterialService(materialRepos, sessionRepos, uploadRepos, taskRepos, objectStorageService, media.Prober{}, tx, now)
	manifestService := application.NewManifestService(connectionRepos)
	taskService := application.NewTaskService(taskRepos, materialRepos, connectionRepos, objectStorageService, governanceRepos, manifestService, tx, hub)
	governanceService := application.NewGovernanceService(governanceRepos, tx)
	// The worker resolves the current Object Storage Connection and speaks the
	// fixed Kapon generation route. The connection service is the call-time
	// credential source: the decrypted
	// Provider Key exists only between its resolve and the adapter's
	// Authorization header.
	gateway := kapon.NewGenerationsClient(cfg.KaponBaseURL, objectStorageService, kapon.ReferencePreparationTiming{
		Now: now, Wait: deps.ReferencePreparationWait, Jitter: deps.ReferencePreparationJitter,
	})
	worker := application.NewTaskWorker(taskRepos, materialRepos, connectionRepos, connectionService, objectStorageService, media.Prober{}, gateway, assetRepos, hub, tx, workerLeaseOwner())
	uploadCleanup := application.NewReferenceMaterialUploadCleanupWorker(uploadRepos, objectStorageService, tx, now)
	return &Module{
		sessions:      creationhttp.NewSessionHandler(sessionService),
		materials:     creationhttp.NewMaterialHandler(materialService),
		connection:    creationhttp.NewProviderConnectionHandler(connectionService),
		objectStorage: creationhttp.NewObjectStorageConnectionHandler(objectStorageService),
		manifest:      creationhttp.NewCapabilityManifestHandler(manifestService),
		tasks:         creationhttp.NewGenerationTaskHandler(taskService, objectStorageService),
		governance:    creationhttp.NewGovernanceHandler(governanceService, connectionService),
		hub:           hub,
		worker:        worker,
		uploadCleanup: uploadCleanup,
		guard:         authz.NewGuard(deps.SessionAuthenticator),
		corsOrigins:   cfg.CORSAllowedOrigins,
	}, nil
}

// workerLeaseOwner namespaces this process's queue leases so a restart's new
// leases never collide with a stale predecessor's.
func workerLeaseOwner() string {
	return "creation-worker-" + domain.NewUUID().String()[:8]
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

// RunWorkers drives both durable Creation queues until cancellation. A fatal
// claim error cancels its sibling and is surfaced to the composition root.
func (m *Module) RunWorkers(ctx context.Context) error {
	workerCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	results := make(chan error, 2)
	go func() { results <- m.worker.Run(workerCtx) }()
	go func() { results <- m.uploadCleanup.Run(workerCtx) }()
	first := <-results
	cancel()
	second := <-results
	if first != nil {
		return first
	}
	return second
}

// httpGuards adapts the shared guard to the transport table.
func httpGuards(guard *authz.Guard) creationhttp.Guards {
	return creationhttp.Guards{ActiveUser: guard.RequireActiveUser, Admin: guard.RequireAdmin}
}
