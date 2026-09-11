package integrationtest

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/creation"
)

func TestProviderTransferCleanupFollowsCommittedProviderJobResult(t *testing.T) {
	cases := []struct {
		name         string
		media        string
		configure    func(*harness)
		wantTask     string
		wantJob      string
		wantReleased bool
	}{
		{
			name: "synchronous image success", media: "image", wantTask: "succeeded", wantJob: "completed", wantReleased: true,
			configure: func(h *harness) { h.kapon.generation.setImage(imageScript{outputs: 1}) },
		},
		{
			name: "definitive submit rejection", media: "image", wantTask: "failed", wantJob: "failed", wantReleased: true,
			configure: func(h *harness) {
				h.kapon.generation.setImage(imageScript{status: http.StatusBadRequest, code: "input_content_policy"})
			},
		},
		{
			name: "indeterminate submit", media: "image", wantTask: "failed", wantJob: "indeterminate", wantReleased: false,
			configure: func(h *harness) { h.kapon.generation.setImage(imageScript{abort: true}) },
		},
		{
			name: "asynchronous video failure", media: "video", wantTask: "failed", wantJob: "failed", wantReleased: true,
			configure: func(h *harness) {
				h.kapon.generation.setVideo(videoTaskScript{succeedAfter: 1000, failAfter: 1, failCode: "content_policy"})
			},
		},
		{
			name: "asynchronous video timeout", media: "video", wantTask: "timed_out", wantJob: "timed_out", wantReleased: true,
			configure: func(h *harness) { h.kapon.generation.setVideo(videoTaskScript{succeedAfter: 1000, timeoutAfter: 1}) },
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, _, creatorEmailAddress := readyTaskHarness(t, harnessOptions{runWorkers: true})
			creator := h.loginToken(t, creatorEmailAddress, harnessPassword)
			tc.configure(h)
			h.referenceTransport.beforeRelease = committedProviderResultGuard(h)
			taskID := h.submitTaskWithImageReferences(t, creator, tc.name, tc.media, 1)
			view := h.awaitTaskTerminal(t, creator, taskID)
			if view.Task.Status != tc.wantTask {
				t.Fatalf("task status = %s, want %s (%s)", view.Task.Status, tc.wantTask, slotVerdicts(view))
			}
			jobID, jobStatus := providerJobResult(t, h, taskID)
			if jobStatus != tc.wantJob {
				t.Fatalf("provider job status = %s, want %s", jobStatus, tc.wantJob)
			}
			if tc.wantReleased {
				releases := awaitReferenceReleases(t, h.referenceTransport, 1)
				if releases[0].jobID.String() != jobID || releases[0].ordinal != 0 || !releases[0].hasDeadline || releases[0].contextErr != nil {
					t.Fatalf("release did not use exact identity and an independent timeout: %+v", releases)
				}
				if h.referenceTransport.exists(jobID, 0) {
					t.Fatal("eligible terminal result left its Provider Transfer Object")
				}
				return
			}
			time.Sleep(100 * time.Millisecond)
			if releases := h.referenceTransport.released(); len(releases) != 0 {
				t.Fatalf("%s registered active cleanup: %+v", tc.wantJob, releases)
			}
			if !h.referenceTransport.exists(jobID, 0) {
				t.Fatal("indeterminate result deleted a Provider Transfer Object still needed by Kapon")
			}
		})
	}
}

