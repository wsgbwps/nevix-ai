package integrationtest

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/creation"
)

func TestReferencePreparationFailureClassesPersistBeforeKapon(t *testing.T) {
	tests := []struct {
		name         string
		prepareError error
		wantReason   string
		wantAttempts int
	}{
		{name: "configuration", prepareError: creation.ErrObjectStorageConfiguration, wantReason: "action_required", wantAttempts: 1},
		{name: "source missing", prepareError: creation.ErrBlobNotFound, wantReason: "internal_error", wantAttempts: 1},
		{name: "checksum mismatch", prepareError: creation.ErrReferenceSourceChecksumMismatch, wantReason: "internal_error", wantAttempts: 1},
		{name: "transient exhausted", prepareError: creation.ErrObjectStorageUnavailable, wantReason: "temporarily_unavailable", wantAttempts: 4},
		{name: "rate limit exhausted", prepareError: creation.ErrObjectStorageRateLimited, wantReason: "temporarily_unavailable", wantAttempts: 4},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			transport := &fakeReferenceTransport{
				prepareError: func(creation.UUID, int, int) error { return tc.prepareError },
			}
			var waits []time.Duration
			h, _, creatorEmailAddress := readyTaskHarness(t, harnessOptions{
				runWorkers:         true,
				referenceTransport: transport,
				referenceWait: func(_ context.Context, delay time.Duration) error {
					waits = append(waits, delay)
					return nil
				},
				referenceJitter: func(base time.Duration) time.Duration { return base },
			})
			creator := h.loginToken(t, creatorEmailAddress, harnessPassword)
			taskID := h.submitReferencePreparationTask(t, creator, tc.name, 1)
			view := h.awaitTaskTerminal(t, creator, taskID)
			if view.Task.Status != "failed" || len(view.Slots) != 1 || view.Slots[0].FailureReason == nil || *view.Slots[0].FailureReason != tc.wantReason {
				t.Fatalf("preparation verdict = %s (%s), want failed/%s", view.Task.Status, slotVerdicts(view), tc.wantReason)
			}
			var jobStatus string
			var submitAttempts int
			if err := h.ownerPool.QueryRow(h.ctx, `
				SELECT status, submit_attempts FROM creation_provider_jobs WHERE task_id = $1::uuid
			`, taskID).Scan(&jobStatus, &submitAttempts); err != nil {
				t.Fatalf("read provider job: %v", err)
			}
			if jobStatus != "failed" || submitAttempts != 0 || h.kapon.generation.imageRequests() != 0 {
				t.Fatalf("pre-marker state = %s/%d provider_calls=%d", jobStatus, submitAttempts, h.kapon.generation.imageRequests())
			}
			if got := len(transport.attempts()); got != tc.wantAttempts {
				t.Fatalf("preparation attempts = %d, want %d", got, tc.wantAttempts)
			}
			if got := len(waits); got != tc.wantAttempts-1 {
				t.Fatalf("preparation waits = %v, want %d", waits, tc.wantAttempts-1)
			}
		})
	}
}

func TestReferencePreparationBudgetStopsRetriesBeforeKapon(t *testing.T) {
	transport := &fakeReferenceTransport{
		prepareError: func(creation.UUID, int, int) error { return creation.ErrObjectStorageUnavailable },
	}
	now := time.Now().UTC()
	h, _, creatorEmailAddress := readyTaskHarness(t, harnessOptions{
		runWorkers:         true,
		referenceTransport: transport,
		now:                func() time.Time { return now },
		referenceWait: func(context.Context, time.Duration) error {
			now = now.Add(10 * time.Minute)
			return nil
		},
		referenceJitter: func(base time.Duration) time.Duration { return base },
	})
	creator := h.loginToken(t, creatorEmailAddress, harnessPassword)
	taskID := h.submitReferencePreparationTask(t, creator, "shared-budget", 1)
	view := h.awaitTaskTerminal(t, creator, taskID)
	if view.Task.Status != "failed" || len(view.Slots) != 1 || view.Slots[0].FailureReason == nil || *view.Slots[0].FailureReason != "temporarily_unavailable" {
		t.Fatalf("budget verdict = %s (%s)", view.Task.Status, slotVerdicts(view))
	}
	if got := len(transport.attempts()); got != 1 {
		t.Fatalf("budget exhaustion attempted reference %d times, want 1", got)
	}
	if h.kapon.generation.imageRequests() != 0 {
		t.Fatal("budget exhaustion reached Kapon")
	}
}

