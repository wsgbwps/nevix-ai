package application

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/nevix-ai/server/internal/auditlog"
	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/creation/domain"
)

// The closed exact-action set these commands consume (issue #154). The
// identity Module owns issuance; these strings are the wire contract's
// action ids, mirrored here because Modules never import each other.
const (
	proofActionCreate  = "provider_connection.create"
	proofActionReplace = "provider_connection.replace"
	proofActionDelete  = "provider_connection.delete"
)

// ConnectionService orchestrates the instance's single AI Provider
// Connection. High-risk commands (configure/replace/delete) consume an
// exact-action proof first — consumption commits on its own, so any later
// failure leaves the proof spent and the admin re-verifies. Provider calls
// never run inside a write transaction; every persisted transition carries
// its sanitized audit row in the same transaction (ADR-0016).
type ConnectionService struct {
	connections domain.ProviderConnectionRepository
	runner      domain.WriteRunner
	vault       domain.CredentialVault
	checker     domain.ProviderCheckClient
	proofs      authz.ReauthProofVerifier
}

func NewConnectionService(
	connections domain.ProviderConnectionRepository,
	runner domain.WriteRunner,
	vault domain.CredentialVault,
	checker domain.ProviderCheckClient,
	proofs authz.ReauthProofVerifier,
) *ConnectionService {
	return &ConnectionService{connections: connections, runner: runner, vault: vault, checker: checker, proofs: proofs}
}

// GetActive returns the active connection for the admin view.
func (s *ConnectionService) GetActive(ctx context.Context) (domain.ProviderConnection, error) {
	return s.connections.GetActive(ctx)
}

// MemberCapabilities returns the per-media member projection.
func (s *ConnectionService) MemberCapabilities(ctx context.Context) (domain.MediaCapabilitiesView, error) {
	connection, err := s.connections.GetActive(ctx)
	if err != nil {
		if errors.Is(err, domain.ErrConnectionNotConfigured) {
			return domain.DeriveMediaCapabilities(nil), nil
		}
		return domain.MediaCapabilitiesView{}, err
	}
	return domain.DeriveMediaCapabilities(&connection), nil
}

// Configure establishes the first connection: consume the create proof,
// refuse a second active connection, establish the master key (no
// ciphertext can exist yet), check the candidate against the fixed provider
// route, then persist the sealed envelope with the check's states in one
// audited transaction. A rejected candidate persists nothing — the proof
// stays consumed.
func (s *ConnectionService) Configure(ctx context.Context, principal authz.Principal, proof, candidateKey string) (domain.ProviderConnection, error) {
	if err := s.proofs.VerifyProof(ctx, principal, proofActionCreate, proof); err != nil {
		return domain.ProviderConnection{}, err
	}
	if _, err := s.connections.GetActive(ctx); err == nil {
		return domain.ProviderConnection{}, domain.ErrConnectionExists
	} else if !errors.Is(err, domain.ErrConnectionNotConfigured) {
		return domain.ProviderConnection{}, err
	}
	key, err := s.vault.EnsureKey()
	if err != nil {
		return domain.ProviderConnection{}, fmt.Errorf("creation: establish provider credential master key: %w", err)
	}
	result, err := s.checkCandidate(ctx, candidateKey)
	if err != nil {
		return domain.ProviderConnection{}, err
	}
	creatorID, err := domain.ParseUUID(principal.UserID)
	if err != nil {
		return domain.ProviderConnection{}, fmt.Errorf("creation: principal user id is not a uuid: %w", err)
	}
	connectionID := domain.NewUUID()
	envelope, err := s.vault.Seal(key, connectionID, []byte(candidateKey))
	if err != nil {
		return domain.ProviderConnection{}, err
	}
	image, video := result.MediaCapabilities()
	checkedAt := time.Now().UTC()
	completed := domain.CheckOutcomeCompleted
	connection := domain.ProviderConnection{
		ID:               connectionID,
		AdminState:       domain.AdminStateEnabled,
		CredentialState:  domain.CredentialStateValid,
		ImageCapability:  image,
		VideoCapability:  video,
		Envelope:         &envelope,
		LastCheckedAt:    &checkedAt,
		LastCheckOutcome: &completed,
		CreatedByUserID:  creatorID,
	}
	err = s.runner.Run(ctx, func(sc domain.WriteScope) error {
		if err := s.connections.Insert(ctx, sc.Tx(), &connection); err != nil {
			return err
		}
		return appendConnectionAudit(ctx, sc.Tx(), principal, auditlog.ProviderConnectionCreated, &connection)
	})
	if err != nil {
		return domain.ProviderConnection{}, err
	}
	// Re-read so the response carries the persisted timestamps, not the
	// pre-insert aggregate's zero values.
	return s.connections.GetActive(ctx)
}

