package application

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/nevix-ai/server/internal/auditlog"
	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/creation/domain"
)

const proofActionObjectStorageCreate = "object_storage_connection.create"

type ObjectStorageConnectionService struct {
	connections  domain.ObjectStorageConnectionRepository
	providers    domain.ConnectionSignals
	runner       domain.WriteRunner
	vault        domain.ObjectStorageCredentialVault
	verifier     domain.ObjectStorageVerifier
	proofs       authz.ReauthProofVerifier
	activationMu sync.Mutex
}

func NewObjectStorageConnectionService(
	connections domain.ObjectStorageConnectionRepository,
	providers domain.ConnectionSignals,
	runner domain.WriteRunner,
	vault domain.ObjectStorageCredentialVault,
	verifier domain.ObjectStorageVerifier,
	proofs authz.ReauthProofVerifier,
) *ObjectStorageConnectionService {
	return &ObjectStorageConnectionService{
		connections: connections, providers: providers, runner: runner,
		vault: vault, verifier: verifier, proofs: proofs,
	}
}

func (s *ObjectStorageConnectionService) GetAdmin(ctx context.Context) (domain.ObjectStorageConnection, error) {
	connection, err := s.activeConnection(ctx)
	if errors.Is(err, domain.ErrObjectStorageConnectionNotConfigured) {
		return domain.ObjectStorageConnection{State: domain.ObjectStorageStateUnconfigured}, nil
	}
	return connection, err
}

type ObjectStorageCapability struct {
	Available          bool
	Provider           domain.ObjectStorageProvider
	UploadOrigin       string
	ConnectionRevision int64
}

func (s *ObjectStorageConnectionService) Capability(ctx context.Context) (ObjectStorageCapability, error) {
	connection, err := s.activeConnection(ctx)
	if errors.Is(err, domain.ErrObjectStorageConnectionNotConfigured) {
		return ObjectStorageCapability{}, nil
	}
	if err != nil {
		return ObjectStorageCapability{}, err
	}
	capability := ObjectStorageCapability{
		Available:          connection.State == domain.ObjectStorageStateReady,
		Provider:           connection.Provider,
		ConnectionRevision: connection.Revision,
	}
	if capability.Available {
		capability.UploadOrigin = connection.Origin()
	}
	return capability, nil
}

