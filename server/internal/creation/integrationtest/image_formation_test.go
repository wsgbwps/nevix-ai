package integrationtest

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// Slice-10 image-formation scenarios (issue #160): the generation call
// carries the decrypted Provider Key and the pinned (ratio, resolution)
// payload, and every verified output forms exactly one immutable PNG Media
// Asset while rejections and unverifiable outputs form none.

// TestImageSubmitCarriesCredentialAndPinnedSize: the worker's generation
// call authenticates with the configured connection key and transmits the
// frozen ratio/resolution through the adapter's pinned size mapping.
func TestImageSubmitCarriesCredentialAndPinnedSize(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1})

	draft := h.saveImageDraft(t, token, "默认参数", 1)
	status, body := h.submitTask(t, token, draft.SessionID, "img-wire-default", draft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	if view := decodeTaskView(t, body); view.Task.MediaType != "image" {
		t.Fatalf("submit response must carry the media type, got %q", view.Task.MediaType)
	}
	h.awaitTaskTerminal(t, token, decodeTaskView(t, body).Task.ID)

	call := h.kapon.generation.lastImageCall()
	if call == nil {
		t.Fatal("image generation call must reach the provider")
	}
	if call.bearer != "Bearer task-kernel-key" {
		t.Fatalf("generation call must authenticate with the configured key, got %q", call.bearer)
	}
	if call.model != "doubao-seedream-5.0-lite" {
		t.Fatalf("fixed image model must not be substituted, got %q", call.model)
	}
	if call.size != "2048x2048" {
		t.Fatalf("1:1 2K must map onto the pinned 2048x2048 size, got %q", call.size)
	}
	if call.n != 1 || call.images != 0 {
		t.Fatalf("text-to-image must send quantity without references, got n=%d images=%d", call.n, call.images)
	}

	// A second scenario proves the ratio reaches the vendor payload.
	draft16x9 := h.saveDraftOn(t, token, draft.SessionID, taskDraft{
		SessionID: draft.SessionID, MediaType: "image", Model: "doubao-seedream-5.0-lite",
		Mode: "text-to-image", Ratio: "16:9", Resolution: "1K", Quantity: 1, Prompt: "横幅",
	})
	status, body = h.submitTask(t, token, draft16x9.SessionID, "img-wire-16x9", draft16x9.Revision)
	if status != http.StatusCreated {
		t.Fatalf("submit 16:9: %d %s", status, body)
	}
	h.awaitTaskTerminal(t, token, decodeTaskView(t, body).Task.ID)
	if call := h.kapon.generation.lastImageCall(); call.size != "1024x576" {
		t.Fatalf("16:9 1K must map onto the pinned 1024x576 size, got %q", call.size)
	}
}