func TestReferencePreparationPartialFailureCleansEveryAttemptedObject(t *testing.T) {
	transport := &fakeReferenceTransport{
		prepareError: func(_ creation.UUID, ordinal int, _ int) error {
			if ordinal == 2 {
				return creation.ErrBlobNotFound
			}
			return nil
		},
		releaseError: func(_ creation.UUID, ordinal int) error {
			if ordinal == 0 {
				return creation.ErrObjectStorageUnavailable
			}
			return nil
		},
	}
	h, _, creatorEmailAddress := readyTaskHarness(t, harnessOptions{runWorkers: true, referenceTransport: transport})
	creator := h.loginToken(t, creatorEmailAddress, harnessPassword)
	taskID := h.submitReferencePreparationTask(t, creator, "partial-cleanup", 3)
	view := h.awaitTaskTerminal(t, creator, taskID)
	if view.Task.Status != "failed" || len(view.Slots) != 1 || view.Slots[0].FailureReason == nil || *view.Slots[0].FailureReason != "internal_error" {
		t.Fatalf("partial preparation verdict = %s (%s)", view.Task.Status, slotVerdicts(view))
	}
	releases := transport.releases()
	if len(releases) < 3 || releases[0].ordinal != 0 || releases[1].ordinal != 1 || releases[2].ordinal != 2 {
		t.Fatalf("partial cleanup attempts = %+v, want first pass ordinals 0,1,2", releases)
	}
	if transport.objectCount() != 1 {
		t.Fatalf("cleanup failure should leave only its exact object, got %d objects", transport.objectCount())
	}
	if h.kapon.generation.imageRequests() != 0 {
		t.Fatal("partial preparation failure reached Kapon")
	}
}

