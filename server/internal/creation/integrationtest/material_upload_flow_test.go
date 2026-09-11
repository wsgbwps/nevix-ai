package integrationtest

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/creation"
)

type materialUploadView struct {
	ID                 string `json:"id"`
	SessionID          string `json:"session_id"`
	FileName           string `json:"file_name"`
	DeclaredKind       string `json:"declared_kind"`
	DeclaredMIMEType   string `json:"declared_mime_type"`
	DeclaredByteSize   int64  `json:"declared_byte_size"`
	ClaimsVersion      int    `json:"claims_version"`
	ConnectionRevision int64  `json:"connection_revision"`
	Status             string `json:"status"`
	PutExpiresAt       string `json:"put_expires_at"`
	FinalizeExpiresAt  string `json:"finalize_expires_at"`
	CreatedAt          string `json:"created_at"`
	FinalizedAt        string `json:"finalized_at"`
}

type uploadRequestView struct {
	Method    string            `json:"method"`
	URL       string            `json:"url"`
	Headers   map[string]string `json:"headers"`
	ExpiresAt string            `json:"expires_at"`
}

type materialUploadAuthorizationView struct {
	Upload        materialUploadView `json:"upload"`
	UploadRequest uploadRequestView  `json:"upload_request"`
}

type materialUploadStatusView struct {
	Upload   materialUploadView `json:"upload"`
	Material *materialView      `json:"material"`
}

func (h *harness) ensureObjectStorage(t *testing.T) {
	t.Helper()
	h.storageMu.Lock()
	defer h.storageMu.Unlock()
	if h.storageReady {
		return
	}
	admin := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	status, body := h.doRequest(t, http.MethodGet, "/creation/object-storage-connection", admin, nil)
	if status != http.StatusOK {
		t.Fatalf("read object storage connection: status=%d body=%s", status, body)
	}
	var current struct {
		State string `json:"state"`
	}
	mustDecode(t, body, &current)
	if current.State == "ready" {
		h.storageReady = true
		return
	}
	status, body = h.createObjectStorageConnection(t, admin)
	if status != http.StatusCreated {
		t.Fatalf("configure object storage: status=%d body=%s", status, body)
	}
	h.storageReady = true
}

func uploadCreateInput(key, name, kind, mimeType string, byteSize int64) map[string]any {
	return map[string]any{
		"idempotency_key":    key,
		"file_name":          name,
		"declared_kind":      kind,
		"declared_mime_type": mimeType,
		"declared_byte_size": byteSize,
	}
}

func (h *harness) createMaterialUpload(t *testing.T, token, sessionID string, input map[string]any) (int, []byte, materialUploadAuthorizationView) {
	t.Helper()
	status, body := h.doRequest(t, http.MethodPost, "/creation/sessions/"+sessionID+"/reference-material-uploads", token, input)
	var authorization materialUploadAuthorizationView
	if status == http.StatusCreated || status == http.StatusOK {
		assertContractResponse(t, http.MethodPost, "/creation/sessions/x/reference-material-uploads", status, body)
		mustDecode(t, body, &authorization)
	}
	return status, body, authorization
}

func putAuthorizedUpload(t *testing.T, authorization materialUploadAuthorizationView, body []byte) {
	t.Helper()
	req, err := http.NewRequest(authorization.UploadRequest.Method, authorization.UploadRequest.URL, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("build signed PUT: %v", err)
	}
	for name, value := range authorization.UploadRequest.Headers {
		req.Header.Set(name, value)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("signed PUT: %v", err)
	}
	defer resp.Body.Close()
	responseBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		t.Fatalf("signed PUT: status=%d body=%s", resp.StatusCode, responseBody)
	}
}

