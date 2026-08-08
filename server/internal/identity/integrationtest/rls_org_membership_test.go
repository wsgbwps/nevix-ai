// This file proves the Organization Membership schema foundation's RLS/GRANT
// matrix (identity-org-membership ticket 01, ADR-0008) with real
// anon/authenticated tokens against PostgREST: cross-organization read
// isolation, and the client write boundary (only the own profile row is
// writable; organizations/memberships are SELECT-only). Seeding runs as the
// identity_app role, which doubles as proof of its GRANTs and permissive
// policies.
//
// Like the other integration tests here it is opt-in: it skips unless the
// harness (scripts/test-mail-smoke.sh) exports the stack environment.
package integrationtest

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nevix-ai/server/internal/identity/mailpittest"
)

// rlsStack wires the RLS tests to the running local Supabase stack.
type rlsStack struct {
	supabaseURL    string
	publishableKey string
	pool           *pgxpool.Pool
	mailpit        *mailpittest.Client
}

func newRLSStack(t *testing.T, ctx context.Context) *rlsStack {
	t.Helper()
	supabaseURL := requireEnv(t, "NEVIX_SUPABASE_URL")
	publishableKey := requireEnv(t, "NEVIX_SUPABASE_PUBLISHABLE_KEY")
	databaseURL := requireEnv(t, "NEVIX_DATABASE_URL")
	mailpitURL := requireEnv(t, "NEVIX_MAILPIT_URL")

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect to database: %v", err)
	}
	t.Cleanup(pool.Close)
	return &rlsStack{
		supabaseURL:    supabaseURL,
		publishableKey: publishableKey,
		pool:           pool,
		mailpit:        mailpittest.NewClient(mailpitURL),
	}
}

// rlsUser is one confirmed GoTrue user with a real authenticated JWT.
type rlsUser struct {
	ID    string
	Email string
	Token string
}

// signUpConfirmedUser registers a unique user through GoTrue, confirms the
// signup with the six-digit code captured in Mailpit, and returns the session
// token the Data API accepts.
func (s *rlsStack) signUpConfirmedUser(t *testing.T, ctx context.Context, label string) rlsUser {
	t.Helper()
	email := fmt.Sprintf("rls-%s-%d@nevix.test", label, time.Now().UnixNano())

	status, body := s.gotrueRequest(t, ctx, http.MethodPost, "/auth/v1/signup", map[string]string{
		"email":    email,
		"password": "rls-integration-password-1",
	})
	if status != http.StatusOK {
		t.Fatalf("signup %s: status %d: %s", email, status, body)
	}

	messages, err := s.mailpit.WaitForMessages(ctx, fmt.Sprintf("to:%q", email))
	if err != nil {
		t.Fatalf("confirmation email for %s never reached Mailpit: %v", email, err)
	}
	detail, err := s.mailpit.Message(ctx, messages[0].ID)
	if err != nil {
		t.Fatalf("read confirmation email for %s: %v", email, err)
	}

	status, body = s.gotrueRequest(t, ctx, http.MethodPost, "/auth/v1/verify", map[string]string{
		"type":  "signup",
		"email": email,
		"token": extractCode(t, detail.Text),
	})
	if status != http.StatusOK {
		t.Fatalf("verify signup %s: status %d: %s", email, status, body)
	}
	var session struct {
		AccessToken string `json:"access_token"`
		User        struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	if err := json.Unmarshal(body, &session); err != nil {
		t.Fatalf("decode verify response for %s: %v", email, err)
	}
	if session.AccessToken == "" || session.User.ID == "" {
		t.Fatalf("verify response for %s carries no session: %s", email, body)
	}
	return rlsUser{ID: session.User.ID, Email: email, Token: session.AccessToken}
}

// gotrueRequest posts one JSON body to GoTrue with the publishable key and
// returns the status and raw body.
func (s *rlsStack) gotrueRequest(t *testing.T, ctx context.Context, method, path string, payload any) (int, []byte) {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal %s payload: %v", path, err)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.supabaseURL+path, bytes.NewReader(encoded))
	if err != nil {
		t.Fatalf("build %s request: %v", path, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("apikey", s.publishableKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s request: %v", path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read %s response: %v", path, err)
	}
	return resp.StatusCode, body
}

// rest calls the Data API; an empty token sends an anon request (apikey only).
func (s *rlsStack) rest(t *testing.T, ctx context.Context, method, path, token string, payload any) (int, []byte) {
	t.Helper()
	var bodyReader io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("marshal %s %s payload: %v", method, path, err)
		}
		bodyReader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.supabaseURL+"/rest/v1"+path, bodyReader)
	if err != nil {
		t.Fatalf("build %s %s request: %v", method, path, err)
	}
	req.Header.Set("apikey", s.publishableKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Prefer", "return=representation")
	// The schema cache of the running PostgREST may predate this migration;
	// force the latest exposed schema.
	req.Header.Set("Accept-Profile", "public")
	req.Header.Set("Content-Profile", "public")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s request: %v", method, path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read %s %s response: %v", method, path, err)
	}
	return resp.StatusCode, body
}