func TestProviderTransferCleanupWaitsForAuthoritativeCancel(t *testing.T) {
	h, _, creatorEmailAddress := readyTaskHarness(t, harnessOptions{runWorkers: true})
	creator := h.loginToken(t, creatorEmailAddress, harnessPassword)
	h.kapon.generation.setVideo(videoTaskScript{succeedAfter: 1000, cancelOK: true, cancelAuthoritative: true})
	h.referenceTransport.beforeRelease = committedProviderResultGuard(h)
	taskID := h.submitTaskWithImageReferences(t, creator, "authoritative-cancel", "video", 1)

	deadline := time.Now().Add(10 * time.Second)
	accepted := false
	for time.Now().Before(deadline) {
		if countRows(t, h.ownerPool, `
			SELECT count(*) FROM creation_provider_jobs
			WHERE task_id = $1::uuid AND external_ref IS NOT NULL
		`, taskID) == 1 {
			accepted = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !accepted {
		t.Fatal("video job was not accepted before cancellation")
	}
	if status, body := h.doRequest(t, http.MethodPost, "/creation/tasks/"+taskID+"/cancel", creator, nil); status != http.StatusOK {
		t.Fatalf("request cancel: status=%d body=%s", status, body)
	}
	view := h.awaitTaskTerminal(t, creator, taskID)
	if view.Task.Status != "cancelled" {
		t.Fatalf("authoritative cancel status = %s, want cancelled", view.Task.Status)
	}
	jobID, jobStatus := providerJobResult(t, h, taskID)
	if jobStatus != "cancelled" {
		t.Fatalf("provider job status = %s, want cancelled", jobStatus)
	}
	if releases := awaitReferenceReleases(t, h.referenceTransport, 1); releases[0].jobID.String() != jobID {
		t.Fatalf("cancel cleanup used the wrong Provider Job: %+v", releases)
	}
}

func TestPreSubmitCredentialFailureCleansPreparedReferencesAfterCancellation(t *testing.T) {
	h, _, creatorEmailAddress := readyTaskHarness(t, harnessOptions{runWorkers: true})
	creator := h.loginToken(t, creatorEmailAddress, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1})
	h.referenceTransport.afterPrepare = func(jobID creation.UUID, _ int) error {
		var taskID string
		if err := h.ownerPool.QueryRow(h.ctx, `
			SELECT task_id FROM creation_provider_jobs WHERE id = $1::uuid
		`, jobID.String()).Scan(&taskID); err != nil {
			return err
		}
		if status, body := h.doRequest(t, http.MethodPost, "/creation/tasks/"+taskID+"/cancel", creator, nil); status != http.StatusOK {
			return errors.New("pre-submit cancel failed: " + string(body))
		}
		_, err := h.ownerPool.Exec(h.ctx, `
			UPDATE provider_connections
			SET credential_ciphertext = set_byte(credential_ciphertext, 0, 255 - get_byte(credential_ciphertext, 0))
			WHERE terminated_at IS NULL
		`)
		return err
	}

	taskID := h.submitTaskWithImageReferences(t, creator, "cancel-before-credential", "image", 1)
	view := h.awaitTaskTerminal(t, creator, taskID)
	if view.Task.Status != "cancelled" {
		t.Fatalf("pre-submit cancellation status = %s, want cancelled", view.Task.Status)
	}
	jobID, _ := providerJobResult(t, h, taskID)
	if releases := awaitReferenceReleases(t, h.referenceTransport, 1); releases[0].jobID.String() != jobID {
		t.Fatalf("credential failure cleanup used the wrong Provider Job: %+v", releases)
	}
	if h.referenceTransport.exists(jobID, 0) {
		t.Fatal("credential failure after cancellation left its prepared object")
	}
	if got := h.kapon.generation.imageRequests(); got != 0 {
		t.Fatalf("credential failure after cancellation reached Kapon %d times", got)
	}
}

func TestProviderTransferCleanupContainsFailuresAndPanics(t *testing.T) {
	var logs bytes.Buffer
	priorLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(priorLogger) })

	h, _, creatorEmailAddress := readyTaskHarness(t, harnessOptions{runWorkers: true})
	creator := h.loginToken(t, creatorEmailAddress, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1})
	h.referenceTransport.failRelease(0, errors.New("https://signed.example/private provider-transfer/secret"))
	h.referenceTransport.panicRelease(1, "credential-private-panic")
	taskID := h.submitTaskWithImageReferences(t, creator, "cleanup-boundaries", "image", 3)
	view := h.awaitTaskTerminal(t, creator, taskID)
	if view.Task.Status != "succeeded" || len(view.Slots) != 1 || view.Slots[0].Status != "succeeded" {
		t.Fatalf("cleanup failure changed committed result: %s (%s)", view.Task.Status, slotVerdicts(view))
	}
	jobID, jobStatus := providerJobResult(t, h, taskID)
	if jobStatus != "completed" {
		t.Fatalf("cleanup failure changed provider job to %s", jobStatus)
	}
	releases := awaitReferenceReleases(t, h.referenceTransport, 3)
	for ordinal, release := range releases {
		if release.jobID.String() != jobID || release.ordinal != ordinal || !release.hasDeadline || release.contextErr != nil {
			t.Fatalf("release %d lost independent cleanup context or identity: %+v", ordinal, release)
		}
	}
	if !h.referenceTransport.exists(jobID, 0) || !h.referenceTransport.exists(jobID, 1) || h.referenceTransport.exists(jobID, 2) {
		t.Fatal("one cleanup failure/panic did not leave failed objects for lifecycle while allowing later deletion")
	}
	logged := logs.String()
	if !strings.Contains(logged, "provider transfer cleanup incomplete") ||
		!strings.Contains(logged, "job_status=completed") || !strings.Contains(logged, "reference_count=3") || !strings.Contains(logged, "failed_count=2") {
		t.Fatalf("missing stable cleanup warning: %s", logged)
	}
	for _, secret := range []string{"signed.example", "provider-transfer/", "credential-private-panic", jobID} {
		if strings.Contains(logged, secret) {
			t.Fatalf("cleanup log exposed %q: %s", secret, logged)
		}
	}
}

