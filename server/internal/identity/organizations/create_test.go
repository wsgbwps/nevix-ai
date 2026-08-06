// Unit tests for the CreateOrganization command's request validation: these
// paths reject before touching the database, so no pool is needed. The
// idempotency and atomicity behavior is covered by the integration suite.
package organizations_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/nevix-ai/server/internal/identity/organizations"
)

func postCreate(creator *organizations.Creator, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/identity/organizations", strings.NewReader(body))
	rec := httptest.NewRecorder()
	creator.ServeHTTP(rec, req)
	return rec
}

func envelopeOf(t *testing.T, rec *httptest.ResponseRecorder) (string, string) {
	t.Helper()
	var envelope struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("response body is not the error envelope: %v", err)
	}
	return envelope.Error, envelope.Message
}

func TestCreateOrganizationRejectsInvalidRequests(t *testing.T) {
	creator := organizations.NewCreator(nil)

	cases := []struct {
		name      string
		body      string
		wantError string
	}{
		{"not json", "{", "invalid_request"},
		{"missing id", `{"name":"Acme"}`, "invalid_request"},
		{"missing name", `{"id":"11111111-2222-3333-4444-555555555555"}`, "invalid_request"},
		{"id not a uuid", `{"id":"not-a-uuid","name":"Acme"}`, "invalid_organization_id"},
		{"blank name", `{"id":"11111111-2222-3333-4444-555555555555","name":"   "}`, "invalid_organization_name"},
	}
	for _, tc := range cases {
		rec := postCreate(creator, tc.body)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: status %d, want 400", tc.name, rec.Code)
		}
		errCode, message := envelopeOf(t, rec)
		if errCode != tc.wantError || message == "" {
			t.Fatalf("%s: envelope (%q, %q), want error %q with a message", tc.name, errCode, message, tc.wantError)
		}
	}
}
