package integrationtest

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// Provider Connection flows (issue #157) through the Module's public HTTP
// seams: the permission matrix, the proof-gated lifecycle, candidate
// replacement, master-key fail-closed behavior, and the sanitized member
// surface. Every key is a locally minted fixture; the fake Kapon route is
// the only provider the server ever contacts here.

const (
	providerKeyOne  = "kapon-e2e-key-one-0000000000000001"
	providerKeyTwo  = "kapon-e2e-key-two-0000000000000002"
	providerKeyBad  = "kapon-e2e-key-rejected-00000000003"
	masterKeyPrefix = "provider-credential-master.key"
)

// doSecureRequest mirrors doRequest with the trusted-proxy HTTPS marker the
// official Nginx stack writes (deploy/nginx); proof issuance and the
// key-bearing connection commands require it.
func (h *harness) doSecureRequest(t *testing.T, method, path, token string, body any) (int, []byte) {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		blob, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body for %s %s: %v", method, path, err)
		}
		reader = bytes.NewReader(blob)
	} else {
		reader = bytes.NewReader(nil)
	}
	req, err := http.NewRequestWithContext(h.ctx, method, h.serverURL+path, reader)
	if err != nil {
		t.Fatalf("build request %s %s: %v", method, path, err)
	}
	req.Header.Set("X-Forwarded-Proto", "https")
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

// issueProof obtains one exact-action proof through the real identity
// endpoint over proven HTTPS transport.
func (h *harness) issueProof(t *testing.T, adminToken, action string) string {
	t.Helper()
	status, body := h.doSecureRequest(t, "POST", "/identity/admin/reauth/proofs", adminToken, map[string]string{
		"action":   action,
		"password": harnessAdminPassword,
	})
	if status != http.StatusCreated && status != http.StatusOK {
		t.Fatalf("issue reauth proof %s: status=%d body=%s", action, status, body)
	}
	return extractField(t, body, "proof")
}

// resetProviderConnections clears the singleton slot so each scenario
// starts from a known absence (owner credential: fixtures only).
func (h *harness) resetProviderConnections(t *testing.T) {
	t.Helper()
	if _, err := h.ownerPool.Exec(h.ctx, `TRUNCATE public.provider_connections`); err != nil {
		t.Fatalf("reset provider connections: %v", err)
	}
}

// configureConnection runs the full first-time configuration with an
// accepted key; fatal on anything but success.
func (h *harness) configureConnection(t *testing.T, adminToken, key string) (int, []byte) {
	t.Helper()
	proof := h.issueProof(t, adminToken, "provider_connection.create")
	return h.doSecureRequest(t, "POST", "/creation/provider-connection", adminToken, map[string]string{
		"proof": proof, "provider_key": key,
	})
}

// activeRow reads the singleton's persisted facts for assertions.
type activeRow struct {
	id         string
	ciphertext []byte
	nonce      []byte
	keyID      string
	terminated bool
}

func (h *harness) activeConnectionRow(t *testing.T) (activeRow, bool) {
	t.Helper()
	var row activeRow
	var terminated *string
	err := h.ownerPool.QueryRow(h.ctx,
		`SELECT id::text, credential_ciphertext, credential_nonce, credential_key_id, terminated_at::text
		 FROM public.provider_connections ORDER BY created_at DESC LIMIT 1`,
	).Scan(&row.id, &row.ciphertext, &row.nonce, &row.keyID, &terminated)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return activeRow{}, false
		}
		t.Fatalf("read provider connection row: %v", err)
	}
	row.terminated = terminated != nil
	return row, true
}

// masterKeyPath locates the key file inside the harness secrets directory.
func (h *harness) masterKeyPath(t *testing.T) string {
	t.Helper()
	entries, err := os.ReadDir(h.secretsDir)
	if err != nil {
		t.Fatalf("read secrets dir: %v", err)
	}
	for _, entry := range entries {
		if filepath.Base(entry.Name()) == masterKeyPrefix {
			return filepath.Join(h.secretsDir, entry.Name())
		}
	}
	return ""
}