// Replace switches the Provider Key through a candidate: consume the replace
// proof, check the candidate while the stored envelope stays untouched, then
// atomically swap envelope and states in one audited transaction. A failed
// candidate leaves the previous credential and capabilities byte-identical.
// The command doubles as the credential recovery path: when the master key
// cannot be loaded, the reauthenticated admin re-establishes it here before
// the new ciphertext is written (ADR-0016 凭据恢复).
func (s *ConnectionService) Replace(ctx context.Context, principal authz.Principal, proof, candidateKey string) (domain.ProviderConnection, error) {
	if err := s.proofs.VerifyProof(ctx, principal, proofActionReplace, proof); err != nil {
		return domain.ProviderConnection{}, err
	}
	connection, err := s.connections.GetActive(ctx)
	if err != nil {
		return domain.ProviderConnection{}, err
	}
	// EnsureKey is the sanctioned recovery: it returns a loadable existing
	// key as-is and re-establishes the file only when it is missing or
	// unusable — never silently under a readable key.
	key, err := s.vault.EnsureKey()
	if err != nil {
		return domain.ProviderConnection{}, fmt.Errorf("creation: establish provider credential master key: %w", err)
	}
	result, err := s.checkCandidate(ctx, candidateKey)
	if err != nil {
		return domain.ProviderConnection{}, err
	}
	envelope, err := s.vault.Seal(key, connection.ID, []byte(candidateKey))
	if err != nil {
		return domain.ProviderConnection{}, err
	}
	image, video := result.MediaCapabilities()
	checkedAt := time.Now().UTC()
	err = s.runner.Run(ctx, func(sc domain.WriteScope) error {
		if err := s.connections.ReplaceCredential(ctx, sc.Tx(), connection.ID, &envelope,
			domain.CredentialStateValid, image, video, checkedAt, domain.CheckOutcomeCompleted); err != nil {
			return err
		}
		return appendConnectionAudit(ctx, sc.Tx(), principal, auditlog.ProviderConnectionReplaced, &domain.ProviderConnection{
			ID: connection.ID, AdminState: connection.AdminState,
			CredentialState: domain.CredentialStateValid, ImageCapability: image, VideoCapability: video,
		})
	})
	if err != nil {
		return domain.ProviderConnection{}, err
	}
	return s.connections.GetActive(ctx)
}

// Delete terminates the connection: consume the delete proof, then clear the
// encrypted credential and stamp termination in one audited transaction. The
// non-sensitive identity row stays for traceability; the singleton slot is
// released for a future configure with a fresh identity.
func (s *ConnectionService) Delete(ctx context.Context, principal authz.Principal, proof string) (domain.ProviderConnection, error) {
	if err := s.proofs.VerifyProof(ctx, principal, proofActionDelete, proof); err != nil {
		return domain.ProviderConnection{}, err
	}
	connection, err := s.connections.GetActive(ctx)
	if err != nil {
		return domain.ProviderConnection{}, err
	}
	err = s.runner.Run(ctx, func(sc domain.WriteScope) error {
		if err := s.connections.Terminate(ctx, sc.Tx(), connection.ID); err != nil {
			return err
		}
		return appendConnectionAudit(ctx, sc.Tx(), principal, auditlog.ProviderConnectionDeleted, &connection)
	})
	if err != nil {
		return domain.ProviderConnection{}, err
	}
	terminated := connection
	terminatedAt := time.Now().UTC()
	terminated.TerminatedAt = &terminatedAt
	terminated.Envelope = nil
	return terminated, nil
}

