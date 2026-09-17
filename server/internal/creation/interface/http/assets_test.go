package creationhttp

import (
	"net/http/httptest"
	"testing"
)

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
