// Package readiness loads the deployment's Production Readiness evidence
// document. Evidence is a mounted deployment asset, not database state: the
// manual workflow (scripts/production-readiness) writes it after real Kapon
// runs, and the server re-reads it on restart.
package readiness

import (
	"errors"
	"fmt"
	"os"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// LoadEvidenceFile reads one evidence document. An unset path or a missing
// file is the valid "nothing activated yet" state every deployment ships in;
// a file that exists but cannot be parsed is a loud startup error — a
// corrupted authority document must never silently deactivate capabilities.
func LoadEvidenceFile(path string) (domain.ReadinessEvidence, error) {
	if path == "" {
		return domain.ReadinessEvidence{}, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return domain.ReadinessEvidence{}, nil
		}
		return domain.ReadinessEvidence{}, fmt.Errorf("creation: read production readiness evidence %s: %w", path, err)
	}
	evidence, err := domain.ParseReadinessEvidence(raw)
	if err != nil {
		return domain.ReadinessEvidence{}, fmt.Errorf("creation: production readiness evidence %s: %w", path, err)
	}
	return evidence, nil
}
