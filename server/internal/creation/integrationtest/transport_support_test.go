package integrationtest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"
)

// doRequest issues one HTTP call against the harness server with an optional
// bearer token and JSON body.
func (h *harness) doRequest(t *testing.T, method, path, token string, body any) (int, []byte) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		blob, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body for %s %s: %v", method, path, err)
		}
		reader = bytes.NewReader(blob)
	}
	req, err := http.NewRequestWithContext(h.ctx, method, h.serverURL+path, reader)
	if err != nil {
		t.Fatalf("build request %s %s: %v", method, path, err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read response %s %s: %v", method, path, err)
	}
	return resp.StatusCode, respBody
}

// claimAdmin provisions the first Admin through the public Instance Claim
// (open mode); it must run before any member exists.
func (h *harness) claimAdmin(t *testing.T) string {
	t.Helper()
	status, body := h.doRequest(t, "POST", "/identity/setup/initialize", "", map[string]any{
		"email":        harnessAdminEmail,
		"password":     harnessAdminPassword,
		"display_name": "Instance Admin",
	})
	if status != http.StatusOK && status != http.StatusCreated {
		t.Fatalf("claim first admin: status=%d body=%s", status, body)
	}
	return extractToken(t, body)
}

// registerMember issues an admin join code and registers one new Member,
// returning the fresh bearer token from the register response.
func (h *harness) registerMember(t *testing.T, email string) string {
	t.Helper()
	adminToken := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	status, body := h.doRequest(t, "POST", "/identity/admin/join-codes", adminToken, map[string]any{"label": "harness-" + email})
	if status != http.StatusCreated && status != http.StatusOK {
		t.Fatalf("issue join code: status=%d body=%s", status, body)
	}
	code := extractField(t, body, "code")
	registerStatus, registerBody := h.doRequest(t, "POST", "/identity/register", "", map[string]any{
		"join_code":    code,
		"email":        email,
		"password":     harnessPassword,
		"display_name": email[:len(email)-10],
	})
	if registerStatus != http.StatusCreated && registerStatus != http.StatusOK {
		t.Fatalf("register %s: status=%d body=%s", email, registerStatus, registerBody)
	}
	return extractToken(t, registerBody)
}

// loginToken obtains a fresh bearer token via the real login command.
func (h *harness) loginToken(t *testing.T, email, password string) string {
	t.Helper()
	status, body := h.doRequest(t, "POST", "/identity/auth/login", "", map[string]any{
		"email": email, "password": password,
	})
	if status != http.StatusOK {
		t.Fatalf("login %s: status=%d body=%s", email, status, body)
	}
	return extractToken(t, body)
}

const (
	harnessAdminEmail    = "instance-admin@nevix.test"
	harnessAdminPassword = "harness-admin-password-1"
	creatorEmail         = "creator-a@nevix.test"
	otherCreatorEmail    = "creator-b@nevix.test"
	harnessPassword      = "harness-user-password-1"
)

// ensureAccounts idempotently materializes the authorization-matrix cast:
// an instance Admin plus two separate Member creators. Accounts persist
// across the suite run, so each block re-checks before provisioning.
func (h *harness) ensureAccounts(t *testing.T) {
	t.Helper()
	if !h.userExists(harnessAdminEmail) {
		h.claimAdmin(t)
	}
	if !h.userExists(creatorEmail) {
		h.registerMember(t, creatorEmail)
	}
	if !h.userExists(otherCreatorEmail) {
		h.registerMember(t, otherCreatorEmail)
	}
}

func (h *harness) userExists(email string) bool {
	t := h.t
	t.Helper()
	var exists bool
	err := h.ownerPool.QueryRow(context.Background(),
		`SELECT EXISTS (SELECT FROM users WHERE email = $1)`, email).Scan(&exists)
	return err == nil && exists
}

func extractToken(t *testing.T, body []byte) string {
	token := extractField(t, body, "token")
	if token == "" {
		t.Fatalf("response carries no token: %s", body)
	}
	return token
}

func extractField(t *testing.T, body []byte, field string) string {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("decode response for field %q: %v (%s)", field, err, body)
	}
	value, _ := decoded[field].(string)
	return value
}

func sessionName(base string) string {
	return fmt.Sprintf("%s-%d", base, time.Now().UnixNano())
}