func TestAlreadyTerminalProviderJobDoesNotReplayCleanup(t *testing.T) {
	h, _, creatorEmailAddress := readyTaskHarness(t, harnessOptions{})
	creator := h.loginToken(t, creatorEmailAddress, harnessPassword)
	taskID := h.submitTaskWithImageReferences(t, creator, "commit-cleanup-crash-window", "image", 1)
	jobID, _ := providerJobResult(t, h, taskID)
	h.referenceTransport.seed(jobID, 1)
	if _, err := h.ownerPool.Exec(h.ctx, `
		UPDATE creation_provider_jobs SET status = 'failed', terminal_at = now() WHERE task_id = $1::uuid
	`, taskID); err != nil {
		t.Fatalf("install committed terminal job fixture: %v", err)
	}

	workerCtx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.creation.RunWorkers(workerCtx) }()
	view := h.awaitTaskTerminal(t, creator, taskID)
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("stop worker: %v", err)
	}
	if view.Task.Status != "failed" {
		t.Fatalf("already-terminal job did not converge task: %s", view.Task.Status)
	}
	if releases := h.referenceTransport.released(); len(releases) != 0 {
		t.Fatalf("already-committed terminal job replayed non-durable cleanup: %+v", releases)
	}
	if !h.referenceTransport.exists(jobID, 0) {
		t.Fatal("accepted commit-to-cleanup crash window did not leave the object to lifecycle")
	}
}

func (h *harness) submitTaskWithImageReferences(t *testing.T, token, key, media string, referenceCount int) string {
	t.Helper()
	session := h.createSession(t, token, sessionName(key))
	references := make([]any, 0, referenceCount)
	for ordinal := range referenceCount {
		materialID := h.uploadImage(t, token, session.ID, key+"-"+itoaFixture(ordinal)+".png")
		references = append(references, map[string]any{"material_id": materialID, "role": "reference"})
	}
	intent := taskIntent{
		MediaType: media, Prompt: key, References: references, Resolution: "2K", Quantity: 1,
		Model: "doubao-seedream-5.0-pro", Mode: "reference-image", Ratio: "1:1",
	}
	if media == "video" {
		intent.Model = "doubao-seedance-2-5"
		intent.Mode = "omni-reference"
		intent.Ratio = ""
		intent.Resolution = "720p"
		intent.Duration = 5
		for _, raw := range intent.References {
			raw.(map[string]any)["role"] = "omni"
		}
	}
	intent = h.buildTaskIntent(t, token, session.ID, intent)
	status, body := h.submitTask(t, token, key, intent)
	if status != http.StatusCreated {
		t.Fatalf("submit referenced %s task: status=%d body=%s", media, status, body)
	}
	return decodeTaskView(t, body).Task.ID
}

func providerJobResult(t *testing.T, h *harness, taskID string) (string, string) {
	t.Helper()
	var jobID, status string
	if err := h.ownerPool.QueryRow(h.ctx, `
		SELECT id, status FROM creation_provider_jobs WHERE task_id = $1::uuid
	`, taskID).Scan(&jobID, &status); err != nil {
		t.Fatalf("read Provider Job result: %v", err)
	}
	return jobID, status
}

func committedProviderResultGuard(h *harness) func(context.Context, creation.UUID, int) error {
	return func(_ context.Context, jobID creation.UUID, _ int) error {
		var jobStatus, taskStatus string
		var activeReservations int
		if err := h.ownerPool.QueryRow(h.ctx, `
			SELECT job.status, task.status,
			       (SELECT count(*) FROM creation_generation_reservations r WHERE r.task_id = task.id AND r.released_at IS NULL)
			FROM creation_provider_jobs job
			JOIN creation_generation_tasks task ON task.id = job.task_id
			WHERE job.id = $1::uuid
		`, jobID.String()).Scan(&jobStatus, &taskStatus, &activeReservations); err != nil {
			return err
		}
		if activeReservations != 0 || (jobStatus != "completed" && jobStatus != "failed" && jobStatus != "cancelled" && jobStatus != "timed_out") ||
			(taskStatus != "succeeded" && taskStatus != "partially_succeeded" && taskStatus != "failed" && taskStatus != "cancelled" && taskStatus != "timed_out") {
			return errors.New("cleanup observed an uncommitted Provider Job result")
		}
		return nil
	}
}
