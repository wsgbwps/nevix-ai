package integrationtest

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"
)

// Generation task kernel scenario support (issue #159): a configured provider
// connection, a saved draft, and idempotent submission helpers.

// readyTaskHarness builds a harness whose manifest is fully active and whose
// provider connection is configured against the fake Kapon route.
func readyTaskHarness(t *testing.T, opts harnessOptions) (*harness, string, string) {
	t.Helper()
	h := newHarnessWithOptions(t, opts)
	h.ensureAccounts(t)
	adminToken := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	h.resetProviderConnections(t)
	// Governance rows and attempt counters persist across scenarios (one
	// shared database), so a ready harness always starts from the unset,
	// uncounted baseline.
	if _, err := h.ownerPool.Exec(h.ctx, `DELETE FROM creation_generation_policies`); err != nil {
		t.Fatalf("clear governance policies: %v", err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `DELETE FROM creation_generation_attempts`); err != nil {
		t.Fatalf("clear generation attempts: %v", err)
	}
	h.kapon.acceptKey("task-kernel-key")
	status, body := h.configureConnection(t, adminToken, "task-kernel-key")
	if status != http.StatusCreated && status != http.StatusOK {
		t.Fatalf("configure connection: status=%d body=%s", status, body)
	}
	return h, adminToken, creatorEmail
}

// taskDraft mirrors the saved composer draft (contracts SessionDraft).
type taskDraft struct {
	SessionID  string
	Revision   string
	MediaType  string
	Model      string
	Mode       string
	Ratio      string
	Resolution string
	Quantity   int
	Duration   int
	Prompt     string
}

// saveImageDraft saves a minimal text-to-image draft on a fresh session.
func (h *harness) saveImageDraft(t *testing.T, token, prompt string, quantity int) taskDraft {
	t.Helper()
	status, body := h.doRequest(t, "POST", "/creation/sessions", token, map[string]any{"name": "kernel"})
	if status != http.StatusCreated {
		t.Fatalf("create session: status=%d body=%s", status, body)
	}
	sessionID := extractField(t, body, "id")
	return h.saveDraftOn(t, token, sessionID, taskDraft{
		SessionID: sessionID, MediaType: "image", Model: "doubao-seedream-5.0-pro",
		Mode: "text-to-image", Ratio: "1:1", Resolution: "2K", Quantity: quantity, Prompt: prompt,
	})
}

// saveDraftOn stores the draft and captures the revision the submitter echoes.
func (h *harness) saveDraftOn(t *testing.T, token, sessionID string, draft taskDraft) taskDraft {
	t.Helper()
	payload := map[string]any{
		"prompt":           draft.Prompt,
		"media_type":       draft.MediaType,
		"manifest_version": 3,
		"model":            draft.Model,
		"mode":             draft.Mode,
		"ratio":            nil,
		"resolution":       draft.Resolution,
		"quantity":         nil,
		"duration_seconds": nil,
		"references":       []any{},
	}
	if draft.Ratio != "" {
		payload["ratio"] = draft.Ratio
	}
	if draft.Quantity > 0 {
		payload["quantity"] = draft.Quantity
	}
	if draft.Duration > 0 {
		payload["duration_seconds"] = draft.Duration
	}
	status, body := h.doRequest(t, "PUT", "/creation/sessions/"+sessionID+"/draft", token, payload)
	if status != http.StatusOK {
		t.Fatalf("save draft: status=%d body=%s", status, body)
	}
	draft.SessionID = sessionID
	draft.Revision = extractField(t, body, "updated_at")
	if draft.Revision == "" {
		t.Fatal("draft save must return the revision timestamp")
	}
	return draft
}

// submitTask POSTs one idempotent submission.
func (h *harness) submitTask(t *testing.T, token, sessionID, key, revision string) (int, []byte) {
	t.Helper()
	return h.doRequest(t, "POST", "/creation/sessions/"+sessionID+"/tasks", token, map[string]any{
		"idempotency_key": key,
		"draft_revision":  revision,
	})
}

// taskView decodes the task detail payload.
type taskView struct {
	Task struct {
		ID              string  `json:"id"`
		SessionID       string  `json:"session_id"`
		Status          string  `json:"status"`
		MediaType       string  `json:"media_type"`
		SlotCount       int     `json:"slot_count"`
		CancelRequested bool    `json:"cancel_requested"`
		TerminalCause   *string `json:"terminal_cause"`
		CreatedAt       string  `json:"created_at"`
	} `json:"task"`
	Slots []struct {
		Index             int     `json:"index"`
		Status            string  `json:"status"`
		FailureReason     *string `json:"failure_reason"`
		FailureDiagnostic *struct {
			Source       string  `json:"source"`
			Code         string  `json:"code"`
			Message      string  `json:"message"`
			HTTPStatus   *int    `json:"http_status"`
			ProviderType *string `json:"provider_type"`
			RequestID    *string `json:"request_id"`
		} `json:"failure_diagnostic"`
		Result *struct {
			MimeType   string `json:"mime_type"`
			ByteSize   int64  `json:"byte_size"`
			Checksum   string `json:"checksum_sha256"`
			WidthPx    *int   `json:"width_px"`
			HeightPx   *int   `json:"height_px"`
			DurationMS *int   `json:"duration_ms"`
		} `json:"result"`
	} `json:"slots"`
}

func decodeTaskView(t *testing.T, body []byte) taskView {
	t.Helper()
	var view taskView
	if err := json.Unmarshal(body, &view); err != nil {
		t.Fatalf("decode task view: %v", err)
	}
	return view
}

func (h *harness) getTask(t *testing.T, token, taskID string) (int, []byte, taskView) {
	t.Helper()
	status, body := h.doRequest(t, "GET", "/creation/tasks/"+taskID, token, nil)
	var view taskView
	if status == http.StatusOK {
		view = decodeTaskView(t, body)
	}
	return status, body, view
}

// awaitTaskTerminal polls the task until it reaches a terminal status or the
// deadline expires; the worker's convergence stays within test budgets.
func (h *harness) awaitTaskTerminal(t *testing.T, token, taskID string) taskView {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		_, _, view := h.getTask(t, token, taskID)
		switch view.Task.Status {
		case "succeeded", "partially_succeeded", "failed", "cancelled", "timed_out":
			return view
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("task %s did not converge within 30s", taskID)
	return taskView{}
}

// slotVerdicts renders the slots compactly for failure messages.
func slotVerdicts(view taskView) string {
	out := ""
	for _, slot := range view.Slots {
		out += fmt.Sprintf("[#%d %s", slot.Index, slot.Status)
		if slot.FailureReason != nil {
			out += "/" + *slot.FailureReason
		}
		out += "]"
	}
	return out
}
