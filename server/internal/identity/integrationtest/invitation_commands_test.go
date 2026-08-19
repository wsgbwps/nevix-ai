// Integration tests for the Invitation trusted commands. They exercise the
// mounted identity Module against real PostgreSQL and Mailpit, asserting only
// externally observable HTTP, persisted state, and delivered-mail contracts.
package integrationtest

import (
	"bytes"
	"context"
	cryptorand "crypto/rand"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// identityCommand sends one JSON command over the mounted Module surface.
func identityCommand(t *testing.T, handler http.Handler, method, path, token string, payload any) (int, []byte) {
	t.Helper()
	status, body, _ := identityCommandFromIP(t, handler, method, path, token, "", payload)
	return status, body
}

func identityCommandFromIP(t *testing.T, handler http.Handler, method, path, token, clientIP string, payload any) (int, []byte, http.Header) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal %s %s request: %v", method, path, err)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	if clientIP == "" {
		hash := fnv.New32a()
		_, _ = hash.Write([]byte(t.Name()))
		sum := hash.Sum32()
		clientIP = fmt.Sprintf("198.18.%d.%d", byte(sum>>8), byte(sum))
	}
	req.RemoteAddr = clientIP + ":43210"
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes(), rec.Header()
}

func assertCommandError(t *testing.T, body []byte, want string) {
	t.Helper()
	var envelope struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("decode Identity command error: %v", err)
	}
	if envelope.Error != want {
		t.Fatalf("Identity command error = %q, want %q; body %s", envelope.Error, want, body)
	}
}

func seedProfile(t *testing.T, ctx context.Context, h *harness, userID, displayName string) {
	t.Helper()
	if _, err := h.fixturePool.Exec(ctx,
		`INSERT INTO public.profiles (user_id, display_name) VALUES ($1, $2)`, userID, displayName,
	); err != nil {
		t.Fatalf("seed profile %s: %v", userID, err)
	}
}

func ageActiveInvitationCodeBeyondCooldown(t *testing.T, ctx context.Context, h *harness, invitationID string) {
	t.Helper()
	result, err := h.fixturePool.Exec(ctx,
		`UPDATE identity.verification_codes
		 SET created_at = clock_timestamp() - interval '2 minutes'
		 WHERE target_id = $1 AND action_type = 'invitation' AND status = 'active'`, invitationID,
	)
	if err != nil {
		t.Fatalf("age active invitation code: %v", err)
	}
	if result.RowsAffected() != 1 {
		t.Fatalf("aged %d active invitation codes for %s, want 1", result.RowsAffected(), invitationID)
	}
}

func TestCreateInvitationEnforcesSharedCodeCooldownAndEmailLimit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "invitation-create-limit-owner")
	seedProfile(t, ctx, h, owner.ID, "Invitation Limit Owner")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Invitation Create Limit Org"},
		[]membershipSeed{{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"}},
	)
	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	token := keys.signToken(t, owner.ID, time.Now().Add(time.Hour))
	path := "/identity/organizations/" + orgID + "/invitations"

	cooldownEmail := fmt.Sprintf("invitation-create-cooldown-%d@nevix.test", time.Now().UnixNano())
	h.seedIssuance(t, ctx, cooldownEmail, "198.51.100.10", 10)
	status, body, headers := identityCommandFromIP(t, handler, http.MethodPost, path, token, "198.51.100.11", map[string]string{"email": cooldownEmail})
	if status != http.StatusTooManyRequests {
		t.Fatalf("create invitation during shared cooldown: status %d body %s, want 429", status, body)
	}
	assertCommandError(t, body, "cooldown_active")
	assertContractResponse(t, http.MethodPost, path, status, body)
	retryAfter, err := strconv.Atoi(headers.Get("Retry-After"))
	if err != nil || retryAfter < 1 || retryAfter > 60 {
		t.Fatalf("create invitation Retry-After %q, want 1..60 seconds", headers.Get("Retry-After"))
	}

	hourlyEmail := fmt.Sprintf("invitation-create-hourly-%d@nevix.test", time.Now().UnixNano())
	for i, ageSeconds := range []int{350, 280, 210, 140, 70} {
		h.seedIssuance(t, ctx, hourlyEmail, fmt.Sprintf("198.51.100.%d", 20+i), ageSeconds)
	}
	status, body, headers = identityCommandFromIP(t, handler, http.MethodPost, path, token, "198.51.100.30", map[string]string{"email": hourlyEmail})
	if status != http.StatusTooManyRequests {
		t.Fatalf("create invitation above shared email limit: status %d body %s, want 429", status, body)
	}
	assertCommandError(t, body, "email_rate_limited")
	assertContractResponse(t, http.MethodPost, path, status, body)
	if got := headers.Get("Retry-After"); got != "" {
		t.Fatalf("email-rate-limited create Retry-After = %q, want absent", got)
	}

	for _, email := range []string{cooldownEmail, hourlyEmail} {
		var invitations, outboxRows, audits int
		if err := h.fixturePool.QueryRow(ctx,
			`SELECT
				(SELECT count(*) FROM public.invitations WHERE organization_id = $1 AND email = $2),
				(SELECT count(*) FROM identity.outbox_messages WHERE recipient = $2),
				(SELECT count(*) FROM public.audit_logs WHERE organization_id = $1 AND metadata->>'email' = $2)`,
			orgID, email,
		).Scan(&invitations, &outboxRows, &audits); err != nil {
			t.Fatalf("read rejected create state for %s: %v", email, err)
		}
		if invitations != 0 || outboxRows != 0 || audits != 0 {
			t.Fatalf("rejected create for %s wrote invitation:%d outbox:%d audit:%d, want all zero", email, invitations, outboxRows, audits)
		}
	}
}

func TestResendInvitationEnforcesCooldownAndIPLimitWithoutMutation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "invitation-resend-limit-owner")
	seedProfile(t, ctx, h, owner.ID, "Invitation Resend Limit Owner")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Invitation Resend Limit Org"},
		[]membershipSeed{{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"}},
	)
	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	token := keys.signToken(t, owner.ID, time.Now().Add(time.Hour))
	createPath := "/identity/organizations/" + orgID + "/invitations"
	email := fmt.Sprintf("invitation-resend-limit-%d@nevix.test", time.Now().UnixNano())
	status, body, _ := identityCommandFromIP(t, handler, http.MethodPost, createPath, token, "203.0.113.40", map[string]string{"email": email})
	if status != http.StatusAccepted {
		t.Fatalf("create invitation for resend limits: status %d body %s, want 202", status, body)
	}

	var invitationID, codeID string
	var originalExpiresAt time.Time
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT i.id, i.expires_at, c.id
		 FROM public.invitations i
		 JOIN identity.verification_codes c ON c.target_id = i.id AND c.action_type = 'invitation'
		 WHERE i.organization_id = $1 AND i.email = $2`, orgID, email,
	).Scan(&invitationID, &originalExpiresAt, &codeID); err != nil {
		t.Fatalf("read invitation for resend limits: %v", err)
	}
	resendPath := createPath + "/" + invitationID + "/resend"

	status, body, headers := identityCommandFromIP(t, handler, http.MethodPost, resendPath, token, "203.0.113.41", map[string]string{})
	if status != http.StatusTooManyRequests {
		t.Fatalf("resend invitation during cooldown: status %d body %s, want 429", status, body)
	}
	assertCommandError(t, body, "cooldown_active")
	assertContractResponse(t, http.MethodPost, resendPath, status, body)
	retryAfter, err := strconv.Atoi(headers.Get("Retry-After"))
	if err != nil || retryAfter < 1 || retryAfter > 60 {
		t.Fatalf("resend invitation Retry-After %q, want 1..60 seconds", headers.Get("Retry-After"))
	}

	if _, err := h.fixturePool.Exec(ctx,
		`UPDATE identity.verification_codes SET created_at = now() - interval '2 minutes' WHERE id = $1`, codeID,
	); err != nil {
		t.Fatalf("age invitation code beyond cooldown: %v", err)
	}
	saturatedIP := "203.0.113.42"
	for i := 0; i < 20; i++ {
		h.seedIssuance(t, ctx, fmt.Sprintf("invitation-ip-seed-%d-%d@nevix.test", time.Now().UnixNano(), i), saturatedIP, 120+i)
	}
	status, body, headers = identityCommandFromIP(t, handler, http.MethodPost, resendPath, token, saturatedIP, map[string]string{})
	if status != http.StatusTooManyRequests {
		t.Fatalf("resend invitation above shared IP limit: status %d body %s, want 429", status, body)
	}
	assertCommandError(t, body, "ip_rate_limited")
	assertContractResponse(t, http.MethodPost, resendPath, status, body)
	if got := headers.Get("Retry-After"); got != "" {
		t.Fatalf("IP-rate-limited resend Retry-After = %q, want absent", got)
	}

	var currentExpiresAt time.Time
	var codeStatus, outboxStatus string
	var codeRows, outboxRows, auditRows int
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT i.expires_at, c.status, o.status,
			(SELECT count(*) FROM identity.verification_codes WHERE target_id = i.id AND action_type = 'invitation'),
			(SELECT count(*) FROM identity.outbox_messages WHERE recipient = i.email),
			(SELECT count(*) FROM public.audit_logs WHERE organization_id = i.organization_id AND metadata->>'invitation_id' = i.id::text)
		 FROM public.invitations i
		 JOIN identity.verification_codes c ON c.id = $2
		 JOIN identity.outbox_messages o ON o.verification_code_id = c.id
		 WHERE i.id = $1`, invitationID, codeID,
	).Scan(&currentExpiresAt, &codeStatus, &outboxStatus, &codeRows, &outboxRows, &auditRows); err != nil {
		t.Fatalf("read rejected resend state: %v", err)
	}
	if !currentExpiresAt.Equal(originalExpiresAt) || codeStatus != "active" || outboxStatus != "pending" || codeRows != 1 || outboxRows != 1 || auditRows != 1 {
		t.Fatalf("rejected resends changed state: expires=%s code=%s outbox=%s rows=(%d,%d,%d)", currentExpiresAt, codeStatus, outboxStatus, codeRows, outboxRows, auditRows)
	}
}

