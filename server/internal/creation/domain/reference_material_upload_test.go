package domain

import (
	"testing"
	"time"
)

func TestReferenceMaterialUploadResilienceContract(t *testing.T) {
	if ReferenceMaterialUploadVerifying != "verifying" || ReferenceMaterialUploadTerminal != "terminal" {
		t.Fatal("resilient upload states must remain stable wire values")
	}
	if ReferenceMaterialVerificationLifetime != 30*time.Minute {
		t.Fatalf("verification lease = %s, want 30m", ReferenceMaterialVerificationLifetime)
	}
}
