package creationhttp

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseAssetFilterReadsCreatorDisplayNamePrefix(t *testing.T) {
	req := httptest.NewRequest("GET", "/creation/assets?creator=%20aSSeT%20CrEaToR%20", nil)
	recorder := httptest.NewRecorder()

	filter, ok := parseAssetFilter(recorder, req)
	if !ok || filter.Creator != "aSSeT CrEaToR" {
		t.Fatalf("creator filter = %q ok=%v, want trimmed display-name prefix", filter.Creator, ok)
	}
}

func TestParseAssetFilterBoundsCreatorInCharacters(t *testing.T) {
	req := httptest.NewRequest("GET", "/creation/assets?creator="+strings.Repeat("名", maxAssetCreatorLength+1), nil)
	recorder := httptest.NewRecorder()

	if _, ok := parseAssetFilter(recorder, req); ok {
		t.Fatal("129-character creator filter accepted")
	}
	if recorder.Code != 400 {
		t.Fatalf("status=%d, want 400", recorder.Code)
	}
}
