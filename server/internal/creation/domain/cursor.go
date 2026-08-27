package domain

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"
)

// The compound keyset cursor's wire codec lives with its value object: both
// the HTTP interface (query parameter) and the PostgreSQL repositories (page
// positions) serialize the same domain token, so neither layer depends on
// the other.

// encodedCursor is the on-the-wire cursor envelope: both sort keys travel in
// every token so paging never depends on server-side sessions.
type encodedCursor struct {
	T int64  `json:"t"`
	I string `json:"i"`
}

// EncodeCursor serializes one token. Decoding failures map to
// ErrInvalidCursor rather than being silently ignored.
func EncodeCursor(c CompoundCursor) string {
	payload, err := json.Marshal(encodedCursor{T: c.CreatedAt.UTC().UnixNano(), I: c.ID.String()})
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(payload)
}

// DecodeCursor parses one opaque token back into its sort keys.
func DecodeCursor(raw string) (CompoundCursor, error) {
	var decoded encodedCursor
	blob, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || json.Unmarshal(blob, &decoded) != nil {
		return CompoundCursor{}, fmt.Errorf("%w: %s", ErrInvalidCursor, "cursor payload")
	}
	id, err := ParseUUID(decoded.I)
	if err != nil {
		return CompoundCursor{}, fmt.Errorf("%w: %s", ErrInvalidCursor, "cursor id")
	}
	return CompoundCursor{
		CreatedAt: time.Unix(0, decoded.T).UTC(),
		ID:        id,
	}, nil
}
