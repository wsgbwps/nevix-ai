// Real-PostgreSQL evidence for the Reauthentication Proof lifecycle (issue
// #154): issuance stores only the hash with the five-minute window, the
// consumption transition is atomic and exactly-once under concurrency, a
// wrong action or a failed attempt never burns a proof, and consumption
// commits as its own irreversible transition — a later downstream failure
// cannot restore it. Opt-in like the sibling packages: the harness
// (scripts/test-identity-integration.sh) exports NEVIX_DATABASE_URL (owner)
// and NEVIX_IDENTITY_DATABASE_URL (the identity_app runtime credential);
// without the harness these tests skip.
package reauth

import (
	"context"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"

	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/identity/auth"
	"github.com/nevix-ai/server/internal/identity/session"
	"github.com/nevix-ai/server/internal/identity/writetx"
	"github.com/nevix-ai/server/internal/migration"
)

func requireEnv(t *testing.T, key string) string {
	t.Helper()
	value := os.Getenv(key)
	if value == "" {
		if os.Getenv("NEVIX_IDENTITY_INTEGRATION_REQUESTED") == "1" {
			t.Fatalf("identity integration was requested, but %s is not set; run ./scripts/test-identity-integration.sh from the repository root to start the supported harness", key)
		}
		t.Skipf("identity integration was not requested: %s is not set (run ./scripts/test-identity-integration.sh)", key)
	}
	return value
}

// serviceHarness builds the proof service exactly as the Module does — the
// shared write transaction runner and the auth service owning credential
// reverification — over the runtime credential, with one active admin.
type serviceHarness struct {
	owner       *pgxpool.Pool
	runner      *writetx.Runner
	credentials *auth.Service
	service     *Service
	admin       authz.Principal
}

func newServiceHarness(t *testing.T, ctx context.Context) *serviceHarness {
	t.Helper()
	ownerURL := requireEnv(t, "NEVIX_DATABASE_URL")
	runtimeURL := requireEnv(t, "NEVIX_IDENTITY_DATABASE_URL")
	if _, err := migration.Apply(ctx, ownerURL); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect owner database: %v", err)
	}
	t.Cleanup(owner.Close)
	runtime, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatalf("connect runtime database: %v", err)
	}
	t.Cleanup(runtime.Close)
	if _, err := owner.Exec(ctx, `TRUNCATE public.audit_logs, public.sessions, public.join_codes, public.reauth_proofs, public.users`); err != nil {
		t.Fatalf("truncate user-system tables: %v", err)
	}
	runner := writetx.New(runtime)
	sessions := session.NewService(runtime, runner)
	credentials := auth.NewService(runtime, runner, sessions)

	hash, err := bcrypt.GenerateFromPassword([]byte("correct-password-1"), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("hash fixture password: %v", err)
	}
	var adminID string
	if err := owner.QueryRow(ctx,
		`INSERT INTO public.users (email, password_hash, display_name, role, status, must_change_password)
		 VALUES ('admin@nevix.test', $1, 'Admin', 'admin', 'active', false) RETURNING id`,
		string(hash),
	).Scan(&adminID); err != nil {
		t.Fatalf("insert fixture admin: %v", err)
	}
	return &serviceHarness{
		owner:       owner,
		runner:      runner,
		credentials: credentials,
		service:     NewService(runner, credentials),
		admin:       authz.Principal{SessionID: "session-id", UserID: adminID, Email: "admin@nevix.test", DisplayName: "Admin", Role: "admin"},
	}
}

// issueProof issues one proof for the given action with the admin's current
// password, failing the test on any rejection.
func (h *serviceHarness) issueProof(t *testing.T, ctx context.Context, action, password string) IssueResponse {
	t.Helper()
	actionPtr, passwordPtr := action, password
	issued, err := h.service.Issue(ctx, h.admin, IssueRequest{Action: &actionPtr, Password: &passwordPtr})
	if err != nil {
		t.Fatalf("issue %s proof: %v", action, err)
	}
	return issued
}

// consumeProof presents one proof for the given action and returns the
// service outcome without failing the test.
func (h *serviceHarness) consumeProof(ctx context.Context, proof, action string) (ConsumeResponse, error) {
	proofPtr, actionPtr := proof, action
	return h.service.Consume(ctx, h.admin, ConsumeRequest{Proof: &proofPtr, Action: &actionPtr})
}

