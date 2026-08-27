package creationhttp

import "strings"

// rangeIntent is the grammar-level result of inspecting a Range header
// before any size is known.
type rangeIntent struct {
	present bool // a Range header accompanied the request at all
	valid   bool // exactly one well-formed bytes spec (multi-range excluded)
	suffix  bool // "-n" form when valid
	start   int64
	end     int64 // closed-end value; -1 means open ("a-")
	n       int64 // suffix length when suffix
}

// parseRangeIntent inspects the header. Grammar-level failures (unit
// mismatch, multi-range, malformed specs) keep present=true but valid=false;
// the contract answers those with 416 just like out-of-bounds specs — a
// client that asked for a slice never silently receives the whole blob.
func parseRangeIntent(header string) rangeIntent {
	intent := rangeIntent{}
	if header == "" {
		return intent
	}
	intent.present = true
	spec, ok := strings.CutPrefix(header, "bytes=")
	if !ok || strings.ContainsAny(spec, ", \t") {
		return intent // unit mismatch or multi-range: ignorable per RFC 9110
	}
	if n, ok := parseSuffixForm(spec); ok {
		if n < 0 {
			return intent // invalid negative → whole-content fallback
		}
		intent.valid, intent.suffix, intent.n = true, true, n
		return intent
	}
	startStr, endStr, found := strings.Cut(spec, "-")
	if !found || startStr == "" && endStr == "" {
		return intent
	}
	if startStr == "" {
		// handled above by suffix form; reaching here means like "-" alone
		return intent
	}
	start := parseUint64(startStr)
	if start < 0 {
		return intent
	}
	end := int64(-1)
	if endStr != "" {
		end = parseUint64(endStr)
		if end < 0 || end < start {
			return intent
		}
	}
	intent.valid, intent.start, intent.end = true, start, end
	return intent
}

// resolveRange maps one intent onto concrete served bounds for this blob:
// [start,stop) plus whether to answer 206. satisfiable is only meaningful
// for valid intents; out-of-bounds specs report false so the caller answers
// 416 rather than silently serving nothing.
func resolveRange(intent rangeIntent, size int64) (servePartial bool, start, stop int64, satisfiable bool) {
	stop = size
	satisfiable = true
	switch {
	case !intent.present || !intent.valid:
		return false, 0, size, true
	case intent.suffix:
		if intent.n == 0 || size == 0 {
			return false, 0, 0, false
		}
		start = size - intent.n
		if start < 0 {
			start = 0
		}
		return true, start, size, true
	case intent.end < 0: // open end "a-"
		if intent.start >= size {
			return false, 0, 0, false
		}
		return true, intent.start, size, true
	default: // closed "a-b"
		if intent.start >= size {
			return false, 0, 0, false
		}
		stop = intent.end + 1
		if stop > size {
			stop = size
		}
		return true, intent.start, stop, true
	}
}

// parseSuffixForm parses the bytes=-n spelling; ok=false covers anything
// else including other dash shapes.
func parseSuffixForm(spec string) (int64, bool) {
	if !strings.HasPrefix(spec, "-") {
		return 0, false
	}
	value := parseUint64(spec[1:])
	return value, value >= 0
}

// parseUint64 decodes ASCII digits, returning -1 on empty/oversize/garbage.
func parseUint64(raw string) int64 {
	if raw == "" || len(raw) > 19 {
		return -1
	}
	var value int64
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if c < '0' || c > '9' {
			return -1
		}
		value = value*10 + int64(c-'0')
	}
	return value
}