func TestCreateInvitationQueuesBilingualCodeEmailAndAuditSnapshot(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "invitation-owner")
	invitee := stack.signUpConfirmedUser(t, ctx, "invitation-invitee")
	seedProfile(t, ctx, h, owner.ID, "Owner Snapshot")
	seedProfile(t, ctx, h, invitee.ID, "Invitee Snapshot")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Invitation Org"},
		[]membershipSeed{{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"}},
	)
	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	h.startWorker(t)

	before, err := h.mailpit.Search(ctx, fmt.Sprintf("to:%q", invitee.Email))
	if err != nil {
		t.Fatalf("count prior mail for invitee: %v", err)
	}
	path := "/identity/organizations/" + orgID + "/invitations"
	status, body := identityCommand(t, handler, http.MethodPost, path,
		keys.signToken(t, owner.ID, time.Now().Add(time.Hour)), map[string]string{"email": invitee.Email})
	if status != http.StatusAccepted {
		t.Fatalf("create invitation: status %d body %s, want 202", status, body)
	}
	assertContractResponse(t, http.MethodPost, path, status, body)

	messages := waitForMessageCount(t, ctx, h.mailpit, fmt.Sprintf("to:%q", invitee.Email), len(before)+1)
	var delivered mailMessageForTest
	for _, summary := range messages {
		if summary.ID == before[0].ID {
			continue
		}
		message, err := h.mailpit.Message(ctx, summary.ID)
		if err != nil {
			t.Fatalf("read invitation email: %v", err)
		}
		delivered = mailMessageForTest{subject: message.Subject, body: message.Text}
	}
	if delivered.body == "" {
		t.Fatal("invitation email was not distinguishable from the signup confirmation")
	}
	code := extractCode(t, delivered.body)
	for _, fragment := range []string{
		"Invitation Org", "邀请码", "invitation code", "7 天", "7 days",
	} {
		if !strings.Contains(delivered.body, fragment) {
			t.Fatalf("invitation email body missing bilingual fragment %q: %q", fragment, delivered.body)
		}
	}
	if !strings.Contains(delivered.subject, "邀请") || !strings.Contains(delivered.subject, "invitation") {
		t.Fatalf("invitation email subject is not bilingual: %q", delivered.subject)
	}

	var (
		invitationID     string
		invitationStatus string
		organizationName string
		inviterName      string
		codeHash         string
		actionType       string
		targetID         string
		outboxCodeID     string
		actorID          string
		actorName        string
		action           string
		metadataEmail    string
	)
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT id, status, organization_name, inviter_display_name
		 FROM public.invitations WHERE organization_id = $1 AND email = $2`, orgID, invitee.Email,
	).Scan(&invitationID, &invitationStatus, &organizationName, &inviterName); err != nil {
		t.Fatalf("read invitation: %v", err)
	}
	if invitationStatus != "pending" {
		t.Fatalf("invitation status = %q, want pending", invitationStatus)
	}
	if organizationName != "Invitation Org" || inviterName != "Owner Snapshot" {
		t.Fatalf("invitation display snapshots = (%q, %q), want (Invitation Org, Owner Snapshot)", organizationName, inviterName)
	}
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT code_hash, action_type, target_id FROM identity.verification_codes WHERE target_id = $1`, invitationID,
	).Scan(&codeHash, &actionType, &targetID); err != nil {
		t.Fatalf("read invitation verification code: %v", err)
	}
	if codeHash != h.codeHash(code) || actionType != "invitation" || targetID != invitationID {
		t.Fatalf("invitation code row = (hash=%q action=%q target=%q), want mailed hash, invitation, %q", codeHash, actionType, targetID, invitationID)
	}
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT verification_code_id FROM identity.outbox_messages WHERE recipient = $1 ORDER BY created_at DESC LIMIT 1`, invitee.Email,
	).Scan(&outboxCodeID); err != nil {
		t.Fatalf("read invitation outbox row: %v", err)
	}
	if outboxCodeID == "" {
		t.Fatal("invitation outbox row has no verification_code_id retry horizon")
	}
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT actor_user_id, actor_display_name, action, metadata->>'email'
		 FROM public.audit_logs WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`, orgID,
	).Scan(&actorID, &actorName, &action, &metadataEmail); err != nil {
		t.Fatalf("read invitation audit row: %v", err)
	}
	if actorID != owner.ID || actorName != "Owner Snapshot" || action != "invitation_created" || metadataEmail != invitee.Email {
		t.Fatalf("invitation audit row = (%q, %q, %q, %q), want owner snapshot + invitation_created", actorID, actorName, action, metadataEmail)
	}

	if _, err := h.fixturePool.Exec(ctx, `UPDATE public.profiles SET display_name = 'Owner Changed' WHERE user_id = $1`, owner.ID); err != nil {
		t.Fatalf("change owner profile after audit: %v", err)
	}
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT actor_display_name FROM public.audit_logs WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`, orgID,
	).Scan(&actorName); err != nil {
		t.Fatalf("re-read invitation audit row: %v", err)
	}
	if actorName != "Owner Snapshot" {
		t.Fatalf("audit actor snapshot changed to %q, want Owner Snapshot", actorName)
	}
}

func TestInvitationCommandsSnapshotDirectoryEmailWithoutProfiles(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "profileless-owner")
	invitee := stack.signUpConfirmedUser(t, ctx, "profileless-invitee")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Profileless Invitation Org"},
		[]membershipSeed{{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"}},
	)
	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	ownerToken := keys.signToken(t, owner.ID, time.Now().Add(time.Hour))
	createPath := "/identity/organizations/" + orgID + "/invitations"
	status, body := identityCommand(t, handler, http.MethodPost, createPath, ownerToken, map[string]string{"email": invitee.Email})
	if status != http.StatusAccepted {
		t.Fatalf("create invitation without profiles: status %d body %s, want 202", status, body)
	}
	assertContractResponse(t, http.MethodPost, createPath, status, body)

	var invitationID, invitationBody string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT i.id, o.body
		 FROM public.invitations i
		 JOIN identity.verification_codes c ON c.target_id = i.id AND c.action_type = 'invitation'
		 JOIN identity.outbox_messages o ON o.verification_code_id = c.id
		 WHERE i.organization_id = $1 AND i.email = $2`, orgID, invitee.Email,
	).Scan(&invitationID, &invitationBody); err != nil {
		t.Fatalf("read profileless invitation: %v", err)
	}
	acceptPath := "/identity/invitations/" + invitationID + "/accept"
	status, body = identityCommand(t, handler, http.MethodPost, acceptPath,
		keys.signToken(t, invitee.ID, time.Now().Add(time.Hour)), map[string]string{"code": extractCode(t, invitationBody)})
	if status != http.StatusOK {
		t.Fatalf("accept invitation without profiles: status %d body %s, want 200", status, body)
	}
	assertContractResponse(t, http.MethodPost, acceptPath, status, body)

	var createdActorName, acceptedActorName, acceptedTargetName string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT actor_display_name FROM public.audit_logs
		 WHERE organization_id = $1 AND action = 'invitation_created'`, orgID,
	).Scan(&createdActorName); err != nil {
		t.Fatalf("read profileless creation audit: %v", err)
	}
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT actor_display_name, target_display_name FROM public.audit_logs
		 WHERE organization_id = $1 AND action = 'invitation_accepted'`, orgID,
	).Scan(&acceptedActorName, &acceptedTargetName); err != nil {
		t.Fatalf("read profileless acceptance audit: %v", err)
	}
	if createdActorName != owner.Email || acceptedActorName != invitee.Email || acceptedTargetName != invitee.Email {
		t.Fatalf("profileless snapshots = created:%q accepted:(%q,%q), want directory emails owner:%q invitee:%q",
			createdActorName, acceptedActorName, acceptedTargetName, owner.Email, invitee.Email)
	}
}

type mailMessageForTest struct {
	subject string
	body    string
}

