package domain

import "errors"

// Domain error taxonomy. The interface layer maps these sentinels onto the
// stable machine codes documented in contracts/creation.yaml; they are the
// only outcomes an application use-case may hand to the transport besides
// plain infrastructure failures (which collapse to 500 internal_error).
var (
	// ErrSessionNotFound reports that a session does not exist, does not
	// belong to the acting creator, or is logically deleted. The three are
	// deliberately indistinguishable so guessed ids learn nothing.
	ErrSessionNotFound = errors.New("session not found")
	// ErrMaterialNotFound applies the same indistinguishability to reference
	// materials, including materials under a deleted session.
	ErrMaterialNotFound = errors.New("material not found")
	// ErrInvalidCursor reports a cursor token that is malformed or does not
	// carry the compound sort keys of its list.
	ErrInvalidCursor = errors.New("invalid pagination cursor")
	// ErrMalformedUpload reports multipart framing damage: no file part,
	// truncated body, or a part missing the mandatory filename.
	ErrMalformedUpload = errors.New("malformed upload")
	// ErrTooLarge reports that the streamed upload exceeded the kind's byte
	// ceiling; the partial blob is discarded by the caller.
	ErrTooLarge = errors.New("material exceeds size limit")
	// ErrUnsupportedMedia reports content whose sniffed family is outside
	// the accepted set, or whose extension disagrees with the verified family.
	ErrUnsupportedMedia = errors.New("unsupported media type")
	// ErrUnreadableMedia reports family-valid content that fails authoritative
	// decoding: dimensions, pixel count, duration, or sample structure could
	// not be established.
	ErrUnreadableMedia = errors.New("unreadable media")
	// ErrReferenceOutsideEnvelope reports decodable media whose probed facts
	// fall outside the reference envelope the manifest publishes (image:
	// 256–6000 px per side, ≤36 MP, aspect 1:3..3:1). The material is never
	// persisted.
	ErrReferenceOutsideEnvelope = errors.New("reference media outside the published envelope")
	// ErrRangeNotSatisfiable reports a Range header that is syntactically
	// invalid, spans multiple ranges, or starts past the end of the blob.
	ErrRangeNotSatisfiable = errors.New("range not satisfiable")
	// ErrInvalidDraft reports a draft that violates the structural envelope:
	// a bound overflow, an unknown media type or role, or a reference binding
	// to a material outside the session (or of an incompatible kind). The
	// capability manifest is deliberately not consulted — stale values must
	// round-trip — so this is always a request-shape fault, not staleness.
	ErrInvalidDraft = errors.New("invalid session draft")
)

// Task-command errors. The interface layer maps these onto the stable codes
// documented in contracts/creation.yaml; governance rejections carry their
// machine reason so one evaluation yields one stable answer.
var (
	// ErrTaskNotFound applies the same indistinguishability as sessions:
	// foreign tasks and absent tasks look identical.
	ErrTaskNotFound = errors.New("generation task not found")
	// ErrIdempotencyPayloadConflict reports a reused idempotency key whose
	// frozen payload differs from the stored task's payload hash.
	ErrIdempotencyPayloadConflict = errors.New("idempotency key reused with a different payload")
	// ErrDraftRevisionConflict reports a submission based on a stale draft
	// revision; the stored draft is never silently rewritten.
	ErrDraftRevisionConflict = errors.New("draft changed since the submitted revision")
	// ErrDraftNotReady reports a draft that cannot form a generation intent
	// at all: never saved, missing target media, or structurally invalid.
	ErrDraftNotReady = errors.New("draft is not ready for submission")
	// ErrDraftCapabilityStale reports draft values outside the current
	// capability manifest; the draft keeps its values and blocks submission.
	ErrDraftCapabilityStale = errors.New("draft values are outside the current capability manifest")
	// ErrTaskNotTerminal reports a retry against a task that still owes work.
	ErrTaskNotTerminal = errors.New("generation task is not terminal")
	// ErrNoIncompleteSlots reports a retry against a task with nothing left
	// to retry — every slot already succeeded.
	ErrNoIncompleteSlots = errors.New("no incomplete slots to retry")
	// ErrTaskStateConflict reports a lost guarded transition race; workers
	// treat it as an expected serialization signal, never a 5xx.
	ErrTaskStateConflict = errors.New("task state transition lost the race")
)

// MediaUnavailableError reports admission blocked because the target media
// is not submittable on this instance right now. Reason mirrors the
// capability/manifest vocabulary the Workbench already displays.
type MediaUnavailableError struct {
	Reason string
	Action string
}

func (e *MediaUnavailableError) Error() string {
	return "media is not available for generation: " + e.Reason
}

// GovernanceBlockedError reports admission rejected by the fixed-order
// governance evaluation; Reason is one of the stable machine reasons.
type GovernanceBlockedError struct {
	Reason GovernanceReason
}

func (e *GovernanceBlockedError) Error() string {
	return "generation governance blocked: " + string(e.Reason)
}

// ErrGovernanceUserNotFound reports a user governance target that does not
// exist; the FK constraint is the durable twin.
var ErrGovernanceUserNotFound = errors.New("governance target user not found")
