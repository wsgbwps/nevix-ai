package integrationtest

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/nevix-ai/server/internal/creation"
)

type maintenanceView struct {
	Paused           bool    `json:"paused"`
	OwnerToken       *string `json:"owner_token"`
	Revision         int64   `json:"revision"`
	NonTerminalTasks int64   `json:"non_terminal_tasks"`
	Drained          bool    `json:"drained"`
}

func maintenanceCommand(owner string, revision int64) map[string]any {
	return map[string]any{"owner_token": owner, "expected_revision": revision}
}

func (h *harness) maintenance(t *testing.T, token, action string, command any) (int, []byte, maintenanceView) {
	t.Helper()
	method, path := "GET", "/creation/maintenance"
	if action != "" {
		method, path = "POST", path+"/"+action
	}
	status, body := h.doSecureRequest(t, method, path, token, command)
	var view maintenanceView
	if status == http.StatusOK {
		if err := json.Unmarshal(body, &view); err != nil {
			t.Fatal(err)
		}
	}
	assertContractResponse(t, method, path, status, body)
	return status, body, view
}

func TestCreationMaintenancePreservesAdmissionAndDrainContracts(t *testing.T) {
	h, admin, creator := readyTaskHarness(t, harnessOptions{})
	member := h.loginToken(t, creator, harnessPassword)
	status, body, before := h.maintenance(t, admin, "", nil)
	if status != http.StatusOK || before.Paused || before.Drained {
		t.Fatalf("open maintenance: %d %s", status, body)
	}
	intent := h.imageTaskIntent(t, member, "maintenance task", 1)
	status, body = h.submitTask(t, member, "maintenance-replay", intent)
	if status != http.StatusCreated {
		t.Fatalf("admit before pause: %d %s", status, body)
	}
	task := decodeTaskView(t, body).Task.ID
	owner := "f46bb93f-05d7-4cf3-9883-85e7c0d9a001"
	status, body, paused := h.maintenance(t, admin, "pause", maintenanceCommand(owner, before.Revision))
	if status != http.StatusOK || !paused.Paused || paused.Drained || paused.NonTerminalTasks < 1 {
		t.Fatalf("pause must include queued task: %d %s", status, body)
	}
	t.Cleanup(func() { h.maintenance(t, admin, "resume", maintenanceCommand(owner, paused.Revision)) })
	status, body = h.submitTask(t, member, "maintenance-replay", intent)
	if status != http.StatusOK || decodeTaskView(t, body).Task.ID != task {
		t.Fatalf("paused replay: %d %s", status, body)
	}
	intent.Prompt = "different payload"
	status, body = h.submitTask(t, member, "maintenance-replay", intent)
	if status != http.StatusConflict {
		t.Fatalf("paused conflict: %d %s", status, body)
	}
	facts := map[string]int{}
	for _, table := range []string{"creation_generation_attempts", "creation_generation_tasks", "creation_generation_slots", "creation_provider_jobs", "creation_generation_queue", "creation_generation_reservations"} {
		facts[table] = countRows(t, h.ownerPool, "SELECT count(*) FROM "+table)
	}
	status, body = h.submitTask(t, member, "maintenance-fresh", intent)
	if status != http.StatusServiceUnavailable || extractField(t, body, "error") != "creation_maintenance" {
		t.Fatalf("fresh paused admission: %d %s", status, body)
	}
	for table, before := range facts {
		if after := countRows(t, h.ownerPool, "SELECT count(*) FROM "+table); after != before {
			t.Fatalf("paused rejection wrote %s: %d -> %d", table, before, after)
		}
	}
	entered, unblock := blockImageSubmitAfterMarker(t, h)
	h.startWorkers(t)
	t.Cleanup(unblock)
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("paused worker did not start queued task")
	}
	status, body, running := h.maintenance(t, admin, "", nil)
	if status != http.StatusOK || running.Drained || running.NonTerminalTasks != 1 {
		t.Fatalf("in-flight provider call is not drained: %d %s", status, body)
	}
	unblock()
	if view := h.awaitTaskTerminal(t, member, task); view.Task.Status != "succeeded" {
		t.Fatalf("paused worker: %+v", view.Task)
	}
	status, body, drained := h.maintenance(t, admin, "", nil)
	if status != http.StatusOK || !drained.Drained || drained.NonTerminalTasks != 0 {
		t.Fatalf("drain: %d %s", status, body)
	}
	status, body, resumed := h.maintenance(t, admin, "resume", maintenanceCommand(owner, paused.Revision))
	if status != http.StatusOK || resumed.Paused || resumed.Drained {
		t.Fatalf("resume: %d %s", status, body)
	}
	status, body = h.submitTask(t, member, "maintenance-fresh", intent)
	if status != http.StatusCreated {
		t.Fatalf("resume admission: %d %s", status, body)
	}
}

