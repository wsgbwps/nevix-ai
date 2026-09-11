package application

import (
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

func TestSubmitRetryHoldPreservesProviderPressureClass(t *testing.T) {
	tests := []struct {
		name      string
		pressure  domain.SubmitRetryPressure
		wantDelay time.Duration
	}{
		{name: "confirmed unsent", wantDelay: domain.BackoffLadder(0)},
		{name: "safe 429", pressure: domain.SubmitRetryBackoff, wantDelay: domain.BackoffLadder(0)},
		{name: "safe 503", pressure: domain.SubmitRetryCooldown, wantDelay: domain.CooldownLadder(0)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			worker := &TaskWorker{}
			retryable := &domain.SubmitRetryableError{
				Reason: domain.ReasonProviderRouteUnavailable, Pressure: tt.pressure,
			}
			started := time.Now()
			until := worker.submitRetryHoldUntil("connection:image", domain.MediaImage, retryable)
			delay := until.Sub(started)
			if delay < tt.wantDelay-time.Second || delay > tt.wantDelay+time.Second {
				t.Fatalf("retry delay = %s, want about %s", delay, tt.wantDelay)
			}
		})
	}
}
