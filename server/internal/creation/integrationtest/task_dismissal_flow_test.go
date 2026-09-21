package integrationtest

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
	"testing"
)

type taskDeletionView struct {
	RemovedSlotIndexes []int `json:"removed_slot_indexes"`
	Skipped            []struct {
		SlotIndex int    `json:"slot_index"`
		Reason    string `json:"reason"`
	} `json:"skipped"`
}

func (h *harness) dismissTask(t *testing.T, token, taskID string) (int, []byte) {
	t.Helper()
	return h.doRequest(t, http.MethodDelete, "/creation/tasks/"+taskID, token, nil)
}

// TestDismissingATerminalTaskHidesItAndRemovesItsResults: deleting a task is one
// command with one transaction — the card leaves the session list, its results
// leave the Asset Library, the task's own detail and usage facts still read, and
// a repeat DELETE is the same 404 as any vanished target.
func TestDismissingATerminalTaskHidesItAndRemovesItsResults(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1})

	intent := h.imageTaskIntent(t, token, "任务删除的创作台", 2)
	status, body := h.submitTask(t, token, "task-dismissal-hides", intent)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	view := h.awaitTaskTerminal(t, token, decodeTaskView(t, body).Task.ID)
	taskID := view.Task.ID
	if view.Task.Status != "succeeded" || len(view.Slots) != 2 {
		t.Fatalf("two succeeded slots expected, got %s %s", view.Task.Status, slotVerdicts(view))
	}
	assetIDs := assetIDsOfTask(t, h, taskID)
	if len(assetIDs) != 2 {
		t.Fatalf("formed assets %v", assetIDs)
	}
	usageBefore := countRows(t, h.ownerPool,
		`SELECT count(*) FROM creation_generation_reservations WHERE task_id = $1::uuid AND released_at IS NOT NULL`, taskID)

	status, deletionBody := h.dismissTask(t, token, taskID)
	if status != http.StatusOK {
		t.Fatalf("dismiss task: status=%d body=%s", status, deletionBody)
	}
	var deletion taskDeletionView
	mustDecode(t, deletionBody, &deletion)
	if len(deletion.RemovedSlotIndexes) != 2 || deletion.RemovedSlotIndexes[0] != 0 || deletion.RemovedSlotIndexes[1] != 1 {
		t.Fatalf("removed_slot_indexes=%v body=%s", deletion.RemovedSlotIndexes, deletionBody)
	}
	// An empty skip report is still an array: a client never has to tell a null
	// from "nothing was skipped".
	if !bytes.Contains(deletionBody, []byte(`"skipped":[]`)) {
		t.Fatalf("skipped must serialize as [] not null: %s", deletionBody)
	}
	assertContractResponse(t, http.MethodDelete, "/creation/tasks/"+taskID, status, deletionBody)

	// The card left the browsing list.
	if listed := listSessionTasks(t, h, token, intent.SessionID); len(listed) != 0 {
		t.Fatalf("a dismissed task stayed listed: %v", listed)
	}
	// Its results left the Asset Library, without deleting a single row.
	for _, assetID := range assetIDs {
		if page := readAssetPage(t, h, token, "/creation/assets?search="+assetID); len(page.Assets) != 0 {
			t.Fatalf("asset %s stayed in the library: %+v", assetID, page.Assets)
		}
	}
	if count := countRows(t, h.ownerPool,
		`SELECT count(*) FROM creation_media_assets WHERE task_id = $1::uuid AND deleted_at IS NULL`, taskID); count != 0 {
		t.Fatalf("live asset rows after dismissal=%d", count)
	}
	if count := countRows(t, h.ownerPool,
		`SELECT count(*) FROM creation_media_assets WHERE task_id = $1::uuid`, taskID); count != 2 {
		t.Fatalf("dismissal must not delete rows: asset rows=%d", count)
	}

	// The detail still reads the facts, with each result marked removed.
	detailStatus, detailBody, detail := h.getTask(t, token, taskID)
	if detailStatus != http.StatusOK || detail.Task.Status != "succeeded" {
		t.Fatalf("dismissed task detail: status=%d body=%s", detailStatus, detailBody)
	}
	for _, slot := range detail.Slots {
		if slot.Status != "succeeded" || !slot.ResultDeleted || slot.Result != nil {
			t.Fatalf("slot #%d after dismissal = %+v", slot.Index, slot)
		}
	}
	if usageAfter := countRows(t, h.ownerPool,
		`SELECT count(*) FROM creation_generation_reservations WHERE task_id = $1::uuid AND released_at IS NOT NULL`, taskID); usageAfter != usageBefore {
		t.Fatalf("a hiding rewrote usage facts: %d -> %d", usageBefore, usageAfter)
	}

	// A repeat DELETE is the vanished target, not an error to show.
	repeatStatus, repeatBody := h.dismissTask(t, token, taskID)
	if repeatStatus != http.StatusNotFound {
		t.Fatalf("repeat dismissal status=%d body=%s", repeatStatus, repeatBody)
	}
	assertErrorCode(t, repeatBody, "not_found")
	assertContractResponse(t, http.MethodDelete, "/creation/tasks/"+taskID, repeatStatus, repeatBody)
	if foreignStatus, _ := h.doRequest(t, http.MethodDelete, "/creation/tasks/"+taskID, h.loginToken(t, otherCreatorEmail, harnessPassword), nil); foreignStatus != http.StatusNotFound {
		t.Fatalf("foreign dismissal status=%d", foreignStatus)
	}
}

