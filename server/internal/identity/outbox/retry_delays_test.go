package outbox_test

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/identity/outbox"
)

func TestLoadRetryDelaysDefaultsToProductionSchedule(t *testing.T) {
	delays, err := outbox.LoadRetryDelays(fakeGetenv(map[string]string{}))
	if err != nil {
		t.Fatalf("LoadRetryDelays with variable unset: %v", err)
	}
	want := []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute, time.Hour, 6 * time.Hour}
	if !slices.Equal(delays, want) {
		t.Fatalf("default retry delays = %v, want %v", delays, want)
	}
}

func TestLoadRetryDelaysReadsDeploymentOverride(t *testing.T) {
	delays, err := outbox.LoadRetryDelays(fakeGetenv(map[string]string{
		"OUTBOX_RETRY_DELAYS": "1s, 2s,3s",
	}))
	if err != nil {
		t.Fatalf("LoadRetryDelays with valid override: %v", err)
	}
	want := []time.Duration{time.Second, 2 * time.Second, 3 * time.Second}
	if !slices.Equal(delays, want) {
		t.Fatalf("retry delays = %v, want %v", delays, want)
	}
}

func TestLoadRetryDelaysRejectsInvalidEntries(t *testing.T) {
	for _, raw := range []string{"not-a-duration", "1s,later", "1s,,3s", "0s", "-1s"} {
		t.Run(raw, func(t *testing.T) {
			_, err := outbox.LoadRetryDelays(fakeGetenv(map[string]string{
				"OUTBOX_RETRY_DELAYS": raw,
			}))
			if err == nil || !strings.Contains(err.Error(), "OUTBOX_RETRY_DELAYS") {
				t.Fatalf("LoadRetryDelays(%q) returned %v, want error naming OUTBOX_RETRY_DELAYS", raw, err)
			}
		})
	}
}
