package verification

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const historicalIssuanceRows = 10_000

type capturedQuery struct {
	sql  string
	args []any
}

type queryCapturingTx struct {
	pgx.Tx
	queries []capturedQuery
}

func (tx *queryCapturingTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if strings.Contains(sql, "FROM identity.verification_codes") {
		tx.queries = append(tx.queries, capturedQuery{sql: sql, args: append([]any(nil), args...)})
	}
	return tx.Tx.QueryRow(ctx, sql, args...)
}

type explainDocument []struct {
	Plan explainPlan `json:"Plan"`
}

type explainPlan struct {
	IndexName string        `json:"Index Name"`
	IndexCond string        `json:"Index Cond"`
	Plans     []explainPlan `json:"Plans"`
}

func (p explainPlan) indexCondition(indexName string) (string, bool) {
	if p.IndexName == indexName {
		return p.IndexCond, true
	}
	for _, child := range p.Plans {
		if condition, ok := child.indexCondition(indexName); ok {
			return condition, true
		}
	}
	return "", false
}

func TestIssuanceRateLimitQueriesConstrainCompositeIndexes(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	databaseURL := os.Getenv("NEVIX_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("skipping query-plan test: NEVIX_DATABASE_URL is not set (run scripts/test-mail-smoke.sh)")
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect to database: %v", err)
	}
	t.Cleanup(pool.Close)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin query-plan transaction: %v", err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	runID := time.Now().UnixNano()
	email := fmt.Sprintf("query-plan-%d@nevix.test", runID)
	ip := fmt.Sprintf("198.18.%d.%d", runID%250+1, runID/250%250+1)
	if _, err := tx.Exec(ctx,
		`INSERT INTO identity.verification_codes
		     (email, code_hash, request_ip, created_at, expires_at)
		 SELECT $1, 'historical-email', 'email-history-' || n,
		        clock_timestamp() - interval '2 hours' - make_interval(secs => n),
		        clock_timestamp() - interval '1 hour'
		 FROM generate_series(1, $2) AS history(n)`,
		email, historicalIssuanceRows,
	); err != nil {
		t.Fatalf("seed historical email issuance rows: %v", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO identity.verification_codes
		     (email, code_hash, request_ip, created_at, expires_at)
		 SELECT 'ip-history-' || n || '@nevix.test', 'historical-ip', $1,
		        clock_timestamp() - interval '2 hours' - make_interval(secs => n),
		        clock_timestamp() - interval '1 hour'
		 FROM generate_series(1, $2) AS history(n)`,
		ip, historicalIssuanceRows,
	); err != nil {
		t.Fatalf("seed historical IP issuance rows: %v", err)
	}
	// Keep the assertion deterministic even if unrelated local rows make a
	// sequential scan look artificially cheap. The index scan still decides
	// independently which predicates qualify as Index Cond entries.
	if _, err := tx.Exec(ctx, `SET LOCAL enable_seqscan = off`); err != nil {
		t.Fatalf("prefer index plans for regression assertion: %v", err)
	}

	recorded := &queryCapturingTx{Tx: tx}
	if err := EnforceIssuanceLimits(ctx, recorded, email, ip); err != nil {
		t.Fatalf("enforce issuance limits over historical rows: %v", err)
	}

	wants := map[string]struct {
		indexName string
		column    string
	}{
		"email": {
			indexName: "verification_codes_email_created_idx",
			column:    "email",
		},
		"request_ip": {
			indexName: "verification_codes_request_ip_created_idx",
			column:    "request_ip",
		},
	}
	if len(recorded.queries) != len(wants) {
		t.Fatalf("captured %d rate-limit queries, want %d", len(recorded.queries), len(wants))
	}

	for _, query := range recorded.queries {
		var want struct {
			indexName string
			column    string
		}
		for candidate, candidateWant := range wants {
			if strings.Contains(query.sql, "WHERE "+candidate+" =") {
				want = candidateWant
				break
			}
		}
		if want.indexName == "" {
			t.Fatalf("captured unexpected rate-limit query: %s", query.sql)
		}

		var rawPlan []byte
		if err := tx.QueryRow(ctx, "EXPLAIN (ANALYZE, FORMAT JSON) "+query.sql, query.args...).Scan(&rawPlan); err != nil {
			t.Fatalf("explain %s rate-limit query: %v", want.column, err)
		}
		var document explainDocument
		if err := json.Unmarshal(rawPlan, &document); err != nil {
			t.Fatalf("decode %s query plan: %v", want.column, err)
		}
		if len(document) != 1 {
			t.Fatalf("%s query plan has %d roots, want 1", want.column, len(document))
		}
		condition, ok := document[0].Plan.indexCondition(want.indexName)
		if !ok {
			t.Fatalf("%s query did not use %s: %s", want.column, want.indexName, rawPlan)
		}
		if !strings.Contains(condition, want.column) || !strings.Contains(condition, "created_at") {
			t.Errorf("%s Index Cond = %q, want both %s and created_at", want.indexName, condition, want.column)
		}
	}
}
