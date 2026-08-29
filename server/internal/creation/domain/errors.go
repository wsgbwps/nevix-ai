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
