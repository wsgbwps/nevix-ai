package outbox

import (
	"fmt"
	"strings"
	"time"
)

// defaultRetryDelays is the production backoff schedule: a failed delivery is
// retried after 1m, 5m, 15m, 1h, and 6h. The schedule's length is also the
// retry budget — a message gets one initial attempt plus at most one retry
// per schedule entry before it goes terminal.
var defaultRetryDelays = []time.Duration{
	time.Minute,
	5 * time.Minute,
	15 * time.Minute,
	time.Hour,
	6 * time.Hour,
}

// LoadRetryDelays reads OUTBOX_RETRY_DELAYS, a comma-separated list of Go
// durations waited between consecutive delivery attempts. Unset means the
// production schedule; deployment configuration may compress it so tests
// finish in reasonable time. An invalid entry is an explicit startup error
// naming the variable.
func LoadRetryDelays(getenv func(string) string) ([]time.Duration, error) {
	raw := getenv("OUTBOX_RETRY_DELAYS")
	if raw == "" {
		return append([]time.Duration(nil), defaultRetryDelays...), nil
	}
	parts := strings.Split(raw, ",")
	delays := make([]time.Duration, 0, len(parts))
	for _, part := range parts {
		delay, err := time.ParseDuration(strings.TrimSpace(part))
		if err != nil {
			return nil, fmt.Errorf("identity: OUTBOX_RETRY_DELAYS entry %q: %w", part, err)
		}
		if delay <= 0 {
			return nil, fmt.Errorf("identity: OUTBOX_RETRY_DELAYS entry %q is not a positive duration", part)
		}
		delays = append(delays, delay)
	}
	return delays, nil
}
