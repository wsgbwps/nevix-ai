package integrationtest

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

type uploadHTTPResult struct {
	status int
	body   []byte
}

func TestReferenceMaterialUploadLiveLeaseAndExpiredTakeoverAreFenced(t *testing.T) {
	base := time.Date(2026, time.September, 9, 8, 0, 0, 0, time.UTC)
	var clock atomic.Int64
	clock.Store(base.UnixNano())
	h := newHarnessWithOptions(t, harnessOptions{
		now: func() time.Time { return time.Unix(0, clock.Load()).UTC() },
	})
	h.ensureAccounts(t)
	h.ensureObjectStorage(t)
	creator := h.loginToken(t, creatorEmail, harnessPassword)
	session := h.createSession(t, creator, sessionName("upload-fencing"))
	png := pngBytes(t)
	status, body, upload := h.createMaterialUpload(t, creator, session.ID,
		uploadCreateInput("upload-fencing-key", "fenced.png", "image", "image/png", int64(len(png))))
	if status != http.StatusCreated {
		t.Fatalf("create upload: status=%d body=%s", status, body)
	}
	putAuthorizedUpload(t, upload, png)

	headStarted, releaseHead := h.directStore.blockNextHead()
	firstDone := make(chan uploadHTTPResult, 1)
	go func() {
		status, body := h.doRequest(t, http.MethodPost, "/creation/reference-material-uploads/"+upload.Upload.ID, creator, nil)
		firstDone <- uploadHTTPResult{status: status, body: body}
	}()
	select {
	case <-headStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("first verifier did not reach provider Head")
	}

	status, body = h.doRequest(t, http.MethodGet, "/creation/reference-material-uploads/"+upload.Upload.ID, creator, nil)
	if status != http.StatusOK || !bytes.Contains(body, []byte(`"status":"verifying"`)) {
		t.Fatalf("live verifying status: status=%d body=%s", status, body)
	}
	status, body = h.doRequest(t, http.MethodPost, "/creation/reference-material-uploads/"+upload.Upload.ID, creator, nil)
	if status != http.StatusConflict {
		t.Fatalf("concurrent live finalize: status=%d body=%s", status, body)
	}
	assertErrorCode(t, body, "reference_material_upload_verifying")

	var leaseSeconds float64
	if err := h.ownerPool.QueryRow(h.ctx, `
		SELECT extract(epoch FROM (verification_lease_until - created_at))
		FROM creation_reference_material_uploads WHERE id = $1::uuid`, upload.Upload.ID).Scan(&leaseSeconds); err != nil {
		t.Fatalf("read verification lease: %v", err)
	}
	if leaseSeconds < 1799 || leaseSeconds > 1801 {
		t.Fatalf("verification lease = %.3fs, want 1800s", leaseSeconds)
	}

	clock.Store(base.Add(31 * time.Minute).UnixNano())
	status, body = h.doRequest(t, http.MethodPost, "/creation/reference-material-uploads/"+upload.Upload.ID, creator, nil)
	if status != http.StatusOK {
		t.Fatalf("takeover finalize: status=%d body=%s", status, body)
	}
	close(releaseHead)
	select {
	case first := <-firstDone:
		if first.status != http.StatusOK {
			t.Fatalf("stale verifier did not converge to finalized replay: status=%d body=%s", first.status, first.body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("stale verifier did not finish")
	}
	var materialRows int
	if err := h.ownerPool.QueryRow(h.ctx, `
		SELECT count(*) FROM creation_reference_materials m
		JOIN creation_reference_material_uploads u ON u.material_id = m.id
		WHERE u.id = $1::uuid AND u.status = 'finalized'`, upload.Upload.ID).Scan(&materialRows); err != nil || materialRows != 1 {
		t.Fatalf("fenced takeover material rows=%d err=%v", materialRows, err)
	}
}

func TestReferenceMaterialUploadFinalTransactionRollsBackBeforeLeaseTakeover(t *testing.T) {
	base := time.Date(2026, time.September, 9, 8, 0, 0, 0, time.UTC)
	var clock atomic.Int64
	clock.Store(base.UnixNano())
	h := newHarnessWithOptions(t, harnessOptions{
		now: func() time.Time { return time.Unix(0, clock.Load()).UTC() },
	})
	h.ensureAccounts(t)
	h.ensureObjectStorage(t)
	creator := h.loginToken(t, creatorEmail, harnessPassword)
	session := h.createSession(t, creator, sessionName("upload-finalize-rollback"))
	png := pngBytes(t)
	status, body, upload := h.createMaterialUpload(t, creator, session.ID,
		uploadCreateInput("upload-finalize-rollback", "rollback.png", "image", "image/png", int64(len(png))))
	if status != http.StatusCreated {
		t.Fatalf("create rollback upload: status=%d body=%s", status, body)
	}
	putAuthorizedUpload(t, upload, png)
	if _, err := h.ownerPool.Exec(h.ctx, `
		CREATE FUNCTION test_fail_reference_upload_finalize() RETURNS trigger
		LANGUAGE plpgsql AS $$
		BEGIN
			IF NEW.status = 'finalized' THEN
				RAISE EXCEPTION 'injected finalize failure';
			END IF;
			RETURN NEW;
		END
		$$`); err != nil {
		t.Fatalf("create finalize failure function: %v", err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `
		CREATE TRIGGER test_fail_reference_upload_finalize
		BEFORE UPDATE ON creation_reference_material_uploads
		FOR EACH ROW EXECUTE FUNCTION test_fail_reference_upload_finalize()`); err != nil {
		t.Fatalf("create finalize failure trigger: %v", err)
	}
	dropFailure := func() {
		_, _ = h.ownerPool.Exec(context.Background(), `DROP TRIGGER IF EXISTS test_fail_reference_upload_finalize ON creation_reference_material_uploads`)
		_, _ = h.ownerPool.Exec(context.Background(), `DROP FUNCTION IF EXISTS test_fail_reference_upload_finalize()`)
	}
	t.Cleanup(dropFailure)

	status, body = h.doRequest(t, http.MethodPost, "/creation/reference-material-uploads/"+upload.Upload.ID, creator, nil)
	if status != http.StatusInternalServerError {
		t.Fatalf("injected finalize failure: status=%d body=%s", status, body)
	}
	var materialRows int
	var uploadStatus string
	if err := h.ownerPool.QueryRow(h.ctx, `
		SELECT u.status,
		       (SELECT count(*) FROM creation_reference_materials WHERE id = u.material_id)
		FROM creation_reference_material_uploads u WHERE u.id = $1::uuid`, upload.Upload.ID).Scan(&uploadStatus, &materialRows); err != nil {
		t.Fatalf("read rolled-back finalize facts: %v", err)
	}
	if uploadStatus != "verifying" || materialRows != 0 {
		t.Fatalf("rolled-back finalize status=%s material_rows=%d, want verifying/0", uploadStatus, materialRows)
	}
	dropFailure()
	clock.Store(base.Add(31 * time.Minute).UnixNano())
	status, body = h.doRequest(t, http.MethodPost, "/creation/reference-material-uploads/"+upload.Upload.ID, creator, nil)
	if status != http.StatusOK {
		t.Fatalf("take over after rolled-back finalize: status=%d body=%s", status, body)
	}
}

func TestReferenceMaterialUploadClassifiesTransientPutRequiredAndTerminalFailures(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	h.ensureObjectStorage(t)
	creator := h.loginToken(t, creatorEmail, harnessPassword)
	session := h.createSession(t, creator, sessionName("upload-failures"))
	png := pngBytes(t)

	status, body, transient := h.createMaterialUpload(t, creator, session.ID,
		uploadCreateInput("upload-transient-key", "transient.png", "image", "image/png", int64(len(png))))
	if status != http.StatusCreated {
		t.Fatalf("create transient upload: status=%d body=%s", status, body)
	}
	putAuthorizedUpload(t, transient, png)
	h.directStore.failNextHead(errors.New("raw-provider-secret-should-not-escape"))
	status, body = h.doRequest(t, http.MethodPost, "/creation/reference-material-uploads/"+transient.Upload.ID, creator, nil)
	if status != http.StatusServiceUnavailable {
		t.Fatalf("transient finalize: status=%d body=%s", status, body)
	}
	assertErrorCode(t, body, "object_storage_unavailable")
	if bytes.Contains(body, []byte("raw-provider-secret")) {
		t.Fatalf("transient response leaked provider detail: %s", body)
	}
	assertUploadDatabaseState(t, h, transient.Upload.ID, "pending", false, false)
	status, body = h.doRequest(t, http.MethodPost, "/creation/reference-material-uploads/"+transient.Upload.ID, creator, nil)
	if status != http.StatusOK {
		t.Fatalf("transient retry finalize: status=%d body=%s", status, body)
	}

	status, body, probeTransient := h.createMaterialUpload(t, creator, session.ID,
		uploadCreateInput("upload-probe-transient-key", "probe-transient.png", "image", "image/png", int64(len(png))))
	if status != http.StatusCreated {
		t.Fatalf("create probe transient upload: status=%d body=%s", status, body)
	}
	putAuthorizedUpload(t, probeTransient, png)
	h.directStore.failNextProbeRead(errors.Join(
		io.ErrUnexpectedEOF,
		errors.New("raw-probe-provider-secret-should-not-escape"),
	))
	status, body = h.doRequest(t, http.MethodPost, "/creation/reference-material-uploads/"+probeTransient.Upload.ID, creator, nil)
	if status != http.StatusServiceUnavailable {
		t.Fatalf("probe read transient finalize: status=%d body=%s", status, body)
	}
	assertErrorCode(t, body, "object_storage_unavailable")
	if bytes.Contains(body, []byte("raw-probe-provider-secret")) {
		t.Fatalf("probe transient response leaked provider detail: %s", body)
	}
	assertUploadDatabaseState(t, h, probeTransient.Upload.ID, "pending", false, false)
	status, body = h.doRequest(t, http.MethodPost, "/creation/reference-material-uploads/"+probeTransient.Upload.ID, creator, nil)
	if status != http.StatusOK {
		t.Fatalf("probe transient retry finalize: status=%d body=%s", status, body)
	}

	status, body, absent := h.createMaterialUpload(t, creator, session.ID,
		uploadCreateInput("upload-put-required-key", "missing.png", "image", "image/png", int64(len(png))))
	if status != http.StatusCreated {
		t.Fatalf("create absent upload: status=%d body=%s", status, body)
	}
	status, body = h.doRequest(t, http.MethodPost, "/creation/reference-material-uploads/"+absent.Upload.ID, creator, nil)
	if status != http.StatusConflict {
		t.Fatalf("absent object before PUT deadline: status=%d body=%s", status, body)
	}
	assertErrorCode(t, body, "reference_material_upload_put_required")
	assertUploadDatabaseState(t, h, absent.Upload.ID, "pending", false, false)

	status, body, rejected := h.createMaterialUpload(t, creator, session.ID,
		uploadCreateInput("upload-terminal-key", "wrong-size.png", "image", "image/png", int64(len(png)+1)))
	if status != http.StatusCreated {
		t.Fatalf("create deterministic rejection: status=%d body=%s", status, body)
	}
	putAuthorizedUpload(t, rejected, png)
	status, body = h.doRequest(t, http.MethodPost, "/creation/reference-material-uploads/"+rejected.Upload.ID, creator, nil)
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("deterministic finalize rejection: status=%d body=%s", status, body)
	}
	assertErrorCode(t, body, "material_upload_size_mismatch")
	assertUploadDatabaseState(t, h, rejected.Upload.ID, "terminal", true, false)
	assertExactUploadKeyWasDeleted(t, h, rejected.Upload.ID)
}

func TestReferenceMaterialUploadFinalEligibilityFailureTerminalizesAndCleans(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*testing.T, *harness, materialUploadAuthorizationView)
	}{
		{
			name: "disabled owner",
			mutate: func(t *testing.T, h *harness, upload materialUploadAuthorizationView) {
				if _, err := h.ownerPool.Exec(h.ctx, `
					UPDATE users SET status = 'disabled'
					WHERE id = (SELECT owner_user_id FROM creation_reference_material_uploads WHERE id = $1::uuid)`, upload.Upload.ID); err != nil {
					t.Fatalf("disable owner: %v", err)
				}
				t.Cleanup(func() {
					_, _ = h.ownerPool.Exec(context.Background(), `
						UPDATE users SET status = 'active'
						WHERE id = (SELECT owner_user_id FROM creation_reference_material_uploads WHERE id = $1::uuid)`, upload.Upload.ID)
				})
			},
		},
		{
			name: "deleted session",
			mutate: func(t *testing.T, h *harness, upload materialUploadAuthorizationView) {
				if _, err := h.ownerPool.Exec(h.ctx, `
					UPDATE creation_sessions SET deleted_at = now() WHERE id = $1::uuid`, upload.Upload.SessionID); err != nil {
					t.Fatalf("delete session: %v", err)
				}
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			h.ensureAccounts(t)
			h.ensureObjectStorage(t)
			creator := h.loginToken(t, creatorEmail, harnessPassword)
			session := h.createSession(t, creator, sessionName("eligibility-"+tc.name))
			png := pngBytes(t)
			status, body, upload := h.createMaterialUpload(t, creator, session.ID,
				uploadCreateInput("eligibility-"+tc.name, "eligibility.png", "image", "image/png", int64(len(png))))
			if status != http.StatusCreated {
				t.Fatalf("create upload: status=%d body=%s", status, body)
			}
			putAuthorizedUpload(t, upload, png)
			started, release := h.directStore.blockNextHead()
			done := make(chan uploadHTTPResult, 1)
			go func() {
				status, body := h.doRequest(t, http.MethodPost, "/creation/reference-material-uploads/"+upload.Upload.ID, creator, nil)
				done <- uploadHTTPResult{status: status, body: body}
			}()
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("verifier did not reach Head")
			}
			tc.mutate(t, h, upload)
			close(release)
			result := <-done
			if result.status != http.StatusConflict {
				t.Fatalf("final eligibility verdict: status=%d body=%s", result.status, result.body)
			}
			assertErrorCode(t, result.body, "reference_material_upload_terminal")
			assertUploadDatabaseState(t, h, upload.Upload.ID, "terminal", true, false)
		})
	}
}