// Create consumes the exact-action proof before cloud verification, performs
// that verification without a database transaction, then atomically persists
// the verified envelope and audit event (ADR-0016).
func (s *ObjectStorageConnectionService) Create(ctx context.Context, principal authz.Principal, proof string, candidate domain.ObjectStorageCandidate) (domain.ObjectStorageConnection, error) {
	if err := s.proofs.VerifyProof(ctx, principal, proofActionObjectStorageCreate, proof); err != nil {
		return domain.ObjectStorageConnection{}, err
	}
	if _, err := s.connections.GetActive(ctx); err == nil {
		return domain.ObjectStorageConnection{}, domain.ErrObjectStorageConnectionExists
	} else if !errors.Is(err, domain.ErrObjectStorageConnectionNotConfigured) {
		return domain.ObjectStorageConnection{}, err
	}

	location, err := s.verifier.Verify(ctx, candidate)
	if err != nil {
		if errors.Is(err, domain.ErrInvalidObjectStorageCandidate) {
			return domain.ObjectStorageConnection{}, domain.ErrInvalidObjectStorageCandidate
		}
		// Provider details and the original error can contain credentials or
		// signed authority; this stable code is the entire security-log payload.
		slog.WarnContext(ctx, "creation: object storage candidate verification failed", "code", "object_storage_unavailable")
		return domain.ObjectStorageConnection{}, domain.ErrObjectStorageUnavailable
	}
	// ponytail: a process-local activation lock matches V1's single Server; use a cross-process key protocol only if replicas are added.
	s.activationMu.Lock()
	defer s.activationMu.Unlock()
	if _, err := s.connections.GetActive(ctx); err == nil {
		return domain.ObjectStorageConnection{}, domain.ErrObjectStorageConnectionExists
	} else if !errors.Is(err, domain.ErrObjectStorageConnectionNotConfigured) {
		return domain.ObjectStorageConnection{}, err
	}
	key, err := s.credentialKeyForFirstConnection(ctx)
	if err != nil {
		return domain.ObjectStorageConnection{}, domain.ErrObjectStorageUnavailable
	}
	creatorID, err := domain.ParseUUID(principal.UserID)
	if err != nil {
		return domain.ObjectStorageConnection{}, err
	}
	plaintext, err := json.Marshal(candidate.Credentials)
	if err != nil {
		return domain.ObjectStorageConnection{}, domain.ErrObjectStorageUnavailable
	}
	defer func() {
		for i := range plaintext {
			plaintext[i] = 0
		}
	}()
	connectionID := domain.NewUUID()
	envelope, err := s.vault.SealObjectStorage(key, connectionID, location.Provider, plaintext)
	if err != nil {
		return domain.ObjectStorageConnection{}, domain.ErrObjectStorageUnavailable
	}
	connection := domain.ObjectStorageConnection{
		ID: connectionID, ObjectStorageLocation: location,
		State: domain.ObjectStorageStateReady, Envelope: &envelope,
		AccessKeyIDMasked: domain.MaskObjectStorageAccessKeyID(candidate.Credentials.AccessKeyID),
		LastCheckedAt:     time.Now().UTC(), LastCheckOutcome: domain.CheckOutcomeCompleted,
		CreatedByUserID: creatorID,
	}
	err = s.runner.Run(ctx, func(sc domain.WriteScope) error {
		if err := s.connections.Insert(ctx, sc.Tx(), &connection); err != nil {
			return err
		}
		actor, err := auditlog.SnapshotSubject(ctx, sc.Tx(), principal.UserID)
		if err != nil {
			return err
		}
		return auditlog.Append(ctx, sc.Tx(), auditlog.Entry{
			Actor: actor, Action: auditlog.ObjectStorageConnectionCreated,
			Metadata: map[string]string{
				"connection_id": connection.ID.String(), "provider": string(connection.Provider),
				"region": connection.Region, "bucket": connection.Bucket,
				"revision": strconv.FormatInt(connection.Revision, 10),
			},
		})
	})
	return connection, err
}

func (s *ObjectStorageConnectionService) credentialKeyForFirstConnection(ctx context.Context) (domain.CredentialKey, error) {
	key, err := s.vault.LoadKey()
	if err == nil {
		return key, nil
	}
	if _, providerErr := s.providers.GetActive(ctx); !errors.Is(providerErr, domain.ErrConnectionNotConfigured) {
		return domain.CredentialKey{}, domain.ErrObjectStorageUnavailable
	}
	return s.vault.EnsureKey()
}

func (s *ObjectStorageConnectionService) activeConnection(ctx context.Context) (domain.ObjectStorageConnection, error) {
	connection, err := s.connections.GetActive(ctx)
	if err != nil || connection.State == domain.ObjectStorageStateCredentialUnavailable {
		return connection, err
	}
	if connection.Envelope == nil {
		return s.markCredentialUnavailable(ctx, connection)
	}
	key, err := s.vault.LoadKey()
	if err != nil {
		return s.markCredentialUnavailable(ctx, connection)
	}
	plaintext, err := s.vault.OpenObjectStorage(key, connection.ID, connection.Provider, *connection.Envelope)
	if err != nil {
		return s.markCredentialUnavailable(ctx, connection)
	}
	defer func() {
		for i := range plaintext {
			plaintext[i] = 0
		}
	}()
	var credentials domain.ObjectStorageCredentials
	if err := json.Unmarshal(plaintext, &credentials); err != nil || credentials.AccessKeyID == "" || credentials.SecretAccessKey == "" {
		return s.markCredentialUnavailable(ctx, connection)
	}
	return connection, nil
}

func (s *ObjectStorageConnectionService) markCredentialUnavailable(ctx context.Context, connection domain.ObjectStorageConnection) (domain.ObjectStorageConnection, error) {
	if err := s.runner.Run(ctx, func(sc domain.WriteScope) error {
		return s.connections.MarkCredentialUnavailable(ctx, sc.Tx(), connection.ID)
	}); err != nil {
		return domain.ObjectStorageConnection{}, err
	}
	connection.State = domain.ObjectStorageStateCredentialUnavailable
	return connection, nil
}
