package writetx

import (
	"errors"
	"strings"
	"testing"
)

// The identity decision must reject every role combination other than
// session_user == current_user == identity_app, so each observed role is
// checked independently and the sentinel stays distinguishable from other
// transaction failures. Real PostgreSQL roles prove the same decision at the
// runner seam in runner_roles_integration_test.go and at the Module seam in
// integrationtest (startup_identity_test.go).
func TestUnexpectedIdentityError(t *testing.T) {
	const role = identityAppRole
	for name, tc := range map[string]struct {
		sessionUser, currentUser string
		wantMismatch             bool
	}{
		"direct identity_app login":          {role, role, false},
		"owner authentication":               {"postgres", "postgres", true},
		"assumed role keeps authentication":  {"postgres", role, true},
		"execution role drifts from session": {role, "postgres", true},
	} {
		err := unexpectedIdentityError(tc.sessionUser, tc.currentUser)
		if tc.wantMismatch {
			if err == nil {
				t.Fatalf("%s: accepted session_user=%q current_user=%q", name, tc.sessionUser, tc.currentUser)
			}
			if !errors.Is(err, ErrUnexpectedDatabaseIdentity) {
				t.Fatalf("%s: error %v does not wrap ErrUnexpectedDatabaseIdentity", name, err)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: rejected the direct login: %v", name, err)
		}
	}

	// The operator-facing failure names the expected role and both observed
	// roles, and never carries a connection string or credential.
	err := unexpectedIdentityError("postgres", "identity_app")
	if err == nil {
		t.Fatal("assumed-role combination was accepted")
	}
	for _, want := range []string{"identity_app", "session_user=postgres", "current_user=identity_app"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q omits %q", err, want)
		}
	}
}
