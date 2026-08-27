package creationhttp

import (
	"testing"

	"github.com/nevix-ai/server/internal/creation/domain"
)

func TestParseRangeIntentGrammar(t *testing.T) {
	cases := []struct {
		header string
		want   rangeIntent
	}{
		{"", rangeIntent{}},
		{"bytes=0-499", rangeIntent{present: true, valid: true, start: 0, end: 499}},
		{"bytes=500-", rangeIntent{present: true, valid: true, start: 500, end: -1}},
		{"bytes=-256", rangeIntent{present: true, valid: true, suffix: true, n: 256}},
		{"bytes=-0", rangeIntent{present: true, valid: true, suffix: true, n: 0}},
	}
	for _, tc := range cases {
		got := parseRangeIntent(tc.header)
		if got.present != tc.want.present || got.valid != tc.want.valid || got.suffix != tc.want.suffix ||
			got.start != tc.want.start || got.end != tc.want.end || got.n != tc.want.n {
			t.Errorf("parseRangeIntent(%q) = %+v want %+v", tc.header, got, tc.want)
		}
	}

	ignored := []string{"items=0-10", "bytes=10-20,30-40", "bytes=a-b", "bytes=x-y"}
	for _, header := range ignored {
		intent := parseRangeIntent(header)
		if !intent.present || intent.valid {
			t.Errorf("%q should be present-but-invalid (serve full), got %+v", header, intent)
		}
	}
}

func TestResolveRangeIntervals(t *testing.T) {
	const size = int64(1000)

	cases := []struct {
		name                string
		intent              rangeIntent
		wantServe           bool
		wantStart, wantStop int64
		wantSatisfiable     bool
	}{
		{"full-absent", parseRangeIntent(""), false, 0, size, true},
		{"ignored-invalid", parseRangeIntent("units=nope"), false, 0, size, true},
		{"closed-head", parseRangeIntent("bytes=0-99"), true, 0, 100, true},
		{"closed-mid", parseRangeIntent("bytes=400-600"), true, 400, 601, true},
		{"closed-clamped-tail", parseRangeIntent("bytes=900-2000"), true, 900, 1000, true},
		{"open-end", parseRangeIntent("bytes=700-"), true, 700, 1000, true},
		{"suffix-overlap", parseRangeIntent("bytes=-500"), true, 500, 1000, true},
		{"suffix-beyond", parseRangeIntent("bytes=-5000"), true, 0, 1000, true},
		{"open-past-eof", parseRangeIntent("bytes=1000-"), false, 0, 0, false},
		{"closed-past-eof", parseRangeIntent("bytes=1500-1600"), false, 0, 0, false},
		{"zero-suffix", parseRangeIntent("bytes=-0"), false, 0, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			serve, start, stop, satisfiable := resolveRange(tc.intent, size)
			if serve != tc.wantServe || start != tc.wantStart || stop != tc.wantStop || satisfiable != tc.wantSatisfiable {
				t.Fatalf("resolveRange(%+v,%d) = %v,%d,%d,%v want %v,%d,%d,%v",
					tc.intent, size, serve, start, stop, satisfiable,
					tc.wantServe, tc.wantStart, tc.wantStop, tc.wantSatisfiable)
			}
		})
	}
}

func TestFullBlobConstantUnwindowed(t *testing.T) {
	if domain.FullBlobRange.Offset != 0 || domain.FullBlobRange.Length >= 0 {
		t.Fatal("FullBlobRange must open the whole blob")
	}
}
