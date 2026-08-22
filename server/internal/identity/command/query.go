// Shared query-parameter parsing for the paginated read commands: one
// pagination contract (page ≥ 1 defaulting to 1, per_page 1..100 defaulting
// to 20) and one bounded free-text search contract, so every list endpoint
// answers shape violations identically before any domain code runs.
package command

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const (
	// DefaultPerPage is the page size when the caller omits per_page.
	DefaultPerPage = 20
	// MaxPerPage bounds one page so a caller cannot ask for the whole table.
	MaxPerPage = 100
	// MaxSearchLength bounds the free-text query parameter.
	MaxSearchLength = 256
)

// ErrInvalidPagination reports a page or per_page outside the pagination
// contract; MapError answers it as 400 invalid_pagination.
var ErrInvalidPagination = errors.New("command: invalid pagination")

// ErrInvalidSearch reports a search parameter longer than MaxSearchLength;
// MapError answers it as 400 invalid_search.
var ErrInvalidSearch = errors.New("command: invalid search")

// Pagination is the parsed page request shared by every list command.
type Pagination struct {
	Page    int
	PerPage int
}

// Offset is the zero-based row offset the page maps to.
func (p Pagination) Offset() int {
	return (p.Page - 1) * p.PerPage
}

// ParsePagination reads page and per_page from a request's query values
// against the shared contract. Absent parameters take the defaults; present
// but malformed or out-of-range values are shape failures.
func ParsePagination(query url.Values) (Pagination, error) {
	page := 1
	if raw := query.Get("page"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 {
			return Pagination{}, ErrInvalidPagination
		}
		page = parsed
	}
	perPage := DefaultPerPage
	if raw := query.Get("per_page"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > MaxPerPage {
			return Pagination{}, ErrInvalidPagination
		}
		perPage = parsed
	}
	return Pagination{Page: page, PerPage: perPage}, nil
}

// ParseSearch reads the q parameter: trimmed free text, empty when absent.
// The bound keeps one oversized parameter from dominating the ILIKE scan.
func ParseSearch(r *http.Request) (string, error) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) > MaxSearchLength {
		return "", ErrInvalidSearch
	}
	return q, nil
}
