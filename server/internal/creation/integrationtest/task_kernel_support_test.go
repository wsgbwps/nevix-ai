package integrationtest

import (
	"net/http"
	"strings"
	"sync"
)

// Generation-side scripting for the fake Kapon route (issue #159): the
// models catalog stays in fake_kapon_test.go; this file adds the image
// generation call, the async video task family, and the provider output
// fixtures. All bytes are locally synthesized fixtures — no production
// token, request id, or payload is ever involved.

// imageScript is one scripted synchronous image generation answer.
type imageScript struct {
	status  int    // forced HTTP status (0 = answer normally)
	outputs int    // number of output URLs returned when status == 0
	abort   bool   // drop the connection mid-response (outcome unknown)
	code    string // error code for policy rejections (400 answers)
}

// videoTaskScript drives the async video task family.
type videoTaskScript struct {
	status       int    // forced HTTP status on create/poll (0 = normal)
	failAfter    int    // polls before the task fails with the given code
	failCode     string // provider error code ("content_policy" → input policy)
	timeoutAfter int    // polls before the task reports authoritative expiry
	succeedAfter int    // polls before the task succeeds (default 1)
	cancelOK     bool   // cancel requests succeed
	requests     int    // observed create calls
	polls        int    // observed poll calls
}

type generationFake struct {
	mu        sync.Mutex
	servedPNG []byte
	servedMP4 []byte
	image     imageScript
	video     videoTaskScript
	nextID    int
	outputReq int
}

func newGenerationFake(png, mp4 []byte) *generationFake {
	return &generationFake{servedPNG: png, servedMP4: mp4, video: videoTaskScript{succeedAfter: 1}}
}

func (g *generationFake) setImage(script imageScript) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.image = script
}

func (g *generationFake) setVideo(script videoTaskScript) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.video = script
}

func (g *generationFake) imageRequests() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.outputReq
}

func (g *generationFake) videoRequests() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.video.requests
}

// serveGeneration answers the generation endpoints on the same fake server
// as the catalog. The bearer has already been validated by catalog rules in
// most scenarios; generation endpoints re-check it is present.
func (g *generationFake) serveGeneration(w http.ResponseWriter, r *http.Request) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/v1/images/generations":
		g.outputReq++
		script := g.image
		if script.status != 0 {
			w.WriteHeader(script.status)
			if script.code != "" {
				w.Write([]byte(`{"error":{"code":"` + script.code + `","message":"rejected"}}`))
			}
			return true
		}
		if script.abort {
			// Drop the connection without an HTTP answer: from the client's
			// side the outcome is unknowable.
			panic(http.ErrAbortHandler)
		}
		urls := make([]string, 0, script.outputs)
		for i := 0; i < script.outputs; i++ {
			urls = append(urls, "http://"+r.Host+"/provider-outputs/image/"+itoaFixture(i))
		}
		body := `{"created":0,"data":[`
		for i, u := range urls {
			if i > 0 {
				body += ","
			}
			body += `{"url":"` + u + `"}`
		}
		body += `]}`
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(body))
		return true

	case r.Method == http.MethodPost && r.URL.Path == "/v1/contents/generations/tasks":
		script := g.video
		script.requests++
		g.video.requests++
		if script.status != 0 {
			w.WriteHeader(script.status)
			return true
		}
		g.nextID++
		id := "cgtask-" + itoaFixture(g.nextID)
		g.video.succeedAfter--
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"` + id + `"}`))
		return true

	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/contents/generations/tasks/"):
		script := g.video
		script.polls++
		g.video.requests++
		if script.status != 0 {
			w.WriteHeader(script.status)
			return true
		}
		remaining := script.succeedAfter
		switch {
		case remaining > 0:
			g.video.succeedAfter--
			w.Write([]byte(`{"id":"t","status":"queued"}`))
		case script.timeoutAfter > 0 && script.polls > script.timeoutAfter:
			w.Write([]byte(`{"id":"t","status":"expired"}`))
		case script.failAfter > 0 && script.polls > script.failAfter:
			w.Write([]byte(`{"id":"t","status":"failed","error":{"code":"` + script.failCode + `","message":"x"}}`))
		default:
			w.Write([]byte(`{"id":"t","status":"succeeded","content":{"video_url":"http://` + r.Host + `/provider-outputs/video/0"}}`))
		}
		return true

	case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/v1/contents/generations/tasks/"):
		if g.video.cancelOK {
			w.Write([]byte(`{"id":"t","status":"cancelling"}`))
		} else {
			w.WriteHeader(http.StatusConflict)
		}
		return true

	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/provider-outputs/image/"):
		w.Header().Set("Content-Type", "image/png")
		w.Write(g.servedPNG)
		return true

	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/provider-outputs/video/"):
		w.Header().Set("Content-Type", "video/mp4")
		w.Write(g.servedMP4)
		return true
	}
	return false
}

func itoaFixture(value int) string {
	digits := "0123456789"
	if value == 0 {
		return "0"
	}
	out := ""
	for value > 0 {
		out = string(digits[value%10]) + out
		value /= 10
	}
	return out
}