// restRows is rest plus a decode into a row list for successful reads.
func (s *rlsStack) restRows(t *testing.T, ctx context.Context, path, token string) []map[string]any {
	t.Helper()
	status, body := s.rest(t, ctx, http.MethodGet, path, token, nil)
	if status != http.StatusOK {
		t.Fatalf("GET %s: status %d: %s", path, status, body)
	}
	var rows []map[string]any
	if err := json.Unmarshal(body, &rows); err != nil {
		t.Fatalf("GET %s: decode rows: %v", path, err)
	}
	return rows
}

func newRLSOrgID(t *testing.T) string {
	t.Helper()
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		t.Fatalf("generate organization id: %v", err)
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16])
}

// membershipSeed is one membership row seeded through identity_app.
type membershipSeed struct {
	OrganizationID string
	UserID         string
	Role           string
	Status         string
}

// seedAsIdentityApp writes organizations and memberships inside one
// transaction running as the identity_app role — the same privileges the Go
// commands will hold, so every seed also proves those GRANTs.
func (s *rlsStack) seedAsIdentityApp(t *testing.T, ctx context.Context, orgIDs []string, orgNames []string, memberships []membershipSeed) {
	t.Helper()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin seed transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SET LOCAL ROLE identity_app"); err != nil {
		t.Fatalf("switch to identity_app: %v", err)
	}
	for i, orgID := range orgIDs {
		if _, err := tx.Exec(ctx, "INSERT INTO public.organizations (id, name) VALUES ($1, $2)", orgID, orgNames[i]); err != nil {
			t.Fatalf("seed organization %s: %v", orgID, err)
		}
	}
	for _, membership := range memberships {
		if _, err := tx.Exec(ctx,
			"INSERT INTO public.memberships (organization_id, user_id, role, status) VALUES ($1, $2, $3, $4)",
			membership.OrganizationID, membership.UserID, membership.Role, membership.Status); err != nil {
			t.Fatalf("seed membership %s/%s: %v", membership.OrganizationID, membership.UserID, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed transaction: %v", err)
	}
}

func userIDOf(rows []map[string]any) []string {
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, fmt.Sprint(row["user_id"]))
	}
	return ids
}

