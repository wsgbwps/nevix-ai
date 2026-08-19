// Integration tests for Membership and Organization-setting trusted commands.
// They use the spec's agreed seams: the mounted HTTP interface, real
// PostgreSQL state, real Data API RLS reads, and rendered Outbox rows.
package integrationtest

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestLeaveOrganizationEndsMembershipWithoutEmail(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "leave-owner")
	member := stack.signUpConfirmedUser(t, ctx, "leave-member")
	admin := stack.signUpConfirmedUser(t, ctx, "leave-admin")
	seedProfile(t, ctx, h, member.ID, "Leaving Member")
	seedProfile(t, ctx, h, admin.ID, "Leaving Admin")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Leave Organization"},
		[]membershipSeed{
			{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"},
			{OrganizationID: orgID, UserID: member.ID, Role: "member", Status: "active"},
			{OrganizationID: orgID, UserID: admin.ID, Role: "admin", Status: "active"},
		},
	)
	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	path := "/identity/organizations/" + orgID + "/leave"

	status, body := identityCommand(t, handler, http.MethodPost, path,
		keys.signToken(t, member.ID, time.Now().Add(time.Hour)), map[string]string{})
	if status != http.StatusOK {
		t.Fatalf("leave organization: status %d body %s, want 200", status, body)
	}
	assertContractResponse(t, http.MethodPost, path, status, body)

	var role, membershipStatus, actorID, action string
	var targetIsNull bool
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT m.role, m.status, a.actor_user_id, a.action, a.target_user_id IS NULL
		 FROM public.memberships AS m
		 JOIN public.audit_logs AS a ON a.organization_id = m.organization_id AND a.actor_user_id = m.user_id AND a.action = 'membership_left'
		 WHERE m.organization_id = $1 AND m.user_id = $2 AND m.status = 'ended'
		 ORDER BY a.created_at DESC LIMIT 1`, orgID, member.ID,
	).Scan(&role, &membershipStatus, &actorID, &action, &targetIsNull); err != nil {
		t.Fatalf("read ended membership and audit row: %v", err)
	}
	if role != "member" || membershipStatus != "ended" || actorID != member.ID || action != "membership_left" || !targetIsNull {
		t.Fatalf("leave state = role:%q status:%q actor:%q action:%q targetIsNull:%t, want ended Member + self membership_left audit", role, membershipStatus, actorID, action, targetIsNull)
	}

	var outboxRows int
	if err := h.fixturePool.QueryRow(ctx, `SELECT count(*) FROM identity.outbox_messages WHERE recipient = $1`, member.Email).Scan(&outboxRows); err != nil {
		t.Fatalf("count leave outbox rows: %v", err)
	}
	if outboxRows != 0 {
		t.Fatalf("leave queued %d email rows, want none", outboxRows)
	}

	status, body = identityCommand(t, handler, http.MethodPost, path,
		keys.signToken(t, admin.ID, time.Now().Add(time.Hour)), map[string]string{})
	if status != http.StatusOK {
		t.Fatalf("admin leave organization: status %d body %s, want 200", status, body)
	}
	assertContractResponse(t, http.MethodPost, path, status, body)
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT m.role, m.status, a.actor_user_id, a.action, a.target_user_id IS NULL
		 FROM public.memberships AS m
		 JOIN public.audit_logs AS a ON a.organization_id = m.organization_id AND a.actor_user_id = m.user_id AND a.action = 'membership_left'
		 WHERE m.organization_id = $1 AND m.user_id = $2 AND m.status = 'ended'
		 ORDER BY a.created_at DESC LIMIT 1`, orgID, admin.ID,
	).Scan(&role, &membershipStatus, &actorID, &action, &targetIsNull); err != nil {
		t.Fatalf("read ended admin membership and audit row: %v", err)
	}
	if role != "admin" || membershipStatus != "ended" || actorID != admin.ID || action != "membership_left" || !targetIsNull {
		t.Fatalf("admin leave state = role:%q status:%q actor:%q action:%q targetIsNull:%t, want ended Admin + self membership_left audit", role, membershipStatus, actorID, action, targetIsNull)
	}
	if err := h.fixturePool.QueryRow(ctx, `SELECT count(*) FROM identity.outbox_messages WHERE recipient = $1`, admin.Email).Scan(&outboxRows); err != nil {
		t.Fatalf("count admin leave outbox rows: %v", err)
	}
	if outboxRows != 0 {
		t.Fatalf("admin leave queued %d email rows, want none", outboxRows)
	}
}