func TestReferenceMaterialUploadHappyPathIsDurableAndIdempotent(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	h.ensureObjectStorage(t)
	creator := h.loginToken(t, creatorEmail, harnessPassword)
	session := h.createSession(t, creator, sessionName("direct-upload"))
	payload := pngBytes(t)
	input := uploadCreateInput("direct-upload-same-key", "poster.png", "image", "image/png", int64(len(payload)))

	status, body, first := h.createMaterialUpload(t, creator, session.ID, input)
	if status != http.StatusCreated {
		t.Fatalf("create upload: status=%d body=%s", status, body)
	}
	assertNoSensitiveUploadFields(t, body)
	if first.Upload.Status != "pending" || first.Upload.SessionID != session.ID || first.UploadRequest.Method != http.MethodPut {
		t.Fatalf("created upload shape: %+v", first)
	}
	if first.UploadRequest.ExpiresAt != first.Upload.PutExpiresAt {
		t.Fatalf("signed request expiry=%s want lease deadline=%s", first.UploadRequest.ExpiresAt, first.Upload.PutExpiresAt)
	}
	putExpiry, err := time.Parse(time.RFC3339Nano, first.Upload.PutExpiresAt)
	if err != nil {
		t.Fatalf("parse put expiry: %v", err)
	}
	finalizeExpiry, err := time.Parse(time.RFC3339Nano, first.Upload.FinalizeExpiresAt)
	if err != nil {
		t.Fatalf("parse finalize expiry: %v", err)
	}
	createdAt, err := time.Parse(time.RFC3339Nano, first.Upload.CreatedAt)
	if err != nil {
		t.Fatalf("parse created at: %v", err)
	}
	if lifetime := putExpiry.Sub(createdAt); lifetime != 60*time.Minute {
		t.Fatalf("PUT window=%s want 60m", lifetime)
	}
	if gap := finalizeExpiry.Sub(putExpiry); gap != 30*time.Minute {
		t.Fatalf("finalize-only window=%s want 30m", gap)
	}

	status, body, replay := h.createMaterialUpload(t, creator, session.ID, input)
	if status != http.StatusOK {
		t.Fatalf("replay upload: status=%d body=%s", status, body)
	}
	if replay.Upload.ID != first.Upload.ID || replay.Upload.PutExpiresAt != first.Upload.PutExpiresAt || replay.Upload.FinalizeExpiresAt != first.Upload.FinalizeExpiresAt {
		t.Fatalf("idempotent replay changed identity/deadlines: first=%+v replay=%+v", first.Upload, replay.Upload)
	}

	conflict := uploadCreateInput("direct-upload-same-key", "changed.png", "image", "image/png", int64(len(payload)))
	status, body, _ = h.createMaterialUpload(t, creator, session.ID, conflict)
	if status != http.StatusConflict {
		t.Fatalf("payload conflict: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodPost, "/creation/sessions/x/reference-material-uploads", status, body)
	assertErrorCode(t, body, "idempotency_payload_conflict")

	putAuthorizedUpload(t, first, payload)
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_reference_material_uploads SET claims_version = 7 WHERE id = $1::uuid`, first.Upload.ID); err != nil {
		t.Fatalf("advance upload claims fixture: %v", err)
	}
	status, body = h.doRequest(t, http.MethodGet, "/creation/reference-material-uploads/"+first.Upload.ID, creator, nil)
	if status != http.StatusOK || bytes.Contains(body, []byte(first.UploadRequest.URL)) || bytes.Contains(body, []byte("upload_request")) {
		t.Fatalf("pending status leaked authorization: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodGet, "/creation/reference-material-uploads/x", status, body)

	status, body = h.doRequest(t, http.MethodPost, "/creation/reference-material-uploads/"+first.Upload.ID, creator, nil)
	if status != http.StatusOK {
		t.Fatalf("finalize: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodPost, "/creation/reference-material-uploads/x", status, body)
	var finalized materialUploadStatusView
	mustDecode(t, body, &finalized)
	if finalized.Upload.Status != "finalized" || finalized.Material == nil || finalized.Material.Kind != "image" || finalized.Material.ClaimsVersion != 7 {
		t.Fatalf("finalized upload: %+v", finalized)
	}

	status, body = h.doRequest(t, http.MethodPost, "/creation/reference-material-uploads/"+first.Upload.ID, creator, nil)
	if status != http.StatusOK {
		t.Fatalf("repeat finalize: status=%d body=%s", status, body)
	}
	var repeated materialUploadStatusView
	mustDecode(t, body, &repeated)
	if repeated.Material == nil || repeated.Material.ID != finalized.Material.ID {
		t.Fatalf("repeat finalize created a different material: first=%+v repeat=%+v", finalized.Material, repeated.Material)
	}
	status, body, finalizedReplay := h.createMaterialUpload(t, creator, session.ID, input)
	if status != http.StatusOK || finalizedReplay.Upload.ID != first.Upload.ID || bytes.Contains(body, []byte("upload_request")) {
		t.Fatalf("finalized create replay reissued authority: status=%d body=%s", status, body)
	}
	var materialRows int
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT count(*) FROM creation_reference_materials WHERE id = $1::uuid`, finalized.Material.ID).Scan(&materialRows); err != nil || materialRows != 1 {
		t.Fatalf("immutable material rows=%d err=%v", materialRows, err)
	}
}

func TestReferenceMaterialUploadEnforcesCreatorAndSessionPrivacy(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	h.ensureObjectStorage(t)
	creator := h.loginToken(t, creatorEmail, harnessPassword)
	other := h.loginToken(t, otherCreatorEmail, harnessPassword)
	admin := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	session := h.createSession(t, creator, sessionName("private-upload"))
	payload := pngBytes(t)
	status, body, upload := h.createMaterialUpload(t, creator, session.ID,
		uploadCreateInput("private-upload-key", "private.png", "image", "image/png", int64(len(payload))))
	if status != http.StatusCreated {
		t.Fatalf("create upload: status=%d body=%s", status, body)
	}

	for _, actor := range []string{other, admin} {
		for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodDelete} {
			status, body := h.doRequest(t, method, "/creation/reference-material-uploads/"+upload.Upload.ID, actor, nil)
			if status != http.StatusNotFound {
				t.Fatalf("foreign %s observed upload: status=%d body=%s", method, status, body)
			}
			assertContractResponse(t, method, "/creation/reference-material-uploads/x", status, body)
		}
	}

	foreignSession := h.createSession(t, other, sessionName("foreign-session"))
	status, body, _ = h.createMaterialUpload(t, creator, foreignSession.ID,
		uploadCreateInput("foreign-session-key", "private.png", "image", "image/png", int64(len(payload))))
	if status != http.StatusNotFound {
		t.Fatalf("foreign session upload: status=%d body=%s", status, body)
	}
}

