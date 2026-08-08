// Unit tests for IssueVerificationCode's explicit domain-to-command seams:
// request validation and domain-error mapping. No database is needed.
package verification

import (
	"fmt"
	"net/http"
	"testing"
)

func TestIssueVerificationCodeRequestValidation(t *testing.T) {
	for _, tc := range []struct {
		name     string
		request  IssueVerificationCodeRequest
		wantCode string
	}{
		{"empty email", IssueVerificationCodeRequest{}, "invalid_email"},
		{"display name", IssueVerificationCodeRequest{Email: "User <user@example.com>"}, "invalid_email"},
		{"bare address", IssueVerificationCodeRequest{Email: "  USER@EXAMPLE.COM  "}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.request.Validate()
			if tc.wantCode == "" {
				if err != nil {
					t.Fatalf("Validate returned %v", err)
				}
				if tc.request.Email != "user@example.com" {
					t.Fatalf("normalized email %q, want user@example.com", tc.request.Email)
				}
				return
			}
			if err == nil {
				t.Fatal("Validate returned nil")
			}
			if err.Status != http.StatusBadRequest || err.Code != tc.wantCode {
				t.Fatalf("Validate returned (%d, %q), want (400, %q)", err.Status, err.Code, tc.wantCode)
			}
		})
	}
}

func TestMapErrorPreservesCooldownRetryAfter(t *testing.T) {
	mapped := MapError(fmt.Errorf("issue verification code: %w", &cooldownActiveError{retryAfter: 42}))
	if mapped == nil {
		t.Fatal("mapped cooldown error is nil")
	}
	if mapped.Status != http.StatusTooManyRequests || mapped.Code != "cooldown_active" {
		t.Fatalf("mapped cooldown = (%d, %q), want (429, cooldown_active)", mapped.Status, mapped.Code)
	}
	if got := mapped.Headers["Retry-After"]; got != "42" {
		t.Fatalf("Retry-After %q, want 42", got)
	}

	for _, tc := range []struct {
		err  error
		code string
	}{
		{errEmailRateLimited, "email_rate_limited"},
		{errIPRateLimited, "ip_rate_limited"},
	} {
		mapped := MapError(tc.err)
		if mapped == nil || mapped.Status != http.StatusTooManyRequests || mapped.Code != tc.code {
			t.Fatalf("mapped %v = %#v, want 429 %q", tc.err, mapped, tc.code)
		}
		if got := mapped.Headers["Retry-After"]; got != "" {
			t.Fatalf("mapped %s Retry-After %q, want none", tc.code, got)
		}
	}
}
