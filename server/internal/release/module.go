package release

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"time"

	"fmt"

	"github.com/go-chi/chi/v5"
	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/event"
)

const officialManifestURL = "https://cnb.cool/nevix.ai/nevix-releases/-/git/raw/main/stable/linux-amd64.json"

type candidate struct {
	Version           string `json:"version"`
	MinServerVersion  string `json:"min_server_version"`
	MinDesktopVersion string `json:"min_desktop_version"`
	Compatible        bool   `json:"compatible"`
}

type releaseStatus struct {
	Version           string     `json:"version"`
	MinDesktopVersion string     `json:"min_desktop_version"`
	Outcome           string     `json:"outcome"`
	CheckedAt         *time.Time `json:"checked_at"`
	Candidate         *candidate `json:"candidate"`
}

// Module detects signed releases; it never obtains installation authority.
type Module struct {
	guard     *authz.Guard
	origins   []string
	client    *http.Client
	publicKey string
	checks    chan struct{}
	mu        sync.Mutex
	status    releaseStatus
}

func NewModule(sessions authz.SessionAuthenticator, cfg Config) (*Module, error) {
	if err := validateBuildIdentity(); err != nil {
		return nil, fmt.Errorf("release: invalid compiled identity: %w", err)
	}
	return &Module{
		guard: authz.NewGuard(sessions), origins: append([]string(nil), cfg.CORSAllowedOrigins...), publicKey: PublicKeyPEM,
		client: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		checks: make(chan struct{}, 1),
		status: releaseStatus{Version: Version, MinDesktopVersion: MinDesktopVersion, Outcome: "not-checked"},
	}, nil
}

type route struct {
	method, path string
	handler      http.HandlerFunc
	admin        bool
}

// routes is the owner for command registration, preflight and allowed methods.
func (m *Module) routes() []route {
	return []route{
		{http.MethodGet, "/release/version", m.writeVersion, false},
		{http.MethodGet, "/release/status", func(w http.ResponseWriter, r *http.Request) { m.writeStatus(w, m.snapshot()) }, true},
		{http.MethodPost, "/release/check", func(w http.ResponseWriter, r *http.Request) { m.writeStatus(w, m.check(r.Context())) }, true},
	}
}

func (m *Module) Register(r chi.Router, _ event.Bus) {
	routes := m.routes()
	methods := make(map[string]string, len(routes))
	for _, route := range routes {
		methods[route.path] = route.method
	}
	r.Use(m.cors(methods))
	for _, route := range routes {
		commandRouter := r
		if route.admin {
			commandRouter = r.With(m.guard.RequireAdmin, rejectPendingPasswordChange)
		}
		commandRouter.MethodFunc(route.method, route.path, route.handler)
		r.Options(route.path, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	}
}

func rejectPendingPasswordChange(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if principal, ok := authz.PrincipalFrom(r.Context()); ok && principal.MustChangePassword {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_ = json.NewEncoder(w).Encode(struct {
				Error   string `json:"error"`
				Message string `json:"message"`
			}{"password_change_required", "The initial password must be changed before using this command."})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RunWorkers retries at startup and daily. Source failure only changes the Admin result.
func (m *Module) RunWorkers(ctx context.Context) error {
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for {
		m.check(ctx)
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func (m *Module) check(ctx context.Context) releaseStatus {
	select {
	case m.checks <- struct{}{}:
		defer func() { <-m.checks }()
	case <-ctx.Done():
		return m.snapshot()
	}
	now := time.Now().UTC()
	previous := m.snapshot()
	result := releaseStatus{Version: previous.Version, MinDesktopVersion: previous.MinDesktopVersion, Outcome: "network-failure", CheckedAt: &now}
	switch {
	case m.publicKey == "":
		result.Outcome = "trust-unconfigured"
	case !validRunningVersion(result.Version):
		result.Outcome = "unknown-version"
	default:
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, officialManifestURL, nil)
		if err == nil {
			response, err := m.client.Do(request)
			if err == nil {
				body, readErr := io.ReadAll(io.LimitReader(response.Body, 64*1024+1))
				response.Body.Close()
				if response.StatusCode == http.StatusOK && readErr == nil && len(body) <= 64*1024 {
					manifest, verifyErr := Verify(body, m.publicKey, "linux", "amd64")
					result.Outcome = "invalid-release"
					if verifyErr == nil {
						newer, _ := CompareVersions(manifest.Version, result.Version)
						result.Outcome = "current"
						if newer > 0 {
							compatible, _ := CompareVersions(result.Version, manifest.MinServerVersion)
							result.Candidate = &candidate{manifest.Version, manifest.MinServerVersion, manifest.MinDesktopVersion, compatible >= 0}
							result.Outcome = "available"
							if compatible < 0 {
								result.Outcome = "incompatible"
							}
						}
					}
				}
			}
		}
	}
	m.mu.Lock()
	m.status = result
	m.mu.Unlock()
	return result
}

func validRunningVersion(version string) bool {
	_, err := CompareVersions(version, "0.0.0")
	return err == nil
}

func (m *Module) snapshot() releaseStatus { m.mu.Lock(); defer m.mu.Unlock(); return m.status }

func (m *Module) writeStatus(w http.ResponseWriter, status releaseStatus) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(status)
}

func (m *Module) cors(methods map[string]string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			for _, allowed := range m.origins {
				if origin != "" && origin == allowed {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Add("Vary", "Origin")
					w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
					method := methods[r.URL.Path]
					w.Header().Set("Access-Control-Allow-Methods", method+", OPTIONS")
					break
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}