// Pause blocks new tasks and not-yet-started provider calls; Resume lifts
// the block. Both need only a valid admin session — no proof, no provider
// call.
func (s *ConnectionService) SetAdminState(ctx context.Context, principal authz.Principal, state domain.AdminState) (domain.ProviderConnection, error) {
	if !domain.ValidAdminState(string(state)) {
		return domain.ProviderConnection{}, domain.ErrInvalidAdminState
	}
	connection, err := s.connections.GetActive(ctx)
	if err != nil {
		return domain.ProviderConnection{}, err
	}
	action := auditlog.ProviderConnectionResumed
	if state == domain.AdminStatePaused {
		action = auditlog.ProviderConnectionPaused
	}
	var updated domain.ProviderConnection
	err = s.runner.Run(ctx, func(sc domain.WriteScope) error {
		var err error
		updated, err = s.connections.SetAdminState(ctx, sc.Tx(), connection.ID, state)
		if err != nil {
			return err
		}
		return appendConnectionAudit(ctx, sc.Tx(), principal, action, &updated)
	})
	if err != nil {
		return domain.ProviderConnection{}, err
	}
	return updated, nil
}

// Recheck decrypts the stored credential and repeats the connection check.
// A master-key or envelope failure fails the connection closed
// (credential_unavailable, both media unavailable) without ever writing a
// key file; a transient provider condition rewrites nothing but the outcome
// marker. Only a definitive verdict updates states.
func (s *ConnectionService) Recheck(ctx context.Context, principal authz.Principal) (domain.ProviderConnection, error) {
	connection, err := s.connections.GetActive(ctx)
	if err != nil {
		return domain.ProviderConnection{}, err
	}
	key, err := s.vault.LoadKey()
	if err != nil {
		return s.failClosed(ctx, principal, connection, "credential_unavailable")
	}
	if connection.Envelope == nil {
		// Unreachable while the database CHECK holds; treated as sealed.
		return s.failClosed(ctx, principal, connection, "credential_unavailable")
	}
	candidate, err := s.vault.Open(key, connection.ID, *connection.Envelope)
	if err != nil {
		return s.failClosed(ctx, principal, connection, "credential_unavailable")
	}
	result, checkErr := s.checker.Check(ctx, string(candidate))
	// The decrypted key's useful life ends with the check.
	for i := range candidate {
		candidate[i] = 0
	}
	if checkErr != nil {
		if errors.Is(checkErr, domain.ErrCandidateCredentialInvalid) {
			// The stored key is now definitively rejected: invalid
			// credential, both media unavailable.
			return s.recordDefinitiveInvalid(ctx, principal, connection)
		}
		return s.recordTransientCheck(ctx, principal, connection)
	}
	// A valid token that sees neither allowlisted model is still a valid
	// credential with both media independently unavailable.
	image, video := result.MediaCapabilities()
	credentialState := domain.CredentialStateValid
	checkedAt := time.Now().UTC()
	err = s.runner.Run(ctx, func(sc domain.WriteScope) error {
		if err := s.connections.SetCheckResult(ctx, sc.Tx(), connection.ID, credentialState, image, video, checkedAt, domain.CheckOutcomeCompleted); err != nil {
			return err
		}
		return appendConnectionAudit(ctx, sc.Tx(), principal, auditlog.ProviderConnectionChecked, &domain.ProviderConnection{
			ID: connection.ID, AdminState: connection.AdminState,
			CredentialState: credentialState, ImageCapability: image, VideoCapability: video,
		})
	})
	if err != nil {
		return domain.ProviderConnection{}, err
	}
	return s.connections.GetActive(ctx)
}

// checkCandidate runs one candidate key against the fixed provider route.
// The adapter already speaks the domain's verdicts (candidate invalid or
// transient); the candidate's plaintext never leaves this frame's paths.
func (s *ConnectionService) checkCandidate(ctx context.Context, candidateKey string) (domain.ProviderCheckResult, error) {
	return s.checker.Check(ctx, candidateKey)
}

