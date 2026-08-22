// Unit tests for password policy, bcrypt round-trips, and email
// canonicalization. No database required.
package auth

import (
	"strings"
	"testing"
)

func TestHashPasswordRoundTrips(t *testing.T) {
	hash, err := hashPassword("correct horse battery")
	if err != nil {
		t.Fatalf("hashPassword: %v", err)
	}
	if strings.HasPrefix(hash, "correct") || len(hash) < 20 {
		t.Fatalf("hash %q does not look like a bcrypt string", hash)
	}
	if !verifyPassword(hash, "correct horse battery") {
		t.Fatal("stored hash does not verify against the same password")
	}
	if verifyPassword(hash, "wrong password") {
		t.Fatal("stored hash verifies against a different password")
	}
}

func TestHashPasswordEnforcesMinimumLength(t *testing.T) {
	if _, err := hashPassword("short"); err == nil {
		t.Fatal("password shorter than the minimum was accepted")
	}
	if err := validateNewPassword(strings.Repeat("x", minPasswordLength)); err != nil {
		t.Fatalf("policy-valid password rejected: %v", err)
	}
}

func TestVerifyPasswordRejectsMalformedStoredHash(t *testing.T) {
	if verifyPassword("not-a-bcrypt-hash", "whatever") {
		t.Fatal("malformed stored hash verified")
	}
}

func TestNormalizeEmail(t *testing.T) {
	valid := map[string]string{
		"User@Example.com":            "user@example.com",
		"  user@example.com":          "user@example.com",
		"user.name+x@sub.example.com": "user.name+x@sub.example.com",
	}
	for raw, want := range valid {
		got, err := normalizeEmail(raw)
		if err != nil {
			t.Fatalf("normalizeEmail(%q): %v", raw, err)
		}
		if got != want {
			t.Fatalf("normalizeEmail(%q) = %q, want %q", raw, got, want)
		}
	}
	for _, raw := range []string{"", "not-an-email", "Display Name <user@example.com>", "user@example.com extra"} {
		if _, err := normalizeEmail(raw); err == nil {
			t.Fatalf("normalizeEmail(%q) accepted a non-bare address", raw)
		}
	}
}
