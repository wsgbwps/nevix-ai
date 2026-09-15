package integrationtest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
)

func TestVideoFrameModeRequiresOrderedRoles(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{})
	token := h.loginToken(t, creator, harnessPassword)
	session := h.createSession(t, token, sessionName("video-frame-roles"))
	first := h.uploadImage(t, token, session.ID, "first.png")
	intent := h.buildTaskIntent(t, token, session.ID, taskIntent{
		MediaType: "video", Model: "doubao-seedance-2-5", Mode: "first-frame",
		Ratio: "adaptive", Resolution: "720p", Duration: 5, Prompt: "商品展示",
		References: []any{map[string]any{"material_id": first, "role": "last_frame"}},
	})
	status, body := h.submitTask(t, token, "video-last-without-first", intent)
	if status == http.StatusCreated {
		h.doRequest(t, http.MethodPost, "/creation/tasks/"+decodeTaskView(t, body).Task.ID+"/cancel", token, nil)
	}
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("last frame without first must be rejected, got %d: %s", status, body)
	}
	assertErrorCode(t, body, "capability_stale")
}

func TestVideoFramesRequireAdaptiveRatio(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{})
	token := h.loginToken(t, creator, harnessPassword)
	session := h.createSession(t, token, sessionName("video-frame-ratio"))
	material := h.uploadImage(t, token, session.ID, "first.png")
	intent := h.buildTaskIntent(t, token, session.ID, taskIntent{
		MediaType: "video", Model: "doubao-seedance-2-5", Mode: "first-frame",
		Ratio: "16:9", Resolution: "720p", Duration: 5, Prompt: "商品展示",
		References: []any{map[string]any{"material_id": material, "role": "first_frame"}},
	})
	status, body := h.submitTask(t, token, "video-nonadaptive-frame", intent)
	if status == http.StatusCreated {
		h.doRequest(t, http.MethodPost, "/creation/tasks/"+decodeTaskView(t, body).Task.ID+"/cancel", token, nil)
	}
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("explicit nonadaptive frame ratio must block, got %d: %s", status, body)
	}
	assertErrorCode(t, body, "capability_stale")
}

func TestVideoReferencesRespectManifestDuration(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{})
	token := h.loginToken(t, creator, harnessPassword)
	session := h.createSession(t, token, sessionName("video-reference-duration"))
	for _, kind := range []string{"video", "audio"} {
		for _, duration := range []uint32{1900, 2000, 30000, 30001} {
			t.Run(fmt.Sprintf("%s-%dms", kind, duration), func(t *testing.T) {
				filename := "clip.mp4"
				payload := videoMP4Fixture(320, 180, duration)
				if kind == "audio" {
					filename = "clip.m4a"
					payload = mp4Concat(mp4Box("ftyp", []byte("M4A \x00\x00\x02\x00isomiso2")),
						mp4Box("moov", mp4Concat(mp4Mvhd(1000, duration), mp4Trak("soun", "mp4a", 0, 0))), mp4Box("mdat", make([]byte, 4096)))
				}
				status, body := h.doUpload(t, http.MethodPost, "/creation/sessions/"+session.ID+"/materials", token, filename, payload)
				material := mustUpload(t, status, body)
				intent := h.buildTaskIntent(t, token, session.ID, taskIntent{
					MediaType: "video", Model: "doubao-seedance-2-5", Mode: "omni-reference",
					Ratio: "16:9", Resolution: "720p", Duration: 5, Prompt: "商品展示",
					References: []any{map[string]any{"material_id": material.ID, "role": "omni"}},
				})
				status, body = h.submitTask(t, token, fmt.Sprintf("%s-%dms", kind, duration), intent)
				want := http.StatusCreated
				if duration < 2000 || duration > 30000 {
					want = http.StatusUnprocessableEntity
				}
				if status == http.StatusCreated {
					h.doRequest(t, http.MethodPost, "/creation/tasks/"+decodeTaskView(t, body).Task.ID+"/cancel", token, nil)
				}
				if status != want {
					t.Fatalf("duration boundary status=%d want=%d: %s", status, want, body)
				}
				if want == http.StatusUnprocessableEntity {
					assertErrorCode(t, body, "capability_stale")
				}
			})
		}
	}
}

func TestVideoReferencesRespectManifestMediaCounts(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{})
	token := h.loginToken(t, creator, harnessPassword)
	session := h.createSession(t, token, sessionName("video-reference-counts"))
	refs := make([]any, 0, 2)
	for _, name := range []string{"first.mp4", "second.mp4"} {
		status, body := h.doUpload(t, http.MethodPost, "/creation/sessions/"+session.ID+"/materials", token, name, videoMP4Fixture(320, 180, 2000))
		refs = append(refs, map[string]any{"material_id": mustUpload(t, status, body).ID, "role": "omni"})
	}
	intent := h.buildTaskIntent(t, token, session.ID, taskIntent{
		MediaType: "video", Model: "doubao-seedance-2-5", Mode: "omni-reference",
		Ratio: "16:9", Resolution: "720p", Duration: 5, Prompt: "商品展示", References: refs,
	})
	status, body := h.submitTask(t, token, "video-reference-counts", intent)
	if status == http.StatusCreated {
		h.doRequest(t, http.MethodPost, "/creation/tasks/"+decodeTaskView(t, body).Task.ID+"/cancel", token, nil)
	}
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("per-media limit must block even below total limit, got %d: %s", status, body)
	}
	assertErrorCode(t, body, "capability_stale")
}

