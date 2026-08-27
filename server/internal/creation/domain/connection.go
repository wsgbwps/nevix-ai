package domain

import (
	"context"
	"errors"
	"time"
)

// Provider connection state vocabulary (spec #150 / ADR-0016). AdminState is
// the governance switch; CredentialState covers the instance-level key; each
// media capability degrades independently. Deletion is a terminal event, and
// "needs attention" is a derived hint, never persisted state.
type (
	// AdminState is enabled or paused; paused blocks new tasks and not-yet
	// started provider calls while accepted external work converges.
	AdminState string
	// CredentialState is the Provider Key's instance-level verdict.
	CredentialState string
	// MediaCapability is one media's independent availability.
	MediaCapability string
	// CheckOutcome records how the latest connection check ended; a
	// transient ending never rewrites persisted states.
	CheckOutcome string
)

const (
	AdminStateEnabled AdminState = "enabled"
	AdminStatePaused  AdminState = "paused"

	CredentialStateChecking              CredentialState = "checking"
	CredentialStateValid                 CredentialState = "valid"
	CredentialStateInvalid               CredentialState = "invalid"
	CredentialStateCredentialUnavailable CredentialState = "credential_unavailable"

	MediaCapabilityChecking    MediaCapability = "checking"
	MediaCapabilityAvailable   MediaCapability = "available"
	MediaCapabilityUnavailable MediaCapability = "unavailable"

	CheckOutcomeCompleted              CheckOutcome = "completed"
	CheckOutcomeTemporarilyUnavailable CheckOutcome = "temporarily_unavailable"
)

// ProviderCredentialEnvelope is the versioned AEAD envelope value stored
// beside the connection: the master key ID, the per-seal random nonce, and
// the ciphertext. AAD binding (connection id, provider, purpose) is enforced
// by the codec, not persisted — tampering fails decryption.
type ProviderCredentialEnvelope struct {
	Version    int
	KeyID      string
	Nonce      []byte
	Ciphertext []byte
}

// ProviderConnection is the instance's single AI Provider Connection
// aggregate root. One active connection serves both image and video with no
// fallback; the plaintext Provider Key exists only inside Go during a check
// or a provider call and never leaves this aggregate's encrypted envelope.
type ProviderConnection struct {
	ID               UUID
	AdminState       AdminState
	CredentialState  CredentialState
	ImageCapability  MediaCapability
	VideoCapability  MediaCapability
	Envelope         *ProviderCredentialEnvelope
	LastCheckedAt    *time.Time
	LastCheckOutcome *CheckOutcome
	CreatedByUserID  UUID
	CreatedAt        time.Time
	UpdatedAt        time.Time
	TerminatedAt     *time.Time
}

// NeedsAttention is the derived "action needed" hint for the admin view:
// true when the credential is unusable, the connection is paused, or either
// media is not available. It is computed, never persisted.
func (c *ProviderConnection) NeedsAttention() bool {
	if c.TerminatedAt != nil {
		return false
	}
	return c.CredentialState != CredentialStateValid ||
		c.AdminState != AdminStateEnabled ||
		c.ImageCapability != MediaCapabilityAvailable ||
		c.VideoCapability != MediaCapabilityAvailable
}

// Provider connection domain errors. The interface layer maps these onto the
// stable machine codes documented in contracts/creation.yaml.
var (
	// ErrConnectionNotConfigured reports that no active connection exists.
	ErrConnectionNotConfigured = errors.New("provider connection not configured")
	// ErrConnectionExists reports the instance already has one active
	// connection; the singleton constraint is the durable twin.
	ErrConnectionExists = errors.New("provider connection already exists")
	// ErrCandidateCredentialInvalid reports the candidate Provider Key was
	// rejected by the fixed-route connection check; the candidate is
	// discarded and nothing about the stored connection changed.
	ErrCandidateCredentialInvalid = errors.New("candidate provider credential is invalid")
	// ErrCheckTemporarilyUnavailable reports the connection check hit a
	// transient upstream condition (timeout, 429, temporary 5xx); persisted
	// states are never rewritten by it.
	ErrCheckTemporarilyUnavailable = errors.New("provider check temporarily unavailable")
	// ErrCredentialSealed reports envelope decryption failed — the master
	// key does not match, or nonce/ciphertext/AAD were tampered with.
	ErrCredentialSealed = errors.New("provider credential envelope could not be opened")
	// ErrInvalidAdminState reports a PATCH body outside enabled|paused.
	ErrInvalidAdminState = errors.New("invalid admin state")
)

