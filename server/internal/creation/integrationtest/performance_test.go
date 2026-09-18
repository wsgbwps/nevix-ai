package integrationtest

import (
	"fmt"
	"net/http"
	"sort"
	"testing"
	"time"
)

func TestNonFileAPILatencyP95(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	token := h.loginToken(t, creatorEmail, harnessPassword)
	adminToken := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	for i := 0; i < 100; i++ {
		status, body := h.doRequest(t, http.MethodPost, "/creation/sessions", token, map[string]any{"name": fmt.Sprintf("latency-%03d", i)})
		if status != http.StatusCreated {
			t.Fatalf("seed session %d: %d %s", i, status, body)
		}
	}

	checks := []struct {
		path  string
		token string
	}{
		{"/creation/sessions?limit=30", token},
		{"/creation/assets?limit=30", token},
		{"/creation/inspiration?limit=30", adminToken},
	}
	durations := make([]float64, 0, len(checks)*20)
	for i := 0; i < 20; i++ {
		for _, check := range checks {
			start := time.Now()
			status, body := h.doRequest(t, http.MethodGet, check.path, check.token, nil)
			durations = append(durations, time.Since(start).Seconds())
			if status != http.StatusOK {
				t.Fatalf("GET %s: %d %s", check.path, status, body)
			}
		}
	}
	sort.Float64s(durations)
	p95 := durations[int(float64(len(durations))*0.95)-1]
	if p95 > 0.5 {
		t.Fatalf("non-file API p95 = %.3fs exceeds the 500ms budget", p95)
	}
}