func TestCreateInvitationRejectsActiveMemberEmailAndAllowsEndedMember(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "membership-rule-owner")
	active := stack.signUpConfirmedUser(t, ctx, "membership-rule-active")
	ended := stack.signUpConfirmedUser(t, ctx, "membership-rule-ended")
	seedProfile(t, ctx, h, owner.ID, "Membership Rule Owner")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Membership Rule Org"},
		[]membershipSeed{
			{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"},
			{OrganizationID: orgID, UserID: active.ID, Role: "member", Status: "active"},
			{OrganizationID: orgID, UserID: ended.ID, Role: "member", Status: "ended"},
		},
	)
	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	path := "/identity/organizations/" + orgID + "/invitations"
	token := keys.signToken(t, owner.ID, time.Now().Add(time.Hour))

	status, body := identityCommand(t, handler, http.MethodPost, path, token, map[string]string{"email": active.Email})
	if status != http.StatusConflict {
		t.Fatalf("invite active member: status %d body %s, want 409", status, body)
	}
	assertContractResponse(t, http.MethodPost, path, status, body)

	status, body = identityCommand(t, handler, http.MethodPost, path, token, map[string]string{"email": ended.Email})
	if status != http.StatusAccepted {
		t.Fatalf("invite ended member: status %d body %s, want 202", status, body)
	}
	assertContractResponse(t, http.MethodPost, path, status, body)
	var pending int
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT count(*) FROM public.invitations WHERE organization_id = $1 AND email = $2 AND status = 'pending'`,
		orgID, ended.Email,
	).Scan(&pending); err != nil {
		t.Fatalf("count ended-member invitation: %v", err)
	}
	if pending != 1 {
		t.Fatalf("ended member received %d pending invitations, want 1", pending)
	}
}

func TestRevokeInvitationCancelsUndeliveredCode(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "revoke-owner")
	invitee := stack.signUpConfirmedUser(t, ctx, "revoke-invitee")
	seedProfile(t, ctx, h, owner.ID, "Revoke Owner")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Revoke Org"},
		[]membershipSeed{{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"}},
	)
	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	token := keys.signToken(t, owner.ID, time.Now().Add(time.Hour))
	createPath := "/identity/organizations/" + orgID + "/invitations"

	status, body := identityCommand(t, handler, http.MethodPost, createPath, token, map[string]string{"email": invitee.Email})
	if status != http.StatusAccepted {
		t.Fatalf("create invitation for revoke: status %d body %s, want 202", status, body)
	}
	var invitationID, codeID string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT i.id, c.id
		 FROM public.invitations i
		 JOIN identity.verification_codes c ON c.target_id = i.id AND c.action_type = 'invitation'
		 WHERE i.organization_id = $1 AND i.email = $2`, orgID, invitee.Email,
	).Scan(&invitationID, &codeID); err != nil {
		t.Fatalf("read invitation and code for revoke: %v", err)
	}

	revokePath := createPath + "/" + invitationID + "/revoke"
	status, body = identityCommand(t, handler, http.MethodPost, revokePath, token, map[string]string{})
	if status != http.StatusOK {
		t.Fatalf("revoke invitation: status %d body %s, want 200", status, body)
	}
	assertContractResponse(t, http.MethodPost, revokePath, status, body)

	var invitationStatus, codeStatus, outboxStatus, auditActorID, auditActorName, auditAction, auditInvitationID, auditEmail string
	if err := h.fixturePool.QueryRow(ctx, `SELECT status FROM public.invitations WHERE id = $1`, invitationID).Scan(&invitationStatus); err != nil {
		t.Fatalf("read revoked invitation: %v", err)
	}
	if err := h.fixturePool.QueryRow(ctx, `SELECT status FROM identity.verification_codes WHERE id = $1`, codeID).Scan(&codeStatus); err != nil {
		t.Fatalf("read revoked code: %v", err)
	}
	if err := h.fixturePool.QueryRow(ctx, `SELECT status FROM identity.outbox_messages WHERE verification_code_id = $1`, codeID).Scan(&outboxStatus); err != nil {
		t.Fatalf("read revoked outbox row: %v", err)
	}
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT actor_user_id, actor_display_name, action, metadata->>'invitation_id', metadata->>'email'
		 FROM public.audit_logs WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`, orgID,
	).Scan(&auditActorID, &auditActorName, &auditAction, &auditInvitationID, &auditEmail); err != nil {
		t.Fatalf("read revocation audit row: %v", err)
	}
	if invitationStatus != "revoked" || codeStatus != "superseded" || outboxStatus != "cancelled" || auditActorID != owner.ID || auditActorName != "Revoke Owner" || auditAction != "invitation_revoked" || auditInvitationID != invitationID || auditEmail != invitee.Email {
		t.Fatalf("revocation state = invitation:%q code:%q outbox:%q audit:(%q,%q,%q,%q,%q), want revoked/superseded/cancelled and owner snapshot", invitationStatus, codeStatus, outboxStatus, auditActorID, auditActorName, auditAction, auditInvitationID, auditEmail)
	}
	if _, err := h.fixturePool.Exec(ctx, `UPDATE public.profiles SET display_name = 'Revoke Owner Changed' WHERE user_id = $1`, owner.ID); err != nil {
		t.Fatalf("change revoke owner profile after audit: %v", err)
	}
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT actor_display_name FROM public.audit_logs WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`, orgID,
	).Scan(&auditActorName); err != nil {
		t.Fatalf("re-read revocation audit row: %v", err)
	}
	if auditActorName != "Revoke Owner" {
		t.Fatalf("revocation audit actor snapshot changed to %q, want Revoke Owner", auditActorName)
	}
	status, body = identityCommand(t, handler, http.MethodPost, revokePath, token, map[string]string{})
	if status != http.StatusOK {
		t.Fatalf("repeat revoke invitation: status %d body %s, want 200", status, body)
	}
	assertContractResponse(t, http.MethodPost, revokePath, status, body)
	var revocationAudits int
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT count(*) FROM public.audit_logs WHERE organization_id = $1 AND action = 'invitation_revoked'`, orgID,
	).Scan(&revocationAudits); err != nil {
		t.Fatalf("count repeat-revocation audit rows: %v", err)
	}
	if revocationAudits != 1 {
		t.Fatalf("repeat revocation wrote %d audit rows, want 1", revocationAudits)
	}
}

func TestResendInvitationRefreshesCodeAndCancelsPriorUndeliveredMail(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "resend-owner")
	invitee := stack.signUpConfirmedUser(t, ctx, "resend-invitee")
	seedProfile(t, ctx, h, owner.ID, "Resend Owner")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Resend Org"},
		[]membershipSeed{{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"}},
	)
	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	token := keys.signToken(t, owner.ID, time.Now().Add(time.Hour))
	createPath := "/identity/organizations/" + orgID + "/invitations"

	before, err := h.mailpit.Search(ctx, fmt.Sprintf("to:%q", invitee.Email))
	if err != nil {
		t.Fatalf("count prior mail for resend invitee: %v", err)
	}
	status, body := identityCommand(t, handler, http.MethodPost, createPath, token, map[string]string{"email": invitee.Email})
	if status != http.StatusAccepted {
		t.Fatalf("create invitation for resend: status %d body %s, want 202", status, body)
	}

	var invitationID, originalCodeID, originalBody string
	var originalExpiresAt time.Time
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT i.id, i.expires_at, c.id, o.body
		 FROM public.invitations i
		 JOIN identity.verification_codes c ON c.target_id = i.id AND c.action_type = 'invitation'
		 JOIN identity.outbox_messages o ON o.verification_code_id = c.id
		 WHERE i.organization_id = $1 AND i.email = $2`, orgID, invitee.Email,
	).Scan(&invitationID, &originalExpiresAt, &originalCodeID, &originalBody); err != nil {
		t.Fatalf("read initial invitation delivery state: %v", err)
	}
	originalCode := extractCode(t, originalBody)
	ageActiveInvitationCodeBeyondCooldown(t, ctx, h, invitationID)

	resendPath := createPath + "/" + invitationID + "/resend"
	status, body = identityCommand(t, handler, http.MethodPost, resendPath, token, map[string]string{})
	if status != http.StatusAccepted {
		t.Fatalf("resend invitation: status %d body %s, want 202", status, body)
	}
	assertContractResponse(t, http.MethodPost, resendPath, status, body)

	var refreshedExpiresAt time.Time
	if err := h.fixturePool.QueryRow(ctx, `SELECT expires_at FROM public.invitations WHERE id = $1`, invitationID).Scan(&refreshedExpiresAt); err != nil {
		t.Fatalf("read refreshed invitation deadline: %v", err)
	}
	if !refreshedExpiresAt.After(originalExpiresAt) {
		t.Fatalf("resend expiration = %s, want later than original %s", refreshedExpiresAt, originalExpiresAt)
	}
	var originalCodeStatus, originalOutboxStatus string
	if err := h.fixturePool.QueryRow(ctx, `SELECT status FROM identity.verification_codes WHERE id = $1`, originalCodeID).Scan(&originalCodeStatus); err != nil {
		t.Fatalf("read superseded code: %v", err)
	}
	if err := h.fixturePool.QueryRow(ctx, `SELECT status FROM identity.outbox_messages WHERE verification_code_id = $1`, originalCodeID).Scan(&originalOutboxStatus); err != nil {
		t.Fatalf("read cancelled old outbox row: %v", err)
	}
	var refreshedCodeID, refreshedCodeStatus, refreshedOutboxStatus string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT c.id, c.status, o.status
		 FROM identity.verification_codes c
		 JOIN identity.outbox_messages o ON o.verification_code_id = c.id
		 WHERE c.target_id = $1 AND c.action_type = 'invitation' AND c.status = 'active'`, invitationID,
	).Scan(&refreshedCodeID, &refreshedCodeStatus, &refreshedOutboxStatus); err != nil {
		t.Fatalf("read refreshed code and outbox: %v", err)
	}
	if refreshedCodeID == originalCodeID || originalCodeStatus != "superseded" || originalOutboxStatus != "cancelled" || refreshedCodeStatus != "active" || refreshedOutboxStatus != "pending" {
		t.Fatalf("resend state = old(%q,%q) new(%q,%q,%q), want old superseded/cancelled and distinct active/pending new code", originalCodeStatus, originalOutboxStatus, refreshedCodeID, refreshedCodeStatus, refreshedOutboxStatus)
	}

	h.startWorker(t)
	messages := waitForMessageCount(t, ctx, h.mailpit, fmt.Sprintf("to:%q", invitee.Email), len(before)+1)
	var refreshedBody string
	for _, summary := range messages {
		message, err := h.mailpit.Message(ctx, summary.ID)
		if err != nil {
			t.Fatalf("read resend email: %v", err)
		}
		if strings.Contains(strings.ToLower(message.Subject), "invitation") {
			refreshedBody = message.Text
		}
	}
	if refreshedBody == "" {
		t.Fatal("resend did not deliver the refreshed invitation email")
	}
	if refreshedCode := extractCode(t, refreshedBody); refreshedCode == originalCode {
		t.Fatal("resend delivered the superseded invitation code")
	}
	var resendActorID, resendActorName, resendAction, resendInvitationID, resendEmail string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT actor_user_id, actor_display_name, action, metadata->>'invitation_id', metadata->>'email'
		 FROM public.audit_logs WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`, orgID,
	).Scan(&resendActorID, &resendActorName, &resendAction, &resendInvitationID, &resendEmail); err != nil {
		t.Fatalf("read resend audit row: %v", err)
	}
	if resendActorID != owner.ID || resendActorName != "Resend Owner" || resendAction != "invitation_resent" || resendInvitationID != invitationID || resendEmail != invitee.Email {
		t.Fatalf("resend audit = (%q,%q,%q,%q,%q), want owner snapshot + invitation_resent", resendActorID, resendActorName, resendAction, resendInvitationID, resendEmail)
	}
	if _, err := h.fixturePool.Exec(ctx, `UPDATE public.profiles SET display_name = 'Resend Owner Changed' WHERE user_id = $1`, owner.ID); err != nil {
		t.Fatalf("change resend owner profile after audit: %v", err)
	}
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT actor_display_name FROM public.audit_logs WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`, orgID,
	).Scan(&resendActorName); err != nil {
		t.Fatalf("re-read resend audit row: %v", err)
	}
	if resendActorName != "Resend Owner" {
		t.Fatalf("resend audit actor snapshot changed to %q, want Resend Owner", resendActorName)
	}
}

func TestResendInvitationDoesNotRevalidateHistoricalCode(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "resend-history-owner")
	invitee := stack.signUpConfirmedUser(t, ctx, "resend-history-invitee")
	seedProfile(t, ctx, h, owner.ID, "Resend History Owner")
	seedProfile(t, ctx, h, invitee.ID, "Resend History Invitee")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Resend History Org"},
		[]membershipSeed{{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"}},
	)
	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	ownerToken := keys.signToken(t, owner.ID, time.Now().Add(time.Hour))
	inviteeToken := keys.signToken(t, invitee.ID, time.Now().Add(time.Hour))
	createPath := "/identity/organizations/" + orgID + "/invitations"

	originalReader := cryptorand.Reader
	t.Cleanup(func() { cryptorand.Reader = originalReader })
	cryptorand.Reader = bytes.NewReader([]byte{0, 0, 0})
	status, body := identityCommand(t, handler, http.MethodPost, createPath, ownerToken, map[string]string{"email": invitee.Email})
	if status != http.StatusAccepted {
		t.Fatalf("create invitation for code history: status %d body %s, want 202", status, body)
	}
	var invitationID, initialBody string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT i.id, o.body
		 FROM public.invitations i
		 JOIN identity.verification_codes c ON c.target_id = i.id AND c.action_type = 'invitation'
		 JOIN identity.outbox_messages o ON o.verification_code_id = c.id
		 WHERE i.organization_id = $1 AND i.email = $2`, orgID, invitee.Email,
	).Scan(&invitationID, &initialBody); err != nil {
		t.Fatalf("read initial code history state: %v", err)
	}
	initialCode := extractCode(t, initialBody)

	resendPath := createPath + "/" + invitationID + "/resend"
	ageActiveInvitationCodeBeyondCooldown(t, ctx, h, invitationID)
	cryptorand.Reader = bytes.NewReader([]byte{0, 0, 1})
	status, body = identityCommand(t, handler, http.MethodPost, resendPath, ownerToken, map[string]string{})
	if status != http.StatusAccepted {
		t.Fatalf("first resend for code history: status %d body %s, want 202", status, body)
	}

	ageActiveInvitationCodeBeyondCooldown(t, ctx, h, invitationID)
	cryptorand.Reader = bytes.NewReader([]byte{0, 0, 0, 0, 0, 2})
	status, body = identityCommand(t, handler, http.MethodPost, resendPath, ownerToken, map[string]string{})
	cryptorand.Reader = originalReader
	if status != http.StatusAccepted {
		t.Fatalf("second resend for code history: status %d body %s, want 202", status, body)
	}
	var latestBody string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT o.body
		 FROM identity.verification_codes c
		 JOIN identity.outbox_messages o ON o.verification_code_id = c.id
		 WHERE c.target_id = $1 AND c.action_type = 'invitation' AND c.status = 'active'`, invitationID,
	).Scan(&latestBody); err != nil {
		t.Fatalf("read latest code history state: %v", err)
	}
	latestCode := extractCode(t, latestBody)
	if latestCode == initialCode {
		t.Fatalf("second resend reused historical code %q", initialCode)
	}

	acceptPath := "/identity/invitations/" + invitationID + "/accept"
	var failedAttemptsBeforeHistorical, failedAttemptsAfterHistorical int
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT failed_attempts FROM identity.verification_codes
		 WHERE target_id = $1 AND action_type = 'invitation' AND status = 'active'`, invitationID,
	).Scan(&failedAttemptsBeforeHistorical); err != nil {
		t.Fatalf("read active attempt count before historical-code acceptance: %v", err)
	}
	status, body, headers := identityCommandFromIP(t, handler, http.MethodPost, acceptPath, inviteeToken, "", map[string]string{"code": initialCode})
	if status != http.StatusConflict {
		t.Fatalf("accept with historical code: status %d body %s, want 409", status, body)
	}
	assertCommandError(t, body, "invitation_code_invalidated")
	assertContractResponse(t, http.MethodPost, acceptPath, status, body)
	if got := headers.Get("X-Invitation-Code-Attempts-Remaining"); got != "" {
		t.Fatalf("historical code remaining-attempts header = %q, want absent", got)
	}
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT failed_attempts FROM identity.verification_codes
		 WHERE target_id = $1 AND action_type = 'invitation' AND status = 'active'`, invitationID,
	).Scan(&failedAttemptsAfterHistorical); err != nil {
		t.Fatalf("read active attempt count after historical-code acceptance: %v", err)
	}
	if failedAttemptsAfterHistorical != failedAttemptsBeforeHistorical {
		t.Fatalf("historical code changed current failed attempts from %d to %d", failedAttemptsBeforeHistorical, failedAttemptsAfterHistorical)
	}
	status, body = identityCommand(t, handler, http.MethodPost, acceptPath, inviteeToken, map[string]string{"code": latestCode})
	if status != http.StatusOK {
		t.Fatalf("accept with latest code: status %d body %s, want 200", status, body)
	}
	assertContractResponse(t, http.MethodPost, acceptPath, status, body)
}

func TestAcceptInvitationCreatesMemberAndConsumesCode(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "accept-owner")
	invitee := stack.signUpConfirmedUser(t, ctx, "accept-invitee")
	seedProfile(t, ctx, h, owner.ID, "Accept Owner")
	seedProfile(t, ctx, h, invitee.ID, "Accept Invitee")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Accept Org"},
		[]membershipSeed{{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"}},
	)
	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	createPath := "/identity/organizations/" + orgID + "/invitations"
	status, body := identityCommand(t, handler, http.MethodPost, createPath,
		keys.signToken(t, owner.ID, time.Now().Add(time.Hour)), map[string]string{"email": invitee.Email})
	if status != http.StatusAccepted {
		t.Fatalf("create invitation for acceptance: status %d body %s, want 202", status, body)
	}

	var invitationID, codeID, pendingBody string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT i.id, c.id, o.body
		 FROM public.invitations i
		 JOIN identity.verification_codes c ON c.target_id = i.id AND c.action_type = 'invitation'
		 JOIN identity.outbox_messages o ON o.verification_code_id = c.id
		 WHERE i.organization_id = $1 AND i.email = $2`, orgID, invitee.Email,
	).Scan(&invitationID, &codeID, &pendingBody); err != nil {
		t.Fatalf("read invitation acceptance inputs: %v", err)
	}
	code := extractCode(t, pendingBody)

	acceptPath := "/identity/invitations/" + invitationID + "/accept"
	status, body = identityCommand(t, handler, http.MethodPost, acceptPath,
		keys.signToken(t, invitee.ID, time.Now().Add(time.Hour)), map[string]string{"code": code})
	if status != http.StatusOK {
		t.Fatalf("accept invitation: status %d body %s, want 200", status, body)
	}
	assertContractResponse(t, http.MethodPost, acceptPath, status, body)
	if strings.Contains(string(body), code) {
		t.Fatalf("acceptance response exposed invitation code: %s", body)
	}

	var activeMemberships int
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT count(*) FROM public.memberships
		 WHERE organization_id = $1 AND user_id = $2 AND role = 'member' AND status = 'active'`, orgID, invitee.ID,
	).Scan(&activeMemberships); err != nil {
		t.Fatalf("count accepted membership: %v", err)
	}
	var invitationStatus, codeStatus, actorID, actorName, targetID, targetName, action string
	if err := h.fixturePool.QueryRow(ctx, `SELECT status FROM public.invitations WHERE id = $1`, invitationID).Scan(&invitationStatus); err != nil {
		t.Fatalf("read accepted invitation: %v", err)
	}
	if err := h.fixturePool.QueryRow(ctx, `SELECT status FROM identity.verification_codes WHERE id = $1`, codeID).Scan(&codeStatus); err != nil {
		t.Fatalf("read consumed invitation code: %v", err)
	}
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT actor_user_id, actor_display_name, target_user_id, target_display_name, action
		 FROM public.audit_logs WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`, orgID,
	).Scan(&actorID, &actorName, &targetID, &targetName, &action); err != nil {
		t.Fatalf("read acceptance audit row: %v", err)
	}
	if activeMemberships != 1 || invitationStatus != "accepted" || codeStatus != "consumed" || actorID != invitee.ID || actorName != "Accept Invitee" || targetID != invitee.ID || targetName != "Accept Invitee" || action != "invitation_accepted" {
		t.Fatalf("acceptance state = memberships:%d invitation:%q code:%q audit:(%q,%q,%q,%q,%q), want one active Member, accepted, consumed, and invitee snapshots", activeMemberships, invitationStatus, codeStatus, actorID, actorName, targetID, targetName, action)
	}
	var codelessOutboxMessages int
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT count(*) FROM identity.outbox_messages
		 WHERE recipient = $1 AND verification_code_id IS NULL`, invitee.Email,
	).Scan(&codelessOutboxMessages); err != nil {
		t.Fatalf("count codeless acceptance notifications: %v", err)
	}
	if codelessOutboxMessages != 0 {
		t.Fatalf("accepting an invitation queued %d codeless emails, want none", codelessOutboxMessages)
	}
	if _, err := h.fixturePool.Exec(ctx, `UPDATE public.profiles SET display_name = 'Accept Invitee Changed' WHERE user_id = $1`, invitee.ID); err != nil {
		t.Fatalf("change accepting invitee profile after audit: %v", err)
	}
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT actor_display_name, target_display_name FROM public.audit_logs WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`, orgID,
	).Scan(&actorName, &targetName); err != nil {
		t.Fatalf("re-read acceptance audit row: %v", err)
	}
	if actorName != "Accept Invitee" || targetName != "Accept Invitee" {
		t.Fatalf("acceptance audit snapshots changed to actor:%q target:%q, want Accept Invitee", actorName, targetName)
	}
}

