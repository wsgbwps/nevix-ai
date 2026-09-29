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