// recordDefinitiveInvalid persists the definitive token-rejected verdict:
// invalid credential with both media unavailable.
func (s *ConnectionService) recordDefinitiveInvalid(ctx context.Context, principal authz.Principal, connection domain.ProviderConnection) (domain.ProviderConnection, error) {
	checkedAt := time.Now().UTC()
	err := s.runner.Run(ctx, func(sc domain.WriteScope) error {
		if err := s.connections.SetCheckResult(ctx, sc.Tx(), connection.ID,
			domain.CredentialStateInvalid, domain.MediaCapabilityUnavailable, domain.MediaCapabilityUnavailable,
			checkedAt, domain.CheckOutcomeCompleted); err != nil {
			return err
		}
		return appendConnectionAudit(ctx, sc.Tx(), principal, auditlog.ProviderConnectionChecked, &domain.ProviderConnection{
			ID: connection.ID, AdminState: connection.AdminState,
			CredentialState: domain.CredentialStateInvalid,
			ImageCapability: domain.MediaCapabilityUnavailable,
			VideoCapability: domain.MediaCapabilityUnavailable,
		})
	})
	if err != nil {
		return domain.ProviderConnection{}, err
	}
	return s.connections.GetActive(ctx)
}

// failClosed persists credential_unavailable with both media unavailable
// and its audit row; the reason string stays out of machine-facing state.
func (s *ConnectionService) failClosed(ctx context.Context, principal authz.Principal, connection domain.ProviderConnection, cause string) (domain.ProviderConnection, error) {
	err := s.runner.Run(ctx, func(sc domain.WriteScope) error {
		if err := s.connections.MarkCredentialUnavailable(ctx, sc.Tx(), connection.ID); err != nil {
			return err
		}
		return appendConnectionAudit(ctx, sc.Tx(), principal, auditlog.ProviderConnectionChecked, &domain.ProviderConnection{
			ID: connection.ID, AdminState: connection.AdminState,
			CredentialState: domain.CredentialStateCredentialUnavailable,
			ImageCapability: domain.MediaCapabilityUnavailable,
			VideoCapability: domain.MediaCapabilityUnavailable,
		}, cause)
	})
	if err != nil {
		return domain.ProviderConnection{}, err
	}
	return s.connections.GetActive(ctx)
}

// recordTransientCheck persists only the outcome marker; states keep their
// previous values (spec: timeouts, 429, and temporary 5xx never permanently
// rewrite state).
func (s *ConnectionService) recordTransientCheck(ctx context.Context, principal authz.Principal, connection domain.ProviderConnection) (domain.ProviderConnection, error) {
	checkedAt := time.Now().UTC()
	err := s.runner.Run(ctx, func(sc domain.WriteScope) error {
		if err := s.connections.SetCheckResult(ctx, sc.Tx(), connection.ID,
			connection.CredentialState, connection.ImageCapability, connection.VideoCapability,
			checkedAt, domain.CheckOutcomeTemporarilyUnavailable); err != nil {
			return err
		}
		return appendConnectionAudit(ctx, sc.Tx(), principal, auditlog.ProviderConnectionChecked, &connection, "temporarily_unavailable")
	})
	if err != nil {
		return domain.ProviderConnection{}, err
	}
	return s.connections.GetActive(ctx)
}

// appendConnectionAudit writes the sanitized connection audit row inside
// the caller's transaction: connection id and outcome states only — never
// key material, endpoints, model ids, provider request ids, or raw errors.
func appendConnectionAudit(ctx context.Context, tx domain.TxExecutor, principal authz.Principal, action auditlog.Action, connection *domain.ProviderConnection, extra ...string) error {
	actor, err := auditlog.SnapshotSubject(ctx, tx, principal.UserID)
	if err != nil {
		return err
	}
	metadata := map[string]string{
		"connection_id":    connection.ID.String(),
		"credential_state": string(connection.CredentialState),
		"image_capability": string(connection.ImageCapability),
		"video_capability": string(connection.VideoCapability),
	}
	if len(extra) > 0 {
		metadata["outcome"] = extra[0]
	}
	return auditlog.Append(ctx, tx, auditlog.Entry{Actor: actor, Action: action, Metadata: metadata})
}
