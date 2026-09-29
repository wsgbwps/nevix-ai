package application

import (
	"errors"
	"testing"

	"github.com/nevix-ai/server/internal/creation/domain"
)

func TestFreezeSpecificationUsesImageModelRatios(t *testing.T) {
	manifest := domain.DeriveCapabilityManifest(&domain.ProviderConnection{
		AdminState: domain.AdminStateEnabled, CredentialState: domain.CredentialStateValid,
		ImageCapability: domain.MediaCapabilityAvailable,
	})
	media := domain.DraftMediaImage
	mode, ratio, resolution, quantity := domain.ModeTextToImage, "1:8", "512", 1
	model := domain.GeminiModelID
	intent := &domain.GenerationIntent{
		Prompt: "wide image", MediaType: &media, ManifestVersion: manifest.ManifestVersion,
		Model: &model, Mode: &mode, Ratio: &ratio, Resolution: &resolution, Quantity: &quantity,
	}
	if spec, err := freezeSpecification(intent, manifest); err != nil || spec.Model != model || *spec.Ratio != ratio {
		t.Fatalf("Gemini-only ratio should freeze: spec=%+v err=%v", spec, err)
	}
	model = domain.ImageModelID
	resolution = "1K"
	if _, err := freezeSpecification(intent, manifest); !errors.Is(err, domain.ErrCapabilityStale) {
		t.Fatalf("Seedream must reject Gemini-only ratio, got %v", err)
	}
}

func TestFreezeSpecificationValidatesModelQuality(t *testing.T) {
	manifest := domain.DeriveCapabilityManifest(&domain.ProviderConnection{
		AdminState: domain.AdminStateEnabled, CredentialState: domain.CredentialStateValid,
		ImageCapability: domain.MediaCapabilityAvailable, VideoCapability: domain.MediaCapabilityAvailable,
	})
	media := domain.DraftMediaImage
	model, mode, ratio, resolution, quantity := domain.GPTFlareModelID, domain.ModeTextToImage, "1:1", "1K", 1
	intent := &domain.GenerationIntent{
		Prompt: "image", MediaType: &media, ManifestVersion: manifest.ManifestVersion,
		Model: &model, Mode: &mode, Ratio: &ratio, Resolution: &resolution, Quantity: &quantity,
	}
	spec, err := freezeSpecification(intent, manifest)
	if err != nil || spec.SchemaVersion != 2 || spec.Quality == nil || *spec.Quality != "high" {
		t.Fatalf("omitted GPT quality must freeze high: spec=%+v err=%v", spec, err)
	}
	quality := "max"
	intent.Quality = &quality
	spec, err = freezeSpecification(intent, manifest)
	if err != nil || spec.Quality == nil || *spec.Quality != "max" {
		t.Fatalf("chosen GPT quality must freeze: spec=%+v err=%v", spec, err)
	}
	for _, invalid := range []string{"auto", "ultra", ""} {
		intent.Quality = &invalid
		if _, err := freezeSpecification(intent, manifest); !errors.Is(err, domain.ErrCapabilityStale) {
			t.Fatalf("GPT quality %q must fail, got %v", invalid, err)
		}
	}
	quality = "high"
	model = domain.ImageModelID
	resolution = "2K"
	intent.Quality = &quality
	if _, err := freezeSpecification(intent, manifest); !errors.Is(err, domain.ErrCapabilityStale) {
		t.Fatalf("non-GPT quality must fail, got %v", err)
	}
}
