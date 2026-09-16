package creation

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCORSExposesAssetChecksumHeader(t *testing.T) {
	handler := corsMiddleware([]string{"https://app.nevix.test"}, nil)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/creation/assets/asset-one/content", nil)
	req.Header.Set("Origin", "https://app.nevix.test")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Expose-Headers"); !strings.Contains(got, "X-Content-SHA-256") {
		t.Fatalf("Expose-Headers %q, want X-Content-SHA-256 so the browser can verify asset bytes", got)
	}
}
