package integrationtest

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const outboxVerificationCodeIndex = "outbox_messages_verification_code_idx"

type outboxFKExplainDocument []struct {
	Plan outboxFKExplainPlan `json:"Plan"`
}

type outboxFKExplainPlan struct {
	IndexName string                `json:"Index Name"`
	Plans     []outboxFKExplainPlan `json:"Plans"`
}

func (p outboxFKExplainPlan) usesIndex(name string) bool {
	if p.IndexName == name {
		return true
	}
	for _, child := range p.Plans {
		if child.usesIndex(name) {
			return true
		}
	}
	return false
}

func TestOutboxVerificationCodeForeignKeyIndexCoversEveryReferenceStatus(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, requireEnv(t, "NEVIX_DATABASE_URL"))
	if err != nil {
		t.Fatalf("connect to database: %v", err)
	}
	t.Cleanup(pool.Close)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin catalog transaction: %v", err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	var predicate string
	if err := tx.QueryRow(ctx,
		`SELECT pg_get_expr(index.indpred, index.indrelid, true)
		 FROM pg_catalog.pg_index AS index
		 JOIN pg_catalog.pg_class AS indexed_table ON indexed_table.oid = index.indrelid
		 JOIN pg_catalog.pg_namespace AS table_schema ON table_schema.oid = indexed_table.relnamespace
		 JOIN pg_catalog.pg_class AS indexed_relation ON indexed_relation.oid = index.indexrelid
		 JOIN pg_catalog.pg_constraint AS foreign_key
		   ON foreign_key.conrelid = indexed_table.oid
		  AND foreign_key.contype = 'f'
		 JOIN pg_catalog.pg_attribute AS referencing_column
		   ON referencing_column.attrelid = indexed_table.oid
		  AND referencing_column.attnum = ANY(foreign_key.conkey)
		 WHERE table_schema.nspname = 'identity'
		   AND indexed_table.relname = 'outbox_messages'
		   AND indexed_relation.relname = $1
		   AND referencing_column.attname = 'verification_code_id'
		   AND index.indkey[0] = referencing_column.attnum
		   AND index.indisvalid
		   AND index.indisready`, outboxVerificationCodeIndex,
	).Scan(&predicate); err != nil {
		t.Fatalf("read verification_code_id foreign-key index predicate from PostgreSQL catalog: %v", err)
	}

	t.Run("catalog predicate includes every non-null reference", func(t *testing.T) {
		if strings.Contains(predicate, "status") || !strings.Contains(predicate, "verification_code_id IS NOT NULL") {
			t.Errorf("index predicate = %q, want only verification_code_id IS NOT NULL so terminal Outbox rows remain indexed", predicate)
		}
	})

	if _, err := tx.Exec(ctx, "SET LOCAL enable_seqscan = off"); err != nil {
		t.Fatalf("disable sequential scans for deterministic index applicability checks: %v", err)
	}
	var rawPlan []byte
	if err := tx.QueryRow(ctx,
		`EXPLAIN (FORMAT JSON, COSTS OFF)
		 SELECT 1
		 FROM identity.outbox_messages
		 WHERE verification_code_id = '00000000-0000-0000-0000-000000000001'::uuid`,
	).Scan(&rawPlan); err != nil {
		t.Fatalf("explain status-independent Outbox reference lookup: %v", err)
	}
	var document outboxFKExplainDocument
	if err := json.Unmarshal(rawPlan, &document); err != nil {
		t.Fatalf("decode status-independent Outbox reference plan: %v", err)
	}
	if len(document) != 1 || !document[0].Plan.usesIndex(outboxVerificationCodeIndex) {
		t.Errorf("status-independent Outbox reference plan does not use %s: %s", outboxVerificationCodeIndex, rawPlan)
	}
}