// TestRLSCrossOrganizationIsolation proves the read matrix with real
// authenticated tokens: organizations and memberships are visible only within
// the caller's active organizations, profiles only to the owner and active
// co-members, and anon is denied outright.
func TestRLSCrossOrganizationIsolation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	stack := newRLSStack(t, ctx)

	ownerA := stack.signUpConfirmedUser(t, ctx, "owner-a")
	member := stack.signUpConfirmedUser(t, ctx, "member")
	ownerB := stack.signUpConfirmedUser(t, ctx, "owner-b")

	orgA, orgB := newRLSOrgID(t), newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgA, orgB}, []string{"RLS Org A", "RLS Org B"},
		[]membershipSeed{
			{orgA, ownerA.ID, "owner", "active"},
			{orgA, member.ID, "member", "active"},
			{orgB, ownerB.ID, "owner", "active"},
			// The member once belonged to Org B; the ended row stays.
			{orgB, member.ID, "member", "ended"},
		})

	// Every user creates their own profile through the Data API.
	for _, user := range []rlsUser{ownerA, member, ownerB} {
		status, body := stack.rest(t, ctx, http.MethodPost, "/profiles", user.Token,
			map[string]string{"user_id": user.ID, "display_name": "RLS " + user.ID[:8]})
		if status != http.StatusCreated {
			t.Fatalf("insert own profile for %s: status %d: %s", user.Email, status, body)
		}
	}

	// Organizations: active members only.
	for _, check := range []struct {
		user rlsUser
		want string
	}{
		{ownerA, "RLS Org A"},
		{member, "RLS Org A"},
		{ownerB, "RLS Org B"},
	} {
		rows := stack.restRows(t, ctx, "/organizations?select=name", check.user.Token)
		if len(rows) != 1 || fmt.Sprint(rows[0]["name"]) != check.want {
			t.Fatalf("%s sees organizations %v, want exactly [%s]", check.user.Email, rows, check.want)
		}
	}

	// Profiles: own row plus active co-members, never cross-organization.
	profileChecks := []struct {
		user rlsUser
		want []string
		not  []string
	}{
		{ownerA, []string{ownerA.ID, member.ID}, []string{ownerB.ID}},
		{member, []string{member.ID, ownerA.ID}, []string{ownerB.ID}},
		{ownerB, []string{ownerB.ID}, []string{ownerA.ID, member.ID}},
	}
	for _, check := range profileChecks {
		ids := userIDOf(stack.restRows(t, ctx, "/profiles?select=user_id", check.user.Token))
		for _, want := range check.want {
			if !slices.Contains(ids, want) {
				t.Fatalf("%s should see profile %s, sees %v", check.user.Email, want, ids)
			}
		}
		for _, forbidden := range check.not {
			if slices.Contains(ids, forbidden) {
				t.Fatalf("%s must not see profile %s, sees %v", check.user.Email, forbidden, ids)
			}
		}
	}

	// Memberships: own rows including ended ones, plus the active rows of the
	// caller's organizations; other organizations' ended rows stay hidden.
	memberRows := stack.restRows(t, ctx, "/memberships?select=organization_id,user_id,status", member.Token)
	if len(memberRows) != 3 {
		t.Fatalf("member sees %d membership rows, want 3: %v", len(memberRows), memberRows)
	}
	ownerBRows := stack.restRows(t, ctx, "/memberships?select=organization_id,user_id,status", ownerB.Token)
	if len(ownerBRows) != 1 {
		t.Fatalf("owner B sees %d membership rows, want exactly the own active one: %v", len(ownerBRows), ownerBRows)
	}
	if fmt.Sprint(ownerBRows[0]["status"]) != "active" || fmt.Sprint(ownerBRows[0]["user_id"]) != ownerB.ID {
		t.Fatalf("owner B sees %v, want the own active membership", ownerBRows)
	}

	// anon: no table privileges, denied before RLS even evaluates.
	status, _ := stack.rest(t, ctx, http.MethodGet, "/organizations?select=name", "", nil)
	if status < 400 {
		t.Fatalf("anon read organizations: status %d, want denial", status)
	}
}

