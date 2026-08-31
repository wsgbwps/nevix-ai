package integrationtest

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// fakeKapon stands in for the reviewed Kapon route in automated tests: it
// answers GET /v1/models for accepted bearer keys and can be scripted per
// scenario (token rejection, partial model visibility, temporary upstream
// pressure). No production token ever appears — only locally minted
// fixtures (spec #150: automation never uses production credentials).
type fakeKapon struct {
	server *httptest.Server

	generation *generationFake

	mu           sync.Mutex
	acceptedKeys map[string]bool
	forcedStatus int // 0 = normal catalog behavior
	imageModel   bool
	videoModel   bool
	requests     int
	lastBearer   string
}

func newFakeKapon(t *testing.T) *fakeKapon {
	fake := &fakeKapon{
		acceptedKeys: map[string]bool{},
		imageModel:   true,
		videoModel:   true,
		generation:   newGenerationFake(pngBytes(t), jpegBytes(t), mp4Fixture()),
	}
	fake.server = httptest.NewServer(http.HandlerFunc(fake.serve))
	t.Cleanup(fake.server.Close)
	return fake
}

// URL reports the fake route the Creation Module is configured with.
func (f *fakeKapon) URL() string { return f.server.URL }

// acceptKey admits one candidate key to the catalog.
func (f *fakeKapon) acceptKey(key string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.acceptedKeys[key] = true
}

// rejectAllKeys drops every previously accepted key (the stored credential
// became invalid).
func (f *fakeKapon) rejectAllKeys() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.acceptedKeys = map[string]bool{}
}

// forceStatus makes every response carry one HTTP status (0 restores the
// catalog).
func (f *fakeKapon) forceStatus(status int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.forcedStatus = status
}

// setModels toggles each allowlisted model's visibility.
func (f *fakeKapon) setModels(image, video bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.imageModel = image
	f.videoModel = video
}

func (f *fakeKapon) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	accepted := f.acceptedKeys
	forcedStatus := f.forcedStatus
	imageModel, videoModel := f.imageModel, f.videoModel
	f.requests++
	bearer := r.Header.Get("Authorization")
	f.lastBearer = bearer
	f.mu.Unlock()

	if r.URL.Path != "/v1/models" || r.Method != http.MethodGet {
		if !f.generation.serveGeneration(w, r) {
			w.WriteHeader(http.StatusNotFound)
		}
		return
	}
	if forcedStatus != 0 {
		w.WriteHeader(forcedStatus)
		return
	}
	if len(bearer) <= len("Bearer ") || !accepted[bearer[len("Bearer "):]] {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(catalogBody(imageModel, videoModel)))
}

func catalogBody(imageModel, videoModel bool) string {
	models := ""
	add := func(id string) {
		if models != "" {
			models += ","
		}
		models += `{"id":"` + id + `"}`
	}
	if imageModel {
		add("doubao-seedream-5.0-lite")
	}
	if videoModel {
		add("doubao-seedance-2-5")
	}
	return `{"object":"list","data":[` + models + `]}`
}

// requestCount reports how many catalog calls arrived.
func (f *fakeKapon) requestCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.requests
}
