// Password hashing and policy for the user system. Hashes are bcrypt strings;
// the only policy is a minimum length (ADR-0015) — no composition rules.
package auth

import (
	"fmt"
	"net/mail"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

// minPasswordLength is the whole password policy (ADR-0015).
const minPasswordLength = 8

// maxPasswordBytes is the bcrypt generator's hard capacity: generation of a
// longer input fails inside the hasher, so request validation rejects it
// with a documented 400 instead of surfacing that limit as a 500. Below the
// cap the policy stays minimum-length-only (ADR-0015); the bound is an
// encoding constraint, not a composition rule. Verification of longer
// candidates is unaffected: bcrypt comparison truncates above the cap the
// same way generation does.
const maxPasswordBytes = 72

// bcryptCost is the bcrypt work factor. Deliberately a constant: the
// deployment profile is a few hundred users on customer intranets, and the
// cost is revisited only with evidence.
const bcryptCost = 10

// ValidateNewPassword enforces the policy for every credential-setting path
// (bootstrap, admin-created accounts, admin resets). Exported so the
// user-governance request shapes validate against the same single rule.
func ValidateNewPassword(password string) error {
	if len(password) < minPasswordLength {
		return fmt.Errorf("auth: password must be at least %d characters", minPasswordLength)
	}
	return nil
}

// HashPassword returns the bcrypt hash of a policy-valid password. Exported
// for the user-governance commands, which set credentials through the same
// single password-policy owner (admin create and reset).
func HashPassword(password string) (string, error) {
	if err := ValidateNewPassword(password); err != nil {
		return "", err
	}
	hashed, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return "", fmt.Errorf("auth: hash password: %w", err)
	}
	return string(hashed), nil
}

// verifyPassword reports whether the candidate matches the stored hash. A
// malformed stored hash is a mismatch, not an error: the account is simply not
// usable until its password is reset.
func verifyPassword(storedHash, candidate string) bool {
	return bcrypt.CompareHashAndPassword([]byte(storedHash), []byte(candidate)) == nil
}

// NormalizeEmail canonicalizes a login email: trimmed, lowercased, and a bare
// RFC 5322 address (a display-name form is rejected). Email is the unique
// login identifier, so every comparison runs on this canonical form.
// Exported so the user-governance commands validate against the same rule.
func NormalizeEmail(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	address, err := mail.ParseAddress(trimmed)
	if err != nil || address.Address != trimmed {
		return "", fmt.Errorf("auth: email must be a bare address")
	}
	normalized := strings.ToLower(trimmed)
	if normalized != trimmed && !validLowercasedAddress(normalized) {
		return "", fmt.Errorf("auth: email must be a bare address")
	}
	return normalized, nil
}

// validLowercasedAddress re-parses after lowercasing so an address whose
// local part was quoted (case-significant) is not silently rewritten.
func validLowercasedAddress(lowered string) bool {
	address, err := mail.ParseAddress(lowered)
	return err == nil && address.Address == lowered
}