func TestAcceptInvitationRejectsForwardedExpiredRevokedAndExhaustedCodes(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	const attemptLimit = 5
	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "accept-errors-owner")
	attemptInvitee := stack.signUpConfirmedUser(t, ctx, "accept-errors-attempt")
	stranger := stack.signUpConfirmedUser(t, ctx, "accept-errors-stranger")
	expiredInvitee := stack.signUpConfirmedUser(t, ctx, "accept-errors-expired")
	revokedInvitee := stack.signUpConfirmedUser(t, ctx, "accept-errors-revoked")
	seedProfile(t, ctx, h, owner.ID, "Acceptance Errors Owner")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Acceptance Errors Org"},
		[]membershipSeed{{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"}},
	)
	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	ownerToken := keys.signToken(t, owner.ID, time.Now().Add(time.Hour))
	createPath := "/identity/organizations/" + orgID + "/invitations"
	createInvitation := func(email string) (string, string, string) {
		t.Helper()
		status, body := identityCommand(t, handler, http.MethodPost, createPath, ownerToken, map[string]string{"email": email})
		if status != http.StatusAccepted {
			t.Fatalf("create invitation for acceptance errors: status %d body %s, want 202", status, body)
		}
		var invitationID, codeID, outboxBody string
		if err := h.fixturePool.QueryRow(ctx,
			`SELECT i.id, c.id, o.body
			 FROM public.invitations i
			 JOIN identity.verification_codes c ON c.target_id = i.id AND c.action_type = 'invitation'
			 JOIN identity.outbox_messages o ON o.verification_code_id = c.id
			 WHERE i.organization_id = $1 AND i.email = $2`, orgID, email,
		).Scan(&invitationID, &codeID, &outboxBody); err != nil {
			t.Fatalf("read invitation acceptance error inputs: %v", err)
		}
		return invitationID, codeID, extractCode(t, outboxBody)
	}

	attemptInvitationID, attemptCodeID, attemptCode := createInvitation(attemptInvitee.Email)
	attemptPath := "/identity/invitations/" + attemptInvitationID + "/accept"
	status, body := identityCommand(t, handler, http.MethodPost, attemptPath,
		keys.signToken(t, stranger.ID, time.Now().Add(time.Hour)), map[string]string{"code": attemptCode})
	if status != http.StatusNotFound {
		t.Fatalf("accept forwarded invitation: status %d body %s, want 404", status, body)
	}
	assertCommandError(t, body, "invitation_not_found")
	assertContractResponse(t, http.MethodPost, attemptPath, status, body)
	var failedAttempts int
	if err := h.fixturePool.QueryRow(ctx, `SELECT failed_attempts FROM identity.verification_codes WHERE id = $1`, attemptCodeID).Scan(&failedAttempts); err != nil {
		t.Fatalf("read forwarded-code attempts: %v", err)
	}
	if failedAttempts != 0 {
		t.Fatalf("forwarded invitation changed code attempts to %d, want 0", failedAttempts)
	}

	wrongCode := "000000"
	if wrongCode == attemptCode {
		wrongCode = "999999"
	}
	inviteeToken := keys.signToken(t, attemptInvitee.ID, time.Now().Add(time.Hour))
	for attempt := 1; attempt <= attemptLimit; attempt++ {
		var headers http.Header
		status, body, headers = identityCommandFromIP(t, handler, http.MethodPost, attemptPath, inviteeToken, "", map[string]string{"code": wrongCode})
		wantStatus, wantCode := http.StatusBadRequest, "invalid_invitation_code"
		if attempt == attemptLimit {
			wantStatus, wantCode = http.StatusConflict, "code_attempts_exhausted"
		}
		if status != wantStatus {
			t.Fatalf("wrong invitation code attempt %d: status %d body %s, want %d", attempt, status, body, wantStatus)
		}
		assertCommandError(t, body, wantCode)
		assertContractResponse(t, http.MethodPost, attemptPath, status, body)
		if got, want := headers.Get("X-Invitation-Code-Attempts-Remaining"), strconv.Itoa(attemptLimit-attempt); got != want {
			t.Fatalf("wrong invitation code attempt %d remaining-attempts header = %q, want %q", attempt, got, want)
		}
	}
	var exhaustedStatus, exhaustedOutboxStatus string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT c.failed_attempts, c.status, o.status
		 FROM identity.verification_codes c
		 JOIN identity.outbox_messages o ON o.verification_code_id = c.id
		 WHERE c.id = $1`, attemptCodeID,
	).Scan(&failedAttempts, &exhaustedStatus, &exhaustedOutboxStatus); err != nil {
		t.Fatalf("read exhausted code state: %v", err)
	}
	if failedAttempts != attemptLimit || exhaustedStatus != "superseded" || exhaustedOutboxStatus != "cancelled" {
		t.Fatalf("exhausted code state = attempts:%d code:%q outbox:%q, want 5/superseded/cancelled", failedAttempts, exhaustedStatus, exhaustedOutboxStatus)
	}
	status, body, headers := identityCommandFromIP(t, handler, http.MethodPost, attemptPath, inviteeToken, "", map[string]string{"code": attemptCode})
	if status != http.StatusConflict {
		t.Fatalf("accept exhausted code: status %d body %s, want 409", status, body)
	}
	assertCommandError(t, body, "code_attempts_exhausted")
	assertContractResponse(t, http.MethodPost, attemptPath, status, body)
	if got := headers.Get("X-Invitation-Code-Attempts-Remaining"); got != "0" {
		t.Fatalf("exhausted code remaining-attempts header = %q, want 0", got)
	}

	expiredInvitationID, _, expiredCode := createInvitation(expiredInvitee.Email)
	if _, err := h.fixturePool.Exec(ctx,
		`UPDATE public.invitations SET expires_at = now() - interval '1 second' WHERE id = $1`, expiredInvitationID,
	); err != nil {
		t.Fatalf("expire invitation: %v", err)
	}
	if _, err := h.fixturePool.Exec(ctx,
		`UPDATE identity.verification_codes SET expires_at = now() - interval '1 second' WHERE target_id = $1`, expiredInvitationID,
	); err != nil {
		t.Fatalf("expire invitation code: %v", err)
	}
	expiredPath := "/identity/invitations/" + expiredInvitationID + "/accept"
	status, body = identityCommand(t, handler, http.MethodPost, expiredPath,
		keys.signToken(t, expiredInvitee.ID, time.Now().Add(time.Hour)), map[string]string{"code": expiredCode})
	if status != http.StatusConflict {
		t.Fatalf("accept expired invitation: status %d body %s, want 409", status, body)
	}
	assertCommandError(t, body, "invitation_expired")
	assertContractResponse(t, http.MethodPost, expiredPath, status, body)

	revokedInvitationID, _, revokedCode := createInvitation(revokedInvitee.Email)
	revokePath := createPath + "/" + revokedInvitationID + "/revoke"
	status, body = identityCommand(t, handler, http.MethodPost, revokePath, ownerToken, map[string]string{})
	if status != http.StatusOK {
		t.Fatalf("revoke invitation before acceptance: status %d body %s, want 200", status, body)
	}
	revokedPath := "/identity/invitations/" + revokedInvitationID + "/accept"
	status, body = identityCommand(t, handler, http.MethodPost, revokedPath,
		keys.signToken(t, revokedInvitee.ID, time.Now().Add(time.Hour)), map[string]string{"code": revokedCode})
	if status != http.StatusConflict {
		t.Fatalf("accept revoked invitation: status %d body %s, want 409", status, body)
	}
	assertCommandError(t, body, "invitation_revoked")
	assertContractResponse(t, http.MethodPost, revokedPath, status, body)
}

func TestAcceptInvitationConcurrentRequestsCreateOneActiveMembership(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "accept-race-owner")
	invitee := stack.signUpConfirmedUser(t, ctx, "accept-race-invitee")
	seedProfile(t, ctx, h, owner.ID, "Accept Race Owner")
	seedProfile(t, ctx, h, invitee.ID, "Accept Race Invitee")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Accept Race Org"},
		[]membershipSeed{{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"}},
	)
	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	createPath := "/identity/organizations/" + orgID + "/invitations"
	status, body := identityCommand(t, handler, http.MethodPost, createPath,
		keys.signToken(t, owner.ID, time.Now().Add(time.Hour)), map[string]string{"email": invitee.Email})
	if status != http.StatusAccepted {
		t.Fatalf("create invitation for acceptance race: status %d body %s, want 202", status, body)
	}
	var invitationID, pendingBody string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT i.id, o.body
		 FROM public.invitations i
		 JOIN identity.verification_codes c ON c.target_id = i.id AND c.action_type = 'invitation'
		 JOIN identity.outbox_messages o ON o.verification_code_id = c.id
		 WHERE i.organization_id = $1 AND i.email = $2`, orgID, invitee.Email,
	).Scan(&invitationID, &pendingBody); err != nil {
		t.Fatalf("read invitation race inputs: %v", err)
	}
	payload, err := json.Marshal(map[string]string{"code": extractCode(t, pendingBody)})
	if err != nil {
		t.Fatalf("marshal concurrent acceptance payload: %v", err)
	}
	acceptPath := "/identity/invitations/" + invitationID + "/accept"
	token := keys.signToken(t, invitee.ID, time.Now().Add(time.Hour))
	type acceptanceResult struct {
		status int
		body   []byte
	}
	const concurrentAccepts = 8
	start := make(chan struct{})
	results := make(chan acceptanceResult, concurrentAccepts)
	for range concurrentAccepts {
		go func() {
			<-start
			req := httptest.NewRequest(http.MethodPost, acceptPath, bytes.NewReader(payload))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			results <- acceptanceResult{status: rec.Code, body: rec.Body.Bytes()}
		}()
	}
	close(start)
	for range concurrentAccepts {
		result := <-results
		if result.status != http.StatusOK {
			t.Fatalf("concurrent acceptance: status %d body %s, want 200", result.status, result.body)
		}
		assertContractResponse(t, http.MethodPost, acceptPath, result.status, result.body)
	}

	var activeMembers, acceptanceAudits int
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT count(*) FROM public.memberships
		 WHERE organization_id = $1 AND user_id = $2 AND status = 'active'`, orgID, invitee.ID,
	).Scan(&activeMembers); err != nil {
		t.Fatalf("count concurrent active memberships: %v", err)
	}
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT count(*) FROM public.audit_logs
		 WHERE organization_id = $1 AND action = 'invitation_accepted'`, orgID,
	).Scan(&acceptanceAudits); err != nil {
		t.Fatalf("count concurrent acceptance audits: %v", err)
	}
	if activeMembers != 1 || acceptanceAudits != 1 {
		t.Fatalf("concurrent acceptance wrote memberships:%d audit rows:%d, want exactly one each", activeMembers, acceptanceAudits)
	}
}

