// The in-process login failure rate limiter (ADR-0015): per-email failure
// counting inside one server process. The single-instance, 200–300-user
// deployment profile makes an in-process counter the whole mechanism; a
// shared store would be speculative.
package auth

import (
	"sync"
	"time"
)

const (
	// maxLoginFailures is how many failures within loginFailureWindow lock
	// the email out.
	maxLoginFailures = 5
	// loginFailureWindow is the sliding window failures are counted in; it
	// doubles as the lockout duration (the lock lifts as the oldest failure
	// leaves the window).
	loginFailureWindow = 15 * time.Minute
)

// LoginRateLimiter counts consecutive login failures per canonical email.
// Successful login clears the email entirely; the daily sweep prunes idle
// entries so the map cannot grow without bound.
type LoginRateLimiter struct {
	mu       sync.Mutex
	failures map[string][]time.Time
}

// NewLoginRateLimiter builds an empty limiter.
func NewLoginRateLimiter() *LoginRateLimiter {
	return &LoginRateLimiter{failures: map[string][]time.Time{}}
}

// Allowed reports whether the email may attempt a login now; when locked out,
// the retry duration says how long until the oldest counted failure expires.
func (l *LoginRateLimiter) Allowed(email string, now time.Time) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	windowStart := now.Add(-loginFailureWindow)
	recent := retainSince(l.failures[email], windowStart)
	l.failures[email] = recent
	if len(recent) < maxLoginFailures {
		return true, 0
	}
	return false, recent[0].Add(loginFailureWindow).Sub(now)
}

// RecordFailure counts one failed attempt for the email.
func (l *LoginRateLimiter) RecordFailure(email string, now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.failures[email] = append(retainSince(l.failures[email], now.Add(-loginFailureWindow)), now)
}

// RecordSuccess forgets every counted failure for the email.
func (l *LoginRateLimiter) RecordSuccess(email string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.failures, email)
}

// Prune drops entries whose every failure has left the window.
func (l *LoginRateLimiter) Prune(now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	windowStart := now.Add(-loginFailureWindow)
	for email, failures := range l.failures {
		if recent := retainSince(failures, windowStart); len(recent) == 0 {
			delete(l.failures, email)
		} else {
			l.failures[email] = recent
		}
	}
}

func retainSince(failures []time.Time, windowStart time.Time) []time.Time {
	retained := failures[:0]
	for _, failure := range failures {
		if failure.After(windowStart) {
			retained = append(retained, failure)
		}
	}
	return retained
}
