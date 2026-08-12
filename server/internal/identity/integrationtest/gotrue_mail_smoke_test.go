// Package identity_test hosts the identity module's integration smoke tests.
// This file proves the GoTrue → captured mailbox (Mailpit) path: a signup
// against the local Supabase stack must produce a confirmation email in Mailpit.
//
// The test is opt-in: it runs only when the harness (scripts/test-identity-integration.sh
// locally and in CI) exports NEVIX_SUPABASE_URL, NEVIX_SUPABASE_PUBLISHABLE_KEY,
// and NEVIX_MAILPIT_URL. Without them it skips, so plain `go test ./...` stays
// green with no stack running.
package integrationtest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/identity/mailpittest"
)

func requireEnv(t *testing.T, key string) string {
	t.Helper()
	value := os.Getenv(key)
	if value == "" {
		if os.Getenv("NEVIX_IDENTITY_INTEGRATION_REQUESTED") == "1" {
			t.Fatalf("identity integration was requested, but %s is not set; run ./scripts/test-identity-integration.sh from the repository root to start the supported harness", key)
		}
		t.Skipf("identity integration was not requested: %s is not set (run ./scripts/test-identity-integration.sh)", key)
	}
	return value
}

func TestGoTrueSignupDeliversConfirmationEmailToMailpit(t *testing.T) {
	supabaseURL := requireEnv(t, "NEVIX_SUPABASE_URL")
	publishableKey := requireEnv(t, "NEVIX_SUPABASE_PUBLISHABLE_KEY")
	mailpitURL := requireEnv(t, "NEVIX_MAILPIT_URL")

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// Unique recipient per run so assertions never match mail from earlier runs.
	recipient := fmt.Sprintf("smoke-%d@nevix.test", time.Now().UnixNano())

	body, err := json.Marshal(map[string]string{
		"email":    recipient,
		"password": "smoke-test-password-1",
	})
	if err != nil {
		t.Fatalf("marshal signup body: %v", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, supabaseURL+"/auth/v1/signup", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("build signup request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("apikey", publishableKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("signup request against GoTrue: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		payload, _ := io.ReadAll(resp.Body)
		t.Fatalf("signup returned status %s: %s", resp.Status, payload)
	}

	mailpit := mailpittest.NewClient(mailpitURL)
	messages, err := mailpit.WaitForMessages(ctx, fmt.Sprintf("to:%q", recipient))
	if err != nil {
		t.Fatalf("confirmation email never reached Mailpit: %v", err)
	}
	if len(messages) != 1 {
		t.Fatalf("expected exactly 1 captured email for %s, got %d", recipient, len(messages))
	}
	message := messages[0]
	if len(message.To) != 1 || message.To[0].Address != recipient {
		t.Fatalf("captured email addressed to %+v, want exactly [%s]", message.To, recipient)
	}
	if message.Subject == "" {
		t.Fatalf("captured email for %s has an empty subject", recipient)
	}
}
