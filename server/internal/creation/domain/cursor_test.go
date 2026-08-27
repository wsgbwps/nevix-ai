package domain

import (
	"testing"
	"time"
)

func TestCursorRoundTripAndTamperResistance(t *testing.T) {
	original := CompoundCursor{
		CreatedAt: time.Unix(0, 1_756_000_000_000_000_000).UTC(),
		ID:        NewUUID(),
	}
	token := EncodeCursor(original)
	if token == "" {
		t.Fatal("encode produced empty token")
	}
	decoded, err := DecodeCursor(token)
	if err != nil || !decoded.CreatedAt.Equal(original.CreatedAt) || decoded.ID != original.ID {
		t.Fatalf("round trip: %+v err=%v", decoded, err)
	}

	for _, bad := range []string{"!!!not-base64!!!", "eyJ0IjoxfQ"} {
		if _, err := DecodeCursor(bad); err == nil {
			t.Errorf("DecodeCursor(%q) accepted garbage", bad)
		}
	}
}