func TestInvitationAdminCommandsPreserveAuthorizationAndContractSemantics(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "authorization-owner")
	member := stack.signUpConfirmedUser(t, ctx, "authorization-member")
	outsider := stack.signUpConfirmedUser(t, ctx, "authorization-outsider")
	invitee := stack.signUpConfirmedUser(t, ctx, "authorization-invitee")
	seedProfile(t, ctx, h, owner.ID, "Authorization Owner")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Authorization Org"},
		[]membershipSeed{
			{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"},
			{OrganizationID: orgID, UserID: member.ID, Role: "member", Status: "active"},
		},
	)
	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	ownerToken := keys.signToken(t, owner.ID, time.Now().Add(time.Hour))
	memberToken := keys.signToken(t, member.ID, time.Now().Add(time.Hour))
	outsiderToken := keys.signToken(t, outsider.ID, time.Now().Add(time.Hour))
	createPath := "/identity/organizations/" + orgID + "/invitations"
	assertDenied := func(name, path string, payload any) {
		t.Helper()
		status, body := identityCommand(t, handler, http.MethodPost, path, outsiderToken, payload)
		if status != http.StatusNotFound {
			t.Fatalf("%s as nonmember: status %d body %s, want 404", name, status, body)
		}
		assertCommandError(t, body, "organization_not_found")
		assertContractResponse(t, http.MethodPost, path, status, body)

		status, body = identityCommand(t, handler, http.MethodPost, path, memberToken, payload)
		if status != http.StatusForbidden {
			t.Fatalf("%s as Member: status %d body %s, want 403", name, status, body)
		}
		assertCommandError(t, body, "insufficient_organization_role")
		assertContractResponse(t, http.MethodPost, path, status, body)
	}

	assertDenied("create invitation", createPath, map[string]string{"email": invitee.Email})
	status, body := identityCommand(t, handler, http.MethodPost, createPath, ownerToken, map[string]string{"email": invitee.Email})
	if status != http.StatusAccepted {
		t.Fatalf("create invitation for authorization checks: status %d body %s, want 202", status, body)
	}
	var invitationID string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT id FROM public.invitations WHERE organization_id = $1 AND email = $2`, orgID, invitee.Email,
	).Scan(&invitationID); err != nil {
		t.Fatalf("read invitation for authorization checks: %v", err)
	}
	resendPath := createPath + "/" + invitationID + "/resend"
	revokePath := createPath + "/" + invitationID + "/revoke"
	assertDenied("resend invitation", resendPath, map[string]string{})
	assertDenied("revoke invitation", revokePath, map[string]string{})

	invalidResendPath := createPath + "/not-a-uuid/resend"
	status, body = identityCommand(t, handler, http.MethodPost, invalidResendPath, ownerToken, map[string]string{})
	if status != http.StatusBadRequest {
		t.Fatalf("resend malformed invitation id: status %d body %s, want 400", status, body)
	}
	assertCommandError(t, body, "invalid_invitation_id")
	assertContractResponse(t, http.MethodPost, invalidResendPath, status, body)
}

func TestCodeIssuanceSharesLimitsWithoutSharingInvalidationScope(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "issuance-isolation-owner")
	invitee := stack.signUpConfirmedUser(t, ctx, "issuance-isolation-invitee")
	seedProfile(t, ctx, h, owner.ID, "Issuance Isolation Owner")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Issuance Isolation Org"},
		[]membershipSeed{{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"}},
	)
	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	createPath := "/identity/organizations/" + orgID + "/invitations"
	status, body := identityCommand(t, handler, http.MethodPost, createPath,
		keys.signToken(t, owner.ID, time.Now().Add(time.Hour)), map[string]string{"email": invitee.Email})
	if status != http.StatusAccepted {
		t.Fatalf("create invitation for issuance isolation: status %d body %s, want 202", status, body)
	}

	var invitationID, invitationCodeID string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT i.id, c.id
		 FROM public.invitations i
		 JOIN identity.verification_codes c ON c.target_id = i.id AND c.action_type = 'invitation'
		 WHERE i.organization_id = $1 AND i.email = $2`, orgID, invitee.Email,
	).Scan(&invitationID, &invitationCodeID); err != nil {
		t.Fatalf("read invitation code for issuance isolation: %v", err)
	}
	if _, err := h.fixturePool.Exec(ctx,
		`UPDATE identity.verification_codes SET created_at = now() - interval '2 minutes' WHERE id = $1`, invitationCodeID,
	); err != nil {
		t.Fatalf("age invitation code beyond public resend cooldown: %v", err)
	}

	status, body = identityCommand(t, handler, http.MethodPost, "/identity/verification-codes", "", map[string]string{"email": invitee.Email})
	if status != http.StatusAccepted {
		t.Fatalf("issue public verification code: status %d body %s, want 202", status, body)
	}
	assertContractResponse(t, http.MethodPost, "/identity/verification-codes", status, body)

	var invitationCodeStatus, invitationOutboxStatus string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT c.status, o.status
		 FROM identity.verification_codes c
		 JOIN identity.outbox_messages o ON o.verification_code_id = c.id
		 WHERE c.id = $1`, invitationCodeID,
	).Scan(&invitationCodeStatus, &invitationOutboxStatus); err != nil {
		t.Fatalf("read invitation state after public issuance: %v", err)
	}
	if invitationCodeStatus != "active" || invitationOutboxStatus != "pending" {
		t.Fatalf("public issuance changed invitation code:%q outbox:%q, want active/pending", invitationCodeStatus, invitationOutboxStatus)
	}

	var publicCodeID string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT id FROM identity.verification_codes
		 WHERE email = $1 AND action_type IS NULL AND target_id IS NULL`, invitee.Email,
	).Scan(&publicCodeID); err != nil {
		t.Fatalf("read public code for invitation isolation: %v", err)
	}
	if _, err := h.fixturePool.Exec(ctx,
		`UPDATE identity.verification_codes
		 SET created_at = clock_timestamp() - interval '2 minutes'
		 WHERE id = $1 OR id = $2`, invitationCodeID, publicCodeID,
	); err != nil {
		t.Fatalf("age shared-limit codes before invitation resend: %v", err)
	}
	resendPath := createPath + "/" + invitationID + "/resend"
	status, body = identityCommand(t, handler, http.MethodPost, resendPath,
		keys.signToken(t, owner.ID, time.Now().Add(time.Hour)), map[string]string{})
	if status != http.StatusAccepted {
		t.Fatalf("resend invitation for public-code isolation: status %d body %s, want 202", status, body)
	}
	assertContractResponse(t, http.MethodPost, resendPath, status, body)

	var publicCodeStatus, publicOutboxStatus string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT c.status, o.status
		 FROM identity.verification_codes c
		 JOIN identity.outbox_messages o ON o.verification_code_id = c.id
		 WHERE c.id = $1`, publicCodeID,
	).Scan(&publicCodeStatus, &publicOutboxStatus); err != nil {
		t.Fatalf("read public code after invitation resend: %v", err)
	}
	if publicCodeStatus != "active" || publicOutboxStatus != "pending" {
		t.Fatalf("invitation resend changed public code:%q outbox:%q, want active/pending", publicCodeStatus, publicOutboxStatus)
	}
}

func TestCreateInvitationWaitsForConcurrentAcceptanceBeforeCheckingMembership(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "create-accept-race-owner")
	invitee := stack.signUpConfirmedUser(t, ctx, "create-accept-race-invitee")
	seedProfile(t, ctx, h, owner.ID, "Create Accept Race Owner")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Create Accept Race Org"},
		[]membershipSeed{{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"}},
	)
	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	token := keys.signToken(t, owner.ID, time.Now().Add(time.Hour))
	createPath := "/identity/organizations/" + orgID + "/invitations"
	status, body := identityCommand(t, handler, http.MethodPost, createPath, token, map[string]string{"email": invitee.Email})
	if status != http.StatusAccepted {
		t.Fatalf("create invitation for acceptance race: status %d body %s, want 202", status, body)
	}

	var invitationID string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT id FROM public.invitations WHERE organization_id = $1 AND email = $2`, orgID, invitee.Email,
	).Scan(&invitationID); err != nil {
		t.Fatalf("read invitation for acceptance race: %v", err)
	}

	tx, err := h.fixturePool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin simulated acceptance: %v", err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if _, err := tx.Exec(ctx, "SET LOCAL ROLE identity_app"); err != nil {
		t.Fatalf("switch simulated acceptance to identity_app: %v", err)
	}
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, orgID, invitee.Email,
	); err != nil {
		t.Fatalf("lock simulated acceptance subject: %v", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE public.invitations SET status = 'accepted', updated_at = now() WHERE id = $1`, invitationID,
	); err != nil {
		t.Fatalf("accept simulated invitation: %v", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO public.memberships (organization_id, user_id, role, status)
		 VALUES ($1, $2, 'member', 'active')`, orgID, invitee.ID,
	); err != nil {
		t.Fatalf("create simulated accepted membership: %v", err)
	}

	type creationResult struct {
		status int
		body   []byte
	}
	results := make(chan creationResult, 1)
	go func() {
		status, body := identityCommand(t, handler, http.MethodPost, createPath, token, map[string]string{"email": invitee.Email})
		results <- creationResult{status: status, body: body}
	}()

	deadline := time.Now().Add(2 * time.Second)
	for {
		select {
		case result := <-results:
			t.Fatalf("create returned before concurrent acceptance committed: status %d body %s", result.status, result.body)
		default:
		}
		var waiting int
		if err := h.fixturePool.QueryRow(ctx,
			`SELECT count(*)
			 FROM pg_stat_activity
			 WHERE datname = current_database()
			   AND wait_event_type = 'Lock'
			   AND (query LIKE '%pg_advisory_xact_lock%' OR query LIKE '%INSERT INTO public.invitations%')`,
		).Scan(&waiting); err != nil {
			t.Fatalf("observe blocked create request: %v", err)
		}
		if waiting > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("create request did not reach its transaction while acceptance held the subject lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := tx.Commit(context.WithoutCancel(ctx)); err != nil {
		t.Fatalf("commit simulated acceptance: %v", err)
	}

	result := <-results
	if result.status != http.StatusConflict {
		t.Fatalf("create after accepted membership: status %d body %s, want 409", result.status, result.body)
	}
	assertCommandError(t, result.body, "active_membership_exists")
	assertContractResponse(t, http.MethodPost, createPath, result.status, result.body)

	var pending int
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT count(*) FROM public.invitations
		 WHERE organization_id = $1 AND email = $2 AND status = 'pending'`, orgID, invitee.Email,
	).Scan(&pending); err != nil {
		t.Fatalf("count pending invitations after acceptance race: %v", err)
	}
	if pending != 0 {
		t.Fatalf("acceptance race left %d pending invitations, want 0", pending)
	}
}

func TestInvitationCommandsRejectMissingRequiredFields(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "missing-fields-owner")
	invitee := stack.signUpConfirmedUser(t, ctx, "missing-fields-invitee")
	seedProfile(t, ctx, h, owner.ID, "Missing Fields Owner")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Missing Fields Org"},
		[]membershipSeed{{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"}},
	)
	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	ownerToken := keys.signToken(t, owner.ID, time.Now().Add(time.Hour))
	createPath := "/identity/organizations/" + orgID + "/invitations"

	status, body := identityCommand(t, handler, http.MethodPost, createPath, ownerToken, map[string]string{})
	if status != http.StatusBadRequest {
		t.Fatalf("create invitation without email: status %d body %s, want 400", status, body)
	}
	assertCommandError(t, body, "invalid_request")
	assertContractResponse(t, http.MethodPost, createPath, status, body)

	status, body = identityCommand(t, handler, http.MethodPost, createPath, ownerToken, map[string]string{"email": invitee.Email})
	if status != http.StatusAccepted {
		t.Fatalf("create invitation for missing code test: status %d body %s, want 202", status, body)
	}
	var invitationID string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT id FROM public.invitations WHERE organization_id = $1 AND email = $2`, orgID, invitee.Email,
	).Scan(&invitationID); err != nil {
		t.Fatalf("read invitation for missing code test: %v", err)
	}
	resendPath := createPath + "/" + invitationID + "/resend"
	revokePath := createPath + "/" + invitationID + "/revoke"
	for _, endpoint := range []struct {
		name string
		path string
	}{
		{name: "resend", path: resendPath},
		{name: "revoke", path: revokePath},
	} {
		status, body = identityCommand(t, handler, http.MethodPost, endpoint.path, ownerToken, nil)
		if status != http.StatusBadRequest {
			t.Errorf("%s invitation with null body: status %d body %s, want 400", endpoint.name, status, body)
			continue
		}
		assertCommandError(t, body, "invalid_request")
		assertContractResponse(t, http.MethodPost, endpoint.path, status, body)
	}
	var invitationStatus string
	if err := h.fixturePool.QueryRow(ctx, `SELECT status FROM public.invitations WHERE id = $1`, invitationID).Scan(&invitationStatus); err != nil {
		t.Fatalf("read invitation after null-body commands: %v", err)
	}
	if invitationStatus != "pending" {
		t.Errorf("null-body commands changed invitation status to %q, want pending", invitationStatus)
	}
	acceptPath := "/identity/invitations/" + invitationID + "/accept"
	status, body = identityCommand(t, handler, http.MethodPost, acceptPath,
		keys.signToken(t, invitee.ID, time.Now().Add(time.Hour)), map[string]string{})
	if status != http.StatusBadRequest {
		t.Fatalf("accept invitation without code: status %d body %s, want 400", status, body)
	}
	assertCommandError(t, body, "invalid_request")
	assertContractResponse(t, http.MethodPost, acceptPath, status, body)
}

