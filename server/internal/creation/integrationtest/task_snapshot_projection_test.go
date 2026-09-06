package integrationtest

import (
	"encoding/json"
	"net/http"
	"testing"
)

// Issue #186: every task projection carries the creation intent frozen at
// submit. The list summary's snapshot and the detail's specification must be
// the same persisted row, so the gallery never needs the (device-local)
// draft to render a task's header.
func TestTaskListAndDetailCarryFrozenIntentSnapshot(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{})
	token := h.loginToken(t, creator, harnessPassword)
	first := h.imageTaskIntent(t, token, "快照意图一", 1)
	second := h.buildTaskIntent(t, token, first.SessionID, taskIntent{
		MediaType: "image", Model: "doubao-seedream-5.0-pro",
		Mode: "text-to-image", Ratio: "16:9", Resolution: "1K", Quantity: 2, Prompt: "快照意图二",
	})
	if status, body := h.submitTask(t, token, "snapshot-key-1", first); status != http.StatusCreated {
		t.Fatalf("submit first task: status=%d body=%s", status, body)
	}
	if status, body := h.submitTask(t, token, "snapshot-key-2", second); status != http.StatusCreated {
		t.Fatalf("submit second task: status=%d body=%s", status, body)
	}

	listStatus, listBody := h.doRequest(t, "GET", "/creation/sessions/"+first.SessionID+"/tasks?limit=20", token, nil)
	if listStatus != http.StatusOK {
		t.Fatalf("list tasks: status=%d body=%s", listStatus, listBody)
	}
	assertContractResponse(t, "GET", "/creation/sessions/"+first.SessionID+"/tasks", listStatus, listBody)

	var page struct {
		Tasks []struct {
			ID       string `json:"id"`
			Snapshot *struct {
				Prompt          string  `json:"prompt"`
				Model           string  `json:"model"`
				Mode            string  `json:"mode"`
				Ratio           *string `json:"ratio"`
				Resolution      *string `json:"resolution"`
				Quantity        int     `json:"quantity"`
				DurationSeconds *int    `json:"duration_seconds"`
			} `json:"snapshot"`
		} `json:"tasks"`
	}
	if err := json.Unmarshal(listBody, &page); err != nil {
		t.Fatalf("decode task list: %v", err)
	}
	if len(page.Tasks) != 2 {
		t.Fatalf("want the two submitted tasks, got %+v", page.Tasks)
	}
	byPrompt := map[string]int{}
	for _, task := range page.Tasks {
		if task.Snapshot == nil {
			t.Fatalf("task %s carries no snapshot: %+v", task.ID, task)
		}
		byPrompt[task.Snapshot.Prompt]++
	}
	if byPrompt["快照意图一"] != 1 || byPrompt["快照意图二"] != 1 {
		t.Fatalf("snapshots must keep each submit-time intent, got %+v", page.Tasks)
	}
	for _, task := range page.Tasks {
		snapshot := task.Snapshot
		intent := first
		if snapshot.Prompt == second.Prompt {
			intent = second
		}
		if snapshot.Model != intent.Model || snapshot.Mode != intent.Mode ||
			snapshot.Ratio == nil || *snapshot.Ratio != intent.Ratio ||
			snapshot.Resolution == nil || *snapshot.Resolution != intent.Resolution ||
			snapshot.Quantity != intent.Quantity {
			t.Fatalf("snapshot does not match the frozen intent: intent=%+v snapshot=%+v", intent, snapshot)
		}
	}

	detailStatus, detailBody, detail := h.getTask(t, token, page.Tasks[1].ID)
	if detailStatus != http.StatusOK {
		t.Fatalf("get task: status=%d body=%s", detailStatus, detailBody)
	}
	assertContractResponse(t, "GET", "/creation/tasks/"+page.Tasks[1].ID, detailStatus, detailBody)
	if detail.Task.Snapshot == nil || detail.Specification == nil {
		t.Fatalf("detail must carry both the task snapshot and the specification")
	}
	if detail.Task.Snapshot.Prompt != detail.Specification.Prompt ||
		detail.Task.Snapshot.Model != detail.Specification.Model ||
		detail.Task.Snapshot.Mode != detail.Specification.Mode ||
		*detail.Task.Snapshot.Ratio != *detail.Specification.Ratio ||
		*detail.Task.Snapshot.Resolution != *detail.Specification.Resolution ||
		detail.Task.Snapshot.Quantity != detail.Specification.Quantity {
		t.Fatalf("task snapshot and detail specification disagree: %+v vs %+v",
			detail.Task.Snapshot, detail.Specification)
	}
}
