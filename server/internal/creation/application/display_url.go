package application

import "time"

// displayURLLifetime is how long one issued display grant stays usable. It is
// also the revocation window: restricting, withdrawing, or logically deleting a
// resource blocks the next authorization immediately, but a URL already handed
// to the renderer keeps working until it expires (ADR-0016).
const displayURLLifetime = 10 * time.Minute

// DisplayURLAuthorization is one resource's ephemeral display grant: a signed
// GET for one exact object, plus the moment the renderer must ask Go again.
// Never persisted, logged, or copied outside the authorized renderer.
type DisplayURLAuthorization struct {
	URL       string
	ExpiresAt time.Time
}
