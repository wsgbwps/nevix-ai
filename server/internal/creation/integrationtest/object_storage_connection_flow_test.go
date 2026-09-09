package integrationtest

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/creation"
)

const (
	objectStorageAccessKey = "LTAI5tObjectStorage1234"
	objectStorageSecretKey = "object-storage-secret-value"
)

func newObjectStorageHarness(t *testing.T, verifier creation.ObjectStorageVerifier) *harness {
	t.Helper()
	return newHarnessWithOptions(t, harnessOptions{objectStorageVerifier: verifier})
}

func captureDefaultSlog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return &logs
}

func successfulObjectStorageVerifier(t *testing.T) creation.ObjectStorageVerifier {
	t.Helper()
	return func(_ context.Context, candidate creation.ObjectStorageCandidate) (creation.ObjectStorageLocation, error) {
		if candidate.Credentials.AccessKeyID != objectStorageAccessKey || candidate.Credentials.SecretAccessKey != objectStorageSecretKey {
			t.Fatalf("verifier received wrong credentials")
		}
		return creation.ObjectStorageLocation{Provider: "oss", Region: "cn-hangzhou", Bucket: "nevix-private"}, nil
	}
}

func (h *harness) resetObjectStorageConnections(t *testing.T) {
	t.Helper()
	h.storageMu.Lock()
	h.storageReady = false
	h.storageMu.Unlock()
	if _, err := h.ownerPool.Exec(h.ctx, `TRUNCATE public.object_storage_connections CASCADE`); err != nil {
		t.Fatalf("reset object storage connections: %v", err)
	}
}

func (h *harness) createObjectStorageConnection(t *testing.T, admin string) (int, []byte) {
	t.Helper()
	proof := h.issueProof(t, admin, "object_storage_connection.create")
	return h.doSecureRequest(t, http.MethodPost, "/creation/object-storage-connection", admin, map[string]string{
		"proof": proof, "provider": " OSS ", "region": " CN-HANGZHOU ", "bucket": " NEVIX-PRIVATE ",
		"access_key_id": objectStorageAccessKey, "secret_access_key": objectStorageSecretKey,
	})
}

