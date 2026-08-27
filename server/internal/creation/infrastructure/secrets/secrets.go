// Package secrets owns the Provider Credential master key (ADR-0016 本地
// AEAD): one 32-byte CSPRNG key in an out-of-database secrets volume with
// directory 0700, file 0600, and atomic creation. Loading validates
// permissions and size; a missing, unreadable, too-open, or corrupt key is a
// typed failure the connection maps to credential_unavailable — with
// ciphertext present the key file is never silently regenerated, so the
// recovery clue (re-entering the key as the admin) stays authoritative.
package secrets

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// masterKeyBytes is the fixed AES-256 key size.
const masterKeyBytes = 32

// Key file failures distinguishable by policy. All of them mean the master
// key cannot be trusted right now; none of them may regenerate a key behind
// an existing ciphertext.
var (
	// ErrKeyDirectoryNotPrivate reports the secrets directory exists with
	// permissions wider than 0700.
	ErrKeyDirectoryNotPrivate = errors.New("secrets: key directory permissions are wider than 0700")
	// ErrKeyFileNotPrivate reports the key file exists with permissions
	// wider than 0600.
	ErrKeyFileNotPrivate = errors.New("secrets: key file permissions are wider than 0600")
	// ErrKeyCorrupt reports a key file whose content is not exactly 32
	// bytes.
	ErrKeyCorrupt = errors.New("secrets: master key file is corrupt")
	// ErrKeyUnreadable reports an unreadable key file or directory (missing
	// permissions, I/O failure, or absence).
	ErrKeyUnreadable = errors.New("secrets: master key file is unreadable")
)

// KeyStore addresses the master key inside one secrets directory.
type KeyStore struct {
	dir      string
	fileName string
}

// NewKeyStore binds the store to a directory; the key file name is fixed so
// operators and backup procedures address one canonical artifact.
func NewKeyStore(dir string) *KeyStore {
	return &KeyStore{dir: dir, fileName: "provider-credential-master.key"}
}

// Load returns the existing master key. Every failure mode — missing,
// unreadable, wrong permissions, wrong size — is typed; callers translate
// them into credential_unavailable without ever writing to disk.
func (s *KeyStore) Load() (domain.CredentialKey, error) {
	if err := s.requirePrivateDir(); err != nil {
		return domain.CredentialKey{}, err
	}
	path := filepath.Join(s.dir, s.fileName)
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, fs.ErrPermission) {
			return domain.CredentialKey{}, ErrKeyUnreadable
		}
		return domain.CredentialKey{}, fmt.Errorf("secrets: stat key file: %w", err)
	}
	if !info.Mode().IsRegular() {
		return domain.CredentialKey{}, ErrKeyCorrupt
	}
	if info.Mode().Perm() != 0o600 {
		return domain.CredentialKey{}, ErrKeyFileNotPrivate
	}
	material, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrPermission) {
			return domain.CredentialKey{}, ErrKeyUnreadable
		}
		return domain.CredentialKey{}, fmt.Errorf("secrets: read key file: %w", err)
	}
	if len(material) != masterKeyBytes {
		return domain.CredentialKey{}, ErrKeyCorrupt
	}
	return newCredentialKey(material), nil
}

// Ensure returns a usable master key, establishing the key file atomically
// only when none exists. Callers invoke it exclusively on the explicit
// reauthenticated paths where writing a new ciphertext follows: first-time
// configuration (no ciphertext can exist) and credential replacement (the
// sanctioned recovery that re-establishes the key before sealing the new
// envelope). An existing readable key is returned as-is; an existing but
// corrupt or too-open key is replaced only by that explicit recovery — never
// silently.
func (s *KeyStore) Ensure() (domain.CredentialKey, error) {
	key, err := s.Load()
	if err == nil {
		return key, nil
	}
	switch {
	case errors.Is(err, ErrKeyUnreadable), errors.Is(err, ErrKeyCorrupt), errors.Is(err, ErrKeyFileNotPrivate):
	case errors.Is(err, ErrKeyDirectoryNotPrivate):
		// A too-open directory would expose the fresh key the moment it is
		// written; recovery must fix the directory first.
		return domain.CredentialKey{}, err
	default:
		return domain.CredentialKey{}, err
	}
	if err := s.ensurePrivateDir(); err != nil {
		return domain.CredentialKey{}, err
	}
	material := make([]byte, masterKeyBytes)
	if _, err := rand.Read(material); err != nil {
		return domain.CredentialKey{}, fmt.Errorf("secrets: generate master key: %w", err)
	}
	if err := s.writeAtomically(material); err != nil {
		return domain.CredentialKey{}, err
	}
	return newCredentialKey(material), nil
}

// ensurePrivateDir creates the secrets directory with 0700 or verifies an
// existing one already has exactly that protection.
func (s *KeyStore) ensurePrivateDir() error {
	info, err := os.Stat(s.dir)
	if err == nil {
		if !info.IsDir() {
			return fmt.Errorf("secrets: key path %s is not a directory", s.dir)
		}
		if info.Mode().Perm() != 0o700 {
			return ErrKeyDirectoryNotPrivate
		}
		return nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("secrets: stat key directory: %w", err)
	}
	if err := os.Mkdir(s.dir, 0o700); err != nil {
		return fmt.Errorf("secrets: create key directory: %w", err)
	}
	// umask can only narrow permissions, but verify what actually landed.
	return s.requirePrivateDir()
}

// requirePrivateDir validates an existing directory is exactly 0700.
func (s *KeyStore) requirePrivateDir() error {
	info, err := os.Stat(s.dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, fs.ErrPermission) {
			return ErrKeyUnreadable
		}
		return fmt.Errorf("secrets: stat key directory: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("secrets: key path %s is not a directory", s.dir)
	}
	if info.Mode().Perm() != 0o700 {
		return ErrKeyDirectoryNotPrivate
	}
	return nil
}

// writeAtomically installs the key file: write to a private temporary file
// in the same directory, fsync, rename over the target, then fsync the
// directory so a crash never leaves a partially written or extra-permissive
// key behind.
func (s *KeyStore) writeAtomically(material []byte) error {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return fmt.Errorf("secrets: create key directory: %w", err)
	}
	tmp, err := os.CreateTemp(s.dir, ".master-key-*")
	if err != nil {
		return fmt.Errorf("secrets: create temporary key file: %w", err)
	}
	tmpName := tmp.Name()
	defer func() {
		tmp.Close()
		os.Remove(tmpName)
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return fmt.Errorf("secrets: protect temporary key file: %w", err)
	}
	if _, err := tmp.Write(material); err != nil {
		return fmt.Errorf("secrets: write temporary key file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("secrets: sync temporary key file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("secrets: close temporary key file: %w", err)
	}
	if err := os.Rename(tmpName, filepath.Join(s.dir, s.fileName)); err != nil {
		return fmt.Errorf("secrets: install key file: %w", err)
	}
	dir, err := os.Open(s.dir)
	if err != nil {
		return fmt.Errorf("secrets: open key directory for sync: %w", err)
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil {
		return fmt.Errorf("secrets: sync key directory: %w", err)
	}
	return nil
}

// newCredentialKey derives the envelope key ID from the material.
func newCredentialKey(material []byte) domain.CredentialKey {
	var key domain.CredentialKey
	copy(key.Material[:], material)
	digest := sha256.Sum256(key.Material[:])
	key.ID = hex.EncodeToString(digest[:8])
	return key
}