func TestReferenceMaterialUploadRejectsEveryDeclaredKindAboveItsLimitBeforeSigning(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	creator := h.loginToken(t, creatorEmail, harnessPassword)
	session := h.createSession(t, creator, sessionName("declared-limits"))
	for _, tc := range []struct {
		kind     string
		mimeType string
		fileName string
		limit    int64
	}{
		{"image", "image/png", "large.png", 10 << 20},
		{"audio", "audio/mpeg", "large.mp3", 50 << 20},
		{"video", "video/mp4", "large.mp4", 200 << 20},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			status, body, _ := h.createMaterialUpload(t, creator, session.ID, uploadCreateInput(
				"over-limit-"+tc.kind, tc.fileName,
				tc.kind, tc.mimeType, tc.limit+1,
			))
			if status != http.StatusRequestEntityTooLarge {
				t.Fatalf("declared %s limit: status=%d body=%s", tc.kind, status, body)
			}
			assertContractResponse(t, http.MethodPost, "/creation/sessions/x/reference-material-uploads", status, body)
		})
	}
}

func TestReferenceMaterialUploadSignsOnlyEachProvidersClosedHeaderSet(t *testing.T) {
	for _, tc := range []struct {
		provider       string
		bucket         string
		metadataHeader string
		forbidHeader   string
	}{
		{"oss", "nevix-private", "X-Oss-Meta-Upload-Id", "X-Oss-Forbid-Overwrite"},
		{"cos", "nevix-private-1250000000", "X-Cos-Meta-Upload-Id", "X-Cos-Forbid-Overwrite"},
	} {
		t.Run(tc.provider, func(t *testing.T) {
			h := newHarnessWithOptions(t, harnessOptions{objectStorageVerifier: func(_ context.Context, candidate creation.ObjectStorageCandidate) (creation.ObjectStorageLocation, error) {
				return creation.ObjectStorageLocation{Provider: candidate.Location.Provider, Region: "cn-hangzhou", Bucket: tc.bucket}, nil
			}})
			h.ensureAccounts(t)
			h.resetObjectStorageConnections(t)
			admin := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
			proof := h.issueProof(t, admin, "object_storage_connection.create")
			status, body := h.doSecureRequest(t, http.MethodPost, "/creation/object-storage-connection", admin, map[string]string{
				"proof": proof, "provider": tc.provider, "region": "cn-hangzhou", "bucket": tc.bucket,
				"access_key_id": objectStorageAccessKey, "secret_access_key": objectStorageSecretKey,
			})
			if status != http.StatusCreated {
				t.Fatalf("configure %s: status=%d body=%s", tc.provider, status, body)
			}
			creator := h.loginToken(t, creatorEmail, harnessPassword)
			session := h.createSession(t, creator, sessionName("headers-"+tc.provider))
			status, body, upload := h.createMaterialUpload(t, creator, session.ID, uploadCreateInput(
				"headers-"+tc.provider, "poster.png", "image", "image/png", 1024,
			))
			if status != http.StatusCreated {
				t.Fatalf("create %s upload: status=%d body=%s", tc.provider, status, body)
			}
			headers := upload.UploadRequest.Headers
			if len(headers) != 3 || headers["Content-Type"] != "image/png" || headers[tc.metadataHeader] != upload.Upload.ID || headers[tc.forbidHeader] != "true" {
				t.Fatalf("%s signed headers are not the closed set: %#v", tc.provider, headers)
			}
		})
	}
}