// proofRow reads one proof row's persisted state by token.
func (h *serviceHarness) proofRow(t *testing.T, ctx context.Context, token string) (action string, expiresAt, consumedAt *time.Time) {
	t.Helper()
	err := h.owner.QueryRow(ctx,
		`SELECT action, expires_at, consumed_at FROM public.reauth_proofs WHERE token_hash = $1`,
		hashToken(token),
	).Scan(&action, &expiresAt, &consumedAt)
	if err != nil {
		t.Fatalf("read proof row: %v", err)
	}
	return action, expiresAt, consumedAt
}

func TestIssueStoresOnlyTheHashWithAFiveMinuteWindow(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	h := newServiceHarness(t, ctx)

	before := time.Now().Add(-2 * time.Second)
	issued := h.issueProof(t, ctx, ActionProviderConnectionReplace, "correct-password-1")
	after := time.Now().Add(2 * time.Second)

	if issued.Proof == "" || issued.Action != ActionProviderConnectionReplace {
		t.Fatalf("issue response = %+v, want the opaque proof and the bound action", issued)
	}
	// The five-minute window is fixed and database-clocked: the stored
	// expiry must fall within the issue statement's bounds.
	if issued.ExpiresAt.Before(before.Add(Validity)) || issued.ExpiresAt.After(after.Add(Validity)) {
		t.Fatalf("expires_at = %v, want issue time + %v", issued.ExpiresAt, Validity)
	}
	rowAction, expiresAt, consumedAt := h.proofRow(t, ctx, issued.Proof)
	if rowAction != ActionProviderConnectionReplace {
		t.Fatalf("stored action = %q, want the bound action", rowAction)
	}
	if consumedAt != nil {
		t.Fatal("fresh proof is already consumed")
	}
	if !expiresAt.Equal(issued.ExpiresAt) {
		t.Fatalf("stored expiry %v differs from the response %v", expiresAt, issued.ExpiresAt)
	}
	// Only the hash is persisted: the token body never appears in storage.
	var storedToken string
	err := h.owner.QueryRow(ctx, `SELECT encode(token_hash, 'hex') FROM public.reauth_proofs WHERE token_hash = $1`, hashToken(issued.Proof)).Scan(&storedToken)
	if err != nil {
		t.Fatalf("read stored hash: %v", err)
	}
	if storedToken == issued.Proof {
		t.Fatal("the proof body is stored verbatim; only the hash may persist")
	}

	// A wrong current password issues nothing.
	wrongPassword := "wrong-password-1"
	validAction := ActionProviderConnectionReplace
	if _, err := h.service.Issue(ctx, h.admin, IssueRequest{Action: &validAction, Password: &wrongPassword}); err == nil {
		t.Fatal("issue with a wrong password succeeded")
	}
}