func TestCreationMaintenanceAuthorizationOwnershipAndRestart(t *testing.T) {
	h, admin, creator := readyTaskHarness(t, harnessOptions{})
	member := h.loginToken(t, creator, harnessPassword)
	_, _, before := h.maintenance(t, admin, "", nil)
	owner := "f46bb93f-05d7-4cf3-9883-85e7c0d9a002"
	command := maintenanceCommand(owner, before.Revision)
	for _, input := range []any{map[string]any{}, maintenanceCommand("00000000-0000-0000-0000-000000000000", before.Revision), maintenanceCommand(owner, -1), map[string]any{"owner_token": owner, "expected_revision": nil}} {
		status, body, _ := h.maintenance(t, admin, "pause", input)
		if status != http.StatusBadRequest {
			t.Fatalf("invalid maintenance command: %d %s", status, body)
		}
	}
	for _, action := range []string{"", "pause", "resume"} {
		for _, test := range []struct {
			token  string
			status int
		}{{member, http.StatusForbidden}, {"invalid", http.StatusUnauthorized}, {"", http.StatusUnauthorized}} {
			status, body, _ := h.maintenance(t, test.token, action, command)
			if status != test.status {
				t.Fatalf("unauthorized %s: %d %s", action, status, body)
			}
		}
	}
	status, body := h.doRequest(t, "GET", "/creation/maintenance", admin, nil)
	if status != http.StatusBadRequest || extractField(t, body, "error") != "secure_transport_required" {
		t.Fatalf("unproven transport: %d %s", status, body)
	}
	revoked := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	status, body = h.doRequest(t, "POST", "/identity/auth/logout", revoked, map[string]any{})
	if status != http.StatusOK && status != http.StatusNoContent {
		t.Fatalf("logout: %d %s", status, body)
	}
	for _, action := range []string{"", "pause", "resume"} {
		status, body, _ := h.maintenance(t, revoked, action, command)
		if status != http.StatusUnauthorized {
			t.Fatalf("revoked %s: %d %s", action, status, body)
		}
	}
	status, body, paused := h.maintenance(t, admin, "pause", command)
	if status != http.StatusOK || paused.Revision != before.Revision+1 {
		t.Fatalf("pause: %d %s", status, body)
	}
	t.Cleanup(func() {
		defer h.closeServer()
		_, _, current := h.maintenance(t, admin, "", nil)
		if current.Paused && current.OwnerToken != nil && (*current.OwnerToken == owner || *current.OwnerToken == "f46bb93f-05d7-4cf3-9883-85e7c0d9a003") {
			h.maintenance(t, admin, "resume", maintenanceCommand(*current.OwnerToken, current.Revision))
		}
	})
	status, body, replayed := h.maintenance(t, admin, "pause", command)
	if status != http.StatusOK || replayed.Revision != paused.Revision {
		t.Fatalf("pause exact retry: %d %s", status, body)
	}
	other := "f46bb93f-05d7-4cf3-9883-85e7c0d9a003"
	for _, action := range []string{"pause", "resume"} {
		status, body, _ := h.maintenance(t, admin, action, maintenanceCommand(other, paused.Revision))
		if status != http.StatusConflict {
			t.Fatalf("competing %s: %d %s", action, status, body)
		}
	}
	// Construct another production Module over the same runtime pool and real Identity.
	module, err := creation.NewModule(h.ctx, h.runtimePool, creation.Config{SecretsDir: h.secretsDir, KaponBaseURL: h.kapon.URL(), CORSAllowedOrigins: []string{requireEnv(t, "NEVIX_CORS_ALLOWED_ORIGINS")}}, creation.Deps{SessionAuthenticator: h.identity.SessionAuthenticator(), ReauthVerifier: h.identity.ReauthProofs()})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Group(func(r chi.Router) { h.identity.Register(r, nil) })
	router.Group(func(r chi.Router) { module.Register(r, nil) })
	h.closeServer()
	h.startServer(router)
	status, body, restarted := h.maintenance(t, admin, "", nil)
	if status != http.StatusOK || !restarted.Paused || restarted.Revision != paused.Revision || restarted.OwnerToken == nil || *restarted.OwnerToken != owner {
		t.Fatalf("restart cleared pause: %d %s", status, body)
	}
	status, body, resumed := h.maintenance(t, admin, "resume", maintenanceCommand(owner, paused.Revision))
	if status != http.StatusOK || resumed.Paused || resumed.Revision != paused.Revision+1 {
		t.Fatalf("resume: %d %s", status, body)
	}
	status, body, replayed = h.maintenance(t, admin, "resume", maintenanceCommand(owner, paused.Revision))
	if status != http.StatusOK || replayed.Revision != resumed.Revision {
		t.Fatalf("resume retry: %d %s", status, body)
	}
	status, body, newPause := h.maintenance(t, admin, "pause", maintenanceCommand(other, resumed.Revision))
	if status != http.StatusOK {
		t.Fatalf("new pause: %d %s", status, body)
	}
	status, body, _ = h.maintenance(t, admin, "resume", maintenanceCommand(owner, paused.Revision))
	if status != http.StatusConflict {
		t.Fatalf("stale resume cleared new pause: %d %s", status, body)
	}
	status, body, current := h.maintenance(t, admin, "", nil)
	if status != http.StatusOK || !current.Paused || current.Revision != newPause.Revision {
		t.Fatalf("new pause changed: %d %s", status, body)
	}
	status, body = h.doRequest(t, "GET", "/identity/audit-logs?per_page=100", admin, nil)
	if status != http.StatusOK {
		t.Fatalf("maintenance audit: %d %s", status, body)
	}
	var audit struct {
		Entries []struct {
			Action      string            `json:"action"`
			ActorUserID string            `json:"actor_user_id"`
			Metadata    map[string]string `json:"metadata"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(body, &audit); err != nil {
		t.Fatal(err)
	}
	for revision, action := range map[int64]string{paused.Revision: "creation_maintenance_paused", resumed.Revision: "creation_maintenance_resumed", newPause.Revision: "creation_maintenance_paused"} {
		found := 0
		for _, entry := range audit.Entries {
			if entry.Action == action && entry.Metadata["revision"] == fmt.Sprint(revision) {
				found++
				if entry.ActorUserID != h.userID(t, harnessAdminEmail) {
					t.Fatalf("maintenance audit actor: %+v", entry)
				}
			}
		}
		if found != 1 {
			t.Fatalf("transition revision %d wrote %d audit entries", revision, found)
		}
	}
}

func TestCreationMaintenanceSerializesConcurrentAdmission(t *testing.T) {
	h, admin, creator := readyTaskHarness(t, harnessOptions{})
	member := h.loginToken(t, creator, harnessPassword)
	intent := h.imageTaskIntent(t, member, "admission pause race", 1)
	_, _, before := h.maintenance(t, admin, "", nil)
	owner := "f46bb93f-05d7-4cf3-9883-85e7c0d9a004"
	var wg sync.WaitGroup
	start := make(chan struct{})
	statuses := make(chan int, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			status, _ := h.submitTask(t, member, fmt.Sprintf("maintenance-race-%d", i), intent)
			statuses <- status
		}(i)
	}
	close(start)
	status, body, paused := h.maintenance(t, admin, "pause", maintenanceCommand(owner, before.Revision))
	if status != http.StatusOK {
		t.Fatalf("racing pause: %d %s", status, body)
	}
	t.Cleanup(func() { h.maintenance(t, admin, "resume", maintenanceCommand(owner, paused.Revision)) })
	wg.Wait()
	close(statuses)
	admitted := int64(0)
	for status := range statuses {
		if status == http.StatusCreated {
			admitted++
		} else if status != http.StatusServiceUnavailable {
			t.Fatalf("racing admission status %d", status)
		}
	}
	_, _, after := h.maintenance(t, admin, "", nil)
	if after.NonTerminalTasks != admitted || paused.NonTerminalTasks != admitted {
		t.Fatalf("pause did not fence admission commits: pause=%+v after=%+v admissions=%d", paused, after, admitted)
	}
	status, body = h.submitTask(t, member, "after-race", intent)
	if status != http.StatusServiceUnavailable {
		t.Fatalf("post-pause admission: %d %s", status, body)
	}
}

func TestCreationMaintenanceRetryKeepsReplayAndResumes(t *testing.T) {
	h, admin, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	member := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1, outputStatus: http.StatusBadGateway, outputStatusOn: 2})
	intent := h.imageTaskIntent(t, member, "maintenance retry", 3)
	status, body := h.submitTask(t, member, "maintenance-retry-source", intent)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	original := decodeTaskView(t, body).Task.ID
	if task := h.awaitTaskTerminal(t, member, original); task.Task.Status != "partially_succeeded" {
		t.Fatalf("partial source: %+v", task.Task)
	}
	path := "/creation/tasks/" + original + "/retry"
	status, body = h.doRequest(t, "POST", path, member, map[string]any{"idempotency_key": "maintenance-retry-once"})
	if status != http.StatusCreated {
		t.Fatalf("initial retry: %d %s", status, body)
	}
	retry := decodeTaskView(t, body).Task.ID
	_, _, before := h.maintenance(t, admin, "", nil)
	owner := "f46bb93f-05d7-4cf3-9883-85e7c0d9a005"
	status, body, paused := h.maintenance(t, admin, "pause", maintenanceCommand(owner, before.Revision))
	if status != http.StatusOK {
		t.Fatalf("pause: %d %s", status, body)
	}
	t.Cleanup(func() { h.maintenance(t, admin, "resume", maintenanceCommand(owner, paused.Revision)) })
	status, body = h.doRequest(t, "POST", path, member, map[string]any{"idempotency_key": "maintenance-retry-once"})
	if status != http.StatusOK || decodeTaskView(t, body).Task.ID != retry {
		t.Fatalf("paused retry replay: %d %s", status, body)
	}
	status, body = h.doRequest(t, "POST", path, member, map[string]any{"idempotency_key": "maintenance-retry-source"})
	if status != http.StatusConflict || extractField(t, body, "error") != "idempotency_payload_conflict" {
		t.Fatalf("paused retry conflict: %d %s", status, body)
	}
	assertContractResponse(t, "POST", path, status, body)
	status, body = h.doRequest(t, "POST", path, member, map[string]any{"idempotency_key": "maintenance-retry-fresh"})
	if status != http.StatusServiceUnavailable || extractField(t, body, "error") != "creation_maintenance" {
		t.Fatalf("paused fresh retry: %d %s", status, body)
	}
	assertContractResponse(t, "POST", path, status, body)
	status, body, _ = h.maintenance(t, admin, "resume", maintenanceCommand(owner, paused.Revision))
	if status != http.StatusOK {
		t.Fatalf("resume: %d %s", status, body)
	}
	status, body = h.doRequest(t, "POST", path, member, map[string]any{"idempotency_key": "maintenance-retry-fresh"})
	if status != http.StatusCreated {
		t.Fatalf("resumed retry: %d %s", status, body)
	}
}

func TestCreationMaintenanceWaitsForAdmissionCommit(t *testing.T) {
	h, admin, creator := readyTaskHarness(t, harnessOptions{})
	member := h.loginToken(t, creator, harnessPassword)
	intent := h.imageTaskIntent(t, member, "commit barrier", 1)
	_, _, before := h.maintenance(t, admin, "", nil)
	// Isolated fault-injection fixture holds HTTP admission after task INSERT, before commit.
	_, err := h.ownerPool.Exec(h.ctx, `CREATE FUNCTION public.test_maintenance_admission_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(346339); RETURN NEW; END $$;
CREATE TRIGGER test_maintenance_admission_barrier AFTER INSERT ON public.creation_generation_tasks FOR EACH ROW EXECUTE FUNCTION public.test_maintenance_admission_barrier()`)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := h.ownerPool.Exec(h.ctx, `DROP TRIGGER test_maintenance_admission_barrier ON public.creation_generation_tasks; DROP FUNCTION public.test_maintenance_admission_barrier()`); err != nil {
			t.Error(err)
		}
	})
	barrier, err := h.ownerPool.Begin(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer barrier.Rollback(h.ctx)
	if _, err := barrier.Exec(h.ctx, `SELECT pg_advisory_xact_lock(346339)`); err != nil {
		t.Fatal(err)
	}
	admission := make(chan int, 1)
	go func() {
		status, _ := h.submitTask(t, member, "maintenance-commit-barrier", intent)
		admission <- status
	}()
	deadline := time.Now().Add(10 * time.Second)
	for countRows(t, h.ownerPool, `SELECT count(*) FROM pg_stat_activity WHERE wait_event='advisory' AND usename='identity_app'`) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("admission never reached commit barrier")
		}
		time.Sleep(10 * time.Millisecond)
	}
	owner := "f46bb93f-05d7-4cf3-9883-85e7c0d9a006"
	paused := make(chan maintenanceView, 1)
	go func() {
		status, body, view := h.maintenance(t, admin, "pause", maintenanceCommand(owner, before.Revision))
		if status != http.StatusOK {
			t.Errorf("pause: %d %s", status, body)
		}
		paused <- view
	}()
	deadline = time.Now().Add(10 * time.Second)
	for countRows(t, h.ownerPool, `SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND wait_event<>'advisory' AND usename='identity_app'`) == 0 {
		select {
		case view := <-paused:
			t.Fatalf("pause escaped uncommitted admission: %+v", view)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("pause never waited on admission")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := barrier.Commit(h.ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case status := <-admission:
		if status != http.StatusCreated {
			t.Fatalf("admission: %d", status)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("admission did not commit")
	}
	select {
	case view := <-paused:
		t.Cleanup(func() { h.maintenance(t, admin, "resume", maintenanceCommand(owner, view.Revision)) })
		if !view.Paused || view.Drained || view.NonTerminalTasks != 1 {
			t.Fatalf("pause missed admission commit: %+v", view)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("pause did not finish after commit")
	}
}
