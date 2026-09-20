package creationhttp

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestParseAssetFilterReadsExclusiveCreatedUntil(t *testing.T) {
	req := httptest.NewRequest(
		"GET",
		"/creation/assets?created_since=2026-09-01T00:00:00Z&created_until=2026-09-11T00:00:00Z",
		nil,
	)
	recorder := httptest.NewRecorder()

	filter, ok := parseAssetFilter(recorder, req)
	want := time.Date(2026, 9, 11, 0, 0, 0, 0, time.UTC)
	if !ok || filter.CreatedUntil == nil || !filter.CreatedUntil.Equal(want) {
		t.Fatalf("created_until=%v ok=%v", filter.CreatedUntil, ok)
	}
}

func TestParseAssetFilterRejectsMalformedCreatedUntil(t *testing.T) {
	req := httptest.NewRequest("GET", "/creation/assets?created_until=2026-09-11", nil)
	recorder := httptest.NewRecorder()

	if _, ok := parseAssetFilter(recorder, req); ok {
		t.Fatal("a malformed created_until was admitted")
	}
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status=%d", recorder.Code)
	}
}

func TestParseAssetFilterDoesNotAdmitCreatorFilter(t *testing.T) {
	req := httptest.NewRequest("GET", "/creation/assets?creator=other", nil)
	recorder := httptest.NewRecorder()

	filter, ok := parseAssetFilter(recorder, req)
	if !ok || filter.Creator != "" {
		t.Fatalf("private Asset filter admitted creator=%q ok=%v", filter.Creator, ok)
	}
}

func TestParseAssetFilterReadsExactSearch(t *testing.T) {
	req := httptest.NewRequest("GET", "/creation/assets?search=%20asset-id%20", nil)
	recorder := httptest.NewRecorder()

	filter, ok := parseAssetFilter(recorder, req)
	if !ok || filter.Search != "asset-id" {
		t.Fatalf("search=%q ok=%v", filter.Search, ok)
	}
}

func TestParseAssetFilterReadsRepeatedFacets(t *testing.T) {
	req := httptest.NewRequest("GET",
		"/creation/assets?mode=text-to-image&mode=reference-image&ratio=16%3A9&resolution=2K&resolution=1K", nil)
	recorder := httptest.NewRecorder()

	filter, ok := parseAssetFilter(recorder, req)
	if !ok {
		t.Fatalf("status=%d", recorder.Code)
	}
	if len(filter.Modes) != 2 || filter.Modes[0] != "text-to-image" || filter.Modes[1] != "reference-image" {
		t.Fatalf("modes=%v", filter.Modes)
	}
	if len(filter.Ratios) != 1 || filter.Ratios[0] != "16:9" {
		t.Fatalf("ratios=%v", filter.Ratios)
	}
	if len(filter.Resolutions) != 2 || filter.Resolutions[0] != "2K" {
		t.Fatalf("resolutions=%v", filter.Resolutions)
	}
}

func TestParseAssetFilterRejectsUnknownFacetValues(t *testing.T) {
	for _, query := range []string{
		"ratio=banana",
		"resolution=8K",
		"mode=text-to-audio",
		"ratio=adaptive", // the sentinel: adaptive Assets are matched by shape, never asked for
		"mode=",          // present but empty is still not a contract value
		"ratio=%20",
		"mode=text-to-image&mode=",
	} {
		req := httptest.NewRequest("GET", "/creation/assets?"+query, nil)
		recorder := httptest.NewRecorder()
		if _, ok := parseAssetFilter(recorder, req); ok {
			t.Fatalf("%q was admitted", query)
		}
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%q status=%d", query, recorder.Code)
		}
	}
}