func TestConsumeFailsClosedWithoutBurningTheProof(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	h := newServiceHarness(t, ctx)

	issued := h.issueProof(t, ctx, ActionProviderConnectionDelete, "correct-password-1")

	// Wrong action: rejected, and the proof stays consumable for its own
	// action — a mismatch is not a consumption.
	if _, err := h.consumeProof(ctx, issued.Proof, ActionProviderConnectionCreate); !errors.Is(err, ErrProofActionMismatch) {
		t.Fatalf("mismatched consume error = %v, want ErrProofActionMismatch", err)
	}
	if _, _, consumedAt := h.proofRow(t, ctx, issued.Proof); consumedAt != nil {
		t.Fatal("mismatched attempt stamped consumption")
	}

	// Unknown token: invalid.
	if _, err := h.consumeProof(ctx, "not-a-real-proof", ActionProviderConnectionDelete); !errors.Is(err, ErrProofInvalid) {
		t.Fatalf("unknown-token consume error = %v, want ErrProofInvalid", err)
	}

	// A proof issued by another principal is not consumable through this
	// one: issuer binding fails closed as invalid.
	stranger := h.admin
	stranger.UserID = "00000000-0000-0000-0000-000000000000"
	proofPtr, actionPtr := issued.Proof, ActionProviderConnectionDelete
	if _, err := h.service.Consume(ctx, stranger, ConsumeRequest{Proof: &proofPtr, Action: &actionPtr}); !errors.Is(err, ErrProofInvalid) {
		t.Fatalf("stranger consume error = %v, want ErrProofInvalid", err)
	}

	// Expired: rejected without a stamp. The fixture moves the window into
	// the past through the owner credential — the database clock decides.
	if _, err := h.owner.Exec(ctx, `UPDATE public.reauth_proofs SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, hashToken(issued.Proof)); err != nil {
		t.Fatalf("age out the proof: %v", err)
	}
	if _, err := h.consumeProof(ctx, issued.Proof, ActionProviderConnectionDelete); !errors.Is(err, ErrProofExpired) {
		t.Fatalf("expired consume error = %v, want ErrProofExpired", err)
	}
	if _, _, consumedAt := h.proofRow(t, ctx, issued.Proof); consumedAt != nil {
		t.Fatal("expired attempt stamped consumption")
	}
}

func TestConsumeIsExactlyOnceUnderConcurrencyAndNeverRestored(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newServiceHarness(t, ctx)

	issued := h.issueProof(t, ctx, ActionProviderConnectionCreate, "correct-password-1")

	// Eight concurrent presentations of one proof: exactly one wins, every
	// loser observes already-consumed, and no row state other than the one
	// stamp exists afterwards.
	const racers = 8
	var wins, alreadyConsumed int64
	start := make(chan struct{})
	var wg sync.WaitGroup
	errs := make([]error, racers)
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, errs[i] = h.consumeProof(ctx, issued.Proof, ActionProviderConnectionCreate)
		}(i)
	}
	close(start)
	wg.Wait()
	for _, err := range errs {
		switch {
		case err == nil:
			atomic.AddInt64(&wins, 1)
		case errors.Is(err, ErrProofAlreadyConsumed):
			atomic.AddInt64(&alreadyConsumed, 1)
		default:
			t.Fatalf("concurrent consume returned %v, want one winner and already-consumed losers", err)
		}
	}
	if wins != 1 || alreadyConsumed != racers-1 {
		t.Fatalf("wins = %d, already_consumed = %d, want 1 and %d", wins, alreadyConsumed, racers-1)
	}

	// A later downstream failure cannot restore the spent proof: after an
	// intervening failed command (a failed issuance), the proof still
	// answers already-consumed and the stamp is unchanged.
	wrongPassword := "wrong-password-1"
	failedAction := ActionProviderConnectionCreate
	if _, err := h.service.Issue(ctx, h.admin, IssueRequest{Action: &failedAction, Password: &wrongPassword}); err == nil {
		t.Fatal("intervening failed command unexpectedly succeeded")
	}
	if _, err := h.consumeProof(ctx, issued.Proof, ActionProviderConnectionCreate); !errors.Is(err, ErrProofAlreadyConsumed) {
		t.Fatalf("post-failure consume error = %v, want ErrProofAlreadyConsumed", err)
	}
	_, _, consumedAt := h.proofRow(t, ctx, issued.Proof)
	if consumedAt == nil {
		t.Fatal("consumption stamp vanished after the downstream failure")
	}
}

func TestConsumeRollsBackWithItsAuditRow(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	h := newServiceHarness(t, ctx)

	// Inject a failure at the consumption transaction's last participant —
	// the audit append — so the whole transition must roll back: the proof
	// survives unconsumed and succeeds once the injection is gone.
	if _, err := h.owner.Exec(ctx,
		`CREATE OR REPLACE FUNCTION public.fail_reauth_consume_audit() RETURNS trigger AS $fn$ BEGIN RAISE EXCEPTION 'injected audit failure'; END $fn$ LANGUAGE plpgsql`); err != nil {
		t.Fatalf("install failing audit function: %v", err)
	}
	t.Cleanup(func() {
		if _, err := h.owner.Exec(context.Background(), `DROP FUNCTION IF EXISTS public.fail_reauth_consume_audit()`); err != nil {
			t.Errorf("drop failing audit function: %v", err)
		}
	})
	if _, err := h.owner.Exec(ctx,
		`CREATE TRIGGER fail_reauth_consume_audit BEFORE INSERT ON public.audit_logs FOR EACH ROW WHEN (NEW.action = 'reauth_proof_consumed') EXECUTE FUNCTION public.fail_reauth_consume_audit()`); err != nil {
		t.Fatalf("install failing audit trigger: %v", err)
	}
	t.Cleanup(func() {
		if _, err := h.owner.Exec(context.Background(), `DROP TRIGGER IF EXISTS fail_reauth_consume_audit ON public.audit_logs`); err != nil {
			t.Errorf("drop failing audit trigger: %v", err)
		}
	})

	issued := h.issueProof(t, ctx, ActionProviderConnectionReplace, "correct-password-1")
	if _, err := h.consumeProof(ctx, issued.Proof, ActionProviderConnectionReplace); err == nil {
		t.Fatal("consume succeeded despite the audit failure; the transition must roll back with its audit row")
	}
	if _, _, consumedAt := h.proofRow(t, ctx, issued.Proof); consumedAt != nil {
		t.Fatal("a rolled-back consumption left its stamp behind")
	}
}

func TestIssueRechecksCredentialStampAndStatusUnderLock(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	h := newServiceHarness(t, ctx)

	// The stamp the caller verified against the committed hash.
	var verifiedStamp string
	if err := h.owner.QueryRow(ctx, `SELECT password_hash FROM public.users WHERE id = $1`, h.admin.UserID).Scan(&verifiedStamp); err != nil {
		t.Fatalf("read committed hash: %v", err)
	}

	recheck := func() error {
		return h.runner.Run(ctx, func(sc *writetx.Scope) error {
			return recheckIssuerUnderLock(ctx, sc.Tx(), h.admin.UserID, verifiedStamp)
		})
	}

	// A committed password change between verification and the lock point
	// fails issuance with the uniform credential answer — and no proof row
	// is written.
	if _, err := h.owner.Exec(ctx, `UPDATE public.users SET password_hash = 'rotated-hash' WHERE id = $1`, h.admin.UserID); err != nil {
		t.Fatalf("rotate the credential: %v", err)
	}
	if err := recheck(); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Fatalf("stale-stamp recheck error = %v, want auth.ErrInvalidCredentials", err)
	}
	action, password := ActionProviderConnectionCreate, "correct-password-1"
	if _, err := h.service.Issue(ctx, h.admin, IssueRequest{Action: &action, Password: &password}); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Fatalf("stale-stamp issue error = %v, want auth.ErrInvalidCredentials", err)
	}
	var rows int
	if err := h.owner.QueryRow(ctx, `SELECT count(*) FROM public.reauth_proofs`).Scan(&rows); err != nil {
		t.Fatalf("count proofs: %v", err)
	}
	if rows != 0 {
		t.Fatalf("refused issuance persisted %d proof rows", rows)
	}

	// A committed disable between verification and the lock point fails
	// issuance with the disabled-account answer.
	if _, err := h.owner.Exec(ctx, `UPDATE public.users SET password_hash = $2, status = 'disabled' WHERE id = $1`, h.admin.UserID, verifiedStamp); err != nil {
		t.Fatalf("disable the account: %v", err)
	}
	if err := recheck(); !errors.Is(err, auth.ErrAccountDisabled) {
		t.Fatalf("disabled recheck error = %v, want auth.ErrAccountDisabled", err)
	}

	// An unchanged credential and an active account pass the lock point.
	if _, err := h.owner.Exec(ctx, `UPDATE public.users SET status = 'active' WHERE id = $1`, h.admin.UserID); err != nil {
		t.Fatalf("re-enable the account: %v", err)
	}
	if err := recheck(); err != nil {
		t.Fatalf("fresh recheck error = %v", err)
	}
}

func TestSweepDeletesOnlyExpiredProofs(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	h := newServiceHarness(t, ctx)

	live := h.issueProof(t, ctx, ActionProviderConnectionDelete, "correct-password-1")
	if _, err := h.owner.Exec(ctx,
		`INSERT INTO public.reauth_proofs (user_id, action, token_hash, expires_at) VALUES ($1, $2, $3, now() - interval '1 second')`,
		h.admin.UserID, ActionProviderConnectionCreate, hashToken("swept-expired-proof")); err != nil {
		t.Fatalf("insert expired fixture: %v", err)
	}

	if err := h.service.SweepExpired(ctx); err != nil {
		t.Fatalf("sweep: %v", err)
	}

	var remaining int
	if err := h.owner.QueryRow(ctx, `SELECT count(*) FROM public.reauth_proofs`).Scan(&remaining); err != nil {
		t.Fatalf("count proofs: %v", err)
	}
	if remaining != 1 {
		t.Fatalf("remaining proofs = %d, want 1 (the live window; expiry is enforced at consumption, the sweep only reclaims)", remaining)
	}
	if _, _, consumedAt := h.proofRow(t, ctx, live.Proof); consumedAt != nil {
		t.Fatal("sweep disturbed the live proof")
	}
}