func TestReferenceMaterialCleanupClaimSkipsLockedRowsAndCapsBatchAtOneHundred(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	h.ensureObjectStorage(t)
	creator := h.loginToken(t, creatorEmail, harnessPassword)
	session := h.createSession(t, creator, sessionName("cleanup-batch"))
	status, body, upload := h.createMaterialUpload(t, creator, session.ID,
		uploadCreateInput("cleanup-batch-base", "batch.png", "image", "image/png", 3))
	if status != http.StatusCreated {
		t.Fatalf("create cleanup base: status=%d body=%s", status, body)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `
		UPDATE creation_reference_material_uploads
		SET status = 'terminal', terminal_at = now(),
		    created_at = now() - interval '91 minutes',
		    put_deadline = now() - interval '31 minutes',
		    finalize_deadline = now() - interval '1 minute', cleanup_next_attempt_at = now()
		WHERE id = $1::uuid`, upload.Upload.ID); err != nil {
		t.Fatalf("terminalize cleanup base: %v", err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `
		INSERT INTO creation_reference_material_uploads (
			id, owner_user_id, session_id, material_id, object_key, file_name,
			declared_kind, declared_mime_type, declared_byte_size, claims_version,
			idempotency_key, payload_hash, connection_revision, put_deadline,
			finalize_deadline, status, created_at, terminal_at, cleanup_next_attempt_at
		)
		SELECT gen_random_uuid(), owner_user_id, session_id, gen_random_uuid(),
		       'reference-materials/test/' || gen_random_uuid()::text, file_name,
		       declared_kind, declared_mime_type, declared_byte_size, claims_version,
		       'cleanup-batch-' || n::text, payload_hash, connection_revision,
		       put_deadline, finalize_deadline, 'terminal', created_at, now(), now()
		FROM creation_reference_material_uploads, generate_series(1, 100) AS n
		WHERE id = $1::uuid`, upload.Upload.ID); err != nil {
		t.Fatalf("seed cleanup batch: %v", err)
	}

	lockTx, err := h.ownerPool.Begin(h.ctx)
	if err != nil {
		t.Fatalf("begin cleanup blocker: %v", err)
	}
	defer lockTx.Rollback(context.Background())
	if _, err := lockTx.Exec(h.ctx, `
		SELECT id FROM creation_reference_material_uploads WHERE id = $1::uuid FOR UPDATE`, upload.Upload.ID); err != nil {
		t.Fatalf("lock cleanup row: %v", err)
	}
	workerCtx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.creation.RunWorkers(workerCtx) }()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var confirmed int
		if err := h.ownerPool.QueryRow(h.ctx, `
			SELECT count(*) FROM creation_reference_material_uploads
			WHERE id = $1::uuid OR idempotency_key LIKE 'cleanup-batch-%'`, upload.Upload.ID).Scan(&confirmed); err != nil {
			t.Fatalf("count cleanup fixtures: %v", err)
		}
		if err := h.ownerPool.QueryRow(h.ctx, `
			SELECT count(*) FROM creation_reference_material_uploads
			WHERE cleanup_confirmed_at IS NOT NULL
			  AND (id = $1::uuid OR idempotency_key LIKE 'cleanup-batch-%')`, upload.Upload.ID).Scan(&confirmed); err == nil && confirmed == 100 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	var confirmed int
	if err := h.ownerPool.QueryRow(h.ctx, `
		SELECT count(*) FROM creation_reference_material_uploads
		WHERE cleanup_confirmed_at IS NOT NULL
		  AND (id = $1::uuid OR idempotency_key LIKE 'cleanup-batch-%')`, upload.Upload.ID).Scan(&confirmed); err != nil || confirmed != 100 {
		t.Fatalf("nonblocking capped cleanup count=%d err=%v, want 100", confirmed, err)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("workers stopped with error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("workers did not stop")
	}
}

func TestReferenceMaterialCleanupFailureDoesNotBlockAnotherClaim(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	h.ensureObjectStorage(t)
	creator := h.loginToken(t, creatorEmail, harnessPassword)
	session := h.createSession(t, creator, sessionName("cleanup-isolation"))
	ids := make([]string, 0, 2)
	for index := 0; index < 2; index++ {
		status, body, upload := h.createMaterialUpload(t, creator, session.ID,
			uploadCreateInput("cleanup-isolation-"+string(rune('a'+index)), "cleanup.png", "image", "image/png", 3))
		if status != http.StatusCreated {
			t.Fatalf("create cleanup upload %d: status=%d body=%s", index, status, body)
		}
		ids = append(ids, upload.Upload.ID)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `
		UPDATE creation_reference_material_uploads
		SET status = 'terminal', terminal_at = now(),
		    created_at = now() - interval '91 minutes',
		    put_deadline = now() - interval '31 minutes',
		    finalize_deadline = now() - interval '1 minute', cleanup_next_attempt_at = now()
		WHERE id = ANY($1::uuid[])`, ids); err != nil {
		t.Fatalf("terminalize cleanup fixtures: %v", err)
	}
	var failedKey string
	if err := h.ownerPool.QueryRow(h.ctx, `
		SELECT object_key FROM creation_reference_material_uploads WHERE id = $1::uuid`, ids[0]).Scan(&failedKey); err != nil {
		t.Fatalf("read cleanup failure key: %v", err)
	}
	h.directStore.blockDeleteFor(failedKey)
	workerCtx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.creation.RunWorkers(workerCtx) }()
	deadline := time.Now().Add(5 * time.Second)
	confirmed := 0
	for time.Now().Before(deadline) {
		if err := h.ownerPool.QueryRow(h.ctx, `
			SELECT count(*) FROM creation_reference_material_uploads
			WHERE id = ANY($1::uuid[]) AND cleanup_confirmed_at IS NOT NULL`, ids).Scan(&confirmed); err == nil && confirmed == 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	<-done
	if confirmed != 1 {
		t.Fatalf("confirmed cleanup rows=%d, want one success despite one provider failure", confirmed)
	}
	var failedAttempts int
	var retryDelay float64
	if err := h.ownerPool.QueryRow(h.ctx, `
		SELECT cleanup_attempt_count,
		       extract(epoch FROM (cleanup_next_attempt_at - terminal_at))
		FROM creation_reference_material_uploads
		WHERE id = ANY($1::uuid[]) AND cleanup_confirmed_at IS NULL`, ids).Scan(&failedAttempts, &retryDelay); err != nil {
		t.Fatalf("read failed cleanup retry: %v", err)
	}
	if failedAttempts != 1 || retryDelay < 59 || retryDelay > 61 {
		t.Fatalf("failed cleanup attempt=%d delay=%.3fs, want attempt 1 and 60s", failedAttempts, retryDelay)
	}
}

func TestReferenceMaterialUploadAbortExpiryAndDurableCleanupConverge(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	h.ensureObjectStorage(t)
	creator := h.loginToken(t, creatorEmail, harnessPassword)
	other := h.loginToken(t, otherCreatorEmail, harnessPassword)
	session := h.createSession(t, creator, sessionName("upload-cleanup"))
	png := pngBytes(t)

	status, body, aborted := h.createMaterialUpload(t, creator, session.ID,
		uploadCreateInput("upload-abort-key", "abort.png", "image", "image/png", int64(len(png))))
	if status != http.StatusCreated {
		t.Fatalf("create abort upload: status=%d body=%s", status, body)
	}
	putAuthorizedUpload(t, aborted, png)
	status, body = h.doRequest(t, http.MethodDelete, "/creation/reference-material-uploads/"+aborted.Upload.ID, other, nil)
	if status != http.StatusNotFound {
		t.Fatalf("foreign abort: status=%d body=%s", status, body)
	}
	h.directStore.failDeletes(1)
	status, body = h.doRequest(t, http.MethodDelete, "/creation/reference-material-uploads/"+aborted.Upload.ID, creator, nil)
	if status != http.StatusOK || !bytes.Contains(body, []byte(`"status":"terminal"`)) {
		t.Fatalf("abort upload: status=%d body=%s", status, body)
	}
	assertUploadDatabaseState(t, h, aborted.Upload.ID, "terminal", true, false)
	var immediateAttempts int
	var immediateRetryDelay float64
	if err := h.ownerPool.QueryRow(h.ctx, `
		SELECT cleanup_attempt_count,
		       extract(epoch FROM (cleanup_next_attempt_at - terminal_at))
		FROM creation_reference_material_uploads WHERE id = $1::uuid`, aborted.Upload.ID).Scan(&immediateAttempts, &immediateRetryDelay); err != nil {
		t.Fatalf("read immediate cleanup failure: %v", err)
	}
	if immediateAttempts != 1 || immediateRetryDelay < 59 || immediateRetryDelay > 61 {
		t.Fatalf("immediate cleanup attempt=%d delay=%.3fs, want attempt 1 and 60s", immediateAttempts, immediateRetryDelay)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `
		UPDATE creation_reference_material_uploads
		SET created_at = now() - interval '91 minutes',
		    put_deadline = now() - interval '31 minutes',
		    finalize_deadline = now() - interval '1 minute', cleanup_next_attempt_at = now()
		WHERE id = $1::uuid`, aborted.Upload.ID); err != nil {
		t.Fatalf("make failed cleanup retry due: %v", err)
	}

	status, body, expired := h.createMaterialUpload(t, creator, session.ID,
		uploadCreateInput("upload-expiry-worker-key", "expired.png", "image", "image/png", int64(len(png))))
	if status != http.StatusCreated {
		t.Fatalf("create expiry upload: status=%d body=%s", status, body)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `
		UPDATE creation_reference_material_uploads
		SET created_at = now() - interval '91 minutes',
		    put_deadline = now() - interval '31 minutes',
		    finalize_deadline = now() - interval '1 minute'
		WHERE id = $1::uuid`, expired.Upload.ID); err != nil {
		t.Fatalf("expire upload: %v", err)
	}

	workerCtx, cancel := context.WithCancel(context.Background())
	workersDone := make(chan error, 1)
	go func() { workersDone <- h.creation.RunWorkers(workerCtx) }()
	awaitUploadCleanup(t, h, aborted.Upload.ID)
	awaitUploadCleanup(t, h, expired.Upload.ID)
	cancel()
	select {
	case err := <-workersDone:
		if err != nil {
			t.Fatalf("workers stopped with error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("workers did not stop")
	}
	assertExactUploadKeyWasDeleted(t, h, expired.Upload.ID)

	var attempts int
	if err := h.ownerPool.QueryRow(h.ctx, `
		SELECT cleanup_attempt_count FROM creation_reference_material_uploads WHERE id = $1::uuid`, aborted.Upload.ID).Scan(&attempts); err != nil || attempts != 2 {
		t.Fatalf("durable cleanup attempts=%d err=%v, want immediate attempt plus one worker retry", attempts, err)
	}
	status, body = h.doRequest(t, http.MethodDelete, "/creation/reference-material-uploads/"+aborted.Upload.ID, creator, nil)
	if status != http.StatusOK || !bytes.Contains(body, []byte(`"status":"terminal"`)) {
		t.Fatalf("idempotent abort replay: status=%d body=%s", status, body)
	}
}

func assertUploadDatabaseState(t *testing.T, h *harness, uploadID, wantStatus string, wantTerminal, wantCleanupConfirmed bool) {
	t.Helper()
	var status string
	var hasToken, hasTerminal, hasCleanup bool
	if err := h.ownerPool.QueryRow(h.ctx, `
		SELECT status, verification_token IS NOT NULL, terminal_at IS NOT NULL,
		       cleanup_confirmed_at IS NOT NULL
		FROM creation_reference_material_uploads WHERE id = $1::uuid`, uploadID).Scan(
		&status, &hasToken, &hasTerminal, &hasCleanup,
	); err != nil {
		t.Fatalf("read upload state: %v", err)
	}
	if status != wantStatus || hasToken || hasTerminal != wantTerminal || hasCleanup != wantCleanupConfirmed {
		t.Fatalf("upload state=(%s token=%t terminal=%t cleaned=%t), want=(%s false %t %t)",
			status, hasToken, hasTerminal, hasCleanup, wantStatus, wantTerminal, wantCleanupConfirmed)
	}
}

func assertExactUploadKeyWasDeleted(t *testing.T, h *harness, uploadID string) {
	t.Helper()
	var objectKey string
	if err := h.ownerPool.QueryRow(h.ctx, `
		SELECT object_key FROM creation_reference_material_uploads WHERE id = $1::uuid`, uploadID).Scan(&objectKey); err != nil {
		t.Fatalf("read upload object key: %v", err)
	}
	keys := h.directStore.cleanupKeys()
	found := false
	for _, key := range keys {
		if key == objectKey {
			found = true
		}
	}
	if !found {
		t.Fatalf("exact upload key %q was not deleted: %v", objectKey, keys)
	}
}

func awaitUploadCleanup(t *testing.T, h *harness, uploadID string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var status string
		var confirmed bool
		if err := h.ownerPool.QueryRow(h.ctx, `
			SELECT status, cleanup_confirmed_at IS NOT NULL
			FROM creation_reference_material_uploads WHERE id = $1::uuid`, uploadID).Scan(&status, &confirmed); err == nil && status == "terminal" && confirmed {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("upload %s cleanup did not converge", uploadID)
}