// TestRLSClientWriteBoundary proves the write matrix: the client writes only
// its own profile row; organizations, memberships, invitations, and audit logs
// are SELECT-only; and identity_app has exactly its trusted-command grants.
func TestRLSClientWriteBoundary(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	stack := newRLSStack(t, ctx)

	owner := stack.signUpConfirmedUser(t, ctx, "write-owner")
	other := stack.signUpConfirmedUser(t, ctx, "write-other")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"RLS Write Org"},
		[]membershipSeed{
			{orgID, owner.ID, "owner", "active"},
			{orgID, other.ID, "member", "active"},
		})

	// Own profile row: insert then update.
	status, body := stack.rest(t, ctx, http.MethodPost, "/profiles", owner.Token,
		map[string]string{"user_id": owner.ID, "display_name": "Write Owner"})
	if status != http.StatusCreated {
		t.Fatalf("insert own profile: status %d: %s", status, body)
	}
	status, body = stack.rest(t, ctx, http.MethodPatch, "/profiles?user_id=eq."+owner.ID, owner.Token,
		map[string]string{"display_name": "Write Owner v2"})
	if status != http.StatusOK {
		t.Fatalf("update own profile: status %d: %s", status, body)
	}

	// Someone else's profile row: insert is rejected, update touches nothing.
	status, body = stack.rest(t, ctx, http.MethodPost, "/profiles", owner.Token,
		map[string]string{"user_id": other.ID, "display_name": "Imposter"})
	if status != http.StatusForbidden {
		t.Fatalf("insert another user's profile: status %d: %s, want 403", status, body)
	}
	status, body = stack.rest(t, ctx, http.MethodPatch, "/profiles?user_id=eq."+other.ID, owner.Token,
		map[string]string{"display_name": "Hijacked"})
	if status != http.StatusOK || string(bytes.TrimSpace(body)) != "[]" {
		t.Fatalf("update another user's profile: status %d body %s, want zero affected rows", status, body)
	}

	// organizations, memberships, invitations, and audit logs are client
	// SELECT-only.
	deniedWrites := []struct {
		method  string
		path    string
		payload any
	}{
		{http.MethodPost, "/organizations", map[string]string{"id": newRLSOrgID(t), "name": "Client Created"}},
		{http.MethodPatch, "/organizations?id=eq." + orgID, map[string]string{"name": "Renamed"}},
		{http.MethodPost, "/memberships", map[string]string{"organization_id": orgID, "user_id": other.ID, "role": "admin", "status": "active"}},
		{http.MethodPatch, "/memberships?user_id=eq." + other.ID, map[string]string{"role": "admin"}},
		{http.MethodDelete, "/memberships?user_id=eq." + other.ID, nil},
		{http.MethodPost, "/invitations", map[string]any{"organization_id": orgID, "email": "client@example.test", "expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}},
		{http.MethodPatch, "/invitations?organization_id=eq." + orgID, map[string]string{"status": "revoked"}},
		{http.MethodDelete, "/invitations?organization_id=eq." + orgID, nil},
		{http.MethodPost, "/audit_logs", map[string]any{"organization_id": orgID, "actor_user_id": owner.ID, "actor_display_name": "Write Owner", "target_user_id": other.ID, "target_display_name": "Write Other", "action": "member_removed", "metadata": map[string]string{"source": "client"}}},
		{http.MethodPatch, "/audit_logs?organization_id=eq." + orgID, map[string]string{"action": "rewritten"}},
		{http.MethodDelete, "/audit_logs?organization_id=eq." + orgID, nil},
	}
	for _, write := range deniedWrites {
		status, body := stack.rest(t, ctx, write.method, write.path, owner.Token, write.payload)
		if status != http.StatusForbidden {
			t.Fatalf("client %s %s: status %d: %s, want 403", write.method, write.path, status, body)
		}
	}

	// identity_app updates memberships (command write path) but holds no
	// profile write grant, and reads the directory for email resolution.
	var auditLogID string
	tx, err := stack.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin identity_app transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SET LOCAL ROLE identity_app"); err != nil {
		t.Fatalf("switch to identity_app: %v", err)
	}
	if _, err := tx.Exec(ctx,
		"UPDATE public.memberships SET role = 'admin', updated_at = now() WHERE user_id = $1 AND organization_id = $2",
		other.ID, orgID); err != nil {
		t.Fatalf("identity_app update membership: %v", err)
	}
	var invitationID string
	if err := tx.QueryRow(ctx,
		`INSERT INTO public.invitations (organization_id, email, expires_at)
		 VALUES ($1, 'trusted@example.test', now() + interval '7 days')
		 RETURNING id`, orgID,
	).Scan(&invitationID); err != nil {
		t.Fatalf("identity_app insert invitation: %v", err)
	}
	if _, err := tx.Exec(ctx,
		"UPDATE public.invitations SET status = 'revoked' WHERE id = $1", invitationID,
	); err != nil {
		t.Fatalf("identity_app update invitation: %v", err)
	}
	if err := tx.QueryRow(ctx,
		`INSERT INTO public.audit_logs (
		   organization_id, actor_user_id, actor_display_name,
		   target_user_id, target_display_name, action, metadata
		 ) VALUES ($1, $2, 'Write Owner', $3, 'Write Other', 'member_removed', '{"source":"trusted"}')
		 RETURNING id`,
		orgID, owner.ID, other.ID,
	).Scan(&auditLogID); err != nil {
		t.Fatalf("identity_app insert audit log: %v", err)
	}
	var auditAction string
	if err := tx.QueryRow(ctx,
		"SELECT action FROM public.audit_logs WHERE id = $1", auditLogID,
	).Scan(&auditAction); err != nil {
		t.Fatalf("identity_app select audit log: %v", err)
	}
	if auditAction != "member_removed" {
		t.Fatalf("identity_app read audit action %q, want member_removed", auditAction)
	}
	var codeID string
	var failedAttempts int
	if err := tx.QueryRow(ctx,
		`INSERT INTO identity.verification_codes (
		   email, code_hash, request_ip, status, expires_at, action_type, target_id
		 ) VALUES ($1, 'trusted-code-hash', '127.0.0.1', 'consumed',
		   now() + interval '10 minutes', 'invitation', $2)
		 RETURNING id, failed_attempts`,
		other.Email, newRLSOrgID(t),
	).Scan(&codeID, &failedAttempts); err != nil {
		t.Fatalf("identity_app insert consumed verification code: %v", err)
	}
	if failedAttempts != 0 {
		t.Fatalf("new verification code has %d failed attempts, want 0", failedAttempts)
	}
	if _, err := tx.Exec(ctx,
		"UPDATE identity.verification_codes SET failed_attempts = 1 WHERE id = $1", codeID,
	); err != nil {
		t.Fatalf("identity_app update verification code attempts: %v", err)
	}
	var directoryRows int
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM identity.directory").Scan(&directoryRows); err != nil {
		t.Fatalf("identity_app read identity.directory: %v", err)
	}
	if directoryRows < 2 {
		t.Fatalf("identity.directory has %d rows, want at least the two test users", directoryRows)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit identity_app transaction: %v", err)
	}
	// Audit logs are immutable to identity_app even though that role can insert,
	// select, and delete them for commands and retention.
	auditUpdateTx, err := stack.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin audit update denial transaction: %v", err)
	}
	if _, err := auditUpdateTx.Exec(ctx, "SET LOCAL ROLE identity_app"); err != nil {
		_ = auditUpdateTx.Rollback(ctx)
		t.Fatalf("switch to identity_app for audit update denial: %v", err)
	}
	if _, err := auditUpdateTx.Exec(ctx,
		"UPDATE public.audit_logs SET action = 'rewritten' WHERE id = $1", auditLogID,
	); err == nil {
		_ = auditUpdateTx.Rollback(ctx)
		t.Fatal("identity_app must not update audit logs, but the update succeeded")
	}
	if err := auditUpdateTx.Rollback(ctx); err != nil {
		t.Fatalf("rollback audit update denial transaction: %v", err)
	}

	retentionTx, err := stack.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin audit retention transaction: %v", err)
	}
	defer func() { _ = retentionTx.Rollback(ctx) }()
	if _, err := retentionTx.Exec(ctx, "SET LOCAL ROLE identity_app"); err != nil {
		t.Fatalf("switch to identity_app for audit retention: %v", err)
	}
	tag, err := retentionTx.Exec(ctx, "DELETE FROM public.audit_logs WHERE id = $1", auditLogID)
	if err != nil {
		t.Fatalf("identity_app delete audit log: %v", err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("identity_app deleted %d audit logs, want 1", tag.RowsAffected())
	}
	if err := retentionTx.Commit(ctx); err != nil {
		t.Fatalf("commit audit retention transaction: %v", err)
	}

	// The profiles write denial must be checked in its own transaction: a
	// failed statement aborts the surrounding transaction.
	deniedTx, err := stack.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin identity_app denial transaction: %v", err)
	}
	defer func() { _ = deniedTx.Rollback(ctx) }()
	if _, err := deniedTx.Exec(ctx, "SET LOCAL ROLE identity_app"); err != nil {
		t.Fatalf("switch to identity_app: %v", err)
	}
	if _, err := deniedTx.Exec(ctx,
		"INSERT INTO public.profiles (user_id, display_name) VALUES ($1, 'Server Written')",
		other.ID); err == nil {
		t.Fatal("identity_app must not write profiles, but the insert succeeded")
	}

	// The role change above must not have leaked: the client still sees the
	// updated active row, nothing more.
	var role string
	err = stack.pool.QueryRow(ctx,
		"SELECT role FROM public.memberships WHERE user_id = $1 AND organization_id = $2 AND status = 'active'",
		other.ID, orgID).Scan(&role)
	if err == pgx.ErrNoRows {
		t.Fatal("seeded membership vanished after identity_app update")
	}
	if err != nil {
		t.Fatalf("read membership after identity_app update: %v", err)
	}
	if role != "admin" {
		t.Fatalf("membership role after identity_app update is %q, want admin", role)
	}
}

