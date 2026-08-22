// Unit tests for the shared query-parameter contracts: the pagination bounds
// and the search bound every list command validates through.
package command

import (
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestParsePaginationAppliesDefaults(t *testing.T) {
	pagination, err := ParsePagination(url.Values{})
	if err != nil {
		t.Fatalf("empty query: %v", err)
	}
	if pagination.Page != 1 || pagination.PerPage != DefaultPerPage {
		t.Fatalf("defaults = %d/%d, want 1/%d", pagination.Page, pagination.PerPage, DefaultPerPage)
	}
	if pagination.Offset() != 0 {
		t.Fatalf("offset of page 1 = %d, want 0", pagination.Offset())
	}
}

func TestParsePaginationAcceptsInBoundsValues(t *testing.T) {
	pagination, err := ParsePagination(url.Values{"page": {"3"}, "per_page": {"100"}})
	if err != nil {
		t.Fatalf("in-bounds query: %v", err)
	}
	if pagination.Page != 3 || pagination.PerPage != 100 {
		t.Fatalf("parsed = %d/%d, want 3/100", pagination.Page, pagination.PerPage)
	}
	if got := pagination.Offset(); got != 200 {
		t.Fatalf("offset = %d, want 200", got)
	}
}

func TestParsePaginationRejectsOutOfContractValues(t *testing.T) {
	for name, query := range map[string]string{
		"page zero":         "page=0",
		"page negative":     "page=-1",
		"page junk":         "page=one",
		"per_page zero":     "per_page=0",
		"per_page over":     "per_page=101",
		"per_page junk":     "per_page=many",
		"per_page negative": "per_page=-5",
	} {
		if _, err := ParsePagination(url.Values{strings.SplitN(query, "=", 2)[0]: {strings.SplitN(query, "=", 2)[1]}}); err == nil {
			t.Fatalf("%s: accepted, want ErrInvalidPagination", name)
		}
	}
}

func TestParseSearchTrimsAndBounds(t *testing.T) {
	for name, raw := range map[string]string{
		"absent": "",
		"blank":  "   ",
		"padded": "  alice  ",
	} {
		req := httptest.NewRequest("GET", "/things?q="+strings.ReplaceAll(url.QueryEscape(raw), "+", "%20"), nil)
		got, err := ParseSearch(req)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if strings.TrimSpace(raw) != got {
			t.Fatalf("%s: parsed %q, want %q", name, got, strings.TrimSpace(raw))
		}
	}

	req := httptest.NewRequest("GET", "/things?q="+strings.Repeat("x", MaxSearchLength+1), nil)
	if _, err := ParseSearch(req); err == nil {
		t.Fatal("overly long search accepted, want ErrInvalidSearch")
	}
}