func TestReferencePreparationRestartReusesJobAndObjectIdentityWithFreshURL(t *testing.T) {
	transport := &fakeReferenceTransport{freshURLs: true}
	h, _, creatorEmailAddress := readyTaskHarness(t, harnessOptions{referenceTransport: transport})
	creator := h.loginToken(t, creatorEmailAddress, harnessPassword)
	taskID := h.submitReferencePreparationTask(t, creator, "pre-marker-restart", 1)

	firstCtx, cancelFirst := context.WithCancel(context.Background())
	transport.afterPrepare = func(creation.UUID, int) error {
		cancelFirst()
		return nil
	}
	firstDone := make(chan error, 1)
	go func() { firstDone <- h.creation.RunWorkers(firstCtx) }()
	select {
	case err := <-firstDone:
		if err != nil {
			t.Fatalf("stop first worker pass: %v", err)
		}
	case <-time.After(5 * time.Second):
		cancelFirst()
		t.Fatal("first worker pass did not stop after pre-marker process loss")
	}
	firstAttempts := transport.attempts()
	if len(firstAttempts) != 1 || transport.objectCount() != 1 || h.kapon.generation.imageRequests() != 0 {
		t.Fatalf("first pass attempts/objects/provider = %+v/%d/%d", firstAttempts, transport.objectCount(), h.kapon.generation.imageRequests())
	}
	var jobStatus string
	var submitAttempts int
	if err := h.ownerPool.QueryRow(h.ctx, `
		SELECT status, submit_attempts FROM creation_provider_jobs WHERE task_id = $1::uuid
	`, taskID).Scan(&jobStatus, &submitAttempts); err != nil {
		t.Fatalf("read pre-marker job after first pass: %v", err)
	}
	if jobStatus != "pending" || submitAttempts != 0 {
		t.Fatalf("first pass crossed submit marker: %s/%d", jobStatus, submitAttempts)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `
		UPDATE creation_generation_queue
		SET run_after = now(), lease_owner = NULL, lease_until = NULL
		WHERE task_id = $1::uuid
	`, taskID); err != nil {
		t.Fatalf("expire crashed worker lease: %v", err)
	}

	transport.afterPrepare = nil
	h.kapon.generation.setImage(imageScript{outputs: 1})
	secondCtx, cancelSecond := context.WithCancel(context.Background())
	secondDone := make(chan error, 1)
	go func() { secondDone <- h.creation.RunWorkers(secondCtx) }()
	view := h.awaitTaskTerminal(t, creator, taskID)
	cancelSecond()
	if err := <-secondDone; err != nil {
		t.Fatalf("stop second worker pass: %v", err)
	}
	if view.Task.Status != "succeeded" {
		t.Fatalf("restart recovery status = %s (%s)", view.Task.Status, slotVerdicts(view))
	}
	attempts := transport.attempts()
	if len(attempts) != 2 || attempts[0].jobID != attempts[1].jobID || attempts[0].ordinal != 0 || attempts[1].ordinal != 0 {
		t.Fatalf("restart changed deterministic preparation identity: %+v", attempts)
	}
	call := h.kapon.generation.lastImageCall()
	wantURL := referenceURL(attempts[0].jobID, 0) + "&version=2"
	if call == nil || len(call.imageURLs) != 1 || call.imageURLs[0] != wantURL || !strings.Contains(wantURL, "version=2") {
		t.Fatalf("restart Kapon URL = %+v, want fresh %q", call, wantURL)
	}
	if err := h.ownerPool.QueryRow(h.ctx, `
		SELECT status, submit_attempts FROM creation_provider_jobs WHERE task_id = $1::uuid
	`, taskID).Scan(&jobStatus, &submitAttempts); err != nil {
		t.Fatalf("read recovered provider job: %v", err)
	}
	if jobStatus != "completed" || submitAttempts != 1 || transport.objectCount() != 0 {
		t.Fatalf("recovered job/object state = %s/%d/%d", jobStatus, submitAttempts, transport.objectCount())
	}
}

