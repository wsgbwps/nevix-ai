package application

import (
	"context"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

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

// displayVariant is which fixed transformation a grant signs: the wall's
// lightweight image variant, or the detail's full preview — the untouched
// original for video and audio, so Chromium keeps Range and seek.
type displayVariant int

const (
	displayThumbnail displayVariant = iota
	displayPreview
)

// authorizeDisplay signs one exact object's fixed display variant. The caller
// has already re-checked the read right through that resource identity's own
// visibility query, which is the only authorization point: this signs the key
// that query returned, so a grant can never address a neighbouring object
// (ADR-0016).
func authorizeDisplay(ctx context.Context, storage *ObjectStorageConnectionService, key string, kind domain.Kind, variant displayVariant) (DisplayURLAuthorization, error) {
	store, _, err := storage.ResolveStore(ctx)
	if err != nil {
		return DisplayURLAuthorization{}, err
	}
	var signedURL string
	if variant == displayThumbnail {
		signedURL, err = store.PresignThumbnail(ctx, key, displayURLLifetime)
	} else {
		signedURL, err = store.PresignPreview(ctx, key, kind, displayURLLifetime)
	}
	if err != nil {
		return DisplayURLAuthorization{}, domain.ErrObjectStorageUnavailable
	}
	return DisplayURLAuthorization{URL: signedURL, ExpiresAt: time.Now().UTC().Add(displayURLLifetime)}, nil
}
