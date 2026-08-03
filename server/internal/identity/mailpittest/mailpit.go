// Package mailpittest is identity-module test support: a minimal client for
// the Mailpit HTTP API v1, used by integration tests to assert captured email.
// It must never be imported by production code.
package mailpittest

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client queries one Mailpit instance over its HTTP API.
type Client struct {
	baseURL string
	httpc   *http.Client
}

// NewClient returns a client for the Mailpit HTTP API at baseURL,
// e.g. http://127.0.0.1:54324.
func NewClient(baseURL string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		httpc:   &http.Client{Timeout: 10 * time.Second},
	}
}

// Address is a single RFC 5322 address in a captured message.
type Address struct {
	Name    string `json:"Name"`
	Address string `json:"Address"`
}

// MessageSummary is the subset of Mailpit's message summary that tests assert on.
type MessageSummary struct {
	ID      string    `json:"ID"`
	Subject string    `json:"Subject"`
	To      []Address `json:"To"`
}

// Message is the subset of Mailpit's message detail that tests assert on:
// Text carries the decoded plain-text body.
type Message struct {
	Subject string `json:"Subject"`
	Text    string `json:"Text"`
}

type searchResult struct {
	Messages []MessageSummary `json:"messages"`
}

// Message fetches the full detail of one captured message by ID, including
// its body text.
func (c *Client) Message(ctx context.Context, id string) (*Message, error) {
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
	var message Message
	if err := json.NewDecoder(resp.Body).Decode(&message); err != nil {
		return nil, fmt.Errorf("mailpit message %s: decode response: %w", id, err)
	}
	return &message, nil
}

// Search returns captured messages matching a Mailpit search query,
// e.g. `to:"user@example.test"`.
func (c *Client) Search(ctx context.Context, query string) ([]MessageSummary, error) {
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
	var result searchResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("mailpit search %q: decode response: %w", query, err)
	}
	return result.Messages, nil
}

// WaitForMessages polls Search until at least one message matches the query or
// ctx expires. It returns the matching messages from the last successful poll.
func (c *Client) WaitForMessages(ctx context.Context, query string) ([]MessageSummary, error) {
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
