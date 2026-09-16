// Package kapon implements the Kapon Cloud provider adapter.
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

// DefaultBaseURL is used when KAPON_BASE_URL is unset.
const DefaultBaseURL = "https://models.kapon.cloud"

const (
	ImageModel = domain.ImageModelID
	VideoModel = domain.VideoModelID
)

const checkTimeout = 10 * time.Second

// ModelsCheckClient checks model visibility with a candidate credential.
type ModelsCheckClient struct {
	baseURL string
	http    *http.Client
}

func NewModelsCheckClient(baseURL string) *ModelsCheckClient {
	return &ModelsCheckClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		http:    &http.Client{Timeout: checkTimeout},
	}
}

// ValidateBaseURL permits the two provider origins and loopback test servers.
func ValidateBaseURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("kapon: base URL is not a URL: %w", err)
	}
	if parsed.User != nil || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("kapon: base URL must be an origin without credentials, path, query, or fragment")
	}
	switch parsed.Scheme {
	case "https":
		hostname := strings.ToLower(parsed.Hostname())
		if parsed.Port() == "" && (hostname == "models.kapon.cloud" || hostname == "svip.kapon.cloud") {
			return nil
		}
		return fmt.Errorf("kapon: https base URL must use models.kapon.cloud or svip.kapon.cloud")
	case "http":
		hostname := parsed.Hostname()
		if parsed.Host != "" && (hostname == "127.0.0.1" || hostname == "::1" || strings.EqualFold(hostname, "localhost")) {
			return nil
		}
		return fmt.Errorf("kapon: http base URL is only allowed on a loopback host")
	default:
		return fmt.Errorf("kapon: base URL scheme must be https (http only on loopback)")
	}
}

// Check returns the image and video models visible to a candidate credential.
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
		// Other statuses do not prove that the candidate credential is invalid.
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