func TestObjectStorageConnectionPublicContract(t *testing.T) {
	var h *harness
	verifier := func(_ context.Context, candidate creation.ObjectStorageCandidate) (creation.ObjectStorageLocation, error) {
		var rows int
		if err := h.ownerPool.QueryRow(h.ctx, `SELECT count(*) FROM object_storage_connections`).Scan(&rows); err != nil || rows != 0 {
			t.Fatalf("candidate was persisted before canary completed: rows=%d err=%v", rows, err)
		}
		if candidate.Credentials.AccessKeyID != objectStorageAccessKey || candidate.Credentials.SecretAccessKey != objectStorageSecretKey {
			t.Fatal("canary did not receive the submitted credential pair")
		}
		return creation.ObjectStorageLocation{Provider: "oss", Region: "cn-hangzhou", Bucket: "nevix-private"}, nil
	}
	h = newObjectStorageHarness(t, verifier)
	h.ensureAccounts(t)
	h.resetObjectStorageConnections(t)
	admin := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	member := h.loginToken(t, creatorEmail, harnessPassword)

	status, body := h.doRequest(t, http.MethodGet, "/creation/object-storage-connection", admin, nil)
	if status != http.StatusOK || string(body) != "{\"state\":\"unconfigured\"}\n" {
		t.Fatalf("unconfigured admin view: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodGet, "/creation/object-storage-connection", status, body)
	status, body = h.doRequest(t, http.MethodGet, "/creation/object-storage-capability", member, nil)
	if status != http.StatusOK || string(body) != "{\"available\":false}\n" {
		t.Fatalf("unconfigured capability: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodGet, "/creation/object-storage-capability", status, body)

	for _, path := range []string{"/creation/object-storage-connection", "/creation/object-storage-capability"} {
		status, body = h.doRequest(t, http.MethodGet, path, "", nil)
		if status != http.StatusUnauthorized {
			t.Fatalf("GET %s without session: status=%d body=%s", path, status, body)
		}
	}
	status, body = h.doRequest(t, http.MethodGet, "/creation/object-storage-connection", member, nil)
	if status != http.StatusForbidden {
		t.Fatalf("member admin view: status=%d body=%s", status, body)
	}

	proof := h.issueProof(t, admin, "object_storage_connection.create")
	input := map[string]string{
		"proof": proof, "provider": "oss", "region": "cn-hangzhou", "bucket": "nevix-private",
		"access_key_id": objectStorageAccessKey, "secret_access_key": objectStorageSecretKey,
	}
	status, body = h.doRequest(t, http.MethodPost, "/creation/object-storage-connection", admin, input)
	if status != http.StatusBadRequest {
		t.Fatalf("insecure create: status=%d body=%s", status, body)
	}
	assertErrorCode(t, body, "secure_transport_required")

	status, body = h.doSecureRequest(t, http.MethodPost, "/creation/object-storage-connection", admin, input)
	if status != http.StatusCreated {
		t.Fatalf("create: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodPost, "/creation/object-storage-connection", status, body)
	assertObjectStorageAdminView(t, body, "ready")
	if bytes.Contains(body, []byte(objectStorageAccessKey)) || bytes.Contains(body, []byte(objectStorageSecretKey)) {
		t.Fatalf("create response leaked credentials: %s", body)
	}

	status, body = h.doRequest(t, http.MethodGet, "/creation/object-storage-capability", member, nil)
	if status != http.StatusOK {
		t.Fatalf("ready capability: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodGet, "/creation/object-storage-capability", status, body)
	var capability map[string]any
	if err := json.Unmarshal(body, &capability); err != nil {
		t.Fatalf("decode capability: %v", err)
	}
	if capability["available"] != true || capability["provider"] != "oss" || capability["upload_origin"] != "https://nevix-private.oss-cn-hangzhou.aliyuncs.com" {
		t.Fatalf("ready capability = %v", capability)
	}
	if _, ok := capability["region"]; ok {
		t.Fatalf("capability leaked region: %v", capability)
	}
	if _, ok := capability["bucket"]; ok {
		t.Fatalf("capability leaked bucket: %v", capability)
	}

	var ciphertext []byte
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT credential_ciphertext FROM object_storage_connections WHERE terminated_at IS NULL`).Scan(&ciphertext); err != nil {
		t.Fatalf("read ciphertext: %v", err)
	}
	if bytes.Contains(ciphertext, []byte(objectStorageAccessKey)) || bytes.Contains(ciphertext, []byte(objectStorageSecretKey)) {
		t.Fatal("database envelope contains plaintext credentials")
	}
	assertObjectStorageAudit(t, h)
}

func TestObjectStorageCreateRequiresAdminBeforeProofConsumption(t *testing.T) {
	verifierCalls := 0
	h := newObjectStorageHarness(t, func(_ context.Context, _ creation.ObjectStorageCandidate) (creation.ObjectStorageLocation, error) {
		verifierCalls++
		return creation.ObjectStorageLocation{Provider: "oss", Region: "cn-hangzhou", Bucket: "nevix-private"}, nil
	})
	h.ensureAccounts(t)
	h.resetObjectStorageConnections(t)
	admin := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	member := h.loginToken(t, creatorEmail, harnessPassword)
	proof := h.issueProof(t, admin, "object_storage_connection.create")
	input := map[string]string{
		"proof": proof, "provider": "oss", "region": "cn-hangzhou", "bucket": "nevix-private",
		"access_key_id": objectStorageAccessKey, "secret_access_key": objectStorageSecretKey,
	}

	for _, attempt := range []struct {
		name   string
		token  string
		status int
	}{
		{name: "anonymous", status: http.StatusUnauthorized},
		{name: "member", token: member, status: http.StatusForbidden},
	} {
		status, body := h.doSecureRequest(t, http.MethodPost, "/creation/object-storage-connection", attempt.token, input)
		if status != attempt.status {
			t.Fatalf("%s create: status=%d body=%s", attempt.name, status, body)
		}
		assertContractResponse(t, http.MethodPost, "/creation/object-storage-connection", status, body)
	}
	if verifierCalls != 0 {
		t.Fatalf("unauthorized requests reached canary %d times", verifierCalls)
	}

	status, body := h.doSecureRequest(t, http.MethodPost, "/creation/object-storage-connection", admin, input)
	if status != http.StatusCreated || verifierCalls != 1 {
		t.Fatalf("admin reuse after guard rejection: status=%d verifier_calls=%d body=%s", status, verifierCalls, body)
	}
}

func TestObjectStorageCreateRejectsWrongActionWithoutConsumingProof(t *testing.T) {
	verifierCalls := 0
	h := newObjectStorageHarness(t, func(_ context.Context, _ creation.ObjectStorageCandidate) (creation.ObjectStorageLocation, error) {
		verifierCalls++
		return creation.ObjectStorageLocation{}, errors.New("canary must not run")
	})
	h.ensureAccounts(t)
	h.resetObjectStorageConnections(t)
	admin := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	proof := h.issueProof(t, admin, "provider_connection.create")

	status, body := h.doSecureRequest(t, http.MethodPost, "/creation/object-storage-connection", admin, map[string]string{
		"proof": proof, "provider": "oss", "region": "cn-hangzhou", "bucket": "nevix-private",
		"access_key_id": objectStorageAccessKey, "secret_access_key": objectStorageSecretKey,
	})
	if status != http.StatusConflict {
		t.Fatalf("wrong-action create: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodPost, "/creation/object-storage-connection", status, body)
	assertErrorCode(t, body, "reauth_proof_action_mismatch")
	if verifierCalls != 0 {
		t.Fatalf("wrong-action proof reached canary %d times", verifierCalls)
	}

	status, body = h.doSecureRequest(t, http.MethodPost, "/identity/admin/reauth/proofs/consume", admin, map[string]string{
		"proof": proof, "action": "provider_connection.create",
	})
	if status != http.StatusOK {
		t.Fatalf("correct action after mismatch: status=%d body=%s", status, body)
	}
	status, body = h.doSecureRequest(t, http.MethodPost, "/identity/admin/reauth/proofs/consume", admin, map[string]string{
		"proof": proof, "action": "provider_connection.create",
	})
	if status != http.StatusConflict {
		t.Fatalf("second exact-action consume: status=%d body=%s", status, body)
	}
	assertErrorCode(t, body, "reauth_proof_already_consumed")
}

func TestObjectStorageFailedCanaryPersistsNothingAndBurnsProof(t *testing.T) {
	objectKey := "nevix-canary/private-object-key"
	signedURL := "https://nevix-private.oss-cn-hangzhou.aliyuncs.com/" + objectKey + "?x-oss-signature=raw-signature"
	rawProviderText := "AccessDenied raw provider response request-id=secret-request"
	h := newObjectStorageHarness(t, func(_ context.Context, _ creation.ObjectStorageCandidate) (creation.ObjectStorageLocation, error) {
		return creation.ObjectStorageLocation{}, fmt.Errorf("%s access_key_id=%s secret_access_key=%s object_key=%s signed_url=%s", rawProviderText, objectStorageAccessKey, objectStorageSecretKey, objectKey, signedURL)
	})
	h.ensureAccounts(t)
	h.resetObjectStorageConnections(t)
	admin := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	proof := h.issueProof(t, admin, "object_storage_connection.create")
	logs := captureDefaultSlog(t)
	input := map[string]string{
		"proof": proof, "provider": "oss", "region": "cn-hangzhou", "bucket": "nevix-private",
		"access_key_id": objectStorageAccessKey, "secret_access_key": objectStorageSecretKey,
	}
	status, body := h.doSecureRequest(t, http.MethodPost, "/creation/object-storage-connection", admin, input)
	if status != http.StatusServiceUnavailable {
		t.Fatalf("failed canary: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodPost, "/creation/object-storage-connection", status, body)
	assertErrorCode(t, body, "object_storage_unavailable")
	if logText := logs.String(); !strings.Contains(logText, "object storage candidate verification failed") || !strings.Contains(logText, "code=object_storage_unavailable") {
		t.Fatalf("failed canary omitted sanitized security event: %s", logText)
	}
	for _, forbidden := range []string{objectStorageAccessKey, objectStorageSecretKey, objectKey, signedURL, rawProviderText} {
		if bytes.Contains(body, []byte(forbidden)) {
			t.Fatalf("failed canary response leaked %q: %s", forbidden, body)
		}
		if strings.Contains(logs.String(), forbidden) {
			t.Fatalf("failed canary log leaked %q: %s", forbidden, logs.String())
		}
	}
	var rows int
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT count(*) FROM object_storage_connections`).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("failed candidate persisted: rows=%d err=%v", rows, err)
	}

	status, body = h.doSecureRequest(t, http.MethodPost, "/creation/object-storage-connection", admin, input)
	if status != http.StatusConflict {
		t.Fatalf("reused proof: status=%d body=%s", status, body)
	}
	assertErrorCode(t, body, "reauth_proof_already_consumed")
}

func TestObjectStorageConcurrentFirstCreateHasOneWinner(t *testing.T) {
	arrived := make(chan struct{}, 2)
	release := make(chan struct{})
	verifier := func(_ context.Context, _ creation.ObjectStorageCandidate) (creation.ObjectStorageLocation, error) {
		arrived <- struct{}{}
		select {
		case <-release:
		case <-time.After(2 * time.Second):
		}
		return creation.ObjectStorageLocation{Provider: "oss", Region: "cn-hangzhou", Bucket: "nevix-private"}, nil
	}
	h := newObjectStorageHarness(t, verifier)
	h.ensureAccounts(t)
	h.resetObjectStorageConnections(t)
	admin := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	proofs := []string{
		h.issueProof(t, admin, "object_storage_connection.create"),
		h.issueProof(t, admin, "object_storage_connection.create"),
	}

	statuses := make(chan int, 2)
	var wg sync.WaitGroup
	for _, proof := range proofs {
		wg.Add(1)
		go func(proof string) {
			defer wg.Done()
			status, _ := h.doSecureRequest(t, http.MethodPost, "/creation/object-storage-connection", admin, map[string]string{
				"proof": proof, "provider": "oss", "region": "cn-hangzhou", "bucket": "nevix-private",
				"access_key_id": objectStorageAccessKey, "secret_access_key": objectStorageSecretKey,
			})
			statuses <- status
		}(proof)
	}
	select {
	case <-arrived:
	case <-time.After(2 * time.Second):
	}
	close(release)
	wg.Wait()
	close(statuses)
	counts := map[int]int{}
	for status := range statuses {
		counts[status]++
	}
	if counts[http.StatusCreated] != 1 || counts[http.StatusConflict] != 1 {
		t.Fatalf("concurrent statuses = %v", counts)
	}
	status, body := h.doRequest(t, http.MethodGet, "/creation/object-storage-connection", admin, nil)
	if status != http.StatusOK || extractField(t, body, "state") != "ready" {
		t.Fatalf("concurrent winner credential is not readable: status=%d body=%s", status, body)
	}
}

func TestObjectStorageCredentialLossFailsClosedWithoutBlockingReads(t *testing.T) {
	h := newObjectStorageHarness(t, successfulObjectStorageVerifier(t))
	h.ensureAccounts(t)
	h.resetObjectStorageConnections(t)
	t.Cleanup(func() { h.resetObjectStorageConnections(t) })
	admin := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	member := h.loginToken(t, creatorEmail, harnessPassword)
	if status, body := h.createObjectStorageConnection(t, admin); status != http.StatusCreated {
		t.Fatalf("create: status=%d body=%s", status, body)
	}

	keyPath := h.masterKeyPath(t)
	backup := keyPath + ".issue-218-backup"
	if err := os.Rename(keyPath, backup); err != nil {
		t.Fatalf("hide master key: %v", err)
	}
	t.Cleanup(func() { _ = os.Rename(backup, keyPath) })

	status, body := h.doRequest(t, http.MethodGet, "/creation/object-storage-connection", admin, nil)
	if status != http.StatusOK {
		t.Fatalf("credential-unavailable admin read: status=%d body=%s", status, body)
	}
	assertObjectStorageAdminView(t, body, "credential_unavailable")
	status, body = h.doRequest(t, http.MethodGet, "/creation/object-storage-capability", member, nil)
	if status != http.StatusOK {
		t.Fatalf("credential-unavailable capability: status=%d body=%s", status, body)
	}
	var capability map[string]any
	if err := json.Unmarshal(body, &capability); err != nil {
		t.Fatalf("decode capability: %v", err)
	}
	if capability["available"] != false || capability["provider"] != "oss" || capability["connection_revision"] == nil {
		t.Fatalf("credential-unavailable capability = %v", capability)
	}
	if _, ok := capability["upload_origin"]; ok {
		t.Fatalf("unavailable capability exposed origin: %v", capability)
	}
}

func assertObjectStorageAdminView(t *testing.T, body []byte, state string) {
	t.Helper()
	var view map[string]any
	if err := json.Unmarshal(body, &view); err != nil {
		t.Fatalf("decode admin view: %v", err)
	}
	if view["state"] != state || view["provider"] != "oss" || view["region"] != "cn-hangzhou" || view["bucket"] != "nevix-private" || view["revision"] == nil {
		t.Fatalf("admin view = %v", view)
	}
	credential, _ := view["credential"].(map[string]any)
	if credential["access_key_id_masked"] != "****1234" || credential["secret_access_key_configured"] != true {
		t.Fatalf("masked credential = %v", credential)
	}
	observation, _ := view["observation"].(map[string]any)
	if observation["outcome"] != "completed" || observation["checked_at"] == nil {
		t.Fatalf("observation = %v", observation)
	}
}

func assertObjectStorageAudit(t *testing.T, h *harness) {
	t.Helper()
	var metadata []byte
	if err := h.ownerPool.QueryRow(h.ctx, `
		SELECT metadata FROM audit_logs WHERE action = 'object_storage_connection_created'
		ORDER BY created_at DESC LIMIT 1`).Scan(&metadata); err != nil {
		t.Fatalf("read object storage audit: %v", err)
	}
	for _, forbidden := range []string{objectStorageAccessKey, objectStorageSecretKey, "signed", "object_key"} {
		if bytes.Contains(metadata, []byte(forbidden)) {
			t.Fatalf("audit leaked %q: %s", forbidden, metadata)
		}
	}
}
