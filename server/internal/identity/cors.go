// CORS enforcement for the Module's HTTP surface: the Desktop renderer calls
// the trusted commands directly from the web platform, so every browser
// request carries an Origin that must match the per-environment whitelist.
// Requests without an Origin are non-browser traffic and pass untouched; the
// whitelist is echoed exactly and never collapsed into a wildcard.
package identity

import "net/http"

// corsMiddleware builds the CORS gate from the environment whitelist. An
// origin outside the whitelist receives no CORS headers at all — the browser
// enforces the denial — while whitelisted preflights are answered directly.
func corsMiddleware(allowedOrigins []string) func(http.Handler) http.Handler {
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
				w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
