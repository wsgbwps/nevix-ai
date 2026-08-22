// Unit tests for the in-process login failure limiter.
package auth

import (
	"testing"
	"time"
)

func TestLimiterLocksOutAfterWindowedFailures(t *testing.T) {
	limiter := NewLoginRateLimiter()
	now := time.Now()

	for attempt := 1; attempt < maxLoginFailures; attempt++ {
		limiter.RecordFailure("user@example.com", now.Add(time.Duration(attempt)*time.Second))
	}
	if allowed, _ := limiter.Allowed("user@example.com", now); !allowed {
		t.Fatalf("locked out after %d failures, want lockout only at %d", maxLoginFailures-1, maxLoginFailures)
	}

	// The 5th failure inside the window locks the email out.
	limiter.RecordFailure("user@example.com", now.Add(5*time.Second))
	allowed, retryAfter := limiter.Allowed("user@example.com", now.Add(6*time.Second))
	if allowed {
		t.Fatal("email not locked out after the maximum failures")
	}
	wantRetry := loginFailureWindow - 6*time.Second
	if retryAfter < wantRetry-time.Second || retryAfter > wantRetry+time.Second {
		t.Fatalf("retryAfter %v, want ~%v (oldest failure leaving the window)", retryAfter, wantRetry)
	}

	// Another email is unaffected: the counter is per-email.
	if allowed, _ := limiter.Allowed("other@example.com", now.Add(6*time.Second)); !allowed {
		t.Fatal("lockout leaked to another email")
	}
}

func TestLimiterUnlocksAsTheWindowSlides(t *testing.T) {
	limiter := NewLoginRateLimiter()
	now := time.Now()
	for attempt := 0; attempt < maxLoginFailures; attempt++ {
		limiter.RecordFailure("user@example.com", now.Add(time.Duration(attempt)*time.Second))
	}
	if allowed, _ := limiter.Allowed("user@example.com", now.Add(10*time.Second)); allowed {
		t.Fatal("email should be locked out")
	}
	// Once every counted failure is older than the window, the lock lifts.
	if allowed, _ := limiter.Allowed("user@example.com", now.Add(loginFailureWindow+maxLoginFailures*time.Second)); !allowed {
		t.Fatal("lockout did not lift after the whole window passed")
	}
}

func TestLimiterSuccessClearsTheEmail(t *testing.T) {
	limiter := NewLoginRateLimiter()
	now := time.Now()
	for attempt := 0; attempt < maxLoginFailures; attempt++ {
		limiter.RecordFailure("user@example.com", now)
	}
	limiter.RecordSuccess("user@example.com")
	if allowed, _ := limiter.Allowed("user@example.com", now); !allowed {
		t.Fatal("successful login did not clear the counted failures")
	}
}

func TestLimiterPruneDropsStaleEntries(t *testing.T) {
	limiter := NewLoginRateLimiter()
	now := time.Now()
	limiter.RecordFailure("stale@example.com", now.Add(-loginFailureWindow-time.Minute))
	limiter.RecordFailure("fresh@example.com", now)
	limiter.Prune(now)
	limiter.mu.Lock()
	count := len(limiter.failures)
	limiter.mu.Unlock()
	if count != 1 {
		t.Fatalf("prune left %d entries, want 1 (only the in-window email)", count)
	}
}