// Credential states and media capabilities are closed enumerations; helpers
// below keep persistence and transport honest to the same sets.
func ValidAdminState(v string) bool {
	return v == string(AdminStateEnabled) || v == string(AdminStatePaused)
}

// ProviderCheckResult is one completed connection check's model-visibility
// verdict. Each media degrades independently.
type ProviderCheckResult struct {
	ImageAvailable bool
	VideoAvailable bool
}

// MediaCapabilities maps the verdict onto the independent per-media states.
func (r ProviderCheckResult) MediaCapabilities() (image, video MediaCapability) {
	toCapability := func(visible bool) MediaCapability {
		if visible {
			return MediaCapabilityAvailable
		}
		return MediaCapabilityUnavailable
	}
	return toCapability(r.ImageAvailable), toCapability(r.VideoAvailable)
}

// ProviderCheckClient is the port for the instance-level connection check:
// one low-side-effect call against the fixed provider route that decides
// token validity and allowlisted-model visibility. The candidate key exists
// only for the call's duration.
type ProviderCheckClient interface {
	Check(ctx context.Context, candidateKey string) (ProviderCheckResult, error)
}

// CredentialKey is one master key: the AES-256 material plus the ID the
// versioned envelope persists to bind ciphertext to the sealing key.
type CredentialKey struct {
	ID       string
	Material [32]byte
}

// CredentialVault is the port owning the master key lifecycle and the AEAD
// envelope codec (ADR-0016 本地 AEAD). EnsureKey runs only on the explicit
// reauthenticated paths where a new ciphertext follows; LoadKey never
// writes, so a lost key under existing ciphertext surfaces as an error the
// service fails closed on — never silent regeneration.
type CredentialVault interface {
	EnsureKey() (CredentialKey, error)
	LoadKey() (CredentialKey, error)
	Seal(key CredentialKey, connectionID UUID, plaintext []byte) (ProviderCredentialEnvelope, error)
	Open(key CredentialKey, connectionID UUID, envelope ProviderCredentialEnvelope) ([]byte, error)
}

// MediaCapabilityView is one media's member-facing projection: status, a
// stable machine reason while not available, and one stable action advice.
// Endpoint, model ids, credential detail, and provider diagnostics never
// appear here (spec #150 Member surface).
type MediaCapabilityView struct {
	Status MediaCapability
	Reason string // empty when available
	Action string // empty when available
}

// MediaCapabilitiesView is the member surface's whole payload.
type MediaCapabilitiesView struct {
	Image MediaCapabilityView
	Video MediaCapabilityView
}

// DeriveMediaCapabilities projects the active connection into the member
// surface. The evaluation order is fixed so one snapshot yields one stable
// cause per media: checking, then credential verdicts, then pause, then
// each media's own visibility.
func DeriveMediaCapabilities(connection *ProviderConnection) MediaCapabilitiesView {
	notConfigured := MediaCapabilityView{
		Status: MediaCapabilityUnavailable,
		Reason: "not_configured",
		Action: "contact_admin",
	}
	if connection == nil {
		return MediaCapabilitiesView{Image: notConfigured, Video: notConfigured}
	}
	derive := func(media MediaCapability) MediaCapabilityView {
		switch {
		case connection.CredentialState == CredentialStateChecking || media == MediaCapabilityChecking:
			return MediaCapabilityView{Status: MediaCapabilityChecking, Reason: "checking", Action: "wait"}
		case connection.CredentialState == CredentialStateInvalid:
			return MediaCapabilityView{Status: MediaCapabilityUnavailable, Reason: "credential_invalid", Action: "contact_admin"}
		case connection.CredentialState == CredentialStateCredentialUnavailable:
			return MediaCapabilityView{Status: MediaCapabilityUnavailable, Reason: "credential_unavailable", Action: "contact_admin"}
		case connection.AdminState == AdminStatePaused:
			return MediaCapabilityView{Status: MediaCapabilityUnavailable, Reason: "connection_paused", Action: "contact_admin"}
		case media == MediaCapabilityAvailable:
			return MediaCapabilityView{Status: MediaCapabilityAvailable}
		default:
			return MediaCapabilityView{Status: MediaCapabilityUnavailable, Reason: "model_unavailable", Action: "contact_admin"}
		}
	}
	return MediaCapabilitiesView{Image: derive(connection.ImageCapability), Video: derive(connection.VideoCapability)}
}