func TestAcceptanceReleasesInvitationRowWhileWaitingForCreateSubjectLock(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "accept-lock-order-owner")
	invitee := stack.signUpConfirmedUser(t, ctx, "accept-lock-order-invitee")
	seedProfile(t, ctx, h, owner.ID, "Accept Lock Order Owner")
	seedProfile(t, ctx, h, invitee.ID, "Accept Lock Order Invitee")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Accept Lock Order Org"},
		[]membershipSeed{{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"}},
	)
	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	ownerToken := keys.signToken(t, owner.ID, time.Now().Add(time.Hour))
	createPath := "/identity/organizations/" + orgID + "/invitations"
	status, body := identityCommand(t, handler, http.MethodPost, createPath, ownerToken, map[string]string{"email": invitee.Email})
	if status != http.StatusAccepted {
		t.Fatalf("create invitation for lock order: status %d body %s, want 202", status, body)
	}
	var invitationID, invitationBody string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT i.id, o.body
		 FROM public.invitations i
		 JOIN identity.verification_codes c ON c.target_id = i.id AND c.action_type = 'invitation'
		 JOIN identity.outbox_messages o ON o.verification_code_id = c.id
		 WHERE i.organization_id = $1 AND i.email = $2`, orgID, invitee.Email,
	).Scan(&invitationID, &invitationBody); err != nil {
		t.Fatalf("read invitation for lock order: %v", err)
	}
	invitationCode := extractCode(t, invitationBody)
	inviteeToken := keys.signToken(t, invitee.ID, time.Now().Add(time.Hour))

	tx, err := h.fixturePool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin subject lock: %v", err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, orgID, invitee.Email,
	); err != nil {
		t.Fatalf("hold invitation subject lock: %v", err)
	}

	type commandResult struct {
		status int
		body   []byte
	}
	acceptResults := make(chan commandResult, 1)
	acceptPath := "/identity/invitations/" + invitationID + "/accept"
	go func() {
		status, body := identityCommand(t, handler, http.MethodPost, acceptPath,
			inviteeToken, map[string]string{"code": invitationCode})
		acceptResults <- commandResult{status: status, body: body}
	}()

	deadline := time.Now().Add(2 * time.Second)
	for {
		var waiting int
		if err := h.fixturePool.QueryRow(ctx,
			`SELECT count(*) FROM pg_stat_activity
			 WHERE datname = current_database()
			   AND wait_event_type = 'Lock'
			   AND query LIKE '%pg_advisory_xact_lock%'`,
		).Scan(&waiting); err != nil {
			t.Fatalf("observe blocked acceptance: %v", err)
		}
		if waiting > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("acceptance did not wait for the shared invitation subject lock")
		}
		time.Sleep(10 * time.Millisecond)
	}

	revokeResults := make(chan commandResult, 1)
	revokePath := createPath + "/" + invitationID + "/revoke"
	go func() {
		status, body := identityCommand(t, handler, http.MethodPost, revokePath, ownerToken, map[string]string{})
		revokeResults <- commandResult{status: status, body: body}
	}()
	select {
	case result := <-revokeResults:
		if result.status != http.StatusOK {
			t.Fatalf("revoke while acceptance waits: status %d body %s, want 200", result.status, result.body)
		}
		assertContractResponse(t, http.MethodPost, revokePath, result.status, result.body)
	case <-time.After(2 * time.Second):
		t.Fatal("revoke waited on an invitation row held by blocked acceptance")
	}
	if err := tx.Commit(context.WithoutCancel(ctx)); err != nil {
		t.Fatalf("release invitation subject lock: %v", err)
	}

	result := <-acceptResults
	if result.status != http.StatusConflict {
		t.Fatalf("accept revoked invitation after lock release: status %d body %s, want 409", result.status, result.body)
	}
	assertCommandError(t, result.body, "invitation_revoked")
	assertContractResponse(t, http.MethodPost, acceptPath, result.status, result.body)
}

func TestInvitationDeadlinesStartAfterBlockingLocks(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "deadline-lock-owner")
	invitee := stack.signUpConfirmedUser(t, ctx, "deadline-lock-invitee")
	seedProfile(t, ctx, h, owner.ID, "Deadline Lock Owner")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Deadline Lock Org"},
		[]membershipSeed{{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"}},
	)
	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	ownerToken := keys.signToken(t, owner.ID, time.Now().Add(time.Hour))
	createPath := "/identity/organizations/" + orgID + "/invitations"

	type commandResult struct {
		status int
		body   []byte
	}
	waitForLock := func(queryLike, description string, results <-chan commandResult) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for {
			select {
			case result := <-results:
				t.Fatalf("%s returned before its lock released: status %d body %s", description, result.status, result.body)
			default:
			}
			var waiting int
			if err := h.fixturePool.QueryRow(ctx,
				`SELECT count(*)
				 FROM pg_stat_activity
				 WHERE datname = current_database()
				   AND wait_event_type = 'Lock'
				   AND query LIKE $1`, queryLike,
			).Scan(&waiting); err != nil {
				t.Fatalf("observe blocked %s: %v", description, err)
			}
			if waiting > 0 {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s did not reach its transaction while the lock was held", description)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	assertFreshDeadline := func(description string, releasedAt, expiresAt time.Time) {
		t.Helper()
		const lockWaitAllowance = 250 * time.Millisecond
		minimum := releasedAt.Add(7*24*time.Hour - lockWaitAllowance)
		if expiresAt.Before(minimum) {
			t.Fatalf("%s expiry %s precedes minimum fresh deadline %s", description, expiresAt, minimum)
		}
	}

	createBlocker, err := h.fixturePool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin create subject lock: %v", err)
	}
	defer createBlocker.Rollback(context.WithoutCancel(ctx))
	if _, err := createBlocker.Exec(ctx, "SET LOCAL ROLE identity_app"); err != nil {
		t.Fatalf("switch create subject lock to identity_app: %v", err)
	}
	if _, err := createBlocker.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, orgID, invitee.Email,
	); err != nil {
		t.Fatalf("hold create subject lock: %v", err)
	}
	createResults := make(chan commandResult, 1)
	go func() {
		status, body := identityCommand(t, handler, http.MethodPost, createPath, ownerToken, map[string]string{"email": invitee.Email})
		createResults <- commandResult{status: status, body: body}
	}()
	waitForLock("%pg_advisory_xact_lock%", "create invitation", createResults)
	time.Sleep(time.Second)
	var createReleasedAt time.Time
	if err := h.fixturePool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&createReleasedAt); err != nil {
		t.Fatalf("read database clock before create release: %v", err)
	}
	if err := createBlocker.Commit(context.WithoutCancel(ctx)); err != nil {
		t.Fatalf("release create subject lock: %v", err)
	}
	createResult := <-createResults
	if createResult.status != http.StatusAccepted {
		t.Fatalf("create after subject lock: status %d body %s, want 202", createResult.status, createResult.body)
	}
	assertContractResponse(t, http.MethodPost, createPath, createResult.status, createResult.body)

	var invitationID string
	var createdExpiresAt time.Time
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT id, expires_at FROM public.invitations WHERE organization_id = $1 AND email = $2`, orgID, invitee.Email,
	).Scan(&invitationID, &createdExpiresAt); err != nil {
		t.Fatalf("read created invitation deadline: %v", err)
	}
	assertFreshDeadline("created invitation", createReleasedAt, createdExpiresAt)
	ageActiveInvitationCodeBeyondCooldown(t, ctx, h, invitationID)

	resendBlocker, err := h.fixturePool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin resend invitation lock: %v", err)
	}
	defer resendBlocker.Rollback(context.WithoutCancel(ctx))
	if _, err := resendBlocker.Exec(ctx, "SET LOCAL ROLE identity_app"); err != nil {
		t.Fatalf("switch resend invitation lock to identity_app: %v", err)
	}
	if _, err := resendBlocker.Exec(ctx, `SELECT id FROM public.invitations WHERE id = $1 FOR UPDATE`, invitationID); err != nil {
		t.Fatalf("hold resend invitation lock: %v", err)
	}
	resendPath := createPath + "/" + invitationID + "/resend"
	resendResults := make(chan commandResult, 1)
	go func() {
		status, body := identityCommand(t, handler, http.MethodPost, resendPath, ownerToken, map[string]string{})
		resendResults <- commandResult{status: status, body: body}
	}()
	waitForLock("%FROM public.invitations%", "resend invitation", resendResults)
	time.Sleep(time.Second)
	var resendReleasedAt time.Time
	if err := h.fixturePool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&resendReleasedAt); err != nil {
		t.Fatalf("read database clock before resend release: %v", err)
	}
	if err := resendBlocker.Commit(context.WithoutCancel(ctx)); err != nil {
		t.Fatalf("release resend invitation lock: %v", err)
	}
	resendResult := <-resendResults
	if resendResult.status != http.StatusAccepted {
		t.Fatalf("resend after invitation lock: status %d body %s, want 202", resendResult.status, resendResult.body)
	}
	assertContractResponse(t, http.MethodPost, resendPath, resendResult.status, resendResult.body)

	var resentExpiresAt time.Time
	if err := h.fixturePool.QueryRow(ctx, `SELECT expires_at FROM public.invitations WHERE id = $1`, invitationID).Scan(&resentExpiresAt); err != nil {
		t.Fatalf("read resent invitation deadline: %v", err)
	}
	assertFreshDeadline("resent invitation", resendReleasedAt, resentExpiresAt)
}