// A result the non-admin restriction guard refuses is reported, never fatal — a
// safety restriction must not block deleting the card — and it stays in the
// Asset Library, which the restriction itself hides until an admin releases it.
func TestDismissingATaskReportsARestrictedResultInsteadOfFailing(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1})

	intent := h.imageTaskIntent(t, token, "受限结果的任务删除", 2)
	status, body := h.submitTask(t, token, "task-dismissal-restricted", intent)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	taskID := h.awaitTaskTerminal(t, token, decodeTaskView(t, body).Task.ID).Task.ID
	assetIDs := assetIDsOfTask(t, h, taskID)
	if len(assetIDs) != 2 {
		t.Fatalf("formed assets %v", assetIDs)
	}
	keptID, removedID := assetIDs[0], assetIDs[1]
	if _, err := h.ownerPool.Exec(h.ctx,
		`UPDATE creation_media_assets SET restricted_at = now() WHERE id = $1::uuid`, keptID); err != nil {
		t.Fatalf("restrict fixture: %v", err)
	}

	status, deletionBody := h.dismissTask(t, token, taskID)
	if status != http.StatusOK {
		t.Fatalf("dismiss task with a restricted result: status=%d body=%s", status, deletionBody)
	}
	var deletion taskDeletionView
	mustDecode(t, deletionBody, &deletion)
	if len(deletion.RemovedSlotIndexes) != 1 || deletion.RemovedSlotIndexes[0] != 1 {
		t.Fatalf("removed_slot_indexes=%v body=%s", deletion.RemovedSlotIndexes, deletionBody)
	}
	if len(deletion.Skipped) != 1 || deletion.Skipped[0].SlotIndex != 0 || deletion.Skipped[0].Reason != "restricted" {
		t.Fatalf("skipped=%+v body=%s", deletion.Skipped, deletionBody)
	}
	assertContractResponse(t, http.MethodDelete, "/creation/tasks/"+taskID, status, deletionBody)

	// The task still left the list, and only the removable result was removed.
	if listed := listSessionTasks(t, h, token, intent.SessionID); len(listed) != 0 {
		t.Fatalf("a task with a restricted result stayed listed: %v", listed)
	}
	if count := countRows(t, h.ownerPool,
		`SELECT count(*) FROM creation_media_assets WHERE id = $1::uuid AND deleted_at IS NULL`, keptID); count != 1 {
		t.Fatalf("the skipped result was removed anyway: live rows=%d", count)
	}
	if count := countRows(t, h.ownerPool,
		`SELECT count(*) FROM creation_media_assets WHERE id = $1::uuid AND deleted_at IS NULL`, removedID); count != 0 {
		t.Fatalf("the removable result stayed live: rows=%d", count)
	}
	// Releasing the restriction shows the kept result still in the library.
	if _, err := h.ownerPool.Exec(h.ctx,
		`UPDATE creation_media_assets SET restriction_released_at = now() WHERE id = $1::uuid`, keptID); err != nil {
		t.Fatalf("release fixture: %v", err)
	}
	if page := readAssetPage(t, h, token, "/creation/assets?search="+keptID); len(page.Assets) != 1 {
		t.Fatalf("the skipped result left the library: %+v", page.Assets)
	}
	if repeatStatus, _ := h.dismissTask(t, token, taskID); repeatStatus != http.StatusNotFound {
		t.Fatalf("repeat dismissal status=%d", repeatStatus)
	}
}

// assetIDsOfTask lists one task's live Asset ids in slot order, the ids a
// deletion report should name.
func assetIDsOfTask(t *testing.T, h *harness, taskID string) []string {
	t.Helper()
	rows, err := h.ownerPool.Query(h.ctx,
		`SELECT id::text FROM creation_media_assets
		 WHERE task_id = $1::uuid AND deleted_at IS NULL ORDER BY slot_index`, taskID)
	if err != nil {
		t.Fatalf("read task assets: %v", err)
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan task asset: %v", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read task assets rows: %v", err)
	}
	return ids
}

// listSessionTasks walks one session's task list one page at a time.
func listSessionTasks(t *testing.T, h *harness, token, sessionID string) []string {
	t.Helper()
	seen := []string{}
	cursor := ""
	for range 4 {
		path := "/creation/sessions/" + sessionID + "/tasks?limit=1"
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		status, body := h.doRequest(t, http.MethodGet, path, token, nil)
		if status != http.StatusOK {
			t.Fatalf("task list status=%d body=%s", status, body)
		}
		var page sessionTaskPage
		if err := json.Unmarshal(body, &page); err != nil {
			t.Fatalf("decode task list: %v", err)
		}
		for _, task := range page.Tasks {
			seen = append(seen, task.ID)
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
	}
	return seen
}
