// Package identity is the identity Module. This slice holds the Outbox
// Worker: SMTP deployment configuration, the retry backoff schedule, and the
// pure deliverer that polls identity.outbox_messages and sends over standard
// SMTP.
package identity

import (
	"fmt"
	"strconv"
)

// SMTPConfig is the standard-SMTP delivery endpoint. The same four deployment
// variables cover Mailpit locally and Resend (the provider) in production;
// switching providers changes configuration only, never code.
type SMTPConfig struct {
	Host     string
	Port     int
	User     string
	Password string
}

// LoadSMTPConfig reads SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASSWORD via
// getenv. Any missing or invalid variable is an error naming that variable, so
// a misconfigured process fails explicitly at startup instead of at first send.
func LoadSMTPConfig(getenv func(string) string) (SMTPConfig, error) {
	var missing []string
	for _, key := range []string{"SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"} {
		if getenv(key) == "" {
			missing = append(missing, key)
		}
	}
	if len(missing) > 0 {
		return SMTPConfig{}, fmt.Errorf("identity: missing required SMTP deployment variables: %v", missing)
	}
	port, err := strconv.Atoi(getenv("SMTP_PORT"))
	if err != nil {
		return SMTPConfig{}, fmt.Errorf("identity: SMTP_PORT %q is not a number: %w", getenv("SMTP_PORT"), err)
	}
	return SMTPConfig{
		Host:     getenv("SMTP_HOST"),
		Port:     port,
		User:     getenv("SMTP_USER"),
		Password: getenv("SMTP_PASSWORD"),
	}, nil
}
