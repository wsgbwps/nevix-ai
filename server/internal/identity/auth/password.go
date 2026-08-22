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

// bcryptCost is the bcrypt work factor. Deliberately a constant: the
// deployment profile is a few hundred users on customer intranets, and the
// cost is revisited only with evidence.
const bcryptCost = 10

// validateNewPassword enforces the policy for every credential-setting path
// (bootstrap here; admin-created accounts later).
func validateNewPassword(password string) error {
	if len(password) < minPasswordLength {
		return fmt.Errorf("auth: password must be at least %d characters", minPasswordLength)
	}
	return nil
}

// hashPassword returns the bcrypt hash of a policy-valid password.
func hashPassword(password string) (string, error) {
	if err := validateNewPassword(password); err != nil {
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

// normalizeEmail canonicalizes a login email: trimmed, lowercased, and a bare
// RFC 5322 address (a display-name form is rejected). Email is the unique
// login identifier, so every comparison runs on this canonical form.
func normalizeEmail(raw string) (string, error) {
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