func TestSafeSubmitRetryAfterWorkerRestartRepreparesDeterministicReference(t *testing.T) {
	transport := &fakeReferenceTransport{freshURLs: true}
	h, _, creatorEmailAddress := readyTaskHarness(t, harnessOptions{referenceTransport: transport})
	creator := h.loginToken(t, creatorEmailAddress, harnessPassword)
	one := 1
	h.kapon.generation.setImage(imageScript{
		status: http.StatusTooManyRequests, code: "MODEL_GROUP_ALL_UNAVAILABLE", retryAfterSeconds: &one,
	})
	taskID := h.submitReferencePreparationTask(t, creator, "safe-retry-restart", 1)

	firstCtx, cancelFirst := context.WithCancel(context.Background())
	firstDone := make(chan error, 1)
	go func() { firstDone <- h.creation.RunWorkers(firstCtx) }()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if countRows(t, h.ownerPool, `
			SELECT count(*) FROM creation_provider_jobs
			WHERE task_id = $1::uuid AND submit_attempts = 1 AND last_outcome = 'transient_rejected'
		`, taskID) == 1 {
			break
		}
		if time.Now().After(deadline) {
			cancelFirst()
			t.Fatal("safe rejection was not persisted before worker restart")
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancelFirst()
	if err := <-firstDone; err != nil {
		t.Fatalf("stop first worker pass: %v", err)
	}
	firstAttempts := transport.attempts()
	if len(firstAttempts) != 1 || transport.objectCount() != 1 || h.kapon.generation.imageRequests() != 1 {
		t.Fatalf("first pass attempts/objects/provider = %+v/%d/%d", firstAttempts, transport.objectCount(), h.kapon.generation.imageRequests())
	}

	h.kapon.generation.setImage(imageScript{outputs: 1})
	if _, err := h.ownerPool.Exec(h.ctx, `
		UPDATE creation_generation_queue
		SET run_after = now(), lease_owner = NULL, lease_until = NULL
		WHERE task_id = $1::uuid
	`, taskID); err != nil {
		t.Fatalf("release safe-retry queue item: %v", err)
	}
	secondCtx, cancelSecond := context.WithCancel(context.Background())
	secondDone := make(chan error, 1)
	go func() { secondDone <- h.creation.RunWorkers(secondCtx) }()
	view := h.awaitTaskTerminal(t, creator, taskID)
	cancelSecond()
	if err := <-secondDone; err != nil {
		t.Fatalf("stop second worker pass: %v", err)
	}
	if view.Task.Status != "succeeded" {
		t.Fatalf("safe retry restart status = %s (%s)", view.Task.Status, slotVerdicts(view))
	}
	attempts := transport.attempts()
	if len(attempts) != 2 || attempts[0].jobID != attempts[1].jobID || attempts[0].ordinal != 0 || attempts[1].ordinal != 0 {
		t.Fatalf("safe retry restart changed preparation identity: %+v", attempts)
	}
	call := h.kapon.generation.lastImageCall()
	wantURL := referenceURL(attempts[0].jobID, 0) + "&version=2"
	if call == nil || len(call.imageURLs) != 1 || call.imageURLs[0] != wantURL {
		t.Fatalf("safe retry restart Kapon URL = %+v, want fresh %q", call, wantURL)
	}
	var jobStatus string
	var submitAttempts int
	if err := h.ownerPool.QueryRow(h.ctx, `
		SELECT status, submit_attempts FROM creation_provider_jobs WHERE task_id = $1::uuid
	`, taskID).Scan(&jobStatus, &submitAttempts); err != nil {
		t.Fatalf("read safe-retry restarted job: %v", err)
	}
	if jobStatus != "completed" || submitAttempts != 2 || h.kapon.generation.imageRequests() != 2 || transport.objectCount() != 0 {
		t.Fatalf("safe retry restart job/provider/object state = %s/%d/%d/%d", jobStatus, submitAttempts, h.kapon.generation.imageRequests(), transport.objectCount())
	}
}

func TestCredentialFailureAfterPreparationCleansBeforeHoldAndCancel(t *testing.T) {
	transport := &fakeReferenceTransport{}
	h, _, creatorEmailAddress := readyTaskHarness(t, harnessOptions{referenceTransport: transport})
	creator := h.loginToken(t, creatorEmailAddress, harnessPassword)
	var tamperOnce sync.Once
	tampered := make(chan error, 1)
	transport.afterPrepare = func(creation.UUID, int) error {
		tamperOnce.Do(func() {
			_, err := h.ownerPool.Exec(h.ctx, `
				UPDATE public.provider_connections
				SET credential_ciphertext = set_byte(credential_ciphertext, 0, 255 - get_byte(credential_ciphertext, 0))
				WHERE terminated_at IS NULL
			`)
			tampered <- err
		})
		return nil
	}
	taskID := h.submitReferencePreparationTask(t, creator, "credential-failure-cleanup", 1)

	workerCtx, cancelWorker := context.WithCancel(context.Background())
	workerDone := make(chan error, 1)
	go func() { workerDone <- h.creation.RunWorkers(workerCtx) }()
	defer func() {
		cancelWorker()
		if err := <-workerDone; err != nil {
			t.Errorf("stop worker: %v", err)
		}
	}()
	select {
	case err := <-tampered:
		if err != nil {
			t.Fatalf("tamper provider credential after preparation: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("reference preparation did not reach the credential boundary")
	}
	deadline := time.Now().Add(5 * time.Second)
	for len(transport.releases()) == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if releases := transport.releases(); len(releases) != 1 || releases[0].ordinal != 0 || transport.objectCount() != 0 {
		t.Fatalf("credential hold cleanup = %+v objects=%d, want ordinal 0 and zero objects", releases, transport.objectCount())
	}
	if h.kapon.generation.imageRequests() != 0 {
		t.Fatal("credential failure after preparation reached Kapon")
	}
	var jobStatus string
	var submitAttempts int
	if err := h.ownerPool.QueryRow(h.ctx, `
		SELECT status, submit_attempts FROM creation_provider_jobs WHERE task_id = $1::uuid
	`, taskID).Scan(&jobStatus, &submitAttempts); err != nil {
		t.Fatalf("read held provider job: %v", err)
	}
	if jobStatus != "pending" || submitAttempts != 0 {
		t.Fatalf("credential failure crossed marker: %s/%d", jobStatus, submitAttempts)
	}
	status, body := h.doRequest(t, http.MethodPost, "/creation/tasks/"+taskID+"/cancel", creator, nil)
	if status != http.StatusOK || decodeTaskView(t, body).Task.Status != "cancelled" {
		t.Fatalf("cancel held task: status=%d body=%s", status, body)
	}
	if transport.objectCount() != 0 || h.kapon.generation.imageRequests() != 0 {
		t.Fatal("cancel after credential hold changed cleanup/provider effects")
	}
}

func (h *harness) submitReferencePreparationTask(t *testing.T, creator, name string, referenceCount int) string {
	t.Helper()
	session := h.createSession(t, creator, sessionName(name))
	references := make([]any, 0, referenceCount)
	for ordinal := 0; ordinal < referenceCount; ordinal++ {
		materialID := h.uploadImage(t, creator, session.ID, name+itoaFixture(ordinal)+".png")
		references = append(references, map[string]any{"material_id": materialID, "role": "reference"})
	}
	draft := h.buildTaskIntent(t, creator, session.ID, taskIntent{
		MediaType: "image", Model: "doubao-seedream-5.0-pro", Mode: "reference-image",
		Ratio: "1:1", Resolution: "2K", Quantity: 1, Prompt: name, References: references,
	})
	status, body := h.submitTask(t, creator, name, draft)
	if status != http.StatusCreated {
		t.Fatalf("submit reference preparation task: status=%d body=%s", status, body)
	}
	return decodeTaskView(t, body).Task.ID
}

func TestReferencePreparationCleanupErrorsRemainSanitized(t *testing.T) {
	logs := captureDefaultSlog(t)
	transport := &fakeReferenceTransport{
		prepareError: func(creation.UUID, int, int) error { return creation.ErrBlobNotFound },
		releaseError: func(creation.UUID, int) error {
			return errors.New("signed-url credential provider-transfer/private")
		},
	}
	h, _, creatorEmailAddress := readyTaskHarness(t, harnessOptions{runWorkers: true, referenceTransport: transport})
	creator := h.loginToken(t, creatorEmailAddress, harnessPassword)
	taskID := h.submitReferencePreparationTask(t, creator, "sanitized-cleanup", 1)
	view := h.awaitTaskTerminal(t, creator, taskID)
	if view.Task.Status != "failed" || h.kapon.generation.imageRequests() != 0 {
		t.Fatalf("cleanup error changed task/provider result: %s/%d", view.Task.Status, h.kapon.generation.imageRequests())
	}
	encodedLogs := logs.String()
	if !strings.Contains(encodedLogs, "category=cleanup_failed") || !strings.Contains(encodedLogs, "reference_count=1") {
		t.Fatalf("cleanup log lacks stable category/count: %s", encodedLogs)
	}
	for _, forbidden := range []string{"signed-url", "credential", "provider-transfer/", referenceURL(transport.attempts()[0].jobID, 0)} {
		if strings.Contains(encodedLogs, forbidden) {
			t.Fatalf("cleanup log leaked %q: %s", forbidden, encodedLogs)
		}
	}
}