// TestImageOutputsFormUniqueMediaAssets: every succeeded slot forms exactly
// one PNG Media Asset, and the creator keeps the slot download.
func TestImageOutputsFormUniqueMediaAssets(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 2})

	draft := h.saveImageDraft(t, token, "两张资产", 2)
	status, body := h.submitTask(t, token, draft.SessionID, "img-assets", draft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	view := decodeTaskView(t, body)
	view = h.awaitTaskTerminal(t, token, view.Task.ID)
	if view.Task.Status != "succeeded" {
		t.Fatalf("task must succeed, got %s (%s)", view.Task.Status, slotVerdicts(view))
	}

	taskID := view.Task.ID
	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_media_assets WHERE task_id = $1::uuid`, taskID); got != 2 {
		t.Fatalf("two succeeded slots must form two assets, got %d", got)
	}
	// One asset per slot, verified PNG facts carried over.
	assetSlots := h.ownerPool.QueryRow(h.ctx,
		`SELECT count(DISTINCT slot_index), count(*) FILTER (WHERE mime = 'image/png'),
		        count(*) FILTER (WHERE byte_size > 0), count(*) FILTER (WHERE width_px IS NOT NULL)
		 FROM creation_media_assets WHERE task_id = $1::uuid`, taskID)
	var distinctSlots, pngCount, sizedCount, widthCount int
	if err := assetSlots.Scan(&distinctSlots, &pngCount, &sizedCount, &widthCount); err != nil {
		t.Fatalf("scan asset facts: %v", err)
	}
	if distinctSlots != 2 || pngCount != 2 || sizedCount != 2 || widthCount != 2 {
		t.Fatalf("asset facts incomplete: slots=%d png=%d sized=%d width=%d", distinctSlots, pngCount, sizedCount, widthCount)
	}
	// Assets snapshot the creator for the later team-readable surface.
	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_media_assets WHERE task_id = $1::uuid AND owner_user_id = (SELECT id FROM users WHERE email = $2)`, taskID, creator); got != 2 {
		t.Fatalf("assets must snapshot the creator owner, got %d", got)
	}

	// The slot download remains the Workbench's verified-bytes path.
	status, raw := h.doRequest(t, "GET", "/creation/tasks/"+taskID+"/slots/0/result", token, nil)
	if status != http.StatusOK || len(raw) == 0 {
		t.Fatalf("slot download must serve bytes, got %d len=%d", status, len(raw))
	}

	// The session list projection carries the media type: the Desktop's
	// fail-closed parser rejects a summary with an empty media_type, which
	// would empty the Workbench task list (issue #160 E2E regression).
	status, raw = h.doRequest(t, "GET", "/creation/sessions/"+draft.SessionID+"/tasks?limit=50", token, nil)
	if status != http.StatusOK {
		t.Fatalf("task list must answer 200, got %d", status)
	}
	var page struct {
		Tasks []struct {
			ID        string `json:"id"`
			MediaType string `json:"media_type"`
			Status    string `json:"status"`
		} `json:"tasks"`
	}
	if err := json.Unmarshal(raw, &page); err != nil {
		t.Fatalf("decode task list: %v", err)
	}
	if len(page.Tasks) != 1 {
		t.Fatalf("one listed task expected, got %d", len(page.Tasks))
	}
	if page.Tasks[0].MediaType != "image" || page.Tasks[0].Status != "succeeded" {
		t.Fatalf("list projection lost facts: %+v", page.Tasks[0])
	}
}

// TestPartialSuccessFormsAssetsOnlyForSucceededSlots: a provider shortfall
// fails only the missing slots; their absence from the asset table keeps the
// aggregate's succeeded-only invariant.
func TestPartialSuccessFormsAssetsOnlyForSucceededSlots(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 2})

	draft := h.saveImageDraft(t, token, "部分资产", 3)
	status, body := h.submitTask(t, token, draft.SessionID, "img-partial-assets", draft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	view := decodeTaskView(t, body)
	view = h.awaitTaskTerminal(t, token, view.Task.ID)
	if view.Task.Status != "partially_succeeded" {
		t.Fatalf("shortfall must aggregate partially_succeeded, got %s", view.Task.Status)
	}
	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_media_assets WHERE task_id = $1::uuid`, view.Task.ID); got != 2 {
		t.Fatalf("only succeeded slots form assets, got %d", got)
	}
}

// TestProviderOverSupplyNeverFormsExtraAsset: outputs beyond the stable slot
// count are dropped, not persisted.
func TestProviderOverSupplyNeverFormsExtraAsset(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 4})

	draft := h.saveImageDraft(t, token, "超额输出", 1)
	status, body := h.submitTask(t, token, draft.SessionID, "img-oversupply", draft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	view := decodeTaskView(t, body)
	view = h.awaitTaskTerminal(t, token, view.Task.ID)
	if view.Task.Status != "succeeded" {
		t.Fatalf("task must succeed, got %s", view.Task.Status)
	}
	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_media_assets WHERE task_id = $1::uuid`, view.Task.ID); got != 1 {
		t.Fatalf("over-supply must form exactly one asset, got %d", got)
	}
}

