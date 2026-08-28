package application

import (
	"context"
	"errors"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// ManifestService projects the authoritative Capability Manifest: the
// Nevix-global readiness evidence (loaded once at module construction) merged
// with the instance's live Provider Connection facts on every read. Reads
// never mutate either input — readiness gates declarations, connections keep
// their own check facts.
type ManifestService struct {
	connections domain.ProviderConnectionRepository
	evidence    domain.ReadinessEvidence
}

func NewManifestService(connections domain.ProviderConnectionRepository, evidence domain.ReadinessEvidence) *ManifestService {
	return &ManifestService{connections: connections, evidence: evidence}
}

// CapabilityManifest answers the current manifest view for any active user;
// admins and members receive the identical payload.
func (s *ManifestService) CapabilityManifest(ctx context.Context) (domain.CapabilityManifestView, error) {
	connection, err := s.connections.GetActive(ctx)
	if err != nil {
		if errors.Is(err, domain.ErrConnectionNotConfigured) {
			return domain.DeriveCapabilityManifest(s.evidence, nil), nil
		}
		return domain.CapabilityManifestView{}, err
	}
	return domain.DeriveCapabilityManifest(s.evidence, &connection), nil
}