func TestRemoveMemberEndsAccessAndQueuesOnlyMemberNotification(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "remove-owner")
	member := stack.signUpConfirmedUser(t, ctx, "remove-member")
	seedProfile(t, ctx, h, owner.ID, "Removing Owner")
	seedProfile(t, ctx, h, member.ID, "Removed Member")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Removal Organization"},
		[]membershipSeed{
			{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"},
			{OrganizationID: orgID, UserID: member.ID, Role: "member", Status: "active"},
		},
	)
	var membershipID string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT id FROM public.memberships WHERE organization_id = $1 AND user_id = $2 AND status = 'active'`, orgID, member.ID,
	).Scan(&membershipID); err != nil {
		t.Fatalf("read removable membership: %v", err)
	}

	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	path := "/identity/organizations/" + orgID + "/members/" + membershipID + "/remove"
	status, body := identityCommand(t, handler, http.MethodPost, path,
		keys.signToken(t, owner.ID, time.Now().Add(time.Hour)), map[string]string{})
	if status != http.StatusOK {
		t.Fatalf("remove member: status %d body %s, want 200", status, body)
	}
	assertContractResponse(t, http.MethodPost, path, status, body)

	var membershipStatus, actorName, targetName, action string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT m.status, a.actor_display_name, a.target_display_name, a.action
		 FROM public.memberships AS m
		 JOIN public.audit_logs AS a ON a.organization_id = m.organization_id
		 WHERE m.id = $1
		 ORDER BY a.created_at DESC LIMIT 1`, membershipID,
	).Scan(&membershipStatus, &actorName, &targetName, &action); err != nil {
		t.Fatalf("read removal state and audit: %v", err)
	}
	if membershipStatus != "ended" || actorName != "Removing Owner" || targetName != "Removed Member" || action != "member_removed" {
		t.Fatalf("removal state = status:%q actor:%q target:%q action:%q, want ended + immutable member_removed snapshot", membershipStatus, actorName, targetName, action)
	}

	var recipient, subject, message string
	var carriesCode bool
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT recipient, subject, body, verification_code_id IS NOT NULL
		 FROM identity.outbox_messages
		 WHERE recipient = $1`, member.Email,
	).Scan(&recipient, &subject, &message, &carriesCode); err != nil {
		t.Fatalf("read member removal outbox row: %v", err)
	}
	if recipient != member.Email || carriesCode {
		t.Fatalf("member removal outbox row = recipient:%q carriesCode:%t, want only the removed member without a code", recipient, carriesCode)
	}
	for _, fragment := range []string{"Removal Organization", "Removing Owner", "已被移除", "removed"} {
		if !strings.Contains(subject+"\n"+message, fragment) {
			t.Fatalf("member removal mail misses bilingual fragment %q: subject=%q body=%q", fragment, subject, message)
		}
	}
	var ownerRows int
	if err := h.fixturePool.QueryRow(ctx, `SELECT count(*) FROM identity.outbox_messages WHERE recipient = $1`, owner.Email).Scan(&ownerRows); err != nil {
		t.Fatalf("count owner removal outbox rows: %v", err)
	}
	if ownerRows != 0 {
		t.Fatalf("ordinary Member removal queued %d owner email rows, want none", ownerRows)
	}

	rows := stack.restRows(t, ctx, "/organizations?select=id&id=eq."+orgID, member.Token)
	if len(rows) != 0 {
		t.Fatalf("removed Member still sees organization rows %v, want immediate loss of access", rows)
	}
}

func TestAdminCanRemoveOrdinaryMember(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "admin-remove-owner")
	admin := stack.signUpConfirmedUser(t, ctx, "admin-remove-admin")
	member := stack.signUpConfirmedUser(t, ctx, "admin-remove-member")
	seedProfile(t, ctx, h, admin.ID, "Removing Admin")
	seedProfile(t, ctx, h, member.ID, "Admin Removed Member")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Admin Removal Organization"},
		[]membershipSeed{
			{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"},
			{OrganizationID: orgID, UserID: admin.ID, Role: "admin", Status: "active"},
			{OrganizationID: orgID, UserID: member.ID, Role: "member", Status: "active"},
		},
	)
	var membershipID string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT id FROM public.memberships WHERE organization_id = $1 AND user_id = $2 AND status = 'active'`, orgID, member.ID,
	).Scan(&membershipID); err != nil {
		t.Fatalf("read admin-removable membership: %v", err)
	}

	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	path := "/identity/organizations/" + orgID + "/members/" + membershipID + "/remove"
	status, body := identityCommand(t, handler, http.MethodPost, path,
		keys.signToken(t, admin.ID, time.Now().Add(time.Hour)), map[string]string{})
	if status != http.StatusOK {
		t.Fatalf("admin remove member: status %d body %s, want 200", status, body)
	}
	assertContractResponse(t, http.MethodPost, path, status, body)

	var membershipStatus, actorName, action string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT m.status, a.actor_display_name, a.action
		 FROM public.memberships AS m
		 JOIN public.audit_logs AS a ON a.organization_id = m.organization_id AND a.target_user_id = m.user_id
		 WHERE m.id = $1 AND a.action = 'member_removed'`, membershipID,
	).Scan(&membershipStatus, &actorName, &action); err != nil {
		t.Fatalf("read admin removal state: %v", err)
	}
	if membershipStatus != "ended" || actorName != "Removing Admin" || action != "member_removed" {
		t.Fatalf("admin removal state = status:%q actor:%q action:%q, want ended Member and admin audit", membershipStatus, actorName, action)
	}

	var ownerRows, memberRows int
	if err := h.fixturePool.QueryRow(ctx, `SELECT count(*) FROM identity.outbox_messages WHERE recipient = $1`, owner.Email).Scan(&ownerRows); err != nil {
		t.Fatalf("count owner admin-removal notifications: %v", err)
	}
	if err := h.fixturePool.QueryRow(ctx, `SELECT count(*) FROM identity.outbox_messages WHERE recipient = $1`, member.Email).Scan(&memberRows); err != nil {
		t.Fatalf("count member admin-removal notifications: %v", err)
	}
	if ownerRows != 0 || memberRows != 1 {
		t.Fatalf("admin ordinary removal notifications = owner:%d member:%d, want 0/1", ownerRows, memberRows)
	}
}

func TestChangeMemberRolePreservesOwnerAndQueuesAdminNotifications(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "role-owner")
	member := stack.signUpConfirmedUser(t, ctx, "role-member")
	admin := stack.signUpConfirmedUser(t, ctx, "role-admin")
	seedProfile(t, ctx, h, owner.ID, "Role Owner")
	seedProfile(t, ctx, h, member.ID, "Role Member")
	seedProfile(t, ctx, h, admin.ID, "Role Admin")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Role Organization"},
		[]membershipSeed{
			{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"},
			{OrganizationID: orgID, UserID: member.ID, Role: "member", Status: "active"},
			{OrganizationID: orgID, UserID: admin.ID, Role: "admin", Status: "active"},
		},
	)
	var memberID, adminID string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT id FROM public.memberships WHERE organization_id = $1 AND user_id = $2 AND status = 'active'`, orgID, member.ID,
	).Scan(&memberID); err != nil {
		t.Fatalf("read promotable membership: %v", err)
	}
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT id FROM public.memberships WHERE organization_id = $1 AND user_id = $2 AND status = 'active'`, orgID, admin.ID,
	).Scan(&adminID); err != nil {
		t.Fatalf("read removable admin membership: %v", err)
	}

	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	ownerToken := keys.signToken(t, owner.ID, time.Now().Add(time.Hour))
	memberPath := "/identity/organizations/" + orgID + "/members/" + memberID + "/role"

	status, body := identityCommand(t, handler, http.MethodPost, memberPath, ownerToken, map[string]string{"action": "promote"})
	if status != http.StatusOK {
		t.Fatalf("promote member: status %d body %s, want 200", status, body)
	}
	assertContractResponse(t, http.MethodPost, memberPath, status, body)
	assertRoleChangeState(t, ctx, h, memberID, "admin", "active", "admin_promoted", "Role Owner", "Role Member")
	assertAdminNotification(t, ctx, h,
		member.Email, "Role Member", owner.Email, "Role Owner", 1,
		"Role Owner 已将 Role Member 在「Role Organization」的权限调整为管理员",
		`Role Owner has promoted Role Member to Admin in "Role Organization".`,
	)

	status, body = identityCommand(t, handler, http.MethodPost, memberPath, ownerToken, map[string]string{"action": "demote"})
	if status != http.StatusOK {
		t.Fatalf("demote admin: status %d body %s, want 200", status, body)
	}
	assertContractResponse(t, http.MethodPost, memberPath, status, body)
	assertRoleChangeState(t, ctx, h, memberID, "member", "active", "admin_demoted", "Role Owner", "Role Member")
	assertAdminNotification(t, ctx, h,
		member.Email, "Role Member", owner.Email, "Role Owner", 2,
		"Role Owner 已将 Role Member 在「Role Organization」的管理员权限调整为成员",
		`Role Owner has demoted Role Member from Admin to Member in "Role Organization".`,
	)

	adminPath := "/identity/organizations/" + orgID + "/members/" + adminID + "/role"
	status, body = identityCommand(t, handler, http.MethodPost, adminPath, ownerToken, map[string]string{"action": "remove"})
	if status != http.StatusOK {
		t.Fatalf("remove admin: status %d body %s, want 200", status, body)
	}
	assertContractResponse(t, http.MethodPost, adminPath, status, body)
	assertRoleChangeState(t, ctx, h, adminID, "admin", "ended", "admin_removed", "Role Owner", "Role Admin")
	assertAdminNotification(t, ctx, h,
		admin.Email, "Role Admin", owner.Email, "Role Owner", 1,
		"Role Admin 已被移除出「Role Organization」的管理员角色，操作人为 Role Owner",
		`Role Owner has removed Role Admin from the Admin role in "Role Organization".`,
		"Access for Role Admin ended immediately.",
	)

	var activeOwners, ownerNotificationRows int
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT count(*) FROM public.memberships WHERE organization_id = $1 AND role = 'owner' AND status = 'active'`, orgID,
	).Scan(&activeOwners); err != nil {
		t.Fatalf("count active owners: %v", err)
	}
	if activeOwners != 1 {
		t.Fatalf("active owner count = %d, want exactly one", activeOwners)
	}
	if err := h.fixturePool.QueryRow(ctx, `SELECT count(*) FROM identity.outbox_messages WHERE recipient = $1`, owner.Email).Scan(&ownerNotificationRows); err != nil {
		t.Fatalf("count owner Admin lifecycle notifications: %v", err)
	}
	if ownerNotificationRows != 3 {
		t.Fatalf("owner Admin lifecycle notifications = %d, want one for each of promote/demote/remove", ownerNotificationRows)
	}
}