func TestAcceptInvitationUsesActiveCodeAfterSerializedResends(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "serialized-resend-owner")
	admin := stack.signUpConfirmedUser(t, ctx, "serialized-resend-admin")
	invitee := stack.signUpConfirmedUser(t, ctx, "serialized-resend-invitee")
	seedProfile(t, ctx, h, owner.ID, "Serialized Resend Owner")
	seedProfile(t, ctx, h, admin.ID, "Serialized Resend Admin")
	seedProfile(t, ctx, h, invitee.ID, "Serialized Resend Invitee")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Serialized Resend Org"},
		[]membershipSeed{
			{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"},
			{OrganizationID: orgID, UserID: admin.ID, Role: "admin", Status: "active"},
		},
	)
	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	ownerToken := keys.signToken(t, owner.ID, time.Now().Add(time.Hour))
	adminToken := keys.signToken(t, admin.ID, time.Now().Add(time.Hour))
	inviteeToken := keys.signToken(t, invitee.ID, time.Now().Add(time.Hour))
	createPath := "/identity/organizations/" + orgID + "/invitations"
	status, body := identityCommand(t, handler, http.MethodPost, createPath, ownerToken, map[string]string{"email": invitee.Email})
	if status != http.StatusAccepted {
		t.Fatalf("create invitation for serialized resends: status %d body %s, want 202", status, body)
	}
	var invitationID string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT id FROM public.invitations WHERE organization_id = $1 AND email = $2`, orgID, invitee.Email,
	).Scan(&invitationID); err != nil {
		t.Fatalf("read invitation for serialized resends: %v", err)
	}
	ageActiveInvitationCodeBeyondCooldown(t, ctx, h, invitationID)

	blocker, err := h.fixturePool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin owner membership lock: %v", err)
	}
	defer blocker.Rollback(context.WithoutCancel(ctx))
	if _, err := blocker.Exec(ctx, "SET LOCAL ROLE identity_app"); err != nil {
		t.Fatalf("switch owner membership lock to identity_app: %v", err)
	}
	if _, err := blocker.Exec(ctx,
		`SELECT id FROM public.memberships
		 WHERE organization_id = $1 AND user_id = $2 AND status = 'active'
		 FOR UPDATE`, orgID, owner.ID,
	); err != nil {
		t.Fatalf("hold owner membership lock: %v", err)
	}

	type commandResult struct {
		status int
		body   []byte
	}
	resendPath := createPath + "/" + invitationID + "/resend"
	ownerResults := make(chan commandResult, 1)
	go func() {
		status, body := identityCommand(t, handler, http.MethodPost, resendPath, ownerToken, map[string]string{})
		ownerResults <- commandResult{status: status, body: body}
	}()
	deadline := time.Now().Add(2 * time.Second)
	for {
		select {
		case result := <-ownerResults:
			t.Fatalf("owner resend returned before membership lock released: status %d body %s", result.status, result.body)
		default:
		}
		var waiting int
		if err := h.fixturePool.QueryRow(ctx,
			`SELECT count(*)
			 FROM pg_stat_activity
			 WHERE datname = current_database()
			   AND wait_event_type = 'Lock'
			   AND query LIKE '%FROM public.memberships%'`,
		).Scan(&waiting); err != nil {
			t.Fatalf("observe blocked owner resend: %v", err)
		}
		if waiting > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("owner resend did not reach its membership lock")
		}
		time.Sleep(10 * time.Millisecond)
	}

	status, body = identityCommand(t, handler, http.MethodPost, resendPath, adminToken, map[string]string{})
	if status != http.StatusAccepted {
		t.Fatalf("admin resend while owner blocked: status %d body %s, want 202", status, body)
	}
	assertContractResponse(t, http.MethodPost, resendPath, status, body)
	ageActiveInvitationCodeBeyondCooldown(t, ctx, h, invitationID)
	if err := blocker.Commit(context.WithoutCancel(ctx)); err != nil {
		t.Fatalf("release owner membership lock: %v", err)
	}
	ownerResult := <-ownerResults
	if ownerResult.status != http.StatusAccepted {
		t.Fatalf("owner resend after membership lock: status %d body %s, want 202", ownerResult.status, ownerResult.body)
	}
	assertContractResponse(t, http.MethodPost, resendPath, ownerResult.status, ownerResult.body)

	// The issuance path now records the post-lock wall clock. Backdate only the
	// active row through the test write seam to keep this regression focused on
	// selecting by status rather than assuming timestamp order implies validity.
	if _, err := h.fixturePool.Exec(ctx,
		`UPDATE identity.verification_codes
		 SET created_at = clock_timestamp() - interval '4 minutes'
		 WHERE target_id = $1 AND action_type = 'invitation' AND status = 'active'`, invitationID,
	); err != nil {
		t.Fatalf("backdate active invitation code: %v", err)
	}

	var activeCreatedAt, latestSupersededCreatedAt time.Time
	var activeBody string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT c.created_at, o.body
		 FROM identity.verification_codes c
		 JOIN identity.outbox_messages o ON o.verification_code_id = c.id
		 WHERE c.target_id = $1 AND c.action_type = 'invitation' AND c.status = 'active'`, invitationID,
	).Scan(&activeCreatedAt, &activeBody); err != nil {
		t.Fatalf("read active resent invitation code: %v", err)
	}
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT created_at
		 FROM identity.verification_codes
		 WHERE target_id = $1 AND action_type = 'invitation' AND status = 'superseded'
		 ORDER BY created_at DESC
		 LIMIT 1`, invitationID,
	).Scan(&latestSupersededCreatedAt); err != nil {
		t.Fatalf("read latest superseded invitation code: %v", err)
	}
	if !activeCreatedAt.Before(latestSupersededCreatedAt) {
		t.Fatalf("test setup did not produce an active code older than the superseded predecessor: active %s predecessor %s", activeCreatedAt, latestSupersededCreatedAt)
	}

	acceptPath := "/identity/invitations/" + invitationID + "/accept"
	status, body = identityCommand(t, handler, http.MethodPost, acceptPath, inviteeToken, map[string]string{"code": extractCode(t, activeBody)})
	if status != http.StatusOK {
		t.Fatalf("accept current active code after serialized resends: status %d body %s, want 200", status, body)
	}
	assertContractResponse(t, http.MethodPost, acceptPath, status, body)
}
