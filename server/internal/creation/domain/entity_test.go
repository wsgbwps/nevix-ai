package domain

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func validIntent() *GenerationIntent {
	media := DraftMediaImage
	model := "doubao-seedream-5.0-pro"
	mode := "reference-image"
	ratio := "4:5"
	resolution := "2K"
	quantity := 2
	return &GenerationIntent{
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

func TestGenerationIntentValidateAcceptsTheStructuralEnvelope(t *testing.T) {
	// The widest legal intent validates without a manifest being consulted:
	// stale values must reach the admission freeze, so nothing here names a
	// real capability.
	intent := validIntent()
	stale := "removed-legacy-model"
	intent.Model = &stale
	if err := intent.Validate(); err != nil {
		t.Fatalf("legal intent rejected: %v", err)
	}

	empty := &GenerationIntent{ManifestVersion: 1}
	if err := empty.Validate(); err != nil {
		t.Fatalf("empty intent must stay legal: %v", err)
	}
}

func TestGenerationIntentValidateRejectsEnvelopeViolations(t *testing.T) {
	t.Run("prompt over 2000 runes", func(t *testing.T) {
		intent := validIntent()
		intent.Prompt = strings.Repeat("啊", DraftPromptMaxChars+1)
		if err := intent.Validate(); err != ErrInvalidIntent {
			t.Fatalf("want ErrInvalidIntent, got %v", err)
		}
		if got := utf8.RuneCountInString(strings.Repeat("啊", DraftPromptMaxChars)); got != 2000 {
			t.Fatalf("boundary fixture broken: %d", got)
		}
	})
	t.Run("unknown media type", func(t *testing.T) {
		intent := validIntent()
		audio := DraftMediaType("audio")
		intent.MediaType = &audio
		if err := intent.Validate(); err != ErrInvalidIntent {
			t.Fatalf("want ErrInvalidIntent, got %v", err)
		}
	})
	t.Run("manifest version below one", func(t *testing.T) {
		intent := validIntent()
		intent.ManifestVersion = 0
		if err := intent.Validate(); err != ErrInvalidIntent {
			t.Fatalf("want ErrInvalidIntent, got %v", err)
		}
	})
	t.Run("quantity out of range", func(t *testing.T) {
		intent := validIntent()
		quantity := 5
		intent.Quantity = &quantity
		if err := intent.Validate(); err != ErrInvalidIntent {
			t.Fatalf("want ErrInvalidIntent, got %v", err)
		}
	})
	t.Run("non-positive duration", func(t *testing.T) {
		intent := validIntent()
		duration := 0
		intent.DurationSeconds = &duration
		if err := intent.Validate(); err != ErrInvalidIntent {
			t.Fatalf("want ErrInvalidIntent, got %v", err)
		}
	})
	t.Run("over four references", func(t *testing.T) {
		intent := validIntent()
		intent.References = make([]DraftReference, DraftMaxReferenceFrames+1)
		for i := range intent.References {
			intent.References[i] = DraftReference{MaterialID: NewUUID(), Role: RoleOmni}
		}
		if err := intent.Validate(); err != ErrInvalidIntent {
			t.Fatalf("want ErrInvalidIntent, got %v", err)
		}
	})
	t.Run("unknown role", func(t *testing.T) {
		intent := validIntent()
		intent.References = []DraftReference{{MaterialID: NewUUID(), Role: DraftRole("hero")}}
		if err := intent.Validate(); err != ErrInvalidIntent {
			t.Fatalf("want ErrInvalidIntent, got %v", err)
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
