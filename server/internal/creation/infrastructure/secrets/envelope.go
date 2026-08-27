package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"fmt"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// envelopeVersion is the single envelope format V1 knows how to open; a
// future format bumps it and carries its own open path.
const envelopeVersion = 1

// Seal encrypts one Provider Key under AES-256-GCM with a fresh random
// nonce. The AAD binds the version, the connection identity, the fixed
// provider, and the credential purpose — so a ciphertext moved to another
// connection (or another use) fails to open (ADR-0016).
func Seal(key domain.CredentialKey, connectionID domain.UUID, plaintext []byte) (domain.ProviderCredentialEnvelope, error) {
	aead, err := newAEAD(key)
	if err != nil {
		return domain.ProviderCredentialEnvelope{}, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return domain.ProviderCredentialEnvelope{}, fmt.Errorf("secrets: generate nonce: %w", err)
	}
	ciphertext := aead.Seal(nil, nonce, plaintext, additionalData(connectionID))
	return domain.ProviderCredentialEnvelope{
		Version:    envelopeVersion,
		KeyID:      key.ID,
		Nonce:      nonce,
		Ciphertext: ciphertext,
	}, nil
}

// Open decrypts an envelope, verifying the AAD binding. Any failure — wrong
// key, tampered nonce/ciphertext, or a swapped AAD context — is the single
// ErrCredentialSealed; the caller maps it to credential_unavailable without
// distinguishing causes.
func Open(key domain.CredentialKey, connectionID domain.UUID, envelope domain.ProviderCredentialEnvelope) ([]byte, error) {
	if envelope.Version != envelopeVersion {
		return nil, fmt.Errorf("secrets: unsupported envelope version %d", envelope.Version)
	}
	aead, err := newAEAD(key)
	if err != nil {
		return nil, err
	}
	plaintext, err := aead.Open(nil, envelope.Nonce, envelope.Ciphertext, additionalData(connectionID))
	if err != nil {
		return nil, domain.ErrCredentialSealed
	}
	return plaintext, nil
}

// additionalData is the AAD string binding a ciphertext to exactly one
// connection identity, the reviewed provider, and the credential purpose.
func additionalData(connectionID domain.UUID) []byte {
	return []byte(fmt.Sprintf("nevix.creation.provider_credential.v%d|%s|kapon|provider_key", envelopeVersion, connectionID.String()))
}

// newAEAD builds the AES-256-GCM cipher for one master key.
func newAEAD(key domain.CredentialKey) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key.Material[:])
	if err != nil {
		return nil, fmt.Errorf("secrets: build cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("secrets: build gcm: %w", err)
	}
	return aead, nil
}
