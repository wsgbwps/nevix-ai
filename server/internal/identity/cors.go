// CORS enforcement for the Module's HTTP surface: the Desktop renderer calls
// the trusted commands directly from the web platform, so every browser
// request carries an Origin that must match the per-environment whitelist.
// Requests without an Origin are non-browser traffic and pass untouched; the
// whitelist is echoed exactly and never collapsed into a wildcard. The
// Allow-Methods value of a preflight derives from the route table, never a
// hardcoded list.
package identity

import (
	"net/http"

	"github.com/nevix-ai/server/internal/identity/command"
)

// corsMiddleware builds the CORS gate from the environment whitelist and the
// route table's per-path methods. An origin outside the whitelist receives no
// CORS headers at all — the browser enforces the denial — while whitelisted
// preflights are answered directly.
func corsMiddleware(allowedOrigins []string, methodsByPath map[string][]string) func(http.Handler) http.Handler {
	allowed := make(map[string]struct{}, len(allowedOrigins))
	for _, origin := range allowedOrigins {
		allowed[origin] = struct{}{}
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin == "" {
				next.ServeHTTP(w, r)
				return
			}
			if _, ok := allowed[origin]; !ok {
				next.ServeHTTP(w, r)
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
			if r.Method == http.MethodOptions {
				path := r.Pattern
				if path == "" {
					path = r.URL.Path
				}
				w.Header().Set("Access-Control-Allow-Methods", command.AllowMethods(methodsByPath, path))
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
