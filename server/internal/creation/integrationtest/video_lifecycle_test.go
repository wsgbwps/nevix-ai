package integrationtest

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func TestVideoNormalizedModesUseTaskLifecycle(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	session := h.createSession(t, token, sessionName("video-normalized-modes"))
	first := h.uploadImage(t, token, session.ID, "first.png")
	last := h.uploadImage(t, token, session.ID, "last.png")
	audio := h.uploadAudio(t, token, session.ID)
	status, body := h.doUpload(t, http.MethodPost, "/creation/sessions/"+session.ID+"/materials", token, "clip.mp4", videoMP4Fixture(320, 180, 2000))
	video := mustUpload(t, status, body).ID
	ref := func(id, role string) any { return map[string]any{"material_id": id, "role": role} }
	for _, tc := range []struct {
		mode, ratio string
		refs        []any
	}{
		{"text-to-video", "16:9", nil},
		{"first-frame", "adaptive", []any{ref(first, "first_frame")}},
		{"first-last-frame", "adaptive", []any{ref(first, "first_frame"), ref(last, "last_frame")}},
		{"omni-reference", "9:16", []any{ref(first, "omni"), ref(video, "omni"), ref(audio, "omni")}},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			h.kapon.generation.setVideo(videoTaskScript{succeedAfter: 1})
			intent := h.buildTaskIntent(t, token, session.ID, taskIntent{
				MediaType: "video", Model: "doubao-seedance-2-5", Mode: tc.mode, Ratio: tc.ratio,
				Resolution: "720p", Duration: 5, Prompt: "商品展示", References: tc.refs,
			})
			status, body := h.submitTask(t, token, "video-normalized-"+tc.mode, intent)
			if status != http.StatusCreated {
				t.Fatalf("submit: %d %s", status, body)
			}
			view := h.awaitTaskTerminal(t, token, decodeTaskView(t, body).Task.ID)
			if view.Task.Status != "succeeded" || len(view.Slots) != 1 || view.Slots[0].Result == nil || view.Slots[0].Result.MimeType != "video/mp4" {
				t.Fatalf("normalized video did not converge through Task: %+v %s", view.Task, slotVerdicts(view))
			}
			if view.Specification == nil || view.Specification.Mode != tc.mode || view.Specification.Ratio == nil || *view.Specification.Ratio != tc.ratio || len(view.Specification.References) != len(tc.refs) {
				t.Fatalf("frozen video input changed: %+v", view.Specification)
			}
		})
	}
}

func TestVideoWorkerRestartPollsAcceptedJobWithoutResubmission(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setVideo(videoTaskScript{succeedAfter: 1000})
	session := h.createSession(t, token, sessionName("video-worker-restart"))
	intent := h.buildTaskIntent(t, token, session.ID, taskIntent{
		MediaType: "video", Model: "doubao-seedance-2-5", Mode: "text-to-video", Ratio: "16:9",
		Resolution: "720p", Duration: 5, Prompt: "商品展示",
	})
	status, body := h.submitTask(t, token, "video-worker-restart", intent)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	taskID := decodeTaskView(t, body).Task.ID
	start := func() func() {
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { done <- h.creation.RunWorkers(ctx) }()
		return func() {
			cancel()
			select {
			case err := <-done:
				if err != nil {
					t.Fatalf("stop video worker: %v", err)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("video worker did not stop")
			}
		}
	}
	stop := start()
	deadline := time.Now().Add(10 * time.Second)
	processing := false
	for time.Now().Before(deadline) {
		_, _, view := h.getTask(t, token, taskID)
		if view.Task.Status == "processing" {
			processing = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	stop()
	if !processing {
		t.Fatal("video did not reach accepted processing before restart")
	}
	h.kapon.generation.setVideo(videoTaskScript{succeedAfter: 0})
	stop = start()
	defer stop()
	view := h.awaitTaskTerminal(t, token, taskID)
	if view.Task.Status != "succeeded" || view.Slots[0].Result == nil {
		t.Fatalf("accepted job did not converge after worker restart: %s", slotVerdicts(view))
	}
	if got := h.kapon.generation.videoSubmitRequests(); got != 1 {
		t.Fatalf("accepted video was resubmitted after restart: %d external calls", got)
	}
}
