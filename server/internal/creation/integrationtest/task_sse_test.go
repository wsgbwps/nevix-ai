package integrationtest

import (
	"bufio"
	"net/http"
	"strings"
	"testing"
	"time"
)

// SSE invalidation (issue #159): persistence commits before the invalidation
// publishes, streams are creator-scoped, and the payload carries no private
// content — only the fact that the owner's creation state changed.

// openEventStream opens the creator's SSE stream and returns a line reader.
func (h *harness) openEventStream(t *testing.T, token string) *bufio.Reader {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, h.serverURL+"/creation/events", nil)
	if err != nil {
		t.Fatalf("build sse request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "text/event-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("open sse stream: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("sse must answer 200, got %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("sse content type wrong: %s", ct)
	}
	return bufio.NewReader(resp.Body)
}

// sseLine is one stream line event: either a comment/heartbeat or an
// invalidation block.
type sseLine struct {
	invalidation bool
	data         string
}

// readStreamLines pumps reader lines into the channel until the reader dies.
func readStreamLines(reader *bufio.Reader, out chan<- sseLine) {
	pendingEvent := false
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			close(out)
			return
		}
		line = strings.TrimRight(line, "\n")
		switch {
		case strings.HasPrefix(line, "event: creation-invalidation"):
			pendingEvent = true
		case strings.HasPrefix(line, "data:"):
			out <- sseLine{invalidation: pendingEvent, data: strings.TrimSpace(strings.TrimPrefix(line, "data:"))}
			pendingEvent = false
		case line == "" && pendingEvent:
			out <- sseLine{invalidation: true}
			pendingEvent = false
		default:
			// heartbeat comments and unknown lines are ignored
		}
	}
}

// awaitInvalidation blocks until one invalidation block arrives or the
// window closes. It fails the test when a data payload is non-empty: the
// contract carries no private content.
func awaitInvalidation(t *testing.T, lines <-chan sseLine, window time.Duration) bool {
	t.Helper()
	timer := time.NewTimer(window)
	defer timer.Stop()
	for {
		select {
		case line, ok := <-lines:
			if !ok {
				return false
			}
			if line.data != "" && line.data != "{}" {
				t.Fatalf("invalidation payloads carry no private content, got %q", line.data)
			}
			if line.invalidation {
				return true
			}
		case <-timer.C:
			return false
		}
	}
}

// TestSSEInvalidationIsCommitScopedAndCreatorScoped: a submission's
// invalidation reaches only the owning creator's stream, other creators'
// streams stay silent, and every payload is empty by contract.
func TestSSEInvalidationIsCommitScopedAndCreatorScoped(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	creatorToken := h.loginToken(t, creator, harnessPassword)
	otherToken := h.loginToken(t, otherCreatorEmail, harnessPassword)

	ownerLines := make(chan sseLine, 32)
	otherLines := make(chan sseLine, 32)
	// Open both streams on the test goroutine (the helper asserts); only the
	// line pumps run on their own goroutines.
	ownerReader := h.openEventStream(t, creatorToken)
	otherReader := h.openEventStream(t, otherToken)
	go readStreamLines(ownerReader, ownerLines)
	go readStreamLines(otherReader, otherLines)

	draft := h.imageTaskIntent(t, creatorToken, "SSE 通知", 1)
	status, body := h.submitTask(t, creatorToken, "sse-1", draft)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}

	// The owner receives exactly the post-commit invalidation.
	if !awaitInvalidation(t, ownerLines, 10*time.Second) {
		t.Fatal("the owning creator must receive the invalidation after commit")
	}

	// The other creator's stream stays silent through the owner's events.
	if awaitInvalidation(t, otherLines, 1500*time.Millisecond) {
		t.Fatal("another creator's stream must not receive the owner's invalidation")
	}

	// And it still works for its own submissions — proving the stream was
	// live the whole time rather than silently dead.
	otherDraft := h.imageTaskIntent(t, otherToken, "他人流", 1)
	status, body = h.submitTask(t, otherToken, "sse-2", otherDraft)
	if status != http.StatusCreated {
		t.Fatalf("other submit: %d %s", status, body)
	}
	if !awaitInvalidation(t, otherLines, 10*time.Second) {
		t.Fatal("the other creator's own submission must invalidate their stream")
	}
}
