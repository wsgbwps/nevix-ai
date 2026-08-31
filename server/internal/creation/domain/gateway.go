package domain

import (
	"context"
	"errors"
	"time"
)

// The provider gateway port: the task kernel's single seam to external
// generation. Adapters speak the domain's classified outcomes — request IDs,
// raw error bodies, keys, and prompts never travel past this boundary — and
// every classification below is deliberately recoverable by the kernel's
// retry discipline (spec #150 Retry/超时/取消纪律).

// Gateway classified errors.
var (
	// ErrSubmitIndeterminate reports a submit whose outcome could not be
	// safely identified (response lost before the external identity was
	// persisted). The kernel must never guess a new external request; the
	// job ends indeterminate and only a creator's explicit redo proceeds.
	ErrSubmitIndeterminate = errors.New("provider submit outcome is indeterminate")
	// ErrProviderUnavailable reports transient provider pressure or unknown
	// availability: timeouts on safe calls, 429 without more detail, 5xx.
	// Bounded retry with backoff applies.
	ErrProviderUnavailable = errors.New("provider temporarily unavailable")
	// ErrProviderRateLimited reports an explicit 429; RetryAfter carries the
	// provider's Retry-After when present.
	ErrProviderRateLimited = errors.New("provider rate limited")
	// ErrProviderCreditBlocked reports the provider's definitive 402; the
	// kernel persists the connection-level credit block.
	ErrProviderCreditBlocked = errors.New("provider credit exhausted")
	// ErrProviderTimedOut reports the provider's authoritative timeout or
	// unrecoverable expiry of the external job — the only path that may end
	// work as business timed_out.
	ErrProviderTimedOut = errors.New("provider authoritatively timed out")
	// ErrProviderRejected reports a definitive provider rejection with the
	// stable failure taxonomy reason (input/output policy).
	ErrProviderRejected = errors.New("provider rejected the generation")
)

// ProviderRejectedError carries the stable reason for a definitive
// rejection (input_policy_rejected / output_policy_rejected / internal…).
type ProviderRejectedError struct {
	Reason FailureReason
}

func (e *ProviderRejectedError) Error() string { return string(e.Reason) }

// GatewayOutput is one provider output location. V1 outputs arrive as
// temporary URLs the kernel transfers to its own storage immediately.
type GatewayOutput struct {
	URL string
}

// RateLimitedError reports an explicit 429 with the provider's Retry-After
// when one was sent. It lives on the domain so the worker and the adapter
// share one error shape without leaking transport detail. The Is method
// makes errors.Is match the ErrProviderRateLimited sentinel.
type RateLimitedError struct {
	RetryAfter *time.Duration
}

func (e *RateLimitedError) Error() string { return "provider rate limited" }

func (e *RateLimitedError) Is(target error) bool { return target == ErrProviderRateLimited }

// IsSubmitIndeterminate reports an unidentified submit outcome.
func IsSubmitIndeterminate(err error) bool { return errors.Is(err, ErrSubmitIndeterminate) }

// IsCreditBlocked reports the provider's definitive 402.
func IsCreditBlocked(err error) bool { return errors.Is(err, ErrProviderCreditBlocked) }

// IsRateLimited reports an explicit 429.
func IsRateLimited(err error) bool { return errors.Is(err, ErrProviderRateLimited) }

// IsProviderUnavailable reports transient provider pressure.
func IsProviderUnavailable(err error) bool { return errors.Is(err, ErrProviderUnavailable) }

// IsProviderTimedOut reports the provider's authoritative timeout.
func IsProviderTimedOut(err error) bool { return errors.Is(err, ErrProviderTimedOut) }

// RetryAfterOf extracts the Retry-After hint from a classified 429.
func RetryAfterOf(err error) *time.Duration {
	var limited *RateLimitedError
	if errors.As(err, &limited) {
		return limited.RetryAfter
	}
	return nil
}

// ClassifyFailureReason maps a classified gateway error onto the stable
// failure taxonomy for slot verdicts.
func ClassifyFailureReason(err error) FailureReason {
	var rejected *ProviderRejectedError
	if errors.As(err, &rejected) {
		return rejected.Reason
	}
	return ReasonTemporarilyUnavailable
}

// SubmitRequest is one external execution request built from the frozen
// specification. Reference payloads are transport-ready data URLs the kernel
// assembled from its own storage — the gateway never reads task rows.
type SubmitRequest struct {
	Media      MediaType
	Model      string
	Mode       string
	Prompt     string
	Quantity   int
	Ratio      *string
	Resolution *string
	DurationS  *int
	References []GatewayReference
}

// GatewayReference is one ordered reference with its role and data URL.
type GatewayReference struct {
	Role DraftRole
	Kind Kind
	Data string // data URL
}

// SubmitOutcome is the synchronous portion of a submission: async providers
// return the external reference; sync providers may already return outputs.
type SubmitOutcome struct {
	ExternalRef string
	Outputs     []GatewayOutput
}

// PollStatus is the classified external progress.
type PollStatus string

const (
	PollProcessing PollStatus = "processing"
	PollCompleted  PollStatus = "completed"
	PollFailed     PollStatus = "failed"
	PollCancelled  PollStatus = "cancelled"
	PollTimedOut   PollStatus = "timed_out"
)

// PollOutcome is one authoritative poll answer.
type PollOutcome struct {
	Status  PollStatus
	Outputs []GatewayOutput
	Reason  *FailureReason // classified, when Status == PollFailed
}

// ProviderGateway is the external generation seam.
type ProviderGateway interface {
	// Submit starts one external generation. A lost outcome returns
	// ErrSubmitIndeterminate; classified errors otherwise.
	Submit(ctx context.Context, req SubmitRequest) (SubmitOutcome, error)
	// Poll queries one external job. Polling is provably safe to retry.
	Poll(ctx context.Context, ref string) (PollOutcome, error)
	// Cancel asks the provider to stop one accepted job; convergence stays
	// authoritative via Poll (best-effort cancel contract).
	Cancel(ctx context.Context, ref string) error
}

// BackoffSchedule is the bounded 429 backoff ladder (spec: 5s, 15s, 30s,
// 60s) resolved by consecutive strikes.
func BackoffSchedule(retryAfter *time.Duration) time.Duration {
	if retryAfter != nil {
		return *retryAfter
	}
	return 0 // caller applies the jittered ladder by attempt count
}

// BackoffLadder returns the jittered ladder value for strike n (0-based).
func BackoffLadder(strike int) time.Duration {
	ladder := []time.Duration{5 * time.Second, 15 * time.Second, 30 * time.Second, 60 * time.Second}
	if strike < 0 {
		strike = 0
	}
	if strike >= len(ladder) {
		return ladder[len(ladder)-1]
	}
	return ladder[strike]
}

// CooldownLadder is the 503 per-connection-and-media cooldown ladder
// (30s, 1m, 2m, 5m) by consecutive strikes.
func CooldownLadder(strike int) time.Duration {
	ladder := []time.Duration{30 * time.Second, time.Minute, 2 * time.Minute, 5 * time.Minute}
	if strike < 0 {
		strike = 0
	}
	if strike >= len(ladder) {
		return ladder[len(ladder)-1]
	}
	return ladder[strike]
}
