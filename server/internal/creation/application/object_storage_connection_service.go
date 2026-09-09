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

const (
	proofActionObjectStorageCreate  = "object_storage_connection.create"
	proofActionObjectStorageReplace = "object_storage_connection.replace"
	proofActionObjectStorageRotate  = "object_storage_connection.rotate"
	proofActionObjectStorageDelete  = "object_storage_connection.delete"
	proofActionObjectStorageRecover = "object_storage_connection.recover"
)

type ObjectStorageConnectionService struct {
	connections  domain.ObjectStorageConnectionRepository
	providers    domain.ProviderConnectionRepository
	runner       domain.WriteRunner
	vault        domain.ObjectStorageCredentialVault
	verifier     domain.ObjectStorageVerifier
	proofs       authz.ReauthProofVerifier
	activationMu sync.Mutex
}

func NewObjectStorageConnectionService(
	connections domain.ObjectStorageConnectionRepository,
	providers domain.ProviderConnectionRepository,
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

// Create verifies the candidate outside the audited activation transaction.
func (s *ObjectStorageConnectionService) Create(ctx context.Context, principal authz.Principal, proof string, candidate domain.ObjectStorageCandidate) (domain.ObjectStorageConnection, error) {
	if err := s.proofs.VerifyProof(ctx, principal, proofActionObjectStorageCreate, proof); err != nil {
		return domain.ObjectStorageConnection{}, err
	}
	if _, err := s.connections.GetActive(ctx); err == nil {
		return domain.ObjectStorageConnection{}, domain.ErrObjectStorageConnectionExists
	} else if !errors.Is(err, domain.ErrObjectStorageConnectionNotConfigured) {
		return domain.ObjectStorageConnection{}, err
	}
	location, err := s.verifyCandidate(ctx, candidate)
	if err != nil {
		return domain.ObjectStorageConnection{}, err
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
	connection := domain.ObjectStorageConnection{
		ID:                    domain.NewUUID(),
		ObjectStorageLocation: location,
		State:                 domain.ObjectStorageStateReady,
		AccessKeyIDMasked:     domain.MaskObjectStorageAccessKeyID(candidate.Credentials.AccessKeyID),
		LastCheckedAt:         time.Now().UTC(),
		LastCheckOutcome:      domain.CheckOutcomeCompleted,
		CreatedByUserID:       creatorID,
	}
	if err := s.sealCredentials(key, &connection, candidate.Credentials); err != nil {
		return domain.ObjectStorageConnection{}, domain.ErrObjectStorageUnavailable
	}
	err = s.runner.Run(ctx, func(sc domain.WriteScope) error {
		if err := s.connections.Insert(ctx, sc.Tx(), &connection); err != nil {
			return err
		}
		return appendObjectStorageAudit(ctx, sc.Tx(), principal, auditlog.ObjectStorageConnectionCreated, connection)
	})
	return connection, err
}

// Recheck uses the saved credential and changes only the safe observation.
func (s *ObjectStorageConnectionService) Recheck(ctx context.Context) (domain.ObjectStorageConnection, error) {
	connection, err := s.activeConnection(ctx)
	if err != nil {
		return domain.ObjectStorageConnection{}, err
	}
	if connection.State != domain.ObjectStorageStateReady {
		return domain.ObjectStorageConnection{}, domain.ErrObjectStorageRecoveryRequired
	}
	candidate, plaintext, err := s.storedCandidate(connection)
	if err != nil {
		return s.markCredentialUnavailable(ctx, connection)
	}
	defer wipe(plaintext)
	checkedAt := time.Now().UTC()
	outcome := domain.CheckOutcomeCompleted
	verified, verifyErr := s.verifier.Verify(ctx, candidate)
	if verifyErr != nil || verified != connection.ObjectStorageLocation {
		outcome = domain.CheckOutcomeTemporarilyUnavailable
	}
	err = s.runner.Run(ctx, func(sc domain.WriteScope) error {
		return s.connections.UpdateObservation(ctx, sc.Tx(), connection.ID, connection.Revision, checkedAt, outcome)
	})
	if errors.Is(err, domain.ErrObjectStorageRevisionConflict) {
		return s.activeConnection(ctx)
	}
	if err != nil {
		return domain.ObjectStorageConnection{}, err
	}
	return s.activeConnection(ctx)
}

// Replace changes only an empty, never-frozen location after candidate verify.
func (s *ObjectStorageConnectionService) Replace(ctx context.Context, principal authz.Principal, proof string, expectedRevision int64, candidate domain.ObjectStorageCandidate) (domain.ObjectStorageConnection, error) {
	if err := s.proofs.VerifyProof(ctx, principal, proofActionObjectStorageReplace, proof); err != nil {
		return domain.ObjectStorageConnection{}, err
	}
	current, err := s.requireMaintenanceState(ctx, expectedRevision)
	if err != nil {
		return domain.ObjectStorageConnection{}, err
	}
	if current.LocationFrozenAt != nil {
		return domain.ObjectStorageConnection{}, domain.ErrObjectStorageLocationFrozen
	}
	location, err := s.verifyCandidate(ctx, candidate)
	if err != nil {
		return domain.ObjectStorageConnection{}, err
	}
	if location == current.ObjectStorageLocation {
		return domain.ObjectStorageConnection{}, domain.ErrInvalidObjectStorageCandidate
	}
	key, err := s.vault.LoadKey()
	if err != nil {
		_, _ = s.markCredentialUnavailable(ctx, current)
		return domain.ObjectStorageConnection{}, domain.ErrObjectStorageRecoveryRequired
	}
	updated := current
	updated.ObjectStorageLocation = location
	updated.State = domain.ObjectStorageStateReady
	updated.AccessKeyIDMasked = domain.MaskObjectStorageAccessKeyID(candidate.Credentials.AccessKeyID)
	updated.LastCheckedAt = time.Now().UTC()
	updated.LastCheckOutcome = domain.CheckOutcomeCompleted
	if err := s.sealCredentials(key, &updated, candidate.Credentials); err != nil {
		return domain.ObjectStorageConnection{}, domain.ErrObjectStorageUnavailable
	}
	err = s.runner.Run(ctx, func(sc domain.WriteScope) error {
		if err := s.connections.ReplaceLocation(ctx, sc.Tx(), &updated, expectedRevision); err != nil {
			return err
		}
		return appendObjectStorageAudit(ctx, sc.Tx(), principal, auditlog.ObjectStorageConnectionReplaced, updated)
	})
	return updated, err
}

// Rotate switches credentials at the same location without establishing a key.
func (s *ObjectStorageConnectionService) Rotate(ctx context.Context, principal authz.Principal, proof string, expectedRevision int64, credentials domain.ObjectStorageCredentials) (domain.ObjectStorageConnection, error) {
	if err := s.proofs.VerifyProof(ctx, principal, proofActionObjectStorageRotate, proof); err != nil {
		return domain.ObjectStorageConnection{}, err
	}
	current, err := s.requireMaintenanceState(ctx, expectedRevision)
	if err != nil {
		return domain.ObjectStorageConnection{}, err
	}
	if _, err := s.verifyCandidate(ctx, domain.ObjectStorageCandidate{Location: current.ObjectStorageLocation, Credentials: credentials}); err != nil {
		return domain.ObjectStorageConnection{}, err
	}
	key, err := s.vault.LoadKey()
	if err != nil {
		_, _ = s.markCredentialUnavailable(ctx, current)
		return domain.ObjectStorageConnection{}, domain.ErrObjectStorageRecoveryRequired
	}
	updated := current
	updated.State = domain.ObjectStorageStateReady
	updated.AccessKeyIDMasked = domain.MaskObjectStorageAccessKeyID(credentials.AccessKeyID)
	updated.LastCheckedAt = time.Now().UTC()
	updated.LastCheckOutcome = domain.CheckOutcomeCompleted
	if err := s.sealCredentials(key, &updated, credentials); err != nil {
		return domain.ObjectStorageConnection{}, domain.ErrObjectStorageUnavailable
	}
	err = s.runner.Run(ctx, func(sc domain.WriteScope) error {
		if err := s.connections.RotateCredential(ctx, sc.Tx(), &updated, expectedRevision); err != nil {
			return err
		}
		return appendObjectStorageAudit(ctx, sc.Tx(), principal, auditlog.ObjectStorageCredentialRotated, updated)
	})
	return updated, err
}

// Recover is the sole Object Storage path allowed to establish a replacement
// key under existing ciphertext. Candidate verification still happens first.
func (s *ObjectStorageConnectionService) Recover(ctx context.Context, principal authz.Principal, proof string, expectedRevision int64, credentials domain.ObjectStorageCredentials) (domain.ObjectStorageConnection, error) {
	if err := s.proofs.VerifyProof(ctx, principal, proofActionObjectStorageRecover, proof); err != nil {
		return domain.ObjectStorageConnection{}, err
	}
	current, err := s.connections.GetActive(ctx)
	if err != nil {
		return domain.ObjectStorageConnection{}, err
	}
	if current.Revision != expectedRevision {
		return domain.ObjectStorageConnection{}, domain.ErrObjectStorageRevisionConflict
	}
	if current.State != domain.ObjectStorageStateCredentialUnavailable {
		return domain.ObjectStorageConnection{}, domain.ErrObjectStorageRecoveryNotRequired
	}
	if _, err := s.verifyCandidate(ctx, domain.ObjectStorageCandidate{Location: current.ObjectStorageLocation, Credentials: credentials}); err != nil {
		return domain.ObjectStorageConnection{}, err
	}
	_, loadErr := s.vault.LoadKey()
	key, err := s.vault.EnsureKey()
	if err != nil {
		return domain.ObjectStorageConnection{}, domain.ErrObjectStorageUnavailable
	}
	updated := current
	updated.State = domain.ObjectStorageStateReady
	updated.AccessKeyIDMasked = domain.MaskObjectStorageAccessKeyID(credentials.AccessKeyID)
	updated.LastCheckedAt = time.Now().UTC()
	updated.LastCheckOutcome = domain.CheckOutcomeCompleted
	if err := s.sealCredentials(key, &updated, credentials); err != nil {
		return domain.ObjectStorageConnection{}, domain.ErrObjectStorageUnavailable
	}

	var provider *domain.ProviderConnection
	if loadErr != nil {
		if active, providerErr := s.providers.GetActive(ctx); providerErr == nil {
			provider = &active
		} else if !errors.Is(providerErr, domain.ErrConnectionNotConfigured) {
			return domain.ObjectStorageConnection{}, providerErr
		}
	}
	err = s.runner.Run(ctx, func(sc domain.WriteScope) error {
		if err := s.connections.RecoverCredential(ctx, sc.Tx(), &updated, expectedRevision); err != nil {
			return err
		}
		if provider != nil && provider.Envelope != nil {
			if _, err := s.providers.MarkCredentialUnavailableIfKeyID(ctx, sc.Tx(), provider.ID, provider.Envelope.KeyID); err != nil {
				return err
			}
		}
		return appendObjectStorageAudit(ctx, sc.Tx(), principal, auditlog.ObjectStorageCredentialRecovered, updated)
	})
	return updated, err
}

func (s *ObjectStorageConnectionService) Delete(ctx context.Context, principal authz.Principal, proof string, expectedRevision int64) error {
	if err := s.proofs.VerifyProof(ctx, principal, proofActionObjectStorageDelete, proof); err != nil {
		return err
	}
	current, err := s.connections.GetActive(ctx)
	if err != nil {
		return err
	}
	if current.Revision != expectedRevision {
		return domain.ErrObjectStorageRevisionConflict
	}
	if current.LocationFrozenAt != nil {
		return domain.ErrObjectStorageLocationFrozen
	}
	return s.runner.Run(ctx, func(sc domain.WriteScope) error {
		if err := s.connections.Terminate(ctx, sc.Tx(), current.ID, expectedRevision); err != nil {
			return err
		}
		return appendObjectStorageAudit(ctx, sc.Tx(), principal, auditlog.ObjectStorageConnectionDeleted, current)
	})
}

func (s *ObjectStorageConnectionService) requireMaintenanceState(ctx context.Context, expectedRevision int64) (domain.ObjectStorageConnection, error) {
	connection, err := s.connections.GetActive(ctx)
	if err != nil {
		return domain.ObjectStorageConnection{}, err
	}
	if connection.Revision != expectedRevision {
		return domain.ObjectStorageConnection{}, domain.ErrObjectStorageRevisionConflict
	}
	if connection.State != domain.ObjectStorageStateReady {
		return domain.ObjectStorageConnection{}, domain.ErrObjectStorageRecoveryRequired
	}
	return connection, nil
}

func (s *ObjectStorageConnectionService) verifyCandidate(ctx context.Context, candidate domain.ObjectStorageCandidate) (domain.ObjectStorageLocation, error) {
	location, err := s.verifier.Verify(ctx, candidate)
	if err == nil {
		return location, nil
	}
	if errors.Is(err, domain.ErrInvalidObjectStorageCandidate) {
		return domain.ObjectStorageLocation{}, domain.ErrInvalidObjectStorageCandidate
	}
	slog.WarnContext(ctx, "creation: object storage candidate verification failed", "code", "object_storage_unavailable")
	return domain.ObjectStorageLocation{}, domain.ErrObjectStorageUnavailable
}

func (s *ObjectStorageConnectionService) storedCandidate(connection domain.ObjectStorageConnection) (domain.ObjectStorageCandidate, []byte, error) {
	if connection.Envelope == nil {
		return domain.ObjectStorageCandidate{}, nil, domain.ErrObjectStorageRecoveryRequired
	}
	key, err := s.vault.LoadKey()
	if err != nil {
		return domain.ObjectStorageCandidate{}, nil, err
	}
	plaintext, err := s.vault.OpenObjectStorage(key, connection.ID, connection.Provider, *connection.Envelope)
	if err != nil {
		return domain.ObjectStorageCandidate{}, nil, err
	}
	var credentials domain.ObjectStorageCredentials
	if err := json.Unmarshal(plaintext, &credentials); err != nil || credentials.AccessKeyID == "" || credentials.SecretAccessKey == "" {
		wipe(plaintext)
		return domain.ObjectStorageCandidate{}, nil, domain.ErrObjectStorageRecoveryRequired
	}
	return domain.ObjectStorageCandidate{Location: connection.ObjectStorageLocation, Credentials: credentials}, plaintext, nil
}

func (s *ObjectStorageConnectionService) sealCredentials(key domain.CredentialKey, connection *domain.ObjectStorageConnection, credentials domain.ObjectStorageCredentials) error {
	plaintext, err := json.Marshal(credentials)
	if err != nil {
		return err
	}
	defer wipe(plaintext)
	envelope, err := s.vault.SealObjectStorage(key, connection.ID, connection.Provider, plaintext)
	if err != nil {
		return err
	}
	connection.Envelope = &envelope
	return nil
}

func wipe(value []byte) {
	for i := range value {
		value[i] = 0
	}
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
	_, plaintext, err := s.storedCandidate(connection)
	if err != nil {
		return s.markCredentialUnavailable(ctx, connection)
	}
	wipe(plaintext)
	return connection, nil
}

func (s *ObjectStorageConnectionService) markCredentialUnavailable(ctx context.Context, connection domain.ObjectStorageConnection) (domain.ObjectStorageConnection, error) {
	marked := false
	if err := s.runner.Run(ctx, func(sc domain.WriteScope) error {
		var err error
		marked, err = s.connections.MarkCredentialUnavailable(ctx, sc.Tx(), connection.ID, connection.Revision)
		return err
	}); err != nil {
		return domain.ObjectStorageConnection{}, err
	}
	if !marked {
		return s.connections.GetActive(ctx)
	}
	connection.State = domain.ObjectStorageStateCredentialUnavailable
	return connection, nil
}

func appendObjectStorageAudit(ctx context.Context, tx domain.TxExecutor, principal authz.Principal, action auditlog.Action, connection domain.ObjectStorageConnection) error {
	actor, err := auditlog.SnapshotSubject(ctx, tx, principal.UserID)
	if err != nil {
		return err
	}
	return auditlog.Append(ctx, tx, auditlog.Entry{
		Actor:  actor,
		Action: action,
		Metadata: map[string]string{
			"connection_id": connection.ID.String(),
			"provider":      string(connection.Provider),
			"region":        connection.Region,
			"bucket":        connection.Bucket,
			"revision":      strconv.FormatInt(connection.Revision, 10),
		},
	})
}
