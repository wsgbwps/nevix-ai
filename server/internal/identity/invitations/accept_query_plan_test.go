package invitations

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const historicalInvitationCodeIndex = "verification_codes_invitation_superseded_hash_idx"

type historicalCodeExplainDocument []struct {
	Plan historicalCodeExplainPlan `json:"Plan"`
}

type historicalCodeExplainPlan struct {
	IndexName string                      `json:"Index Name"`
	Plans     []historicalCodeExplainPlan `json:"Plans"`
}

func (p historicalCodeExplainPlan) usesIndex(name string) bool {
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

func TestHistoricalInvitationCodeLookupUsesPartialIndex(t *testing.T) {
	databaseURL := os.Getenv("NEVIX_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("skipping query-plan test: NEVIX_DATABASE_URL is not set (run scripts/test-mail-smoke.sh)")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
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
	if _, err := tx.Exec(ctx, "SET LOCAL enable_seqscan = off"); err != nil {
		t.Fatalf("disable sequential scans: %v", err)
	}

	var rawPlan []byte
	if err := tx.QueryRow(ctx,
		`EXPLAIN (FORMAT JSON, COSTS OFF)
		 SELECT EXISTS (
			 SELECT 1
			 FROM identity.verification_codes
			 WHERE target_id = '00000000-0000-0000-0000-000000000001'::uuid
			   AND action_type = 'invitation'
			   AND code_hash = 'historical-code-hash'
			   AND status = 'superseded'
		 )`,
	).Scan(&rawPlan); err != nil {
		t.Fatalf("explain historical invitation-code lookup: %v", err)
	}

	var document historicalCodeExplainDocument
	if err := json.Unmarshal(rawPlan, &document); err != nil {
		t.Fatalf("decode historical invitation-code plan: %v", err)
	}
	if len(document) != 1 || !document[0].Plan.usesIndex(historicalInvitationCodeIndex) {
		t.Errorf("historical invitation-code lookup does not use %s: %s", historicalInvitationCodeIndex, rawPlan)
	}
}
