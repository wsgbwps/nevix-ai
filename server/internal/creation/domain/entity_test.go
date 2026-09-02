package domain

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func validDraft() *SessionDraft {
	media := DraftMediaImage
	model := "doubao-seedream-5.0-pro"
	mode := "reference-image"
	ratio := "4:5"
	resolution := "2K"
	quantity := 2
	return &SessionDraft{
		Prompt:          "夏季跑鞋主图",
		MediaType:       &media,
		ManifestVersion: 1,
		Model:           &model,
		Mode:            &mode,
		Ratio:           &ratio,
		Resolution:      &resolution,
		Quantity:        &quantity,
		References:      []DraftReference{{MaterialID: NewUUID(), Role: RoleReference}},
	}
}

func TestSessionDraftValidateAcceptsTheStructuralEnvelope(t *testing.T) {
	// The widest legal draft saves without a manifest being consulted: stale
	// values must round-trip, so nothing here names a real capability.
	draft := validDraft()
	stale := "removed-legacy-model"
	draft.Model = &stale
	if err := draft.Validate(); err != nil {
		t.Fatalf("legal draft rejected: %v", err)
	}

	empty := &SessionDraft{ManifestVersion: 1}
	if err := empty.Validate(); err != nil {
		t.Fatalf("empty draft must stay legal: %v", err)
	}
}

func TestSessionDraftValidateRejectsEnvelopeViolations(t *testing.T) {
	t.Run("prompt over 2000 runes", func(t *testing.T) {
		draft := validDraft()
		draft.Prompt = strings.Repeat("啊", DraftPromptMaxChars+1)
		if err := draft.Validate(); err != ErrInvalidDraft {
			t.Fatalf("want ErrInvalidDraft, got %v", err)
		}
		if got := utf8.RuneCountInString(strings.Repeat("啊", DraftPromptMaxChars)); got != 2000 {
			t.Fatalf("boundary fixture broken: %d", got)
		}
	})
	t.Run("unknown media type", func(t *testing.T) {
		draft := validDraft()
		audio := DraftMediaType("audio")
		draft.MediaType = &audio
		if err := draft.Validate(); err != ErrInvalidDraft {
			t.Fatalf("want ErrInvalidDraft, got %v", err)
		}
	})
	t.Run("manifest version below one", func(t *testing.T) {
		draft := validDraft()
		draft.ManifestVersion = 0
		if err := draft.Validate(); err != ErrInvalidDraft {
			t.Fatalf("want ErrInvalidDraft, got %v", err)
		}
	})
	t.Run("quantity out of range", func(t *testing.T) {
		draft := validDraft()
		quantity := 5
		draft.Quantity = &quantity
		if err := draft.Validate(); err != ErrInvalidDraft {
			t.Fatalf("want ErrInvalidDraft, got %v", err)
		}
	})
	t.Run("non-positive duration", func(t *testing.T) {
		draft := validDraft()
		duration := 0
		draft.DurationSeconds = &duration
		if err := draft.Validate(); err != ErrInvalidDraft {
			t.Fatalf("want ErrInvalidDraft, got %v", err)
		}
	})
	t.Run("over four references", func(t *testing.T) {
		draft := validDraft()
		draft.References = make([]DraftReference, DraftMaxReferenceFrames+1)
		for i := range draft.References {
			draft.References[i] = DraftReference{MaterialID: NewUUID(), Role: RoleOmni}
		}
		if err := draft.Validate(); err != ErrInvalidDraft {
			t.Fatalf("want ErrInvalidDraft, got %v", err)
		}
	})
	t.Run("unknown role", func(t *testing.T) {
		draft := validDraft()
		draft.References = []DraftReference{{MaterialID: NewUUID(), Role: DraftRole("hero")}}
		if err := draft.Validate(); err != ErrInvalidDraft {
			t.Fatalf("want ErrInvalidDraft, got %v", err)
		}
	})
}

func TestDraftRoleAcceptsKind(t *testing.T) {
	cases := []struct {
		role    DraftRole
		kind    Kind
		allowed bool
	}{
		{RoleReference, KindImage, true},
		{RoleReference, KindVideo, false},
		{RoleReference, KindAudio, false},
		{RoleFirstFrame, KindImage, true},
		{RoleFirstFrame, KindAudio, false},
		{RoleLastFrame, KindImage, true},
		{RoleOmni, KindImage, true},
		{RoleOmni, KindVideo, true},
		{RoleOmni, KindAudio, true},
	}
	for _, entry := range cases {
		if got := entry.role.AcceptsKind(entry.kind); got != entry.allowed {
			t.Fatalf("%s accepts %s = %v, want %v", entry.role, entry.kind, got, entry.allowed)
		}
	}
}