func TestProviderConnectionPermissionMatrix(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	h.resetProviderConnections(t)
	member := h.loginToken(t, creatorEmail, harnessPassword)

	adminPaths := []struct{ method, path string }{
		{http.MethodGet, "/creation/provider-connection"},
		{http.MethodPost, "/creation/provider-connection"},
		{http.MethodPut, "/creation/provider-connection/credential"},
		{http.MethodPatch, "/creation/provider-connection"},
		{http.MethodPost, "/creation/provider-connection/recheck"},
		{http.MethodDelete, "/creation/provider-connection"},
	}
	for _, route := range adminPaths {
		status, body := h.doRequest(t, route.method, route.path, "", nil)
		if status != http.StatusUnauthorized {
			t.Fatalf("%s %s without session: status=%d body=%s", route.method, route.path, status, body)
		}
		status, body = h.doRequest(t, route.method, route.path, member, nil)
		if status != http.StatusForbidden {
			t.Fatalf("%s %s as member: status=%d body=%s", route.method, route.path, status, body)
		}
	}

	// The member surface is the one active-user route of this aggregate.
	status, body := h.doRequest(t, http.MethodGet, "/creation/media-capabilities", member, nil)
	if status != http.StatusOK {
		t.Fatalf("member capabilities: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodGet, "/creation/media-capabilities", status, body)
	var capabilities struct {
		Image struct {
			Status string  `json:"status"`
			Reason *string `json:"reason"`
			Action *string `json:"action"`
		} `json:"image"`
		Video struct {
			Status string  `json:"status"`
			Reason *string `json:"reason"`
			Action *string `json:"action"`
		} `json:"video"`
	}
	if err := json.Unmarshal(body, &capabilities); err != nil {
		t.Fatalf("decode capabilities: %v", err)
	}
	if capabilities.Image.Status != "unavailable" || capabilities.Image.Reason == nil || *capabilities.Image.Reason != "not_configured" {
		t.Fatalf("unconfigured image capability: %+v", capabilities.Image)
	}
	if capabilities.Video.Status != "unavailable" || capabilities.Video.Reason == nil || *capabilities.Video.Reason != "not_configured" {
		t.Fatalf("unconfigured video capability: %+v", capabilities.Video)
	}
}

func TestConfigureProviderConnectionLifecycle(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	h.resetProviderConnections(t)
	admin := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)

	status, body := h.doRequest(t, http.MethodGet, "/creation/provider-connection", admin, nil)
	if status != http.StatusNotFound {
		t.Fatalf("unconfigured admin view: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodGet, "/creation/provider-connection", status, body)
	assertErrorCode(t, body, "provider_connection_not_configured")

	// The key-bearing command refuses an unproven transport before any
	// proof is consumed.
	proof := h.issueProof(t, admin, "provider_connection.create")
	status, body = h.doRequest(t, http.MethodPost, "/creation/provider-connection", admin, map[string]string{
		"proof": proof, "provider_key": providerKeyOne,
	})
	if status != http.StatusBadRequest {
		t.Fatalf("configure without HTTPS proof: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodPost, "/creation/provider-connection", status, body)
	assertErrorCode(t, body, "secure_transport_required")

	// The refused transport must not have burned the proof.
	h.kapon.acceptKey(providerKeyOne)
	status, body = h.doSecureRequest(t, http.MethodPost, "/creation/provider-connection", admin, map[string]string{
		"proof": proof, "provider_key": providerKeyOne,
	})
	if status != http.StatusCreated {
		t.Fatalf("configure: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodPost, "/creation/provider-connection", status, body)
	view := decodeConnectionView(t, body)
	if view.CredentialState != "valid" || view.ImageCapability != "available" || view.VideoCapability != "available" {
		t.Fatalf("configured view states: %+v", view)
	}
	if view.NeedsAttention {
		t.Fatalf("healthy connection flagged needs_attention: %+v", view)
	}

	// The persisted credential is an AEAD envelope, never the key.
	row, ok := h.activeConnectionRow(t)
	if !ok {
		t.Fatal("no provider connection row after configure")
	}
	if bytes.Equal(row.ciphertext, []byte(providerKeyOne)) || bytes.Contains(row.ciphertext, []byte(providerKeyOne)) {
		t.Fatal("ciphertext contains the plaintext provider key")
	}
	if len(row.ciphertext) <= len(providerKeyOne) {
		t.Fatalf("ciphertext suspiciously short: %d bytes", len(row.ciphertext))
	}

	// The master key file obeys the 0700/0600 discipline.
	keyPath := h.masterKeyPath(t)
	if keyPath == "" {
		t.Fatal("master key file was not created")
	}
	assertPermissionBits(t, keyPath, 0o600)
	assertPermissionBits(t, filepath.Dir(keyPath), 0o700)

	// The singleton refuses a second active connection even with a fresh
	// proof; the refusal leaves the first row untouched.
	firstCiphertext := append([]byte(nil), row.ciphertext...)
	status, body = h.configureConnection(t, admin, providerKeyOne)
	if status != http.StatusConflict {
		t.Fatalf("second configure: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodPost, "/creation/provider-connection", status, body)
	assertErrorCode(t, body, "provider_connection_exists")
	row, _ = h.activeConnectionRow(t)
	if !bytes.Equal(firstCiphertext, row.ciphertext) {
		t.Fatal("singleton conflict rewrote the stored envelope")
	}

	// Audit rows record the lifecycle with sanitized metadata.
	assertSanitizedConnectionAudit(t, h, "provider_connection_created")
}

func TestConfigureCandidateRejectedLeavesNothingAndBurnsProof(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	h.resetProviderConnections(t)
	admin := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)

	proof := h.issueProof(t, admin, "provider_connection.create")
	status, body := h.doSecureRequest(t, http.MethodPost, "/creation/provider-connection", admin, map[string]string{
		"proof": proof, "provider_key": providerKeyBad,
	})
	if status != http.StatusBadRequest {
		t.Fatalf("invalid candidate: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodPost, "/creation/provider-connection", status, body)
	assertErrorCode(t, body, "provider_credential_invalid")
	if _, ok := h.activeConnectionRow(t); ok {
		t.Fatal("rejected candidate persisted a connection row")
	}

	// The proof was consumed by the failed attempt and never restores.
	status, body = h.doSecureRequest(t, http.MethodPost, "/creation/provider-connection", admin, map[string]string{
		"proof": proof, "provider_key": providerKeyOne,
	})
	if status != http.StatusConflict {
		t.Fatalf("reuse consumed proof: status=%d body=%s", status, body)
	}
	assertErrorCode(t, body, "reauth_proof_already_consumed")

	// Wrong action proofs are refused without consumption-side effects.
	status, body = h.doSecureRequest(t, http.MethodPost, "/creation/provider-connection", admin, map[string]string{
		"proof": h.issueProof(t, admin, "provider_connection.replace"), "provider_key": providerKeyOne,
	})
	if status != http.StatusConflict {
		t.Fatalf("action mismatch: status=%d body=%s", status, body)
	}
	assertErrorCode(t, body, "reauth_proof_action_mismatch")

	// A transient upstream condition is not a credential verdict.
	proof = h.issueProof(t, admin, "provider_connection.create")
	h.kapon.forceStatus(http.StatusServiceUnavailable)
	status, body = h.doSecureRequest(t, http.MethodPost, "/creation/provider-connection", admin, map[string]string{
		"proof": proof, "provider_key": providerKeyOne,
	})
	if status != http.StatusServiceUnavailable {
		t.Fatalf("transient candidate check: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodPost, "/creation/provider-connection", status, body)
	assertErrorCode(t, body, "provider_check_temporarily_unavailable")
	if _, ok := h.activeConnectionRow(t); ok {
		t.Fatal("transient check persisted a connection row")
	}
	h.kapon.forceStatus(0)
}

func TestReplaceCandidateFailureKeepsOldCredentialAndSuccessSwitchesIndependently(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	h.resetProviderConnections(t)
	admin := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)

	h.kapon.acceptKey(providerKeyOne)
	if status, body := h.configureConnection(t, admin, providerKeyOne); status != http.StatusCreated {
		t.Fatalf("configure: status=%d body=%s", status, body)
	}
	row, _ := h.activeConnectionRow(t)
	oldCiphertext := append([]byte(nil), row.ciphertext...)

	// A rejected candidate discards the candidate; the old envelope stays
	// byte-identical.
	status, body := h.doSecureRequest(t, http.MethodPut, "/creation/provider-connection/credential", admin, map[string]string{
		"proof": h.issueProof(t, admin, "provider_connection.replace"), "provider_key": providerKeyBad,
	})
	if status != http.StatusBadRequest {
		t.Fatalf("replace with invalid candidate: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodPut, "/creation/provider-connection/credential", status, body)
	assertErrorCode(t, body, "provider_credential_invalid")
	row, _ = h.activeConnectionRow(t)
	if !bytes.Equal(oldCiphertext, row.ciphertext) {
		t.Fatal("rejected candidate rewrote the stored envelope")
	}

	// A candidate that sees only the image model still switches: image
	// available, video independently unavailable.
	h.kapon.setModels(true, false)
	h.kapon.acceptKey(providerKeyTwo)
	status, body = h.doSecureRequest(t, http.MethodPut, "/creation/provider-connection/credential", admin, map[string]string{
		"proof": h.issueProof(t, admin, "provider_connection.replace"), "provider_key": providerKeyTwo,
	})
	if status != http.StatusOK {
		t.Fatalf("replace: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodPut, "/creation/provider-connection/credential", status, body)
	view := decodeConnectionView(t, body)
	if view.CredentialState != "valid" || view.ImageCapability != "available" || view.VideoCapability != "unavailable" {
		t.Fatalf("partial-visibility replace states: %+v", view)
	}
	row, _ = h.activeConnectionRow(t)
	if bytes.Equal(oldCiphertext, row.ciphertext) {
		t.Fatal("successful replace kept the old envelope")
	}

	// The member surface reflects the independent degradation without any
	// provider internals.
	status, body = h.doRequest(t, http.MethodGet, "/creation/media-capabilities", h.loginToken(t, creatorEmail, harnessPassword), nil)
	if status != http.StatusOK {
		t.Fatalf("member capabilities: status=%d body=%s", status, body)
	}
	if reason := extractNested(t, body, "video", "reason"); reason != "model_unavailable" {
		t.Fatalf("video member reason after partial replace: %q", reason)
	}
	if reason := extractNested(t, body, "image", "reason"); reason != "" {
		t.Fatalf("image member reason after available: %q", reason)
	}
	assertSanitizedConnectionAudit(t, h, "provider_connection_replaced")
}

func TestPauseResumeRecheckSemantics(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	h.resetProviderConnections(t)
	admin := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)

	h.kapon.acceptKey(providerKeyOne)
	if status, body := h.configureConnection(t, admin, providerKeyOne); status != http.StatusCreated {
		t.Fatalf("configure: status=%d body=%s", status, body)
	}

	// Pause and resume need only the admin session — no proof, no provider.
	status, body := h.doRequest(t, http.MethodPatch, "/creation/provider-connection", admin, map[string]string{"admin_state": "paused"})
	if status != http.StatusOK {
		t.Fatalf("pause: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodPatch, "/creation/provider-connection", status, body)
	if state := extractField(t, body, "admin_state"); state != "paused" {
		t.Fatalf("paused state: %s body=%s", state, body)
	}
	memberToken := h.loginToken(t, creatorEmail, harnessPassword)
	if reason := h.memberReason(t, memberToken, "image"); reason != "connection_paused" {
		t.Fatalf("paused member reason: %q", reason)
	}

	status, body = h.doRequest(t, http.MethodPatch, "/creation/provider-connection", admin, map[string]string{"admin_state": "enabled"})
	if status != http.StatusOK || extractField(t, body, "admin_state") != "enabled" {
		t.Fatalf("resume: status=%d body=%s", status, body)
	}
	if reason := h.memberReason(t, memberToken, "image"); reason != "" {
		t.Fatalf("resumed member reason: %q", reason)
	}

	// A transient recheck rewrites nothing but the outcome marker.
	h.kapon.forceStatus(http.StatusTooManyRequests)
	status, body = h.doRequest(t, http.MethodPost, "/creation/provider-connection/recheck", admin, nil)
	if status != http.StatusOK {
		t.Fatalf("transient recheck: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodPost, "/creation/provider-connection/recheck", status, body)
	if outcome := extractField(t, body, "last_check_outcome"); outcome != "temporarily_unavailable" {
		t.Fatalf("transient outcome: %s body=%s", outcome, body)
	}
	if state := extractField(t, body, "credential_state"); state != "valid" {
		t.Fatalf("transient recheck rewrote credential state: %s", state)
	}
	h.kapon.forceStatus(0)

	// The stored key becoming provider-rejected is a definitive verdict.
	h.kapon.rejectAllKeys()
	status, body = h.doRequest(t, http.MethodPost, "/creation/provider-connection/recheck", admin, nil)
	if status != http.StatusOK {
		t.Fatalf("invalid recheck: status=%d body=%s", status, body)
	}
	view := decodeConnectionView(t, body)
	if view.CredentialState != "invalid" || view.ImageCapability != "unavailable" || view.VideoCapability != "unavailable" {
		t.Fatalf("invalid recheck states: %+v", view)
	}
	if reason := h.memberReason(t, memberToken, "video"); reason != "credential_invalid" {
		t.Fatalf("invalid member reason: %q", reason)
	}

	// A later healthy verdict recovers over the same stored key.
	h.kapon.acceptKey(providerKeyOne)
	status, body = h.doRequest(t, http.MethodPost, "/creation/provider-connection/recheck", admin, nil)
	if status != http.StatusOK {
		t.Fatalf("recovery recheck: status=%d body=%s", status, body)
	}
	view = decodeConnectionView(t, body)
	if view.CredentialState != "valid" || view.ImageCapability != "available" {
		t.Fatalf("recovery states: %+v", view)
	}
	assertSanitizedConnectionAudit(t, h, "provider_connection_paused")
	assertSanitizedConnectionAudit(t, h, "provider_connection_resumed")
	assertSanitizedConnectionAudit(t, h, "provider_connection_checked")
}

func TestDeleteTerminatesAndReleasesSingleton(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	h.resetProviderConnections(t)
	admin := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)

	h.kapon.acceptKey(providerKeyOne)
	if status, body := h.configureConnection(t, admin, providerKeyOne); status != http.StatusCreated {
		t.Fatalf("configure: status=%d body=%s", status, body)
	}
	row, _ := h.activeConnectionRow(t)

	// Deletion also refuses an unproven transport before consuming proof.
	status, body := h.doRequest(t, http.MethodDelete, "/creation/provider-connection", admin, map[string]string{
		"proof": h.issueProof(t, admin, "provider_connection.delete"),
	})
	if status != http.StatusBadRequest {
		t.Fatalf("delete without HTTPS: status=%d body=%s", status, body)
	}
	assertErrorCode(t, body, "secure_transport_required")

	status, body = h.doSecureRequest(t, http.MethodDelete, "/creation/provider-connection", admin, map[string]string{
		"proof": h.issueProof(t, admin, "provider_connection.delete"),
	})
	if status != http.StatusOK {
		t.Fatalf("delete: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodDelete, "/creation/provider-connection", status, body)

	// The aggregate is gone from the active surface but its non-sensitive
	// identity row survives with the envelope cleared.
	status, body = h.doRequest(t, http.MethodGet, "/creation/provider-connection", admin, nil)
	if status != http.StatusNotFound {
		t.Fatalf("view after delete: status=%d body=%s", status, body)
	}
	var ciphertext []byte
	var terminated *time.Time
	err := h.ownerPool.QueryRow(h.ctx,
		`SELECT credential_ciphertext, terminated_at FROM public.provider_connections WHERE id = $1`, row.id,
	).Scan(&ciphertext, &terminated)
	if err != nil {
		t.Fatalf("terminated row must persist: %v", err)
	}
	if ciphertext != nil || terminated == nil {
		t.Fatalf("terminated row must clear envelope: ciphertext=%v terminated=%v", ciphertext, terminated)
	}

	// Reconfiguration creates a fresh identity, not a revival.
	h.kapon.acceptKey(providerKeyTwo)
	status, body = h.configureConnection(t, admin, providerKeyTwo)
	if status != http.StatusCreated {
		t.Fatalf("reconfigure after delete: status=%d body=%s", status, body)
	}
	if id := extractField(t, body, "id"); id == row.id {
		t.Fatal("reconfigure revived the terminated identity")
	}
	assertSanitizedConnectionAudit(t, h, "provider_connection_deleted")
}

func TestMasterKeyFailureFailsClosedWithoutSilentRegeneration(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	h.resetProviderConnections(t)
	admin := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)

	h.kapon.acceptKey(providerKeyOne)
	if status, body := h.configureConnection(t, admin, providerKeyOne); status != http.StatusCreated {
		t.Fatalf("configure: status=%d body=%s", status, body)
	}
	keyPath := h.masterKeyPath(t)
	if keyPath == "" {
		t.Fatal("master key file missing after configure")
	}

	// Too-open permissions fail the connection closed; the key file is not
	// silently replaced.
	originalKey := readFile(t, keyPath)
	if err := os.Chmod(keyPath, 0o644); err != nil {
		t.Fatalf("widen key permissions: %v", err)
	}
	status, body := h.doRequest(t, http.MethodPost, "/creation/provider-connection/recheck", admin, nil)
	if status != http.StatusOK {
		t.Fatalf("recheck under bad permissions: status=%d body=%s", status, body)
	}
	view := decodeConnectionView(t, body)
	if view.CredentialState != "credential_unavailable" || view.ImageCapability != "unavailable" || view.VideoCapability != "unavailable" {
		t.Fatalf("fail-closed states: %+v", view)
	}
	if reason := h.memberReason(t, h.loginToken(t, creatorEmail, harnessPassword), "image"); reason != "credential_unavailable" {
		t.Fatalf("fail-closed member reason: %q", reason)
	}
	if current := readFile(t, keyPath); !bytes.Equal(originalKey, current) {
		t.Fatal("server silently regenerated or rewrote the master key")
	}

	// A tampered envelope (AAD/ciphertext swap) fails closed the same way —
	// the still-readable key cannot open what was rewritten underneath it.
	if _, err := h.ownerPool.Exec(h.ctx,
		`UPDATE public.provider_connections
		 SET credential_ciphertext = set_byte(credential_ciphertext, 0, 255 - get_byte(credential_ciphertext, 0))
		 WHERE terminated_at IS NULL`); err != nil {
		t.Fatalf("tamper ciphertext: %v", err)
	}
	status, body = h.doRequest(t, http.MethodPost, "/creation/provider-connection/recheck", admin, nil)
	if status != http.StatusOK || extractField(t, body, "credential_state") != "credential_unavailable" {
		t.Fatalf("recheck after tamper: status=%d body=%s", status, body)
	}

	// Losing the key file entirely stays fail-closed; a lost key is never
	// regenerated by a read-only command.
	if err := os.Remove(keyPath); err != nil {
		t.Fatalf("remove key file: %v", err)
	}
	status, body = h.doRequest(t, http.MethodPost, "/creation/provider-connection/recheck", admin, nil)
	if status != http.StatusOK || extractField(t, body, "credential_state") != "credential_unavailable" {
		t.Fatalf("recheck without key file: status=%d body=%s", status, body)
	}
	if regenerated := h.masterKeyPath(t); regenerated != "" {
		t.Fatal("read-only recheck silently regenerated the master key")
	}

	// Recovery is the reauthenticated replace over the missing key: a new
	// master key file is deliberately established, then the new ciphertext
	// lands (ADR-0016 凭据恢复) — never the lost one back.
	h.kapon.acceptKey(providerKeyTwo)
	status, body = h.doSecureRequest(t, http.MethodPut, "/creation/provider-connection/credential", admin, map[string]string{
		"proof": h.issueProof(t, admin, "provider_connection.replace"), "provider_key": providerKeyTwo,
	})
	if status != http.StatusOK {
		t.Fatalf("recovery replace: status=%d body=%s", status, body)
	}
	if extractField(t, body, "credential_state") != "valid" {
		t.Fatalf("recovery states: %s", body)
	}
	recoveredPath := h.masterKeyPath(t)
	if recoveredPath == "" {
		t.Fatal("recovery did not establish a master key file")
	}
	if recovered := readFile(t, recoveredPath); bytes.Equal(originalKey, recovered) {
		t.Fatal("recovery restored the lost master key bytes")
	}
	assertPermissionBits(t, recoveredPath, 0o600)
}

// memberReason reads one media's stable reason from the member surface.
func (h *harness) memberReason(t *testing.T, memberToken, media string) string {
	t.Helper()
	status, body := h.doRequest(t, http.MethodGet, "/creation/media-capabilities", memberToken, nil)
	if status != http.StatusOK {
		t.Fatalf("member capabilities: status=%d body=%s", status, body)
	}
	return extractNested(t, body, media, "reason")
}

type connectionViewDTO struct {
	ID               string `json:"id"`
	AdminState       string `json:"admin_state"`
	CredentialState  string `json:"credential_state"`
	ImageCapability  string `json:"image_capability"`
	VideoCapability  string `json:"video_capability"`
	LastCheckOutcome string `json:"last_check_outcome"`
	NeedsAttention   bool   `json:"needs_attention"`
}

func decodeConnectionView(t *testing.T, body []byte) connectionViewDTO {
	t.Helper()
	var view connectionViewDTO
	if err := json.Unmarshal(body, &view); err != nil {
		t.Fatalf("decode connection view: %v body=%s", err, body)
	}
	return view
}

func assertErrorCode(t *testing.T, body []byte, code string) {
	t.Helper()
	var envelope struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("decode error envelope: %v body=%s", err, body)
	}
	if envelope.Error != code {
		t.Fatalf("error code = %q, want %q (body=%s)", envelope.Error, code, body)
	}
}

func extractNested(t *testing.T, body []byte, outer, field string) string {
	t.Helper()
	var document map[string]map[string]any
	if err := json.Unmarshal(body, &document); err != nil {
		t.Fatalf("decode nested document: %v", err)
	}
	inner, ok := document[outer]
	if !ok {
		t.Fatalf("missing %q in %s", outer, body)
	}
	value, _ := inner[field].(string)
	return value
}

func assertPermissionBits(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	if info.Mode().Perm() != want {
		t.Fatalf("%s permissions = %o, want %o", path, info.Mode().Perm(), want)
	}
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return data
}

// assertSanitizedConnectionAudit proves one lifecycle action produced an
// audit row whose metadata never carries key material.
func assertSanitizedConnectionAudit(t *testing.T, h *harness, action string) {
	t.Helper()
	var metadata string
	err := h.ownerPool.QueryRow(h.ctx,
		`SELECT metadata::text FROM public.audit_logs WHERE action = $1 ORDER BY created_at DESC LIMIT 1`, action,
	).Scan(&metadata)
	if err != nil {
		t.Fatalf("audit row for %s: %v", action, err)
	}
	for _, secret := range []string{providerKeyOne, providerKeyTwo, providerKeyBad} {
		if bytes.Contains([]byte(metadata), []byte(secret)) {
			t.Fatalf("audit metadata for %s leaks provider key material: %s", action, metadata)
		}
	}
}