func TestReferenceMaterialUploadRejectsHeadAndContentMismatchBeforeMaterialCreation(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	h.ensureObjectStorage(t)
	creator := h.loginToken(t, creatorEmail, harnessPassword)
	session := h.createSession(t, creator, sessionName("upload-mismatch"))
	png := pngBytes(t)

	status, body, sizeMismatch := h.createMaterialUpload(t, creator, session.ID,
		uploadCreateInput("size-mismatch", "wrong.png", "image", "image/png", int64(len(png)+1)))
	if status != http.StatusCreated {
		t.Fatalf("create size mismatch upload: status=%d body=%s", status, body)
	}
	putAuthorizedUpload(t, sizeMismatch, png)
	status, body = h.doRequest(t, http.MethodPost, "/creation/reference-material-uploads/"+sizeMismatch.Upload.ID, creator, nil)
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("size mismatch finalize: status=%d body=%s", status, body)
	}
	assertErrorCode(t, body, "material_upload_size_mismatch")
	assertUploadDatabaseState(t, h, sizeMismatch.Upload.ID, "terminal", true, false)
	assertExactUploadKeyWasDeleted(t, h, sizeMismatch.Upload.ID)

	status, body, metadataMismatch := h.createMaterialUpload(t, creator, session.ID,
		uploadCreateInput("metadata-mismatch", "metadata.png", "image", "image/png", int64(len(png))))
	if status != http.StatusCreated {
		t.Fatalf("create metadata mismatch upload: status=%d body=%s", status, body)
	}
	putAuthorizedUpload(t, metadataMismatch, png)
	h.directStore.replaceUploadMetadata(metadataMismatch.UploadRequest.URL, "different-upload-id")
	status, body = h.doRequest(t, http.MethodPost, "/creation/reference-material-uploads/"+metadataMismatch.Upload.ID, creator, nil)
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("metadata mismatch finalize: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodPost, "/creation/reference-material-uploads/x", status, body)
	assertErrorCode(t, body, "material_upload_metadata_mismatch")
	assertUploadDatabaseState(t, h, metadataMismatch.Upload.ID, "terminal", true, false)
	assertExactUploadKeyWasDeleted(t, h, metadataMismatch.Upload.ID)

	status, body, kindMismatch := h.createMaterialUpload(t, creator, session.ID,
		uploadCreateInput("kind-mismatch", "wrong.mp3", "audio", "audio/mpeg", int64(len(png))))
	if status != http.StatusCreated {
		t.Fatalf("create kind mismatch upload: status=%d body=%s", status, body)
	}
	putAuthorizedUpload(t, kindMismatch, png)
	status, body = h.doRequest(t, http.MethodPost, "/creation/reference-material-uploads/"+kindMismatch.Upload.ID, creator, nil)
	if status != http.StatusUnsupportedMediaType {
		t.Fatalf("kind mismatch finalize: status=%d body=%s", status, body)
	}
	assertErrorCode(t, body, "material_unsupported_media")
	assertUploadDatabaseState(t, h, kindMismatch.Upload.ID, "terminal", true, false)
	assertExactUploadKeyWasDeleted(t, h, kindMismatch.Upload.ID)

	var materialRows int
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT count(*) FROM creation_reference_materials WHERE session_id = $1::uuid`, session.ID).Scan(&materialRows); err != nil || materialRows != 0 {
		t.Fatalf("rejected uploads created materials: rows=%d err=%v", materialRows, err)
	}
}

func TestReferenceMaterialUploadExpiredLeaseRequiresNewIdempotencyKey(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	h.ensureObjectStorage(t)
	creator := h.loginToken(t, creatorEmail, harnessPassword)
	session := h.createSession(t, creator, sessionName("upload-expired"))
	png := pngBytes(t)
	input := uploadCreateInput("expired-upload-key", "expired.png", "image", "image/png", int64(len(png)))
	status, body, upload := h.createMaterialUpload(t, creator, session.ID, input)
	if status != http.StatusCreated {
		t.Fatalf("create expiring upload: status=%d body=%s", status, body)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `
		UPDATE creation_reference_material_uploads
		SET created_at = now() - interval '61 minutes',
		    put_deadline = now() - interval '1 minute',
		    finalize_deadline = now() + interval '29 minutes'
		WHERE id = $1::uuid`, upload.Upload.ID); err != nil {
		t.Fatalf("enter finalize-only fixture: %v", err)
	}
	status, body, finalizeOnly := h.createMaterialUpload(t, creator, session.ID, input)
	if status != http.StatusOK || finalizeOnly.Upload.ID != upload.Upload.ID || bytes.Contains(body, []byte("upload_request")) {
		t.Fatalf("finalize-only replay: status=%d body=%s", status, body)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `
		UPDATE creation_reference_material_uploads
		SET created_at = now() - interval '91 minutes',
		    put_deadline = now() - interval '31 minutes',
		    finalize_deadline = now() - interval '1 minute'
		WHERE id = $1::uuid`, upload.Upload.ID); err != nil {
		t.Fatalf("expire upload fixture: %v", err)
	}
	status, body, _ = h.createMaterialUpload(t, creator, session.ID, input)
	if status != http.StatusConflict || !strings.Contains(string(body), "reference_material_upload_expired") {
		t.Fatalf("expired idempotency replay: status=%d body=%s", status, body)
	}

	newInput := uploadCreateInput("expired-upload-new-key", "expired.png", "image", "image/png", int64(len(png)))
	status, body, replacement := h.createMaterialUpload(t, creator, session.ID, newInput)
	if status != http.StatusCreated || replacement.Upload.ID == upload.Upload.ID {
		t.Fatalf("new key after expiry: status=%d body=%s replacement=%+v", status, body, replacement.Upload)
	}
}

func TestSuccessfulGenerationResultBecomesIndependentReferenceMaterialInsideServer(t *testing.T) {
	h, _, creatorEmailAddress := readyTaskHarness(t, harnessOptions{runWorkers: true})
	h.ensureObjectStorage(t)
	creator := h.loginToken(t, creatorEmailAddress, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1})
	draft := h.imageTaskIntent(t, creator, "结果复用", 1)
	status, body := h.submitTask(t, creator, "result-to-material-task", draft)
	if status != http.StatusCreated {
		t.Fatalf("submit source task: status=%d body=%s", status, body)
	}
	task := decodeTaskView(t, body)
	task = h.awaitTaskTerminal(t, creator, task.Task.ID)
	if task.Task.Status != "succeeded" {
		t.Fatalf("source task did not succeed: %+v", task)
	}

	status, body = h.doRequest(t, http.MethodPost, "/creation/sessions/"+draft.SessionID+"/materials/from-result", creator, map[string]any{
		"task_id": task.Task.ID, "slot_index": 0, "file_name": "generated.png",
	})
	if status != http.StatusCreated {
		t.Fatalf("convert result: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodPost, "/creation/sessions/x/materials/from-result", status, body)
	var material materialView
	mustDecode(t, body, &material)
	if material.Kind != "image" || material.MimeType != "image/png" || material.FileName != "generated.png" {
		t.Fatalf("converted material facts: %+v", material)
	}

	other := h.loginToken(t, otherCreatorEmail, harnessPassword)
	status, body = h.doRequest(t, http.MethodPost, "/creation/sessions/"+draft.SessionID+"/materials/from-result", other, map[string]any{
		"task_id": task.Task.ID, "slot_index": 0, "file_name": "stolen.png",
	})
	if status != http.StatusNotFound {
		t.Fatalf("foreign result conversion: status=%d body=%s", status, body)
	}

	var objectKey string
	if err := h.ownerPool.QueryRow(h.ctx,
		`SELECT blob_key FROM creation_reference_materials WHERE id = $1::uuid`, material.ID,
	).Scan(&objectKey); err != nil {
		t.Fatalf("read converted material key: %v", err)
	}
	png := pngBytes(t)
	status, body, _ = h.createMaterialUpload(t, creator, draft.SessionID, uploadCreateInput(
		"material-delete-"+material.ID,
		"collision.png", "image", "image/png", int64(len(png)),
	))
	if status != http.StatusCreated {
		t.Fatalf("pre-create public idempotency collision: status=%d body=%s", status, body)
	}
	h.directStore.failDeletes(1)
	if status, body := h.doRequest(t, http.MethodDelete, "/creation/materials/"+material.ID, creator, nil); status != http.StatusNoContent {
		t.Fatalf("delete converted material: status=%d body=%s", status, body)
	}
	var cleanupID string
	var cleanupDue bool
	if err := h.ownerPool.QueryRow(h.ctx, `
		SELECT id, cleanup_next_attempt_at IS NOT NULL AND cleanup_confirmed_at IS NULL
		FROM creation_reference_material_uploads
		WHERE material_id = $1::uuid AND object_key = $2`, material.ID, objectKey,
	).Scan(&cleanupID, &cleanupDue); err != nil {
		t.Fatalf("read converted material cleanup: %v", err)
	}
	if !cleanupDue {
		t.Fatal("converted material delete did not persist cleanup after provider failure")
	}
	if _, err := h.directStore.Head(h.ctx, objectKey); err != nil {
		t.Fatalf("failed immediate converted-material delete did not leave test object: %v", err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `
		UPDATE creation_reference_material_uploads
		SET cleanup_next_attempt_at = now()
		WHERE id = $1::uuid`, cleanupID); err != nil {
		t.Fatalf("make converted material cleanup due: %v", err)
	}
	workerCtx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.creation.RunWorkers(workerCtx) }()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if err := h.ownerPool.QueryRow(h.ctx, `
			SELECT cleanup_confirmed_at IS NOT NULL
			FROM creation_reference_material_uploads WHERE id = $1::uuid`, cleanupID,
		).Scan(&cleanupDue); err == nil && cleanupDue {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("stop converted material cleanup worker: %v", err)
	}
	if !cleanupDue {
		t.Fatal("converted material cleanup worker did not confirm deletion")
	}
	if _, err := h.directStore.Head(h.ctx, objectKey); err == nil {
		t.Fatal("converted material object survived durable cleanup")
	}
}

func TestUploadedReferenceMaterialFeedsTheGenerationWorkerFromObjectStorage(t *testing.T) {
	h, _, creatorEmailAddress := readyTaskHarness(t, harnessOptions{runWorkers: true})
	h.ensureObjectStorage(t)
	creator := h.loginToken(t, creatorEmailAddress, harnessPassword)
	session := h.createSession(t, creator, sessionName("uploaded-reference-worker"))
	firstMaterialID := h.uploadImage(t, creator, session.ID, "first-reference.png")
	secondMaterialID := h.uploadImage(t, creator, session.ID, "second-reference.png")
	h.referenceTransport.beforePrepare = func(jobID creation.UUID, ordinal int) error {
		var status string
		var attempts int
		if err := h.ownerPool.QueryRow(h.ctx, `
			SELECT status, submit_attempts FROM creation_provider_jobs WHERE id = $1::uuid
		`, jobID.String()).Scan(&status, &attempts); err != nil {
			return fmt.Errorf("read pre-marker job: %w", err)
		}
		if status != "pending" || attempts != 0 || h.kapon.generation.imageRequests() != 0 {
			return fmt.Errorf("reference %d prepared after submit boundary: status=%s attempts=%d provider_calls=%d", ordinal, status, attempts, h.kapon.generation.imageRequests())
		}
		return nil
	}
	h.kapon.generation.setImage(imageScript{outputs: 1})
	draft := h.buildTaskIntent(t, creator, session.ID, taskIntent{
		SessionID: session.ID, MediaType: "image", Model: "doubao-seedream-5.0-pro",
		Mode: "reference-image", Ratio: "1:1", Resolution: "2K", Quantity: 1,
		Prompt: "使用已直传的永久素材", References: []any{
			map[string]any{"material_id": firstMaterialID, "role": "reference"},
			map[string]any{"material_id": secondMaterialID, "role": "reference"},
		},
	})
	status, body := h.submitTask(t, creator, "uploaded-reference-worker-task", draft)
	if status != http.StatusCreated {
		t.Fatalf("submit task with uploaded reference: status=%d body=%s", status, body)
	}
	task := h.awaitTaskTerminal(t, creator, decodeTaskView(t, body).Task.ID)
	if task.Task.Status != "succeeded" {
		t.Fatalf("task using uploaded reference did not succeed: %+v", task)
	}
	call := h.kapon.generation.lastImageCall()
	if call == nil || call.images != 2 {
		t.Fatalf("generation worker did not read the uploaded reference from Object Storage: %+v", call)
	}
	records := h.referenceTransport.prepared()
	if len(records) != 2 || records[0].ordinal != 0 || records[1].ordinal != 1 || records[0].jobID != records[1].jobID {
		t.Fatalf("ordered preparation records = %+v", records)
	}
	wantBytes := pngBytes(t)
	wantSum := sha256.Sum256(wantBytes)
	for _, record := range records {
		if record.role != "reference" || record.kind != "image" || record.mimeType != "image/png" ||
			record.byteSize != int64(len(wantBytes)) || record.checksum != wantSum || record.readSize != int64(len(wantBytes)) || record.readSum != wantSum {
			t.Fatalf("ReferenceSource lost immutable material facts: %+v", record)
		}
	}
	wantURLs := []string{referenceURL(records[0].jobID, 0), referenceURL(records[0].jobID, 1)}
	if len(call.imageURLs) != 2 || call.imageURLs[0] != wantURLs[0] || call.imageURLs[1] != wantURLs[1] {
		t.Fatalf("Kapon image references = %v, want %v", call.imageURLs, wantURLs)
	}
	for _, rawURL := range call.imageURLs {
		if !strings.HasPrefix(rawURL, "https://") || strings.Contains(rawURL, "data:") || strings.Contains(rawURL, "base64") {
			t.Fatalf("Kapon received a non-HTTPS reference: %q", rawURL)
		}
	}
	if got := countRows(t, h.ownerPool, `
		SELECT count(*) FROM creation_provider_jobs
		WHERE id = $1::uuid AND status = 'completed' AND submit_attempts = 1
	`, records[0].jobID.String()); got != 1 {
		t.Fatalf("prepared job did not persist the expected submit result: %d", got)
	}
	var persistedJob string
	if err := h.ownerPool.QueryRow(h.ctx, `
		SELECT row_to_json(job)::text FROM creation_provider_jobs AS job WHERE id = $1::uuid
	`, records[0].jobID.String()).Scan(&persistedJob); err != nil {
		t.Fatalf("read persisted provider job: %v", err)
	}
	if strings.Contains(persistedJob, "provider-transfer.example") {
		t.Fatalf("prepared reference URL was persisted: %s", persistedJob)
	}
}

func TestNearVideoLimitReferenceStreamsWithoutWholePayloadBuffering(t *testing.T) {
	h, _, creatorEmailAddress := readyTaskHarness(t, harnessOptions{runWorkers: true})
	creator := h.loginToken(t, creatorEmailAddress, harnessPassword)
	session := h.createSession(t, creator, sessionName("near-video-reference-limit"))
	status, body := h.doUpload(t, http.MethodPost, "/creation/sessions/"+session.ID+"/materials", creator, "large-reference.mp4", mp4Fixture())
	if status != http.StatusCreated {
		t.Fatalf("upload seed video: status=%d body=%s", status, body)
	}
	materialID := extractField(t, body, "id")

	const fill = byte(0xA7)
	byteSize := int64(200<<20) - 1
	checksum := repeatedByteChecksum(fill, byteSize)
	var blobKey string
	if err := h.ownerPool.QueryRow(h.ctx, `
		UPDATE creation_reference_materials
		SET byte_size = $2, checksum_sha256 = $3
		WHERE id = $1::uuid
		RETURNING blob_key
	`, materialID, byteSize, checksum[:]).Scan(&blobKey); err != nil {
		t.Fatalf("install generated near-limit material facts: %v", err)
	}
	h.directStore.replaceWithGeneratedObject(blobKey, byteSize, fill)
	h.kapon.generation.setVideo(videoTaskScript{succeedAfter: 0})

	draft := h.buildTaskIntent(t, creator, session.ID, taskIntent{
		MediaType: "video", Model: "doubao-seedance-2-5", Mode: "omni-reference",
		Resolution: "720p", Duration: 5, Prompt: "近上限流式参考素材",
		References: []any{map[string]any{"material_id": materialID, "role": "omni"}},
	})
	status, body = h.submitTask(t, creator, "near-video-reference-limit", draft)
	if status != http.StatusCreated {
		t.Fatalf("submit near-limit task: status=%d body=%s", status, body)
	}
	view := h.awaitTaskTerminal(t, creator, decodeTaskView(t, body).Task.ID)
	if view.Task.Status != "succeeded" {
		t.Fatalf("near-limit reference task did not succeed: %s (%s)", view.Task.Status, slotVerdicts(view))
	}
	records := h.referenceTransport.prepared()
	if len(records) != 1 || records[0].byteSize != byteSize || records[0].readSize != byteSize || records[0].checksum != checksum || records[0].readSum != checksum {
		t.Fatalf("near-limit stream facts changed: %+v", records)
	}
	if largest := h.directStore.largestGeneratedRead(); largest <= 0 || largest > 32<<10 {
		t.Fatalf("near-limit source read chunk = %d, want 1..32768 bytes", largest)
	}
}

func repeatedByteChecksum(value byte, size int64) [32]byte {
	hash := sha256.New()
	block := bytes.Repeat([]byte{value}, 32<<10)
	for remaining := size; remaining > 0; {
		chunk := int64(len(block))
		if chunk > remaining {
			chunk = remaining
		}
		_, _ = hash.Write(block[:chunk])
		remaining -= chunk
	}
	var sum [32]byte
	copy(sum[:], hash.Sum(nil))
	return sum
}

func TestReferenceSourceFailuresEndBeforeKaponSubmit(t *testing.T) {
	h, _, creatorEmailAddress := readyTaskHarness(t, harnessOptions{runWorkers: true})
	creator := h.loginToken(t, creatorEmailAddress, harnessPassword)

	run := func(name string, fail func()) {
		t.Helper()
		session := h.createSession(t, creator, sessionName(name))
		materialID := h.uploadImage(t, creator, session.ID, name+".png")
		fail()
		draft := h.buildTaskIntent(t, creator, session.ID, taskIntent{
			MediaType: "image", Model: "doubao-seedream-5.0-pro", Mode: "reference-image",
			Ratio: "1:1", Resolution: "2K", Quantity: 1, Prompt: name,
			References: []any{map[string]any{"material_id": materialID, "role": "reference"}},
		})
		status, body := h.submitTask(t, creator, name, draft)
		if status != http.StatusCreated {
			t.Fatalf("submit %s: status=%d body=%s", name, status, body)
		}
		view := h.awaitTaskTerminal(t, creator, decodeTaskView(t, body).Task.ID)
		if view.Task.Status != "failed" || len(view.Slots) != 1 || view.Slots[0].FailureReason == nil || *view.Slots[0].FailureReason != "internal_error" {
			t.Fatalf("%s did not persist an explicit preparation failure: %s (%s)", name, view.Task.Status, slotVerdicts(view))
		}
		var jobStatus string
		var submitAttempts int
		if err := h.ownerPool.QueryRow(h.ctx, `
			SELECT status, submit_attempts FROM creation_provider_jobs WHERE task_id = $1::uuid
		`, view.Task.ID).Scan(&jobStatus, &submitAttempts); err != nil {
			t.Fatalf("read %s provider job: %v", name, err)
		}
		if jobStatus != "failed" || submitAttempts != 0 {
			t.Fatalf("%s provider job = %s/%d, want failed/0 before marker", name, jobStatus, submitAttempts)
		}
	}

	run("reference-open-failure", func() {
		h.directStore.failNextReferenceOpen(errors.New("sensitive source open failure"))
	})
	run("reference-read-failure", func() {
		h.directStore.failNextReferenceRead(errors.New("sensitive source read failure"))
	})
	if got := h.kapon.generation.imageRequests(); got != 0 {
		t.Fatalf("preparation failures reached Kapon %d times", got)
	}
}

func TestCancelDuringReferencePreparationRejectsMarkerBeforeKapon(t *testing.T) {
	h, _, creatorEmailAddress := readyTaskHarness(t, harnessOptions{runWorkers: true})
	creator := h.loginToken(t, creatorEmailAddress, harnessPassword)
	session := h.createSession(t, creator, sessionName("cancel-during-reference-preparation"))
	materialID := h.uploadImage(t, creator, session.ID, "cancel-reference.png")
	h.referenceTransport.beforePrepare = func(jobID creation.UUID, _ int) error {
		var taskID string
		if err := h.ownerPool.QueryRow(h.ctx, `
			SELECT task_id FROM creation_provider_jobs WHERE id = $1::uuid
		`, jobID.String()).Scan(&taskID); err != nil {
			return fmt.Errorf("resolve task for pre-marker cancellation: %w", err)
		}
		status, body := h.doRequest(t, http.MethodPost, "/creation/tasks/"+taskID+"/cancel", creator, nil)
		if status != http.StatusOK {
			return fmt.Errorf("cancel during reference preparation: status=%d body=%s", status, body)
		}
		return nil
	}
	draft := h.buildTaskIntent(t, creator, session.ID, taskIntent{
		MediaType: "image", Model: "doubao-seedream-5.0-pro", Mode: "reference-image",
		Ratio: "1:1", Resolution: "2K", Quantity: 1, Prompt: "准备中取消",
		References: []any{map[string]any{"material_id": materialID, "role": "reference"}},
	})
	status, body := h.submitTask(t, creator, "cancel-during-reference-preparation", draft)
	if status != http.StatusCreated {
		t.Fatalf("submit cancellable task: status=%d body=%s", status, body)
	}
	view := h.awaitTaskTerminal(t, creator, decodeTaskView(t, body).Task.ID)
	if view.Task.Status != "cancelled" {
		t.Fatalf("pre-marker cancellation status = %s, want cancelled", view.Task.Status)
	}
	if got := h.kapon.generation.imageRequests(); got != 0 {
		t.Fatalf("rejected submit marker still reached Kapon %d times", got)
	}
}

func assertNoSensitiveUploadFields(t *testing.T, body []byte) {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("decode upload response: %v", err)
	}
	encoded := string(body)
	for _, forbidden := range []string{"object_key", "owner_user_id", "payload_hash", objectStorageAccessKey, objectStorageSecretKey} {
		if strings.Contains(encoded, forbidden) {
			t.Fatalf("upload response exposed %q: %s", forbidden, body)
		}
	}
}
