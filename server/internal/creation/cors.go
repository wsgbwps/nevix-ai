// CORS enforcement on the Module's own group: an Origin must match the per-environment whitelist
// exactly, non-browser traffic passes untouched, and preflights derive Allow-Methods from the route
// table. Mirroring Identity's gate is deliberate (AGENTS.md).
package creation

import (
	"net/http"

	creationhttp "github.com/nevix-ai/server/internal/creation/interface/http"
)

// corsMiddleware builds the gate from the environment whitelist.
func corsMiddleware(allowedOrigins []string, methodsByPath map[string][]string) func(http.Handler) http.Handler {
	allowed := make(map[string]struct{}, len(allowedOrigins))
	for _, origin := range allowedOrigins {
		allowed[origin] = struct{}{}
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if _, ok := allowed[origin]; !ok || origin == "" {
				next.ServeHTTP(w, r)
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Expose-Headers", "X-Content-SHA-256")
			w.Header().Add("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			if r.Method == http.MethodOptions {
				path := r.Pattern
				if path == "" {
					path = r.URL.Path
				}
				w.Header().Set("Access-Control-Allow-Methods", creationhttp.AllowMethods(methodsByPath, path))
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
