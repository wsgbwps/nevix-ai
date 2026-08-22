// Guard vocabulary tests over a fake authenticator: the two route guards,
// their error envelopes, and the context principal. Real session
// authentication against PostgreSQL is proven by the identity integrationtest
// suite.
package authz

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

type fakeAuthenticator struct {
	principal Principal
	err       error
}

func (f fakeAuthenticator) Authenticate(*http.Request) (Principal, error) {
	return f.principal, f.err
}

func guardHandler(records *[]Principal) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		principal, ok := PrincipalFrom(r.Context())
		if !ok {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		*records = append(*records, principal)
		w.WriteHeader(http.StatusOK)
	}
}

func doGuarded(t *testing.T, guard func(http.Handler) http.Handler, authenticator fakeAuthenticator) (*httptest.ResponseRecorder, *[]Principal) {
	t.Helper()
	principals := &[]Principal{}
	rec := httptest.NewRecorder()
	guard(guardHandler(principals)).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/identity/users/me", nil))
	return rec, principals
}

func envelope(t *testing.T, rec *httptest.ResponseRecorder) map[string]string {
	t.Helper()
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %q is not the error envelope: %v", rec.Body.String(), err)
	}
	return body
}

func TestRequireActiveUserRejectsUnauthenticatedRequests(t *testing.T) {
	for name, authenticator := range map[string]fakeAuthenticator{
		"authentication error": {err: ErrNotAuthenticated},
		"wrapped error":        {err: errors.Join(ErrNotAuthenticated, errors.New("db"))},
	} {
		rec, principals := doGuarded(t, NewGuard(authenticator).RequireActiveUser, authenticator)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s: status %d, want 401", name, rec.Code)
		}
		body := envelope(t, rec)
		if body["error"] != "unauthorized" {
			t.Fatalf("%s: envelope %v, want unauthorized", name, body)
		}
		if len(*principals) != 0 {
			t.Fatalf("%s: handler ran without an authenticated principal", name)
		}
	}
}
func TestRequireActiveUserAnswersInfraErrorsWith500(t *testing.T) {
	authenticator := fakeAuthenticator{err: errors.New("connection refused")}
	rec, principals := doGuarded(t, NewGuard(authenticator).RequireActiveUser, authenticator)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500 (infrastructure failure must not masquerade as 401)", rec.Code)
	}
	if body := envelope(t, rec); body["error"] != "internal_error" {
		t.Fatalf("envelope %v, want internal_error", body)
	}
	if len(*principals) != 0 {
		t.Fatal("handler ran despite an infrastructure failure")
	}
}

func TestRequireActiveUserPassesPrincipalThroughContext(t *testing.T) {
	authenticator := fakeAuthenticator{principal: Principal{UserID: "u1", Email: "a@b.c", Role: "member"}}
	rec, principals := doGuarded(t, NewGuard(authenticator).RequireActiveUser, authenticator)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200", rec.Code)
	}
	if len(*principals) != 1 || (*principals)[0].UserID != "u1" {
		t.Fatalf("handler observed principals %v, want the authenticated user", *principals)
	}
}

func TestRequireAdminAllowsOnlyAdminRole(t *testing.T) {
	member := fakeAuthenticator{principal: Principal{UserID: "u1", Role: "member"}}
	rec, principals := doGuarded(t, NewGuard(member).RequireAdmin, member)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("member on admin route: status %d, want 403", rec.Code)
	}
	if body := envelope(t, rec); body["error"] != "forbidden" {
		t.Fatalf("member on admin route: envelope %v, want forbidden", body)
	}
	if len(*principals) != 0 {
		t.Fatal("member reached an admin handler")
	}

	admin := fakeAuthenticator{principal: Principal{UserID: "u2", Role: "admin"}}
	rec, principals = doGuarded(t, NewGuard(admin).RequireAdmin, admin)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin on admin route: status %d, want 200", rec.Code)
	}
	if len(*principals) != 1 {
		t.Fatal("admin principal did not reach the handler")
	}
}

func TestRequireAdminRejectsUnauthenticatedRequests(t *testing.T) {
	authenticator := fakeAuthenticator{err: ErrNotAuthenticated}
	rec, principals := doGuarded(t, NewGuard(authenticator).RequireAdmin, authenticator)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401 (not 403: authentication precedes role)", rec.Code)
	}
	if len(*principals) != 0 {
		t.Fatal("unauthenticated request reached an admin handler")
	}
}

func TestPrincipalFromReturnsFalseWithoutGuard(t *testing.T) {
	if _, ok := PrincipalFrom(context.Background()); ok {
		t.Fatal("PrincipalFrom returned a principal for a context the guard never populated")
	}
}
