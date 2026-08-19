// Test support for the captured mailbox: a minimal client for the Mailpit
// HTTP API v1, plus the docker stop/start controls and readiness probe the
// retry tests use to produce real SMTP failures. This file is test-only
// compilation-unit support; it must never be imported by production code
// (being _test.go, it cannot be).
package integrationtest

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/smtp"
	"net/url"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

// mailpitClient queries one Mailpit instance over its HTTP API.
type mailpitClient struct {
	baseURL string
	httpc   *http.Client
}

// newMailpitClient returns a client for the Mailpit HTTP API at baseURL,
// e.g. http://127.0.0.1:54324.
func newMailpitClient(baseURL string) *mailpitClient {
	return &mailpitClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		httpc:   &http.Client{Timeout: 10 * time.Second},
	}
}

// mailpitAddress is a single RFC 5322 address in a captured message.
type mailpitAddress struct {
	Name    string `json:"Name"`
	Address string `json:"Address"`
}

// mailpitMessageSummary is the subset of Mailpit's message summary that tests assert on.
type mailpitMessageSummary struct {
	ID      string           `json:"ID"`
	Subject string           `json:"Subject"`
	To      []mailpitAddress `json:"To"`
}

// mailpitMessage is the subset of Mailpit's message detail that tests assert
// on: Text carries the decoded plain-text body.
type mailpitMessage struct {
	Subject string `json:"Subject"`
	Text    string `json:"Text"`
}

type mailpitSearchResult struct {
	Messages []mailpitMessageSummary `json:"messages"`
}

// Message fetches the full detail of one captured message by ID, including
// its body text.
func (c *mailpitClient) Message(ctx context.Context, id string) (*mailpitMessage, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/api/v1/message/"+id, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.httpc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("mailpit message %s: unexpected status %s", id, resp.Status)
	}
	var message mailpitMessage
	if err := json.NewDecoder(resp.Body).Decode(&message); err != nil {
		return nil, fmt.Errorf("mailpit message %s: decode response: %w", id, err)
	}
	return &message, nil
}

// Search returns captured messages matching a Mailpit search query,
// e.g. `to:"user@example.test"`.
func (c *mailpitClient) Search(ctx context.Context, query string) ([]mailpitMessageSummary, error) {
	endpoint := c.baseURL + "/api/v1/search?query=" + url.QueryEscape(query)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.httpc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("mailpit search %q: unexpected status %s", query, resp.Status)
	}
	var result mailpitSearchResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("mailpit search %q: decode response: %w", query, err)
	}
	return result.Messages, nil
}

// WaitForMessages polls Search until at least one message matches the query or
// ctx expires. It returns the matching messages from the last successful poll.
func (c *mailpitClient) WaitForMessages(ctx context.Context, query string) ([]mailpitMessageSummary, error) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		messages, err := c.Search(ctx, query)
		if err == nil && len(messages) > 0 {
			return messages, nil
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("mailpit: no message matched %q before deadline: %w (last error: %v)", query, ctx.Err(), err)
		case <-ticker.C:
		}
	}
}

// stopMailpit makes the captured mailbox unavailable, producing real SMTP
// failures for the worker; startMailpit restores it. Both go through the
// docker CLI — the same availability operator CI has, no test doubles.
func stopMailpit(t *testing.T, ctx context.Context, container string) {
	t.Helper()
	runDocker(t, ctx, "stop", container)
	// Return Mailpit to the stack even if the test fails midway, so later
	// tests in the same run are unaffected. docker start is idempotent here.
	t.Cleanup(func() { _ = exec.Command("docker", "start", container).Run() })
}

func startMailpit(t *testing.T, ctx context.Context, container string) {
	t.Helper()
	runDocker(t, ctx, "start", container)
}

func runDocker(t *testing.T, ctx context.Context, args ...string) {
	t.Helper()
	out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v: %s", strings.Join(args, " "), err, out)
	}
}

// waitMailpitUp waits until both the Mailpit HTTP API and host SMTP mapping are
// reachable again. A restored API alone is not enough for the Outbox Worker.
func (h *harness) waitMailpitUp(t *testing.T, ctx context.Context) {
	t.Helper()
	httpEndpoint := strings.TrimRight(h.mailpitURL, "/") + "/api/v1/search"
	smtpEndpoint := net.JoinHostPort(h.cfg.SMTP.Host, strconv.Itoa(h.cfg.SMTP.Port))
	var httpErr error
	var smtpErr error
	for {
		httpCtx, cancelHTTP := context.WithTimeout(ctx, time.Second)
		_, httpErr = h.mailpit.Search(httpCtx, `to:"mailpit-probe@nevix.test"`)
		cancelHTTP()

		smtpCtx, cancelSMTP := context.WithTimeout(ctx, time.Second)
		var conn net.Conn
		conn, smtpErr = (&net.Dialer{}).DialContext(smtpCtx, "tcp", smtpEndpoint)
		if smtpErr == nil {
			smtpErr = conn.SetDeadline(time.Now().Add(time.Second))
		}
		if smtpErr == nil {
			var smtpClient *smtp.Client
			smtpClient, smtpErr = smtp.NewClient(conn, h.cfg.SMTP.Host)
			if smtpClient != nil {
				_ = smtpClient.Close()
			}
		}
		if conn != nil {
			_ = conn.Close()
		}
		cancelSMTP()

		if httpErr == nil && smtpErr == nil {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("Mailpit did not come back before deadline: HTTP API %s: %v; SMTP %s: %v; deadline: %v",
				httpEndpoint, httpErr, smtpEndpoint, smtpErr, ctx.Err())
		case <-time.After(500 * time.Millisecond):
		}
	}
}
