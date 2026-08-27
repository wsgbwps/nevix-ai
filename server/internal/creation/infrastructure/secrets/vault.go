package secrets

import (
	"github.com/nevix-ai/server/internal/creation/domain"
)

// Vault is the production CredentialVault: the secrets-volume master key
// store plus the AES-256-GCM envelope codec behind one domain port.
type Vault struct {
	store *KeyStore
}

// NewVault binds the vault to one secrets directory.
func NewVault(dir string) *Vault { return &Vault{store: NewKeyStore(dir)} }

// EnsureKey implements the explicit reauthenticated establishment path.
func (v *Vault) EnsureKey() (domain.CredentialKey, error) { return v.store.Ensure() }

// LoadKey implements the never-write load path.
func (v *Vault) LoadKey() (domain.CredentialKey, error) { return v.store.Load() }

// Seal encrypts one Provider Key under the connection-bound AAD.
func (v *Vault) Seal(key domain.CredentialKey, connectionID domain.UUID, plaintext []byte) (domain.ProviderCredentialEnvelope, error) {
	return Seal(key, connectionID, plaintext)
}

// Open decrypts one envelope; every failure is the domain's sealed sentinel.
func (v *Vault) Open(key domain.CredentialKey, connectionID domain.UUID, envelope domain.ProviderCredentialEnvelope) ([]byte, error) {
	return Open(key, connectionID, envelope)
}
