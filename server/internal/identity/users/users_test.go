// Unit tests for the governance request shapes (present fields, email and
// password policy, role enum, display-name bound) and the search-pattern
// escaping — everything checkable without a database.
package users

import (
	"errors"
	"strings"
	"testing"

	"github.com/nevix-ai/server/internal/identity/command"
)

func ptr(s string) *string { return &s }

func TestCreateRequestValidate(t *testing.T) {
	email := "member@nevix.test"
	password := "initial-pass-1"
	for name, tc := range map[string]struct {
		req      CreateRequest
		wantCode string
	}{
		"valid":              {CreateRequest{Email: ptr(email), InitialPassword: ptr(password)}, ""},
		"missing email":      {CreateRequest{InitialPassword: ptr(password)}, "invalid_request"},
		"missing password":   {CreateRequest{Email: ptr(email)}, "invalid_request"},
		"malformed email":    {CreateRequest{Email: ptr("Elio <elio@nevix.test>"), InitialPassword: ptr(password)}, "invalid_email"},
		"short password":     {CreateRequest{Email: ptr(email), InitialPassword: ptr("short")}, "password_too_short"},
		"empty password":     {CreateRequest{Email: ptr(email), InitialPassword: ptr("")}, "password_too_short"},
		"oversize name":      {CreateRequest{Email: ptr(email), InitialPassword: ptr(password), DisplayName: strings.Repeat("x", maxDisplayNameLength+1)}, "invalid_display_name"},
		"max-size name fine": {CreateRequest{Email: ptr(email), InitialPassword: ptr(password), DisplayName: strings.Repeat("x", maxDisplayNameLength)}, ""},
	} {
		got := tc.req.Validate()
		if tc.wantCode == "" {
			if got != nil {
				t.Fatalf("%s: unexpected error %+v", name, got)
			}
			continue
		}
		if got == nil || got.Code != tc.wantCode {
			t.Fatalf("%s: error = %+v, want code %s", name, got, tc.wantCode)
		}
		if got.Status != 400 {
			t.Fatalf("%s: status = %d, want 400", name, got.Status)
		}
	}
}

func TestResetPasswordRequestValidate(t *testing.T) {
	if got := (&ResetPasswordRequest{InitialPassword: ptr("replacement-1")}).Validate(); got != nil {
		t.Fatalf("valid reset: %+v", got)
	}
	for name, tc := range map[string]struct {
		req      ResetPasswordRequest
		wantCode string
	}{
		"missing field":  {ResetPasswordRequest{}, "invalid_request"},
		"short password": {ResetPasswordRequest{InitialPassword: ptr("short")}, "password_too_short"},
	} {
		if got := tc.req.Validate(); got == nil || got.Code != tc.wantCode {
			t.Fatalf("%s: error = %+v, want code %s", name, got, tc.wantCode)
		}
	}
}

func TestChangeEmailRequestValidate(t *testing.T) {
	if got := (&ChangeEmailRequest{Email: ptr("new@nevix.test")}).Validate(); got != nil {
		t.Fatalf("valid email change: %+v", got)
	}
	for name, tc := range map[string]struct {
		req      ChangeEmailRequest
		wantCode string
	}{
		"missing field":   {ChangeEmailRequest{}, "invalid_request"},
		"malformed email": {ChangeEmailRequest{Email: ptr("not an email")}, "invalid_email"},
	} {
		if got := tc.req.Validate(); got == nil || got.Code != tc.wantCode {
			t.Fatalf("%s: error = %+v, want code %s", name, got, tc.wantCode)
		}
	}
}

func TestChangeRoleRequestValidate(t *testing.T) {
	for _, role := range []string{"admin", "member"} {
		if got := (&ChangeRoleRequest{Role: ptr(role)}).Validate(); got != nil {
			t.Fatalf("role %s: %+v", role, got)
		}
	}
	for name, tc := range map[string]struct {
		req      ChangeRoleRequest
		wantCode string
	}{
		"missing field": {ChangeRoleRequest{}, "invalid_request"},
		"unknown role":  {ChangeRoleRequest{Role: ptr("owner")}, "invalid_role"},
		"empty role":    {ChangeRoleRequest{Role: ptr("")}, "invalid_role"},
	} {
		if got := tc.req.Validate(); got == nil || got.Code != tc.wantCode {
			t.Fatalf("%s: error = %+v, want code %s", name, got, tc.wantCode)
		}
	}
}

func TestMapErrorCoversTheDomainSentinels(t *testing.T) {
	for name, tc := range map[string]struct {
		err       error
		wantCode  string
		wantSatus int
	}{
		"user not found":       {errUserNotFound, "user_not_found", 404},
		"email taken":          {errEmailTaken, "email_taken", 409},
		"last admin protected": {errLastAdminProtected, "last_admin_protected", 409},
		"user has logged in":   {errUserHasLoggedIn, "user_has_logged_in", 409},
		"password too short":   {errPasswordTooShort, "password_too_short", 400},
		"bad pagination":       {command.ErrInvalidPagination, "invalid_pagination", 400},
		"bad search":           {command.ErrInvalidSearch, "invalid_search", 400},
		"unmapped noise":       {errBoom, "", 0},
	} {
		got := MapError(tc.err)
		if tc.wantCode == "" {
			if got != nil {
				t.Fatalf("%s: unexpected mapped error %+v", name, got)
			}
			continue
		}
		if got == nil || got.Code != tc.wantCode || got.Status != tc.wantSatus {
			t.Fatalf("%s: mapped = %+v, want %s/%d", name, got, tc.wantCode, tc.wantSatus)
		}
	}
}

var errBoom = errors.New("users: boom") // unmapped noise for the default path

func TestLikePatternEscapesWildcards(t *testing.T) {
	for name, tc := range map[string]struct {
		search string
		want   string
	}{
		"empty matches all": {"", "%"},
		"plain":             {"alice", "%alice%"},
		"percent escaped":   {"50%", "%50\\%%"},
		"underscore esc":    {"a_b", "%a\\_b%"},
		"backslash escaped": {"a\\b", "%a\\\\b%"},
		"all three":         {"%_\\", "%\\%\\_\\\\%"},
	} {
		if got := likePattern(tc.search); got != tc.want {
			t.Fatalf("%s: pattern = %q, want %q", name, got, tc.want)
		}
	}
}

func TestParseUserIDRejectsMalformedIDs(t *testing.T) {
	if _, err := parseUserID("not-a-uuid"); err == nil {
		t.Fatal("malformed id accepted")
	}
	if _, err := parseUserID("00000000-0000-0000-0000-000000000000"); err != nil {
		t.Fatalf("well-formed id rejected: %v", err)
	}
}

func TestLocalPartDerivation(t *testing.T) {
	if got := localPart("jane.doe@nevix.test"); got != "jane.doe" {
		t.Fatalf("localPart = %q, want jane.doe", got)
	}
}