// TestImagePolicyRejectionFormsNoAsset: a definitive provider rejection
// fails the task with the stable reason and never forms an asset.
func TestImagePolicyRejectionFormsNoAsset(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{status: http.StatusBadRequest, code: "input_content_policy"})

	draft := h.saveImageDraft(t, token, "被拒绝输入", 2)
	status, body := h.submitTask(t, token, draft.SessionID, "img-policy", draft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	view := decodeTaskView(t, body)
	view = h.awaitTaskTerminal(t, token, view.Task.ID)
	if view.Task.Status != "failed" {
		t.Fatalf("policy rejection must fail the task, got %s (%s)", view.Task.Status, slotVerdicts(view))
	}
	for _, slot := range view.Slots {
		if slot.Status != "failed" || slot.FailureReason == nil || *slot.FailureReason != "input_policy_rejected" {
			t.Fatalf("stable input-policy reason expected: %s", slotVerdicts(view))
		}
	}
	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_media_assets WHERE task_id = $1::uuid`, view.Task.ID); got != 0 {
		t.Fatalf("policy rejection must form no asset, got %d", got)
	}
}

// TestImageIndeterminateFormsNoAsset: an unidentifiable submit converges to
// indeterminate without external guessing and never forms an asset.
func TestImageIndeterminateFormsNoAsset(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{abort: true})

	draft := h.saveImageDraft(t, token, "结局未知", 1)
	status, body := h.submitTask(t, token, draft.SessionID, "img-indeterminate", draft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	view := decodeTaskView(t, body)
	view = h.awaitTaskTerminal(t, token, view.Task.ID)
	if view.Task.Status != "failed" || view.Task.TerminalCause == nil || *view.Task.TerminalCause != "provider_outcome_indeterminate" {
		t.Fatalf("indeterminate convergence expected, got %s cause=%v", view.Task.Status, view.Task.TerminalCause)
	}
	for _, slot := range view.Slots {
		if slot.Status != "indeterminate" {
			t.Fatalf("slots must settle indeterminate: %s", slotVerdicts(view))
		}
	}
	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_media_assets WHERE task_id = $1::uuid`, view.Task.ID); got != 0 {
		t.Fatalf("indeterminate must form no asset, got %d", got)
	}
}

// TestNonPNGImageOutputFailsVerification: an image task's output must be a
// verifiable PNG; any other family is a failed transfer, not an asset.
func TestNonPNGImageOutputFailsVerification(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1, jpeg: true})

	draft := h.saveImageDraft(t, token, "错误编码", 1)
	status, body := h.submitTask(t, token, draft.SessionID, "img-jpeg-output", draft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	view := decodeTaskView(t, body)
	view = h.awaitTaskTerminal(t, token, view.Task.ID)
	if view.Task.Status != "failed" {
		t.Fatalf("unacceptable output must fail the task, got %s (%s)", view.Task.Status, slotVerdicts(view))
	}
	for _, slot := range view.Slots {
		if slot.Status != "failed" || slot.FailureReason == nil || *slot.FailureReason != "temporarily_unavailable" {
			t.Fatalf("verification failure must be retryable unavailable: %s", slotVerdicts(view))
		}
	}
	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_media_assets WHERE task_id = $1::uuid`, view.Task.ID); got != 0 {
		t.Fatalf("unverified output must form no asset, got %d", got)
	}
}

// TestImageSubmitAcceptsFullLengthUnicodePrompt: the prompt envelope counts
// Unicode characters (spec 图片合同), not bytes — a legal 2000-rune CJK
// prompt (6000 bytes) must submit instead of failing as an over-length
// draft.
func TestImageSubmitAcceptsFullLengthUnicodePrompt(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1})

	draft := h.saveImageDraft(t, token, strings.Repeat("鞋", 2000), 1)
	status, body := h.submitTask(t, token, draft.SessionID, "img-cjk-2000", draft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("2000-rune prompt must submit, got %d %s", status, body)
	}
	view := h.awaitTaskTerminal(t, token, decodeTaskView(t, body).Task.ID)
	if view.Task.Status != "succeeded" {
		t.Fatalf("task must succeed, got %s (%s)", view.Task.Status, slotVerdicts(view))
	}
}
