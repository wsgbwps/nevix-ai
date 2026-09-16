package integrationtest

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"testing"
)

func TestGenerationResultDownloadServesRangesAndChecksum(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1})
	intent := h.imageTaskIntent(t, token, "结果文件区间下载", 1)
	status, body := h.submitTask(t, token, "result-range", intent)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	view := h.awaitTaskTerminal(t, token, decodeTaskView(t, body).Task.ID)
	path := "/creation/tasks/" + view.Task.ID + "/slots/0/result"
	status, whole := h.doRequest(t, http.MethodGet, path, token, nil)
	if status != http.StatusOK || len(whole) < 16 {
		t.Fatalf("download: %d len=%d", status, len(whole))
	}
	digest := sha256.Sum256(whole)
	for _, tc := range []struct {
		name, header string
		start, stop  int
		status       int
	}{
		{"whole", "", 0, len(whole), http.StatusOK},
		{"closed", "bytes=0-15", 0, 16, http.StatusPartialContent},
		{"open", "bytes=16-", 16, len(whole), http.StatusPartialContent},
		{"suffix", "bytes=-8", len(whole) - 8, len(whole), http.StatusPartialContent},
		{"clamped", "bytes=0-9223372036854775807", 0, len(whole), http.StatusPartialContent},
		{"overflow", "bytes=0-9999999999999999999", 0, 0, http.StatusRequestedRangeNotSatisfiable},
		{"multi", "bytes=0-1,4-5", 0, 0, http.StatusRequestedRangeNotSatisfiable},
		{"outside", fmt.Sprintf("bytes=%d-", len(whole)), 0, 0, http.StatusRequestedRangeNotSatisfiable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequestWithContext(h.ctx, http.MethodGet, h.serverURL+path, nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Range", tc.header)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			raw, err := io.ReadAll(resp.Body)
			if err != nil {
				t.Fatal(err)
			}
			if resp.StatusCode != tc.status {
				t.Fatalf("status=%d want=%d bytes=%d", resp.StatusCode, tc.status, len(raw))
			}
			if tc.status == http.StatusRequestedRangeNotSatisfiable {
				assertErrorCode(t, raw, "range_not_satisfiable")
				return
			}
			if !bytes.Equal(raw, whole[tc.start:tc.stop]) {
				t.Fatal("served bytes differ from requested result window")
			}
			if resp.Header.Get("X-Content-SHA-256") != hex.EncodeToString(digest[:]) ||
				resp.Header.Get("Accept-Ranges") != "bytes" || resp.ContentLength != int64(tc.stop-tc.start) {
				t.Fatalf("result download headers: %v", resp.Header)
			}
			if tc.status == http.StatusPartialContent && resp.Header.Get("Content-Range") !=
				fmt.Sprintf("bytes %d-%d/%d", tc.start, tc.stop-1, len(whole)) {
				t.Fatalf("content range: %q", resp.Header.Get("Content-Range"))
			}
		})
	}
	for _, foreignToken := range []string{
		h.loginToken(t, otherCreatorEmail, harnessPassword),
		h.loginToken(t, harnessAdminEmail, harnessAdminPassword),
	} {
		if status, _ := h.doRequest(t, http.MethodGet, path, foreignToken, nil); status != http.StatusNotFound {
			t.Fatalf("foreign result download must be private, status=%d", status)
		}
	}
}

func TestVideoResultPreservesAudioAndServesSeekRange(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	fixture, err := os.ReadFile("../../../../scripts/dev/fixtures/video-with-audio.mp4")
	if err != nil {
		t.Fatal(err)
	}
	h.kapon.generation.mu.Lock()
	h.kapon.generation.servedMP4 = fixture
	h.kapon.generation.mu.Unlock()
	session := h.createSession(t, token, sessionName("video-audio-result"))
	intent := h.buildTaskIntent(t, token, session.ID, taskIntent{
		MediaType: "video", Model: "doubao-seedance-2-5", Mode: "text-to-video",
		Resolution: "720p", Duration: 5, Prompt: "带声音的视频产物",
	})
	status, body := h.submitTask(t, token, "video-audio-result", intent)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	view := h.awaitTaskTerminal(t, token, decodeTaskView(t, body).Task.ID)
	if view.Task.Status != "succeeded" || len(view.Slots) != 1 || view.Slots[0].Result == nil {
		t.Fatalf("video must produce one verified result: %s", view.Task.Status)
	}
	result := view.Slots[0].Result
	digest := sha256.Sum256(fixture)
	if result.MimeType != "video/mp4" || result.ByteSize != int64(len(fixture)) ||
		result.Checksum != hex.EncodeToString(digest[:]) || result.WidthPx == nil || *result.WidthPx != 320 ||
		result.HeightPx == nil || *result.HeightPx != 180 || result.DurationMS == nil || *result.DurationMS != 5000 {
		t.Fatalf("verified video facts: %+v", result)
	}
	path := "/creation/tasks/" + view.Task.ID + "/slots/0/result"
	status, whole := h.doRequest(t, http.MethodGet, path, token, nil)
	if status != http.StatusOK || !bytes.Equal(whole, fixture) || !bytes.Contains(whole, []byte("soun")) {
		t.Fatalf("transferred MP4 must preserve its actual sound track, status=%d", status)
	}
	req, err := http.NewRequestWithContext(h.ctx, http.MethodGet, h.serverURL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Range", "bytes=1024-2047")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil || resp.StatusCode != http.StatusPartialContent || !bytes.Equal(raw, fixture[1024:2048]) ||
		resp.Header.Get("Content-Type") != "video/mp4" ||
		resp.Header.Get("Content-Range") != fmt.Sprintf("bytes 1024-2047/%d", len(fixture)) {
		t.Fatalf("video seek range: status=%d headers=%v error=%v", resp.StatusCode, resp.Header, err)
	}
	key := "generation-results/" + view.Task.ID[:2] + "/" + view.Task.ID[2:4] + "/" + view.Task.ID + "-slot-0"
	h.directStore.replaceWithGeneratedObject(key, int64(len(fixture)), 0xff)
	req, err = http.NewRequestWithContext(h.ctx, http.MethodGet, h.serverURL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	corrupt, err := http.DefaultClient.Do(req)
	if err != nil {
		return
	}
	defer corrupt.Body.Close()
	if raw, err := io.ReadAll(corrupt.Body); err == nil && len(raw) == len(fixture) {
		t.Fatal("same-size corruption must fail the download before a complete body is accepted")
	}
}