func assertRoleChangeState(t *testing.T, ctx context.Context, h *harness, membershipID, wantRole, wantStatus, wantAction, wantActor, wantTarget string) {
	t.Helper()
	var role, membershipStatus, action, actorName, targetName string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT m.role, m.status, a.action, a.actor_display_name, a.target_display_name
		 FROM public.memberships AS m
		 JOIN public.audit_logs AS a ON a.organization_id = m.organization_id AND a.target_user_id = m.user_id
		 WHERE m.id = $1 AND a.action = $2
		 ORDER BY a.created_at DESC LIMIT 1`, membershipID, wantAction,
	).Scan(&role, &membershipStatus, &action, &actorName, &targetName); err != nil {
		t.Fatalf("read %s state: %v", wantAction, err)
	}
	if role != wantRole || membershipStatus != wantStatus || action != wantAction || actorName != wantActor || targetName != wantTarget {
		t.Fatalf("%s state = role:%q status:%q action:%q actor:%q target:%q, want role:%q status:%q action:%q actor:%q target:%q", wantAction, role, membershipStatus, action, actorName, targetName, wantRole, wantStatus, wantAction, wantActor, wantTarget)
	}
}

func assertAdminNotification(t *testing.T, ctx context.Context, h *harness, affectedEmail, affectedName, ownerEmail, ownerName string, wantAffectedRows int, bodyFragments ...string) {
	t.Helper()
	for _, recipient := range []struct {
		email string
		name  string
	}{
		{email: affectedEmail, name: affectedName},
		{email: ownerEmail, name: ownerName},
	} {
		var subject, body string
		var carriesCode bool
		if err := h.fixturePool.QueryRow(ctx,
			`SELECT subject, body, verification_code_id IS NOT NULL
			 FROM identity.outbox_messages
			 WHERE recipient = $1
			 ORDER BY created_at DESC LIMIT 1`, recipient.email,
		).Scan(&subject, &body, &carriesCode); err != nil {
			t.Fatalf("read Admin role notification for %s: %v", recipient.email, err)
		}
		if carriesCode {
			t.Fatalf("Admin role notification for %s carries a verification code", recipient.email)
		}
		for _, greeting := range []string{"您好，" + recipient.name + "：", "Hello, " + recipient.name + ":"} {
			if !strings.Contains(body, greeting) {
				t.Fatalf("Admin role notification for %s misses recipient greeting %q: subject=%q body=%q", recipient.email, greeting, subject, body)
			}
		}
		for _, fragment := range bodyFragments {
			if !strings.Contains(body, fragment) {
				t.Fatalf("Admin role notification for %s misses event body fragment %q: subject=%q body=%q", recipient.email, fragment, subject, body)
			}
		}
		if recipient.email == ownerEmail {
			for _, fragment := range []string{
				"您的权限已提升", "has promoted you",
				"您的权限已降级", "has demoted you",
				"您已被移除", "has removed you",
				"您的组织访问权限已立即结束", "Your organization access ended immediately",
			} {
				if strings.Contains(body, fragment) {
					t.Fatalf("Owner notification claims the affected User's change in the Owner's perspective via %q: body=%q", fragment, body)
				}
			}
		}
	}
	var affectedRows int
	if err := h.fixturePool.QueryRow(ctx, `SELECT count(*) FROM identity.outbox_messages WHERE recipient = $1`, affectedEmail).Scan(&affectedRows); err != nil {
		t.Fatalf("count notifications for %s: %v", affectedEmail, err)
	}
	if affectedRows != wantAffectedRows {
		t.Fatalf("notifications for %s = %d, want %d", affectedEmail, affectedRows, wantAffectedRows)
	}
}

func TestMembershipCommandsEnforceAuthorizationAndStateBoundaries(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "command-owner")
	admin := stack.signUpConfirmedUser(t, ctx, "command-admin")
	member := stack.signUpConfirmedUser(t, ctx, "command-member")
	outsider := stack.signUpConfirmedUser(t, ctx, "command-outsider")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Command Boundary Organization"},
		[]membershipSeed{
			{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"},
			{OrganizationID: orgID, UserID: admin.ID, Role: "admin", Status: "active"},
			{OrganizationID: orgID, UserID: member.ID, Role: "member", Status: "active"},
		},
	)
	var adminID, memberID string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT id FROM public.memberships WHERE organization_id = $1 AND user_id = $2 AND status = 'active'`, orgID, admin.ID,
	).Scan(&adminID); err != nil {
		t.Fatalf("read command-boundary admin: %v", err)
	}
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT id FROM public.memberships WHERE organization_id = $1 AND user_id = $2 AND status = 'active'`, orgID, member.ID,
	).Scan(&memberID); err != nil {
		t.Fatalf("read command-boundary member: %v", err)
	}

	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	leavePath := "/identity/organizations/" + orgID + "/leave"
	removePath := "/identity/organizations/" + orgID + "/members/" + memberID + "/remove"
	adminRemovePath := "/identity/organizations/" + orgID + "/members/" + adminID + "/remove"
	memberRolePath := "/identity/organizations/" + orgID + "/members/" + memberID + "/role"
	missingRolePath := "/identity/organizations/" + orgID + "/members/" + newRLSOrgID(t) + "/role"

	for _, check := range []struct {
		name, method, path, token, wantError, wantMessage string
		payload                                           any
		wantStatus                                        int
	}{
		{"owner leave", http.MethodPost, leavePath, keys.signToken(t, owner.ID, time.Now().Add(time.Hour)), "owner_cannot_leave", "", map[string]string{}, http.StatusConflict},
		{"outsider role", http.MethodPost, memberRolePath, keys.signToken(t, outsider.ID, time.Now().Add(time.Hour)), "organization_not_found", "", map[string]string{"action": "promote"}, http.StatusNotFound},
		{"admin role", http.MethodPost, memberRolePath, keys.signToken(t, admin.ID, time.Now().Add(time.Hour)), "insufficient_organization_role", "Owner role is required.", map[string]string{"action": "promote"}, http.StatusForbidden},
		{"member removal", http.MethodPost, removePath, keys.signToken(t, member.ID, time.Now().Add(time.Hour)), "insufficient_organization_role", "Owner or Admin role is required.", map[string]string{}, http.StatusForbidden},
		{"admin ordinary removal", http.MethodPost, adminRemovePath, keys.signToken(t, admin.ID, time.Now().Add(time.Hour)), "membership_not_member", "", map[string]string{}, http.StatusConflict},
		{"owner demote member", http.MethodPost, memberRolePath, keys.signToken(t, owner.ID, time.Now().Add(time.Hour)), "membership_not_admin", "", map[string]string{"action": "demote"}, http.StatusConflict},
		{"owner missing membership", http.MethodPost, missingRolePath, keys.signToken(t, owner.ID, time.Now().Add(time.Hour)), "membership_not_found", "", map[string]string{"action": "remove"}, http.StatusNotFound},
	} {
		status, body := identityCommand(t, handler, check.method, check.path, check.token, check.payload)
		if status != check.wantStatus {
			t.Errorf("%s: status %d body %s, want %d", check.name, status, body, check.wantStatus)
			continue
		}
		assertCommandError(t, body, check.wantError)
		if check.wantMessage != "" {
			var envelope struct {
				Message string `json:"message"`
			}
			if err := json.Unmarshal(body, &envelope); err != nil {
				t.Fatalf("%s: decode command error message: %v", check.name, err)
			}
			if envelope.Message != check.wantMessage {
				t.Fatalf("%s: command error message = %q, want %q; body %s", check.name, envelope.Message, check.wantMessage, body)
			}
		}
		assertContractResponse(t, check.method, check.path, status, body)
	}

	var activeOwners, activeMembers, auditRows, outboxRows int
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT count(*) FROM public.memberships WHERE organization_id = $1 AND role = 'owner' AND status = 'active'`, orgID,
	).Scan(&activeOwners); err != nil {
		t.Fatalf("count command-boundary owners: %v", err)
	}
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT count(*) FROM public.memberships WHERE organization_id = $1 AND status = 'active'`, orgID,
	).Scan(&activeMembers); err != nil {
		t.Fatalf("count command-boundary memberships: %v", err)
	}
	if err := h.fixturePool.QueryRow(ctx, `SELECT count(*) FROM public.audit_logs WHERE organization_id = $1`, orgID).Scan(&auditRows); err != nil {
		t.Fatalf("count command-boundary audits: %v", err)
	}
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT count(*) FROM identity.outbox_messages WHERE recipient IN ($1, $2, $3, $4)`,
		owner.Email, admin.Email, member.Email, outsider.Email,
	).Scan(&outboxRows); err != nil {
		t.Fatalf("count command-boundary outbox rows: %v", err)
	}
	if activeOwners != 1 || activeMembers != 3 || auditRows != 0 || outboxRows != 0 {
		t.Fatalf("rejected command state = owners:%d members:%d audit:%d outbox:%d, want 1/3/0/0", activeOwners, activeMembers, auditRows, outboxRows)
	}
}