// TestRLSInvitationAndAuditLogVisibility proves the Membership slice's
// public read matrix: administrators see organization rows, invitees see only
// their own pending invitation, and a Member loses every organization-scoped
// row immediately when their Membership ends.
func TestRLSInvitationAndAuditLogVisibility(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	stack := newRLSStack(t, ctx)

	owner := stack.signUpConfirmedUser(t, ctx, "invitation-owner")
	admin := stack.signUpConfirmedUser(t, ctx, "invitation-admin")
	member := stack.signUpConfirmedUser(t, ctx, "invitation-member")
	invitee := stack.signUpConfirmedUser(t, ctx, "invitation-invitee")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"RLS Invitations Org"},
		[]membershipSeed{
			{orgID, owner.ID, "owner", "active"},
			{orgID, admin.ID, "admin", "active"},
			{orgID, member.ID, "member", "active"},
		})

	seedTx, err := stack.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin invitation seed transaction: %v", err)
	}
	defer func() { _ = seedTx.Rollback(ctx) }()
	if _, err := seedTx.Exec(ctx, "SET LOCAL ROLE identity_app"); err != nil {
		t.Fatalf("switch to identity_app for invitation seed: %v", err)
	}
	for _, status := range []string{"pending", "accepted", "revoked"} {
		if _, err := seedTx.Exec(ctx,
			`INSERT INTO public.invitations (organization_id, email, status, expires_at)
			 VALUES ($1, $2, $3, now() + interval '7 days')`,
			orgID, invitee.Email, status,
		); err != nil {
			t.Fatalf("seed %s invitation: %v", status, err)
		}
	}
	if _, err := seedTx.Exec(ctx,
		`INSERT INTO public.audit_logs (
		   organization_id, actor_user_id, actor_display_name,
		   target_user_id, target_display_name, action, metadata
		 ) VALUES ($1, $2, 'Invitation Owner', $3, 'Invitation Member',
		   'member_removed', '{"source":"rls"}')`,
		orgID, owner.ID, member.ID,
	); err != nil {
		t.Fatalf("seed audit log: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit invitation seed transaction: %v", err)
	}

	for _, administrator := range []rlsUser{owner, admin} {
		invitations := stack.restRows(t, ctx,
			"/invitations?select=id,status&organization_id=eq."+orgID, administrator.Token)
		if len(invitations) != 3 {
			t.Fatalf("%s sees invitations %v, want all three organization rows", administrator.Email, invitations)
		}
		auditLogs := stack.restRows(t, ctx,
			"/audit_logs?select=id&organization_id=eq."+orgID, administrator.Token)
		if len(auditLogs) != 1 {
			t.Fatalf("%s sees audit logs %v, want the organization row", administrator.Email, auditLogs)
		}
	}

	inviteeRows := stack.restRows(t, ctx,
		"/invitations?select=id,status&organization_id=eq."+orgID, invitee.Token)
	if len(inviteeRows) != 1 || fmt.Sprint(inviteeRows[0]["status"]) != "pending" {
		t.Fatalf("%s sees invitations %v, want only the pending row", invitee.Email, inviteeRows)
	}
	memberInvitations := stack.restRows(t, ctx,
		"/invitations?select=id&organization_id=eq."+orgID, member.Token)
	if len(memberInvitations) != 0 {
		t.Fatalf("Member sees invitations %v, want none", memberInvitations)
	}
	memberAuditLogs := stack.restRows(t, ctx,
		"/audit_logs?select=id&organization_id=eq."+orgID, member.Token)
	if len(memberAuditLogs) != 0 {
		t.Fatalf("Member sees audit logs %v, want none", memberAuditLogs)
	}

	activeOrganizations := stack.restRows(t, ctx,
		"/organizations?select=id&id=eq."+orgID, member.Token)
	if len(activeOrganizations) != 1 {
		t.Fatalf("active Member sees organizations %v, want the organization", activeOrganizations)
	}

	endTx, err := stack.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin membership end transaction: %v", err)
	}
	defer func() { _ = endTx.Rollback(ctx) }()
	if _, err := endTx.Exec(ctx, "SET LOCAL ROLE identity_app"); err != nil {
		t.Fatalf("switch to identity_app for membership end: %v", err)
	}
	if _, err := endTx.Exec(ctx,
		"UPDATE public.memberships SET status = 'ended' WHERE organization_id = $1 AND user_id = $2",
		orgID, member.ID,
	); err != nil {
		t.Fatalf("end membership: %v", err)
	}
	if err := endTx.Commit(ctx); err != nil {
		t.Fatalf("commit membership end: %v", err)
	}

	for _, path := range []string{
		"/organizations?select=id&id=eq." + orgID,
		"/invitations?select=id&organization_id=eq." + orgID,
		"/audit_logs?select=id&organization_id=eq." + orgID,
	} {
		rows := stack.restRows(t, ctx, path, member.Token)
		if len(rows) != 0 {
			t.Fatalf("ended Member GET %s returns %v, want no organization-scoped rows", path, rows)
		}
	}
}
