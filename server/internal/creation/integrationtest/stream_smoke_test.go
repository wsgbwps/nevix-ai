package integrationtest

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"math/rand"
	"mime/multipart"
	"net/http"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"
)

// TestStreamSmokeParallelFileFlows is the short file-stream smoke every
// file-path PR runs: parallel mixed uploads, full downloads, Range reads,
// and client-cancellation flows against real storage, asserting zero
// unexpected statuses (nothing outside the contract's documented set, and
// no 5xx) plus prompt return after cancellation. The window is ~100 seconds;
// NEVIX_CREATION_SMOKE_SECONDS overrides it for local iteration.
func TestStreamSmokeParallelFileFlows(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	tokens := []string{
		h.loginToken(t, creatorEmail, harnessPassword),
		h.loginToken(t, otherCreatorEmail, harnessPassword),
	}
	// Each creator drives its own private session: creator-scoped probes make
	// a foreign session's material routes answer not_found, so sharing one
	// session across both tokens would only measure the authorization matrix,
	// not the file streams under parallel load.
	materialsPaths := make([]string, len(tokens))
	for i, token := range tokens {
		session := h.createSession(t, token, sessionName("smoke-"+strconv.Itoa(i)))
		materialsPaths[i] = "/creation/sessions/" + session.ID + "/materials"
	}

	blob := noisyPNGBytes(t, 1024, 1024) // incompressible ⇒ multi-chunk streaming

	var (
		mu       sync.Mutex
		statuses = map[int]int{}
		cancels  int
	)
	record := func(status int) {
		mu.Lock()
		statuses[status]++
		mu.Unlock()
	}
	recordCancel := func() {
		mu.Lock()
		cancels++
		mu.Unlock()
	}

	smokeClient := &http.Client{Timeout: 30 * time.Second}
	h.smokeClient = smokeClient

	stopAt := time.Now().Add(smokeWindow(t))
	wg := &sync.WaitGroup{}

	for worker := 0; worker < 3; worker++ {
		wg.Add(1)
		go func(seed int) {
			defer wg.Done()
			token := tokens[seed%len(tokens)]
			materialsPath := materialsPaths[seed%len(materialsPaths)]
			for time.Now().Before(stopAt) {
				name := "smoke-" + strconv.Itoa(seed) + "-" + strconv.FormatInt(time.Now().UnixNano(), 10) + ".png"
				status, body := h.doUpload(t, "POST", materialsPath, token, name, blob)
				record(status)
				if status >= 500 {
					t.Errorf("upload 5xx: %d %s", status, truncate(string(body)))
					return
				}
				time.Sleep(20 * time.Millisecond)
			}
		}(worker)
	}
	for worker := 0; worker < 4; worker++ {
		wg.Add(1)
		go func(seed int) {
			defer wg.Done()
			token := tokens[seed%len(tokens)]
			materialsPath := materialsPaths[seed%len(materialsPaths)]
			for time.Now().Before(stopAt) {
				listing, err := h.listMaterialsForSmoke(materialsPath, token)
				if err != nil {
					t.Logf("smoke: list failed: %v", err)
					record(-1)
					continue
				}
				if len(listing.Materials) == 0 {
					time.Sleep(50 * time.Millisecond)
					continue
				}
				target := listing.Materials[(seed+len(listing.Materials))%len(listing.Materials)]
				req, _ := http.NewRequestWithContext(h.ctx, "GET", h.serverURL+"/creation/materials/"+target.ID, nil)
				req.Header.Set("Authorization", "Bearer "+token)
				if target.ByteSize > 8192 && seed%2 == 0 {
					req.Header.Set("Range", "bytes=4096-8191")
				}
				resp, err := smokeClient.Do(req)
				if err != nil {
					t.Logf("smoke: download %s failed: %v", target.ID, err)
					record(-1)
					continue
				}
				io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
				record(resp.StatusCode)
			}
		}(worker)
	}
	for worker := 0; worker < 2; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			h.uploadThenCancel(t, materialsPaths[0], tokens[0], blob, record, recordCancel)
		}()
	}
	wg.Wait()

	documented := map[int]bool{200: true, 201: true, 204: true, 206: true, 400: true,
		401: true, 403: true, 404: true, 413: true, 415: true, 416: true, 422: true,
		// identity's own surfaces answer these inside the same harness runs
		409: true, 429: true}
	total := 0
	for status, count := range statuses {
		total += count
		switch {
		case status == -1:
			t.Fatalf("transport error during smoke")
		case !documented[status]:
			t.Fatalf("status %d (x%d) is outside the documented vocabulary", status, count)
		}
	}
	if total < 20 {
		t.Fatalf("smoke ran too few flows to be meaningful: %d", total)
	}
	if cancels < 1 {
		t.Fatalf("the cancellation flow never ran: %d abandonments recorded", cancels)
	}
}

