// Package kapon is the reviewed Kapon Cloud adapter (spec #150): V1 uses
// only the fixed domestic route and its OpenAI-style model catalog. The
// instance-level Connection Check is exactly one GET /v1/models with the
// candidate key — token validity plus visibility of the two allowlisted
// models — and never generates real media. Request IDs, raw error bodies,
// and the key itself never leave this package's error paths.
package kapon

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// DefaultBaseURL is the reviewed fixed domestic Kapon route; deployments do
// not choose endpoints per connection and there is no fallback route.
const DefaultBaseURL = "https://models.kapon.cloud"

// Allowlisted models (spec #150): image and video each have exactly one.
// The values live on the domain manifest so the catalog check and the
// published Capability Manifest can never drift apart.
const (
	ImageModel = domain.ImageModelID
	VideoModel = domain.VideoModelID
)

// checkTimeout bounds one catalog call; a timeout is a transient outcome,
// never a credential verdict.
const checkTimeout = 10 * time.Second

// The adapter speaks the domain's candidate verdicts directly so the
// application layer never imports this package's error vocabulary: a 401/403
// is the definitive candidate-invalid verdict; timeouts, transport
// failures, 429s, and temporary 5xx are transient and never rewrite
// persisted connection states.

// ModelsCheckClient performs the instance-level connection check against one
// base route.
type ModelsCheckClient struct {
	baseURL string
	http    *http.Client
}

// NewModelsCheckClient binds the client to a validated base URL.
func NewModelsCheckClient(baseURL string) *ModelsCheckClient {
	return &ModelsCheckClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		http:    &http.Client{Timeout: checkTimeout},
	}
}

// ValidateBaseURL enforces the route policy: https anywhere, or http only on
// a loopback host (the fake-Kapon test harnesses); everything else is a
// startup configuration error.
func ValidateBaseURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("kapon: base URL is not a URL: %w", err)
	}
	switch parsed.Scheme {
	case "https":
		if parsed.Host == "" {
			return fmt.Errorf("kapon: https base URL needs a host")
		}
		return nil
	case "http":
		hostname := parsed.Hostname()
		if hostname == "127.0.0.1" || hostname == "::1" || strings.EqualFold(hostname, "localhost") {
			return nil
		}
		return fmt.Errorf("kapon: http base URL is only allowed on a loopback host")
	default:
		return fmt.Errorf("kapon: base URL scheme must be https (http only on loopback)")
	}
}

// Check performs the single low-side-effect connection check. The candidate
// key exists only for the duration of this call; error surfaces carry no key
// material, request IDs, or raw provider bodies.
func (c *ModelsCheckClient) Check(ctx context.Context, candidateKey string) (domain.ProviderCheckResult, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/v1/models", nil)
	if err != nil {
		return domain.ProviderCheckResult{}, fmt.Errorf("kapon: build models request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+candidateKey)
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return domain.ProviderCheckResult{}, domain.ErrCheckTemporarilyUnavailable
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusOK:
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return domain.ProviderCheckResult{}, domain.ErrCandidateCredentialInvalid
	case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
		return domain.ProviderCheckResult{}, domain.ErrCheckTemporarilyUnavailable
	default:
		// Any other answer says nothing trustworthy about the credential;
		// treat it as transient rather than guessing a verdict.
		return domain.ProviderCheckResult{}, domain.ErrCheckTemporarilyUnavailable
	}

	var catalog struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(nil, resp.Body, 1<<20)).Decode(&catalog); err != nil {
		return domain.ProviderCheckResult{}, domain.ErrCheckTemporarilyUnavailable
	}
	visibility := domain.ProviderCheckResult{}
	for _, model := range catalog.Data {
		switch model.ID {
		case ImageModel:
			visibility.ImageAvailable = true
		case VideoModel:
			visibility.VideoAvailable = true
		}
	}
	return visibility, nil
}
