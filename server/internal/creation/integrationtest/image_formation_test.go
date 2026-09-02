package integrationtest

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// Slice-10 image-formation scenarios (issue #160): the generation call
// carries the decrypted Provider Key and the pinned (ratio, resolution)
// payload, and every verified output forms exactly one immutable image Media
// Asset while rejections and unverifiable outputs form none.

// TestImageSubmitCarriesCredentialAndPinnedSize: the worker's generation
// call authenticates with the configured connection key and transmits the
// frozen ratio/resolution through the adapter's pinned size mapping.
func TestImageSubmitCarriesCredentialAndPinnedSize(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1})

	draft := h.imageTaskIntent(t, token, "默认参数", 1)
	status, body := h.submitTask(t, token, "img-wire-default", draft)
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
	if call.model != "doubao-seedream-5-0-pro-260628" {
		t.Fatalf("the alias must travel as its deterministic versioned backend id (flaky alias routing, field report 2026-09-01), got %q", call.model)
	}
	if call.size != "2048x2048" {
		t.Fatalf("Seedream 5.0 Pro 1:1 2K requires size=2048x2048, got %q", call.size)
	}
	if call.n != 0 || call.images != 0 {
		t.Fatalf("text-to-image must send no undocumented batch field and no references, got n=%d images=%d", call.n, call.images)
	}

	// The provider receives the model-specific pixel size derived from the
	// selected ratio and resolution tier.
	draft16x9 := h.buildTaskIntent(t, token, draft.SessionID, taskIntent{
		SessionID: draft.SessionID, MediaType: "image", Model: "doubao-seedream-5.0-pro",
		Mode: "text-to-image", Ratio: "16:9", Resolution: "1K", Quantity: 1, Prompt: "横幅",
	})
	status, body = h.submitTask(t, token, "img-wire-16x9", draft16x9)
	if status != http.StatusCreated {
		t.Fatalf("submit 16:9: %d %s", status, body)
	}
	h.awaitTaskTerminal(t, token, decodeTaskView(t, body).Task.ID)
	if call := h.kapon.generation.lastImageCall(); call.size != "1424x800" {
		t.Fatalf("Seedream 5.0 Pro 16:9 1K requires size=1424x800, got %q", call.size)
	}
}

// TestImageOutputsFormUniqueMediaAssets: every succeeded slot forms exactly
// one PNG Media Asset, and the creator keeps the slot download.
func TestImageOutputsFormUniqueMediaAssets(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1})

	draft := h.imageTaskIntent(t, token, "两张资产", 2)
	status, body := h.submitTask(t, token, "img-assets", draft)
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
	h.kapon.generation.setImage(imageScript{outputs: 1, emptyOutputsOn: 2})

	draft := h.imageTaskIntent(t, token, "部分资产", 3)
	status, body := h.submitTask(t, token, "img-partial-assets", draft)
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

	draft := h.imageTaskIntent(t, token, "超额输出", 1)
	status, body := h.submitTask(t, token, "img-oversupply", draft)
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

	draft := h.imageTaskIntent(t, token, "被拒绝输入", 2)
	status, body := h.submitTask(t, token, "img-policy", draft)
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

	draft := h.imageTaskIntent(t, token, "结局未知", 1)
	status, body := h.submitTask(t, token, "img-indeterminate", draft)
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

// TestJPEGImageOutputFormsVerifiedAsset reproduces Seedream 5.0 Pro's real
// output shape: a successfully downloaded, probed JPEG is a valid image asset.
func TestJPEGImageOutputFormsVerifiedAsset(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1, jpeg: true})

	draft := h.imageTaskIntent(t, token, "JPEG 输出", 1)
	status, body := h.submitTask(t, token, "img-jpeg-output", draft)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	view := decodeTaskView(t, body)
	view = h.awaitTaskTerminal(t, token, view.Task.ID)
	if view.Task.Status != "succeeded" {
		t.Fatalf("verified JPEG output must succeed, got %s (%s)", view.Task.Status, slotVerdicts(view))
	}
	for _, slot := range view.Slots {
		if slot.Status != "succeeded" || slot.Result == nil || slot.Result.MimeType != "image/jpeg" {
			t.Fatalf("JPEG result facts missing: %s", slotVerdicts(view))
		}
	}
	if got := countRows(t, h.ownerPool,
		`SELECT count(*) FROM creation_media_assets WHERE task_id = $1::uuid AND mime = 'image/jpeg'`, view.Task.ID); got != 1 {
		t.Fatalf("verified JPEG output must form one JPEG asset, got %d", got)
	}
}

// TestImageOutputHTTPFailureKeepsConcreteDiagnostic reproduces the field
// failure where Kapon accepted generation but its temporary output URL could
// not be downloaded. The creator must see the exact stage and HTTP status.
func TestImageOutputHTTPFailureKeepsConcreteDiagnostic(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{
		outputs: 1, outputStatus: http.StatusForbidden,
	})

	draft := h.imageTaskIntent(t, token, "下载诊断", 1)
	status, body := h.submitTask(t, token, "img-output-403", draft)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	view := h.awaitTaskTerminal(t, token, decodeTaskView(t, body).Task.ID)
	if view.Task.Status != "failed" || len(view.Slots) != 1 {
		t.Fatalf("output HTTP failure must fail one slot: %s (%s)", view.Task.Status, slotVerdicts(view))
	}
	slot := view.Slots[0]
	if slot.FailureReason == nil || *slot.FailureReason != "temporarily_unavailable" {
		t.Fatalf("stable reason changed: %s", slotVerdicts(view))
	}
	diagnostic := slot.FailureDiagnostic
	if diagnostic == nil || diagnostic.Source != "output_transfer" ||
		diagnostic.Code != "provider_output_http_status" ||
		diagnostic.HTTPStatus == nil || *diagnostic.HTTPStatus != http.StatusForbidden ||
		diagnostic.Message != "Provider output download returned HTTP 403" {
		t.Fatalf("concrete output diagnostic missing: %+v", diagnostic)
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

	draft := h.imageTaskIntent(t, token, strings.Repeat("鞋", 2000), 1)
	status, body := h.submitTask(t, token, "img-cjk-2000", draft)
	if status != http.StatusCreated {
		t.Fatalf("2000-rune prompt must submit, got %d %s", status, body)
	}
	view := h.awaitTaskTerminal(t, token, decodeTaskView(t, body).Task.ID)
	if view.Task.Status != "succeeded" {
		t.Fatalf("task must succeed, got %s (%s)", view.Task.Status, slotVerdicts(view))
	}
}