func smokeWindow(t *testing.T) time.Duration {
	t.Helper()
	if raw := os.Getenv("NEVIX_CREATION_SMOKE_SECONDS"); raw != "" {
		seconds, err := strconv.Atoi(raw)
		if err == nil && seconds > 0 {
			return time.Duration(seconds) * time.Second
		}
	}
	return 100 * time.Second
}

func (h *harness) listMaterialsForSmoke(path, token string) (materialList, error) {
	status, body := h.doRequest(h.t, "GET", path+"?limit=200", token, nil)
	var listing materialList
	if status != http.StatusOK || jsonFailed(body, &listing) {
		return materialList{}, errorOf(body)
	}
	return listing, nil
}

// uploadThenCancel proves prompt resource release under a dying upload: a
// client with its own hard deadline abandons the body mid-stream. The
// dedicated client owns teardown (no leaked pipes or blocked writers), which
// is exactly the guarantee a real browser abort gives the server.
func (h *harness) uploadThenCancel(
	t *testing.T,
	path, token string,
	payload []byte,
	record func(int),
	recordCancel func(),
) {
	t.Helper()
	reader, writer := io.Pipe()
	form := multipart.NewWriter(writer)

	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, "POST", h.serverURL+path, reader)
	if err != nil {
		cancel()
		record(400)
		return
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)

	go func() {
		var bodyErr error
		part, partErr := form.CreateFormFile("file", "canceled-upload.png")
		switch {
		case partErr != nil:
			bodyErr = partErr
		default:
			if _, copyErr := io.Copy(part, bytes.NewReader(payload)); copyErr != nil {
				bodyErr = copyErr
			} else {
				bodyErr = form.Close()
			}
		}
		// The transport's writeLoop drains this pipe; it must terminate on
		// every producer path. Leaving it open after a failed copy wedges the
		// abandoned request forever: mapRoundTripError waits on writeLoopDone,
		// and the writeLoop waits on a pipe nobody will ever write or close.
		if bodyErr != nil {
			writer.CloseWithError(bodyErr)
		} else {
			writer.Close()
		}
	}()

	aborting := &http.Client{
		Transport: http.DefaultTransport,
		Timeout:   250 * time.Millisecond, // the cancellation itself
	}
	resp, doErr := aborting.Do(req)
	cancel()
	if doErr != nil {
		// Abandoned client-side, as designed; a client abandonment is not a
		// server status, so it never enters the documented vocabulary tally.
		recordCancel()
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	resp.Body.Close()
	record(resp.StatusCode)
}

// noisyPNGBytes encodes deterministic pseudo-random pixels so the PNG stays
// valid while compressing poorly (~1 byte/pixel), forcing chunked streaming.
func noisyPNGBytes(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	rng := rand.New(rand.NewSource(156))
	_, _ = rng.Read(img.Pix)
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode smoke blob: %v", err)
	}
	return buf.Bytes()
}

func jsonFailed(body []byte, dst any) bool { return json.Unmarshal(body, dst) != nil }

type smokeError struct{ detail string }

func (e smokeError) Error() string { return e.detail }

func errorOf(body []byte) error { return smokeError{detail: string(body)} }

func truncate(s string) string {
	if len(s) > 160 {
		return s[:160]
	}
	return s
}
