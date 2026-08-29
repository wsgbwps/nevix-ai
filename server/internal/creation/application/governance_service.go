package application

import (
	"context"
	"strconv"

	"github.com/nevix-ai/server/internal/auditlog"
	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/creation/domain"
)

// GovernanceView is the admin-facing policy projection.
type GovernanceView struct {
	Instance *domain.GovernancePolicy
	Users    []GovernanceUserEntry
}

// GovernanceUserEntry pairs one override row with its target.
type GovernanceUserEntry struct {
	UserID domain.UUID
	Policy domain.GovernancePolicy
}

// GovernanceService manages the instance and per-user generation limits.
// Changes take effect for new submissions immediately; accepted tasks and
// accumulated counters are never touched. Every change appends its
// sanitized audit row inside the same transaction.
type GovernanceService struct {
	governance domain.GovernanceRepository
	runner     domain.WriteRunner
}

func NewGovernanceService(governance domain.GovernanceRepository, runner domain.WriteRunner) *GovernanceService {
	return &GovernanceService{governance: governance, runner: runner}
}

// View lists the instance defaults and every user override.
func (s *GovernanceService) View(ctx context.Context) (GovernanceView, error) {
	instance, users, err := s.governance.ListPolicies(ctx)
	if err != nil {
		return GovernanceView{}, err
	}
	view := GovernanceView{Instance: instance, Users: []GovernanceUserEntry{}}
	for _, policy := range users {
		if policy.UserID == nil {
			continue
		}
		view.Users = append(view.Users, GovernanceUserEntry{UserID: *policy.UserID, Policy: policy})
	}
	return view, nil
}

// PutInstance replaces the instance row.
func (s *GovernanceService) PutInstance(ctx context.Context, principal authz.Principal, policy domain.GovernancePolicy) (domain.GovernancePolicy, error) {
	policy.Scope = domain.GovernanceScopeInstance
	policy.UserID = nil
	err := s.put(ctx, principal, policy)
	if err != nil {
		return domain.GovernancePolicy{}, err
	}
	return policy, nil
}

// PutUser replaces one user's override row.
func (s *GovernanceService) PutUser(ctx context.Context, principal authz.Principal, userID domain.UUID, policy domain.GovernancePolicy) (domain.GovernancePolicy, error) {
	policy.Scope = domain.GovernanceScopeUser
	policy.UserID = &userID
	err := s.put(ctx, principal, policy)
	if err != nil {
		return domain.GovernancePolicy{}, err
	}
	return policy, nil
}

func (s *GovernanceService) put(ctx context.Context, principal authz.Principal, policy domain.GovernancePolicy) error {
	editor, err := domain.ParseUUID(principal.UserID)
	if err != nil {
		return err
	}
	return s.runner.Run(ctx, func(sc domain.WriteScope) error {
		if policy.Scope == domain.GovernanceScopeInstance {
			if err := s.governance.PutInstancePolicy(ctx, sc.Tx(), policy, editor); err != nil {
				return err
			}
		} else {
			if err := s.governance.PutUserPolicy(ctx, sc.Tx(), policy, editor); err != nil {
				return err
			}
		}
		return appendGovernanceAudit(ctx, sc.Tx(), principal, auditlog.GenerationGovernanceUpdated, policy)
	})
}

// appendGovernanceAudit writes the sanitized governance audit row inside the
// caller's transaction: scope, target, and the four limit values only.
func appendGovernanceAudit(ctx context.Context, tx domain.TxExecutor, principal authz.Principal, action auditlog.Action, policy domain.GovernancePolicy) error {
	actor, err := auditlog.SnapshotSubject(ctx, tx, principal.UserID)
	if err != nil {
		return err
	}
	metadata := map[string]string{"scope": string(policy.Scope)}
	if policy.UserID != nil {
		metadata["target_user_id"] = policy.UserID.String()
	}
	if policy.ImageConcurrency != nil {
		metadata["image_concurrency"] = itoa(*policy.ImageConcurrency)
	}
	if policy.VideoConcurrency != nil {
		metadata["video_concurrency"] = itoa(*policy.VideoConcurrency)
	}
	if policy.RateLimit != nil {
		metadata["rate_limit"] = itoa(*policy.RateLimit)
	}
	if policy.MonthlyTaskLimit != nil {
		metadata["monthly_task_limit"] = itoa(*policy.MonthlyTaskLimit)
	}
	return auditlog.Append(ctx, tx, auditlog.Entry{Actor: actor, Action: action, Metadata: metadata})
}

func itoa(value int) string {
	return strconv.Itoa(value)
}