func TestVideoRetryRevalidatesCurrentManifest(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{})
	token := h.loginToken(t, creator, harnessPassword)
	session := h.createSession(t, token, sessionName("video-retry-manifest"))
	intent := h.buildTaskIntent(t, token, session.ID, taskIntent{
		MediaType: "video", Model: "doubao-seedance-2-5", Mode: "text-to-video",
		Ratio: "16:9", Resolution: "720p", Duration: 5, Prompt: "商品展示",
	})
	status, body := h.submitTask(t, token, "video-retry-original", intent)
	if status != http.StatusCreated {
		t.Fatalf("submit retry fixture: %d %s", status, body)
	}
	taskID := decodeTaskView(t, body).Task.ID
	if status, body := h.doRequest(t, http.MethodPost, "/creation/tasks/"+taskID+"/cancel", token, nil); status != http.StatusOK {
		t.Fatalf("cancel retry fixture: %d %s", status, body)
	}
	// Emulate a historical duration no longer published by the current manifest.
	if _, err := h.ownerPool.Exec(h.ctx, `
		UPDATE creation_generation_tasks
		SET specification = jsonb_set(jsonb_set(specification, '{manifest_version}', to_jsonb($2::integer)), '{duration_seconds}', '7'::jsonb), manifest_version = $2
		WHERE id = $1::uuid`, taskID, intent.ManifestVersion-1); err != nil {
		t.Fatalf("prepare historical manifest fixture: %v", err)
	}
	status, body = h.doRequest(t, http.MethodPost, "/creation/tasks/"+taskID+"/retry", token, map[string]any{"idempotency_key": "video-retry-stale"})
	if status == http.StatusCreated {
		h.doRequest(t, http.MethodPost, "/creation/tasks/"+decodeTaskView(t, body).Task.ID+"/cancel", token, nil)
	}
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("retry with an unsupported historical duration must block, got %d: %s", status, body)
	}
	assertErrorCode(t, body, "capability_stale")
	if _, _, original := h.getTask(t, token, taskID); original.Task.Status != "cancelled" {
		t.Fatal("rejected retry must leave the original terminal task unchanged")
	}
}

func TestHistoricalTaskRetryPreservesSupportedIntentAndReplay(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{})
	token := h.loginToken(t, creator, harnessPassword)
	for _, media := range []string{"image", "video"} {
		t.Run(media, func(t *testing.T) {
			session := h.createSession(t, token, sessionName("historical-retry-"+media))
			intent := taskIntent{MediaType: media, Prompt: "仍受支持的历史创作"}
			if media == "image" {
				intent.Model, intent.Mode, intent.Ratio, intent.Resolution, intent.Quantity =
					"doubao-seedream-5.0-pro", "text-to-image", "1:1", "2K", 1
			} else {
				intent.Model, intent.Mode, intent.Ratio, intent.Resolution, intent.Duration =
					"doubao-seedance-2-5", "text-to-video", "16:9", "720p", 5
			}
			intent = h.buildTaskIntent(t, token, session.ID, intent)
			status, body := h.submitTask(t, token, "historical-retry-original-"+media, intent)
			if status != http.StatusCreated {
				t.Fatalf("submit original: %d %s", status, body)
			}
			originalID := decodeTaskView(t, body).Task.ID
			path := "/creation/tasks/" + originalID
			if status, body := h.doRequest(t, http.MethodPost, path+"/cancel", token, nil); status != http.StatusOK {
				t.Fatalf("cancel original: %d %s", status, body)
			}
			if _, err := h.ownerPool.Exec(h.ctx, `
				UPDATE creation_generation_tasks
				SET specification = jsonb_set(specification, '{manifest_version}', to_jsonb($2::integer)), manifest_version = $2
				WHERE id = $1::uuid`, originalID, intent.ManifestVersion-1); err != nil {
				t.Fatalf("prepare historical intent: %v", err)
			}
			_, before := h.doRequest(t, http.MethodGet, path, token, nil)
			request := map[string]any{"idempotency_key": "historical-retry-new-" + media}
			status, body = h.doRequest(t, http.MethodPost, path+"/retry", token, request)
			if status != http.StatusCreated {
				t.Fatalf("supported historical intent must retry: %d %s", status, body)
			}
			retry := decodeTaskView(t, body)
			if retry.Task.ID == originalID || retry.Task.SlotCount != 1 || len(retry.Slots) != 1 {
				t.Fatalf("retry must form one new unfinished slot: %+v", retry.Task)
			}
			var originalDetail, retryDetail map[string]json.RawMessage
			if err := json.Unmarshal(before, &originalDetail); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(body, &retryDetail); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(originalDetail["specification"], retryDetail["specification"]) {
				t.Fatal("retry changed the frozen supported intent or source manifest version")
			}
			status, replayBody := h.doRequest(t, http.MethodPost, path+"/retry", token, request)
			if status != http.StatusOK || decodeTaskView(t, replayBody).Task.ID != retry.Task.ID {
				t.Fatalf("same-key retry must replay the same task: %d %s", status, replayBody)
			}
			_, after := h.doRequest(t, http.MethodGet, path, token, nil)
			if !bytes.Equal(before, after) {
				t.Fatal("retry changed the original terminal task")
			}
			if status, body := h.doRequest(t, http.MethodPost, "/creation/tasks/"+retry.Task.ID+"/cancel", token, nil); status != http.StatusOK {
				t.Fatalf("cancel retry fixture: %d %s", status, body)
			}
		})
	}
}
