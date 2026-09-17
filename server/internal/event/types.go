package event

const SessionRevokedType = "identity.session-revoked"

// SessionRevoked carries the non-sensitive identity of one committed Session
// revocation. Bearer tokens and user or Creation data never cross this seam.
type SessionRevoked struct {
	SessionID string
}
