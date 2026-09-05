package integrationtest

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

func TestTaskChangeCriterionIsExactAcrossSubmitListAndDetail(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{})
	token := h.loginToken(t, creator, harnessPassword)
	draft := h.imageTaskIntent(t, token, "变化判据测试", 1)

	status, body := h.submitTask(t, token, "criterion-key", draft)
	if status != http.StatusCreated {
		t.Fatalf("submit task: status=%d body=%s", status, body)
	}
	created := decodeTaskView(t, body)
	var storedCreatedAt, storedUpdatedAt time.Time
	if err := h.ownerPool.QueryRow(h.ctx, `
		SELECT created_at, updated_at FROM creation_generation_tasks WHERE id = $1::uuid`, created.Task.ID).
		Scan(&storedCreatedAt, &storedUpdatedAt); err != nil {
		t.Fatalf("read admitted task timestamps: %v", err)
	}
	if created.Task.CreatedAt != storedCreatedAt.UTC().Format(time.RFC3339) ||
		created.Task.UpdatedAt != storedUpdatedAt.UTC().Format(time.RFC3339Nano) {
		t.Fatalf("fresh response timestamps do not match the committed row: response=%+v database=(%s, %s)",
			created.Task, storedCreatedAt, storedUpdatedAt)
	}

	markers := []time.Time{
		time.Date(2026, time.September, 5, 1, 2, 3, 123456000, time.UTC),
		time.Date(2026, time.September, 5, 1, 2, 3, 123457000, time.UTC),
	}
	for _, marker := range markers {
		if _, err := h.ownerPool.Exec(h.ctx,
			`UPDATE creation_generation_tasks SET updated_at = $2 WHERE id = $1::uuid`, created.Task.ID, marker); err != nil {
			t.Fatalf("set subsecond marker: %v", err)
		}
		expected := marker.Format(time.RFC3339Nano)

		detailStatus, detailBody, detail := h.getTask(t, token, created.Task.ID)
		if detailStatus != http.StatusOK {
			t.Fatalf("get task: status=%d body=%s", detailStatus, detailBody)
		}
		if detail.Task.UpdatedAt != expected {
			t.Fatalf("detail criterion=%q, want %q", detail.Task.UpdatedAt, expected)
		}

		listStatus, listBody := h.doRequest(t, "GET", "/creation/sessions/"+draft.SessionID+"/tasks?limit=20", token, nil)
		if listStatus != http.StatusOK {
			t.Fatalf("list tasks: status=%d body=%s", listStatus, listBody)
		}
		var page struct {
			Tasks []struct {
				ID        string `json:"id"`
				UpdatedAt string `json:"updated_at"`
			} `json:"tasks"`
		}
		if err := json.Unmarshal(listBody, &page); err != nil {
			t.Fatalf("decode task list: %v", err)
		}
		if len(page.Tasks) != 1 || page.Tasks[0].ID != created.Task.ID || page.Tasks[0].UpdatedAt != expected {
			t.Fatalf("list criterion does not match detail: %+v, detail=%q", page.Tasks, detail.Task.UpdatedAt)
		}
	}

	status, body = h.submitTask(t, token, "criterion-key", draft)
	if status != http.StatusOK {
		t.Fatalf("replay task: status=%d body=%s", status, body)
	}
	replayed := decodeTaskView(t, body)
	if replayed.Task.UpdatedAt != markers[len(markers)-1].Format(time.RFC3339Nano) {
		t.Fatalf("replay returned a stale task criterion: %q", replayed.Task.UpdatedAt)
	}
}