func TestUpdateOrganizationSettingsOwnerOnlyAuthorization(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)
	owner := stack.signUpConfirmedUser(t, ctx, "settings-owner")
	admin := stack.signUpConfirmedUser(t, ctx, "settings-admin")
	member := stack.signUpConfirmedUser(t, ctx, "settings-member")
	formerMember := stack.signUpConfirmedUser(t, ctx, "settings-former-member")
	outsider := stack.signUpConfirmedUser(t, ctx, "settings-outsider")
	seedProfile(t, ctx, h, owner.ID, "Settings Owner")
	seedProfile(t, ctx, h, admin.ID, "Settings Admin")
	seedProfile(t, ctx, h, member.ID, "Settings Member")
	seedProfile(t, ctx, h, formerMember.ID, "Former Settings Member")

	orgID := newRLSOrgID(t)
	stack.seedAsIdentityApp(t, ctx,
		[]string{orgID}, []string{"Original Organization"},
		[]membershipSeed{
			{OrganizationID: orgID, UserID: owner.ID, Role: "owner", Status: "active"},
			{OrganizationID: orgID, UserID: admin.ID, Role: "admin", Status: "active"},
			{OrganizationID: orgID, UserID: member.ID, Role: "member", Status: "active"},
			{OrganizationID: orgID, UserID: formerMember.ID, Role: "member", Status: "ended"},
		},
	)

	keys := newES256KeyServer(t)
	handler := newTransportHandler(t, h, keys.server.URL, []string{"http://desktop.nevix.test"})
	path := "/identity/organizations/" + orgID + "/settings"
	status, body := identityCommand(t, handler, http.MethodPatch, path,
		keys.signToken(t, owner.ID, time.Now().Add(time.Hour)), map[string]string{"name": "  Settings by Owner  "})
	if status != http.StatusOK {
		t.Fatalf("owner update settings: status %d body %s, want 200", status, body)
	}
	assertContractResponse(t, http.MethodPatch, path, status, body)
	var response struct {
		Organization struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"organization"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatalf("decode owner settings response: %v", err)
	}
	if response.Organization.ID != orgID || response.Organization.Name != "Settings by Owner" {
		t.Fatalf("owner settings response = id:%q name:%q, want id:%q trimmed name:%q", response.Organization.ID, response.Organization.Name, orgID, "Settings by Owner")
	}
	assertSettingsState(t, ctx, h, orgID, "Settings by Owner", "Settings Owner")

	for _, check := range []struct {
		name, userID string
	}{
		{name: "admin", userID: admin.ID},
		{name: "member", userID: member.ID},
	} {
		status, body = identityCommand(t, handler, http.MethodPatch, path,
			keys.signToken(t, check.userID, time.Now().Add(time.Hour)), map[string]string{"name": "Rejected Rename"})
		if status != http.StatusForbidden {
			t.Fatalf("%s update settings: status %d body %s, want 403", check.name, status, body)
		}
		assertCommandError(t, body, "insufficient_organization_role")
		var envelope struct {
			Message string `json:"message"`
		}
		if err := json.Unmarshal(body, &envelope); err != nil {
			t.Fatalf("decode %s settings error: %v", check.name, err)
		}
		if envelope.Message != "Owner role is required." {
			t.Fatalf("%s settings error message = %q, want Owner-only explanation", check.name, envelope.Message)
		}
		assertContractResponse(t, http.MethodPatch, path, status, body)
	}

	for _, check := range []struct {
		name, userID string
	}{
		{name: "former member", userID: formerMember.ID},
		{name: "outsider", userID: outsider.ID},
	} {
		status, body = identityCommand(t, handler, http.MethodPatch, path,
			keys.signToken(t, check.userID, time.Now().Add(time.Hour)), map[string]string{"name": "Non-enumerating Rename"})
		if status != http.StatusNotFound {
			t.Fatalf("%s update settings: status %d body %s, want 404", check.name, status, body)
		}
		assertCommandError(t, body, "organization_not_found")
		assertContractResponse(t, http.MethodPatch, path, status, body)
	}

	status, body = identityCommand(t, handler, http.MethodPatch, path,
		keys.signToken(t, owner.ID, time.Now().Add(time.Hour)), map[string]string{})
	if status != http.StatusBadRequest {
		t.Fatalf("missing organization name: status %d body %s, want 400", status, body)
	}
	assertCommandError(t, body, "invalid_request")
	assertContractResponse(t, http.MethodPatch, path, status, body)

	status, body = identityCommand(t, handler, http.MethodPatch, path,
		keys.signToken(t, owner.ID, time.Now().Add(time.Hour)), map[string]string{"name": "   "})
	if status != http.StatusBadRequest {
		t.Fatalf("blank organization name: status %d body %s, want 400", status, body)
	}
	assertCommandError(t, body, "invalid_organization_name")
	assertContractResponse(t, http.MethodPatch, path, status, body)
	assertSettingsState(t, ctx, h, orgID, "Settings by Owner", "Settings Owner")

	var auditRows, outboxRows int
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT count(*) FROM public.audit_logs WHERE organization_id = $1 AND action = 'organization_settings_updated'`, orgID,
	).Scan(&auditRows); err != nil {
		t.Fatalf("count settings audit rows: %v", err)
	}
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT count(*) FROM identity.outbox_messages WHERE recipient IN ($1, $2, $3, $4, $5)`,
		owner.Email, admin.Email, member.Email, formerMember.Email, outsider.Email,
	).Scan(&outboxRows); err != nil {
		t.Fatalf("count settings outbox rows: %v", err)
	}
	if auditRows != 1 {
		t.Fatalf("settings updates wrote %d audit rows, want exactly one Owner update", auditRows)
	}
	if outboxRows != 0 {
		t.Fatalf("settings updates queued %d mail rows, want none", outboxRows)
	}
}

func assertSettingsState(t *testing.T, ctx context.Context, h *harness, organizationID, wantName, wantActor string) {
	t.Helper()
	var name, action, actorName string
	var targetIsNull bool
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT o.name, a.action, a.actor_display_name, a.target_user_id IS NULL
		 FROM public.organizations AS o
		 JOIN public.audit_logs AS a ON a.organization_id = o.id
		 WHERE o.id = $1 AND a.action = 'organization_settings_updated'
		 ORDER BY a.created_at DESC LIMIT 1`, organizationID,
	).Scan(&name, &action, &actorName, &targetIsNull); err != nil {
		t.Fatalf("read settings update state: %v", err)
	}
	if name != wantName || action != "organization_settings_updated" || actorName != wantActor || !targetIsNull {
		t.Fatalf("settings state = name:%q action:%q actor:%q targetIsNull:%t, want name:%q settings audit by %q with no target", name, action, actorName, targetIsNull, wantName, wantActor)
	}
}
