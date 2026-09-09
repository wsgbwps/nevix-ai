package integrationtest

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/creation"
)

const (
	objectStorageRotatedAccessKey = "LTAI5tObjectStorage5678"
	objectStorageRotatedSecretKey = "object-storage-rotated-secret"
)

type objectStorageSnapshot struct {
	revision   int64
	state      string
	provider   string
	region     string
	bucket     string
	ciphertext []byte
	frozen     bool
}

func (h *harness) objectStorageSnapshot(t *testing.T) objectStorageSnapshot {
	t.Helper()
	var snapshot objectStorageSnapshot
	if err := h.ownerPool.QueryRow(h.ctx, `
		SELECT revision, state, provider, region, bucket, credential_ciphertext,
		       location_frozen_at IS NOT NULL
		FROM object_storage_connections WHERE terminated_at IS NULL`).Scan(
		&snapshot.revision, &snapshot.state, &snapshot.provider, &snapshot.region,
		&snapshot.bucket, &snapshot.ciphertext, &snapshot.frozen,
	); err != nil {
		t.Fatalf("read object storage snapshot: %v", err)
	}
	snapshot.ciphertext = append([]byte(nil), snapshot.ciphertext...)
	return snapshot
}

func TestObjectStorageRecheckUpdatesOnlySafeObservation(t *testing.T) {
	checkUnavailable := false
	h := newObjectStorageHarness(t, func(_ context.Context, candidate creation.ObjectStorageCandidate) (creation.ObjectStorageLocation, error) {
		if checkUnavailable {
			return creation.ObjectStorageLocation{}, errors.New("raw provider timeout with secret details")
		}
		return creation.ObjectStorageLocation{Provider: "oss", Region: "cn-hangzhou", Bucket: "nevix-private"}, nil
	})
	h.ensureAccounts(t)
	h.resetObjectStorageConnections(t)
	admin := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	member := h.loginToken(t, creatorEmail, harnessPassword)
	if status, body := h.createObjectStorageConnection(t, admin); status != http.StatusCreated {
		t.Fatalf("create: status=%d body=%s", status, body)
	}
	before := h.objectStorageSnapshot(t)
	checkUnavailable = true

	status, body := h.doSecureRequest(t, http.MethodPost, "/creation/object-storage-connection/recheck", member, nil)
	if status != http.StatusForbidden {
		t.Fatalf("member recheck: status=%d body=%s", status, body)
	}
	status, body = h.doSecureRequest(t, http.MethodPost, "/creation/object-storage-connection/recheck", admin, nil)
	if status != http.StatusOK {
		t.Fatalf("recheck: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodPost, "/creation/object-storage-connection/recheck", status, body)
	var view map[string]any
	mustDecode(t, body, &view)
	observation, _ := view["observation"].(map[string]any)
	if observation["outcome"] != "temporarily_unavailable" {
		t.Fatalf("recheck observation = %v", observation)
	}
	after := h.objectStorageSnapshot(t)
	if after.revision != before.revision || after.state != before.state ||
		after.provider != before.provider || after.region != before.region || after.bucket != before.bucket ||
		!bytes.Equal(after.ciphertext, before.ciphertext) {
		t.Fatalf("recheck changed authoritative state: before=%+v after=%+v", before, after)
	}
}

func TestObjectStorageRotationUsesRevisionCASAndPreservesFailedCandidate(t *testing.T) {
	h := newObjectStorageHarness(t, func(_ context.Context, candidate creation.ObjectStorageCandidate) (creation.ObjectStorageLocation, error) {
		switch candidate.Credentials.AccessKeyID {
		case objectStorageAccessKey, objectStorageRotatedAccessKey:
			return creation.ObjectStorageLocation{Provider: "oss", Region: "cn-hangzhou", Bucket: "nevix-private"}, nil
		default:
			return creation.ObjectStorageLocation{}, errors.New("provider request id and raw credential rejection")
		}
	})
	h.ensureAccounts(t)
	h.resetObjectStorageConnections(t)
	admin := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	if status, body := h.createObjectStorageConnection(t, admin); status != http.StatusCreated {
		t.Fatalf("create: status=%d body=%s", status, body)
	}
	before := h.objectStorageSnapshot(t)

	logs := captureDefaultSlog(t)
	status, body := h.doSecureRequest(t, http.MethodPut, "/creation/object-storage-connection/credential", admin, map[string]any{
		"proof": h.issueProof(t, admin, "object_storage_connection.rotate"), "expected_revision": before.revision,
		"access_key_id": "rejected-access-key", "secret_access_key": "rejected-secret-key",
	})
	if status != http.StatusServiceUnavailable {
		t.Fatalf("failed rotate: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodPut, "/creation/object-storage-connection/credential", status, body)
	for _, forbidden := range []string{"rejected-access-key", "rejected-secret-key", "provider request id"} {
		if bytes.Contains(body, []byte(forbidden)) || bytes.Contains(logs.Bytes(), []byte(forbidden)) {
			t.Fatalf("failed rotate leaked %q: body=%s logs=%s", forbidden, body, logs.String())
		}
	}
	failed := h.objectStorageSnapshot(t)
	if failed.revision != before.revision || !bytes.Equal(failed.ciphertext, before.ciphertext) {
		t.Fatalf("failed rotate changed stored credential: before=%+v after=%+v", before, failed)
	}

	proof := h.issueProof(t, admin, "object_storage_connection.rotate")
	status, body = h.doSecureRequest(t, http.MethodPut, "/creation/object-storage-connection/credential", admin, map[string]any{
		"proof": proof, "expected_revision": before.revision,
		"access_key_id": objectStorageRotatedAccessKey, "secret_access_key": objectStorageRotatedSecretKey,
	})
	if status != http.StatusOK {
		t.Fatalf("rotate: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodPut, "/creation/object-storage-connection/credential", status, body)
	rotated := h.objectStorageSnapshot(t)
	if rotated.revision <= before.revision || bytes.Equal(rotated.ciphertext, before.ciphertext) {
		t.Fatalf("successful rotate did not advance credential: before=%+v after=%+v", before, rotated)
	}

	status, body = h.doSecureRequest(t, http.MethodPut, "/creation/object-storage-connection/credential", admin, map[string]any{
		"proof": proof, "expected_revision": rotated.revision,
		"access_key_id": objectStorageRotatedAccessKey, "secret_access_key": objectStorageRotatedSecretKey,
	})
	if status != http.StatusConflict {
		t.Fatalf("replayed rotate proof: status=%d body=%s", status, body)
	}
	assertErrorCode(t, body, "reauth_proof_already_consumed")

	status, body = h.doSecureRequest(t, http.MethodPut, "/creation/object-storage-connection/credential", admin, map[string]any{
		"proof": h.issueProof(t, admin, "object_storage_connection.rotate"), "expected_revision": before.revision,
		"access_key_id": objectStorageRotatedAccessKey, "secret_access_key": objectStorageRotatedSecretKey,
	})
	if status != http.StatusConflict {
		t.Fatalf("stale rotate: status=%d body=%s", status, body)
	}
	assertErrorCode(t, body, "object_storage_connection_revision_conflict")
	assertSanitizedObjectStorageAudit(t, h, "object_storage_connection_credential_rotated")
}

func TestObjectStorageConcurrentRotationHasOneCASWinner(t *testing.T) {
	arrived := make(chan struct{}, 2)
	release := make(chan struct{})
	h := newObjectStorageHarness(t, func(_ context.Context, candidate creation.ObjectStorageCandidate) (creation.ObjectStorageLocation, error) {
		if candidate.Credentials.AccessKeyID != objectStorageAccessKey {
			arrived <- struct{}{}
			select {
			case <-release:
			case <-time.After(2 * time.Second):
			}
		}
		return creation.ObjectStorageLocation{Provider: "oss", Region: "cn-hangzhou", Bucket: "nevix-private"}, nil
	})
	h.ensureAccounts(t)
	h.resetObjectStorageConnections(t)
	admin := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	if status, body := h.createObjectStorageConnection(t, admin); status != http.StatusCreated {
		t.Fatalf("create: status=%d body=%s", status, body)
	}
	before := h.objectStorageSnapshot(t)
	proofs := []string{
		h.issueProof(t, admin, "object_storage_connection.rotate"),
		h.issueProof(t, admin, "object_storage_connection.rotate"),
	}

	statuses := make(chan int, 2)
	var wg sync.WaitGroup
	for index, proof := range proofs {
		wg.Add(1)
		go func(index int, proof string) {
			defer wg.Done()
			status, _ := h.doSecureRequest(t, http.MethodPut, "/creation/object-storage-connection/credential", admin, map[string]any{
				"proof": proof, "expected_revision": before.revision,
				"access_key_id": "concurrent-key-" + string(rune('a'+index)), "secret_access_key": "concurrent-secret",
			})
			statuses <- status
		}(index, proof)
	}
	for range 2 {
		select {
		case <-arrived:
		case <-time.After(2 * time.Second):
			t.Fatal("concurrent rotations did not both reach external verification")
		}
	}
	close(release)
	wg.Wait()
	close(statuses)
	counts := map[int]int{}
	for status := range statuses {
		counts[status]++
	}
	if counts[http.StatusOK] != 1 || counts[http.StatusConflict] != 1 {
		t.Fatalf("concurrent rotation statuses = %v", counts)
	}
	after := h.objectStorageSnapshot(t)
	if after.revision <= before.revision || after.state != "ready" {
		t.Fatalf("concurrent rotation winner = %+v", after)
	}
}

func TestObjectStorageLocationFreezeIsPermanentButAllowsRotation(t *testing.T) {
	h := newObjectStorageHarness(t, func(_ context.Context, candidate creation.ObjectStorageCandidate) (creation.ObjectStorageLocation, error) {
		if candidate.Credentials.AccessKeyID == "cos-replacement-key" || candidate.Location.Provider == "cos" {
			return creation.ObjectStorageLocation{Provider: "cos", Region: "ap-shanghai", Bucket: "nevix-private-cos"}, nil
		}
		return creation.ObjectStorageLocation{Provider: "oss", Region: "cn-hangzhou", Bucket: "nevix-private"}, nil
	})
	h.ensureAccounts(t)
	h.resetObjectStorageConnections(t)
	admin := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	member := h.loginToken(t, creatorEmail, harnessPassword)
	if status, body := h.createObjectStorageConnection(t, admin); status != http.StatusCreated {
		t.Fatalf("create: status=%d body=%s", status, body)
	}
	initial := h.objectStorageSnapshot(t)
	status, body := h.doSecureRequest(t, http.MethodPut, "/creation/object-storage-connection", admin, map[string]any{
		"proof": h.issueProof(t, admin, "object_storage_connection.replace"), "expected_revision": initial.revision,
		"provider": "cos", "region": "ap-shanghai", "bucket": "nevix-private-cos",
		"access_key_id": "cos-replacement-key", "secret_access_key": "cos-replacement-secret",
	})
	if status != http.StatusOK {
		t.Fatalf("replace empty location: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodPut, "/creation/object-storage-connection", status, body)
	replaced := h.objectStorageSnapshot(t)
	if replaced.provider != "cos" || replaced.revision <= initial.revision || replaced.frozen {
		t.Fatalf("replacement snapshot = %+v", replaced)
	}

	session := h.createSession(t, member, sessionName("object-storage-freeze"))
	status, body = h.doUpload(t, http.MethodPost, "/creation/sessions/"+session.ID+"/materials", member, "freeze.png", pngBytes(t))
	material := mustUpload(t, status, body)
	status, body = h.doRequest(t, http.MethodDelete, "/creation/materials/"+material.ID, member, nil)
	if status != http.StatusNoContent {
		t.Fatalf("delete freeze material: status=%d body=%s", status, body)
	}
	if snapshot := h.objectStorageSnapshot(t); !snapshot.frozen {
		t.Fatalf("location latch cleared after permanent object deletion: %+v", snapshot)
	}

	status, body = h.doSecureRequest(t, http.MethodPut, "/creation/object-storage-connection", admin, map[string]any{
		"proof": h.issueProof(t, admin, "object_storage_connection.replace"), "expected_revision": replaced.revision,
		"provider": "oss", "region": "cn-hangzhou", "bucket": "another-bucket",
		"access_key_id": objectStorageAccessKey, "secret_access_key": objectStorageSecretKey,
	})
	if status != http.StatusConflict {
		t.Fatalf("replace frozen location: status=%d body=%s", status, body)
	}
	assertErrorCode(t, body, "object_storage_location_frozen")
	status, body = h.doSecureRequest(t, http.MethodDelete, "/creation/object-storage-connection", admin, map[string]any{
		"proof": h.issueProof(t, admin, "object_storage_connection.delete"), "expected_revision": replaced.revision,
	})
	if status != http.StatusConflict {
		t.Fatalf("delete frozen location: status=%d body=%s", status, body)
	}
	assertErrorCode(t, body, "object_storage_location_frozen")

	status, body = h.doSecureRequest(t, http.MethodPut, "/creation/object-storage-connection/credential", admin, map[string]any{
		"proof": h.issueProof(t, admin, "object_storage_connection.rotate"), "expected_revision": replaced.revision,
		"access_key_id": "cos-replacement-key", "secret_access_key": "cos-rotated-secret",
	})
	if status != http.StatusOK {
		t.Fatalf("rotate frozen location: status=%d body=%s", status, body)
	}
	var view map[string]any
	mustDecode(t, body, &view)
	if view["location_frozen"] != true {
		t.Fatalf("frozen rotate response = %v", view)
	}
}

func TestObjectStorageEmptyConnectionCanBeDeleted(t *testing.T) {
	h := newObjectStorageHarness(t, successfulObjectStorageVerifier(t))
	h.ensureAccounts(t)
	h.resetObjectStorageConnections(t)
	admin := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	if status, body := h.createObjectStorageConnection(t, admin); status != http.StatusCreated {
		t.Fatalf("create: status=%d body=%s", status, body)
	}
	current := h.objectStorageSnapshot(t)
	status, body := h.doSecureRequest(t, http.MethodDelete, "/creation/object-storage-connection", admin, map[string]any{
		"proof": h.issueProof(t, admin, "object_storage_connection.delete"), "expected_revision": current.revision,
	})
	if status != http.StatusOK || string(body) != "{\"state\":\"unconfigured\"}\n" {
		t.Fatalf("delete empty connection: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodDelete, "/creation/object-storage-connection", status, body)
	assertSanitizedObjectStorageAudit(t, h, "object_storage_connection_deleted")
}

func TestObjectStoragePendingUploadBlocksLocationMutationButAllowsRotation(t *testing.T) {
	h := newObjectStorageHarness(t, func(_ context.Context, candidate creation.ObjectStorageCandidate) (creation.ObjectStorageLocation, error) {
		if candidate.Location.Provider == "cos" {
			return creation.ObjectStorageLocation{Provider: "cos", Region: "ap-shanghai", Bucket: "nevix-private-cos"}, nil
		}
		return creation.ObjectStorageLocation{Provider: "oss", Region: "cn-hangzhou", Bucket: "nevix-private"}, nil
	})
	h.ensureAccounts(t)
	h.resetObjectStorageConnections(t)
	admin := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	creator := h.loginToken(t, creatorEmail, harnessPassword)
	if status, body := h.createObjectStorageConnection(t, admin); status != http.StatusCreated {
		t.Fatalf("create: status=%d body=%s", status, body)
	}
	initial := h.objectStorageSnapshot(t)
	session := h.createSession(t, creator, sessionName("object-storage-upload-latch"))
	payload := pngBytes(t)
	status, body, _ := h.createMaterialUpload(t, creator, session.ID, uploadCreateInput(
		"object-storage-upload-latch", "latch.png", "image", "image/png", int64(len(payload)),
	))
	if status != http.StatusCreated {
		t.Fatalf("create upload lease: status=%d body=%s", status, body)
	}

	status, body = h.doSecureRequest(t, http.MethodPut, "/creation/object-storage-connection", admin, map[string]any{
		"proof": h.issueProof(t, admin, "object_storage_connection.replace"), "expected_revision": initial.revision,
		"provider": "cos", "region": "ap-shanghai", "bucket": "nevix-private-cos",
		"access_key_id": "cos-replacement-key", "secret_access_key": "cos-replacement-secret",
	})
	if status != http.StatusConflict {
		t.Fatalf("replace with pending upload: status=%d body=%s", status, body)
	}
	assertErrorCode(t, body, "object_storage_location_frozen")

	status, body = h.doSecureRequest(t, http.MethodDelete, "/creation/object-storage-connection", admin, map[string]any{
		"proof": h.issueProof(t, admin, "object_storage_connection.delete"), "expected_revision": initial.revision,
	})
	if status != http.StatusConflict {
		t.Fatalf("delete with pending upload: status=%d body=%s", status, body)
	}
	assertErrorCode(t, body, "object_storage_location_frozen")

	status, body = h.doSecureRequest(t, http.MethodPut, "/creation/object-storage-connection/credential", admin, map[string]any{
		"proof": h.issueProof(t, admin, "object_storage_connection.rotate"), "expected_revision": initial.revision,
		"access_key_id": objectStorageRotatedAccessKey, "secret_access_key": objectStorageRotatedSecretKey,
	})
	if status != http.StatusOK {
		t.Fatalf("rotate with pending upload: status=%d body=%s", status, body)
	}
}

func TestObjectStorageExplicitRecoveryOwnsMissingSharedKey(t *testing.T) {
	h := newObjectStorageHarness(t, func(_ context.Context, candidate creation.ObjectStorageCandidate) (creation.ObjectStorageLocation, error) {
		if candidate.Credentials.AccessKeyID == "recovery-rejected-key" {
			return creation.ObjectStorageLocation{}, errors.New("raw recovery rejection")
		}
		return creation.ObjectStorageLocation{Provider: "oss", Region: "cn-hangzhou", Bucket: "nevix-private"}, nil
	})
	h.ensureAccounts(t)
	h.resetProviderConnections(t)
	h.resetObjectStorageConnections(t)
	admin := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	h.kapon.acceptKey(providerKeyOne)
	if status, body := h.configureConnection(t, admin, providerKeyOne); status != http.StatusCreated {
		t.Fatalf("configure provider: status=%d body=%s", status, body)
	}
	if status, body := h.createObjectStorageConnection(t, admin); status != http.StatusCreated {
		t.Fatalf("create storage: status=%d body=%s", status, body)
	}
	before := h.objectStorageSnapshot(t)

	keyPath := h.masterKeyPath(t)
	backup := keyPath + ".issue-219-backup"
	if err := os.Rename(keyPath, backup); err != nil {
		t.Fatalf("hide shared master key: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Remove(keyPath)
		_ = os.Rename(backup, keyPath)
	})
	status, body := h.doRequest(t, http.MethodGet, "/creation/object-storage-connection", admin, nil)
	if status != http.StatusOK || extractField(t, body, "state") != "credential_unavailable" {
		t.Fatalf("missing-key state: status=%d body=%s", status, body)
	}
	if _, err := os.Stat(keyPath); !os.IsNotExist(err) {
		t.Fatalf("read path silently recreated shared key: %v", err)
	}

	h.kapon.acceptKey(providerKeyTwo)
	status, body = h.doSecureRequest(t, http.MethodPut, "/creation/provider-connection/credential", admin, map[string]any{
		"proof": h.issueProof(t, admin, "provider_connection.replace"), "provider_key": providerKeyTwo,
	})
	if status != http.StatusConflict {
		t.Fatalf("provider replacement recreated key ahead of storage recovery: status=%d body=%s", status, body)
	}
	assertErrorCode(t, body, "object_storage_recovery_required")
	if _, err := os.Stat(keyPath); !os.IsNotExist(err) {
		t.Fatalf("provider replacement silently recreated shared key: %v", err)
	}

	status, body = h.doSecureRequest(t, http.MethodPost, "/creation/object-storage-connection/credential/recover", admin, map[string]any{
		"proof": h.issueProof(t, admin, "object_storage_connection.recover"), "expected_revision": before.revision,
		"access_key_id": "recovery-rejected-key", "secret_access_key": "recovery-rejected-secret",
	})
	if status != http.StatusServiceUnavailable {
		t.Fatalf("failed recovery: status=%d body=%s", status, body)
	}
	if _, err := os.Stat(keyPath); !os.IsNotExist(err) {
		t.Fatalf("failed recovery created shared key: %v", err)
	}
	failed := h.objectStorageSnapshot(t)
	if failed.state != "credential_unavailable" || failed.revision != before.revision || !bytes.Equal(failed.ciphertext, before.ciphertext) {
		t.Fatalf("failed recovery changed connection: before=%+v after=%+v", before, failed)
	}

	status, body = h.doSecureRequest(t, http.MethodPost, "/creation/object-storage-connection/credential/recover", admin, map[string]any{
		"proof": h.issueProof(t, admin, "object_storage_connection.recover"), "expected_revision": before.revision,
		"access_key_id": objectStorageRotatedAccessKey, "secret_access_key": objectStorageRotatedSecretKey,
	})
	if status != http.StatusOK {
		t.Fatalf("recover: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodPost, "/creation/object-storage-connection/credential/recover", status, body)
	recovered := h.objectStorageSnapshot(t)
	if recovered.state != "ready" || recovered.revision <= before.revision || bytes.Equal(recovered.ciphertext, before.ciphertext) {
		t.Fatalf("recovered connection = %+v", recovered)
	}
	var providerState string
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT credential_state FROM provider_connections WHERE terminated_at IS NULL`).Scan(&providerState); err != nil {
		t.Fatalf("read provider state after shared-key recovery: %v", err)
	}
	if providerState != "credential_unavailable" {
		t.Fatalf("old provider envelope state = %q, want credential_unavailable", providerState)
	}
	assertSanitizedObjectStorageAudit(t, h, "object_storage_connection_credential_recovered")
	h.resetProviderConnections(t)
	h.resetObjectStorageConnections(t)
}

func assertSanitizedObjectStorageAudit(t *testing.T, h *harness, action string) {
	t.Helper()
	var metadata []byte
	if err := h.ownerPool.QueryRow(h.ctx, `
		SELECT metadata FROM audit_logs WHERE action = $1 ORDER BY created_at DESC LIMIT 1`, action).Scan(&metadata); err != nil {
		t.Fatalf("read %s audit: %v", action, err)
	}
	var fields map[string]string
	if err := json.Unmarshal(metadata, &fields); err != nil {
		t.Fatalf("decode %s audit: %v", action, err)
	}
	allowed := map[string]bool{"connection_id": true, "provider": true, "region": true, "bucket": true, "revision": true}
	if len(fields) != len(allowed) {
		t.Fatalf("%s audit fields = %v", action, fields)
	}
	for key, value := range fields {
		if !allowed[key] {
			t.Fatalf("%s audit has forbidden field %q", action, key)
		}
		for _, forbidden := range []string{objectStorageAccessKey, objectStorageSecretKey, objectStorageRotatedSecretKey, "signed", "object_key"} {
			if bytes.Contains([]byte(value), []byte(forbidden)) {
				t.Fatalf("%s audit leaked %q: %v", action, forbidden, fields)
			}
		}
	}
}
