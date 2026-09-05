package integrationtest

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"
)

// Generation task kernel scenario support (issue #159): a configured provider
// connection and idempotent full-intent submission helpers (ADR-0017).

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

// taskIntent mirrors the submit request's generation intent (contracts
// TaskSubmitInput): the device-local draft's values at submit time.
type taskIntent struct {
	SessionID       string
	ManifestVersion int
	MediaType       string
	Model           string
	Mode            string
	Ratio           string
	Resolution      string
	Quantity        int
	Duration        int
	Prompt          string
	References      []any
}

// imageTaskIntent creates a fresh session and builds a minimal text-to-image
// intent over the live manifest version.
func (h *harness) imageTaskIntent(t *testing.T, token, prompt string, quantity int) taskIntent {
	t.Helper()
	status, body := h.doRequest(t, "POST", "/creation/sessions", token, map[string]any{"name": "kernel"})
	if status != http.StatusCreated {
		t.Fatalf("create session: status=%d body=%s", status, body)
	}
	sessionID := extractField(t, body, "id")
	return h.buildTaskIntent(t, token, sessionID, taskIntent{
		SessionID: sessionID, MediaType: "image", Model: "doubao-seedream-5.0-pro",
		Mode: "text-to-image", Ratio: "1:1", Resolution: "2K", Quantity: quantity, Prompt: prompt,
	})
}

// buildTaskIntent resolves the live manifest version into the intent for one
// session — the submitter records the manifest it drafted against; scenarios
// may override ManifestVersion afterwards to probe version revalidation.
func (h *harness) buildTaskIntent(t *testing.T, token, sessionID string, intent taskIntent) taskIntent {
	t.Helper()
	_, _, manifest := h.getManifest(t, token)
	if manifest.ManifestVersion < 1 {
		t.Fatalf("manifest must publish a version before intents can record it, got %+v", manifest)
	}
	intent.SessionID = sessionID
	intent.ManifestVersion = manifest.ManifestVersion
	return intent
}

// submitTask POSTs one idempotent submission carrying the full intent.
func (h *harness) submitTask(t *testing.T, token, key string, intent taskIntent) (int, []byte) {
	t.Helper()
	payload := map[string]any{
		"idempotency_key":  key,
		"prompt":           intent.Prompt,
		"media_type":       intent.MediaType,
		"manifest_version": intent.ManifestVersion,
		"model":            intent.Model,
		"mode":             intent.Mode,
		"ratio":            nil,
		"resolution":       intent.Resolution,
		"quantity":         nil,
		"duration_seconds": nil,
		"references":       []any{},
	}
	if intent.Ratio != "" {
		payload["ratio"] = intent.Ratio
	}
	if intent.Quantity > 0 {
		payload["quantity"] = intent.Quantity
	}
	if intent.Duration > 0 {
		payload["duration_seconds"] = intent.Duration
	}
	if intent.References != nil {
		payload["references"] = intent.References
	}
	return h.doRequest(t, "POST", "/creation/sessions/"+intent.SessionID+"/tasks", token, payload)
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
		UpdatedAt       string  `json:"updated_at"`
	} `json:"task"`
	Specification *struct {
		Prompt     string  `json:"prompt"`
		Model      string  `json:"model"`
		Mode       string  `json:"mode"`
		Ratio      *string `json:"ratio"`
		Resolution *string `json:"resolution"`
		Quantity   int     `json:"quantity"`
		References []struct {
			MaterialID string `json:"material_id"`
			Role       string `json:"role"`
		} `json:"references"`
	} `json:"specification"`
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
