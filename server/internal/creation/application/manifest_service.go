package application

import (
	"context"
	"errors"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// ManifestService projects the source-controlled Capability Manifest with the
// instance's live Provider Connection facts on every read.
type ManifestService struct {
	connections domain.ProviderConnectionRepository
}

func NewManifestService(connections domain.ProviderConnectionRepository) *ManifestService {
	return &ManifestService{connections: connections}
}

// CapabilityManifest answers the current manifest view for any active user;
// admins and members receive the identical payload.
func (s *ManifestService) CapabilityManifest(ctx context.Context) (domain.CapabilityManifestView, error) {
	connection, err := s.connections.GetActive(ctx)
	if err != nil {
		if errors.Is(err, domain.ErrConnectionNotConfigured) {
			return domain.DeriveCapabilityManifest(nil), nil
		}
		return domain.CapabilityManifestView{}, err
	}
	return domain.DeriveCapabilityManifest(&connection), nil
}
