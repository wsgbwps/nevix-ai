package secrets

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// privateTempDir yields a secrets directory with the deployment's 0700
// discipline; t.TempDir alone lands at 0755 under the default umask.
func privateTempDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatalf("tighten temp dir: %v", err)
	}
	return dir
}

func TestEnvelopeRoundTripBindsConnectionIdentity(t *testing.T) {
	store := NewKeyStore(privateTempDir(t))
	key, err := store.Ensure()
	if err != nil {
		t.Fatalf("ensure key: %v", err)
	}
	connection := domain.NewUUID()
	envelope, err := Seal(key, connection, []byte("provider-key-material"))
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if envelope.Version != 1 || envelope.KeyID != key.ID || len(envelope.Nonce) != 12 {
		t.Fatalf("envelope shape: %+v", envelope)
	}
	if string(envelope.Ciphertext) == "provider-key-material" {
		t.Fatal("ciphertext is plaintext")
	}

	plaintext, err := Open(key, connection, envelope)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if string(plaintext) != "provider-key-material" {
		t.Fatalf("round trip mismatch: %q", plaintext)
	}

	// A second seal uses a fresh nonce; identical inputs never reuse one.
	again, err := Seal(key, connection, []byte("provider-key-material"))
	if err != nil {
		t.Fatalf("seal again: %v", err)
	}
	if string(again.Nonce) == string(envelope.Nonce) {
		t.Fatal("nonce reuse across seals")
	}
}

func TestEnvelopeRejectsAADAndCiphertextTampering(t *testing.T) {
	store := NewKeyStore(privateTempDir(t))
	key, err := store.Ensure()
	if err != nil {
		t.Fatalf("ensure key: %v", err)
	}
	connection := domain.NewUUID()
	envelope, err := Seal(key, connection, []byte("provider-key-material"))
	if err != nil {
		t.Fatalf("seal: %v", err)
	}

	// Swapping the AAD context (another connection identity) must fail.
	other, err := Open(key, domain.NewUUID(), envelope)
	if err == nil {
		t.Fatalf("envelope opened under a different connection identity: %q", other)
	}
	if !errors.Is(err, domain.ErrCredentialSealed) {
		t.Fatalf("AAD swap error = %v, want ErrCredentialSealed", err)
	}

	// Flipping ciphertext bytes must fail closed.
	tampered := envelope
	tampered.Ciphertext = append([]byte(nil), envelope.Ciphertext...)
	tampered.Ciphertext[0] ^= 0xFF
	if _, err := Open(key, connection, tampered); !errors.Is(err, domain.ErrCredentialSealed) {
		t.Fatalf("tampered ciphertext error = %v, want ErrCredentialSealed", err)
	}

	// A different master key cannot open the envelope.
	otherStore := NewKeyStore(privateTempDir(t))
	otherKey, err := otherStore.Ensure()
	if err != nil {
		t.Fatalf("ensure other key: %v", err)
	}
	if _, err := Open(otherKey, connection, envelope); !errors.Is(err, domain.ErrCredentialSealed) {
		t.Fatalf("wrong key error = %v, want ErrCredentialSealed", err)
	}
}

func TestKeyStoreEnsureCreatesPrivateAtomicArtifact(t *testing.T) {
	dir := privateTempDir(t)
	store := NewKeyStore(dir)
	key, err := store.Ensure()
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	info, err := os.Stat(filepath.Join(dir, "provider-credential-master.key"))
	if err != nil {
		t.Fatalf("key file: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("key file perms = %o, want 600", info.Mode().Perm())
	}
	dirInfo, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("key dir: %v", err)
	}
	if dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("key dir perms = %o, want 700", dirInfo.Mode().Perm())
	}
	// A second Ensure returns the same key — never a rotation.
	again, err := store.Ensure()
	if err != nil {
		t.Fatalf("ensure again: %v", err)
	}
	if again.ID != key.ID || again.Material != key.Material {
		t.Fatal("Ensure rotated an existing usable key")
	}
	// No temporary artifacts remain behind the atomic rename.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("stray artifacts in secrets dir: %v", entries)
	}
}

func TestKeyStoreLoadFailsClosedOnCorruption(t *testing.T) {
	dir := privateTempDir(t)
	store := NewKeyStore(dir)
	if _, err := store.Load(); !errors.Is(err, ErrKeyUnreadable) {
		t.Fatalf("missing key error = %v", err)
	}

	if _, err := store.Ensure(); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	keyPath := filepath.Join(dir, "provider-credential-master.key")

	if err := os.Chmod(keyPath, 0o644); err != nil {
		t.Fatalf("widen perms: %v", err)
	}
	if _, err := store.Load(); !errors.Is(err, ErrKeyFileNotPrivate) {
		t.Fatalf("wide perms error = %v", err)
	}
	if err := os.Chmod(keyPath, 0o600); err != nil {
		t.Fatalf("restore perms: %v", err)
	}

	if err := os.WriteFile(keyPath, []byte("short"), 0o600); err != nil {
		t.Fatalf("corrupt key: %v", err)
	}
	if _, err := store.Load(); !errors.Is(err, ErrKeyCorrupt) {
		t.Fatalf("corrupt key error = %v", err)
	}
}

func TestKeyStoreEnsureRefusesToWriteIntoWideDirectory(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatalf("widen dir: %v", err)
	}
	store := NewKeyStore(dir)
	if _, err := store.Ensure(); !errors.Is(err, ErrKeyDirectoryNotPrivate) {
		t.Fatalf("wide dir ensure error = %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "provider-credential-master.key")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("Ensure wrote a key into a too-open directory")
	}
}
