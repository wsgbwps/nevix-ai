// Package application orchestrates Creation use-cases over the domain
// ports: every write runs inside the domain-local verified transaction
// runner, every read stays creator-scoped, and no transport vocabulary
// leaks into these functions.
package application

import (
	"context"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// SessionService handles the session aggregate's lifecycle commands and its
// recoverable generation-intent draft.
type SessionService struct {
	repos     domain.SessionRepository
	materials domain.MaterialRepository
	runner    domain.WriteRunner
}

func NewSessionService(repos domain.SessionRepository, materials domain.MaterialRepository, runner domain.WriteRunner) *SessionService {
	return &SessionService{repos: repos, materials: materials, runner: runner}
}

// Create opens one empty private draft session. NormalizeSessionName keeps
// the name contract (trim + 128 chars); an empty stored name is valid.
func (s *SessionService) Create(ctx context.Context, owner domain.UUID, rawName string) (domain.Session, error) {
	name, err := domain.NormalizeSessionName(rawName)
	if err != nil {
		return domain.Session{}, err
	}
	var created domain.Session
	err = s.runner.Run(ctx, func(scope domain.WriteScope) (err error) {
		created, err = s.repos.Create(ctx, scope.Tx(), owner, name)
		return err
	})
	return created, err
}

// Get resolves one active owned session.
func (s *SessionService) Get(ctx context.Context, owner, id domain.UUID) (domain.Session, error) {
	return s.repos.Get(ctx, owner, id)
}

// GetWithDraft resolves the session together with its recoverable draft
// (nil when never saved). The draft is part of the session aggregate — never
// a second business owner.
func (s *SessionService) GetWithDraft(ctx context.Context, owner, id domain.UUID) (domain.Session, *domain.SessionDraft, error) {
	return s.repos.GetWithDraft(ctx, owner, id)
}

// SaveDraft atomically replaces the session's recoverable generation intent:
// prompt, target media, manifest version, model/mode/parameters, and the
// ordered reference bindings land in one verified transaction, so a failure
// leaves no partial update. Manifest conformance is deliberately out of scope
// here — stale values must round-trip untouched until submission validates
// them (spec #150). Session deletion makes the draft unreachable like every
// other session access.
func (s *SessionService) SaveDraft(ctx context.Context, owner, id domain.UUID, draft *domain.SessionDraft) (time.Time, error) {
	if err := draft.Validate(); err != nil {
		return time.Time{}, err
	}
	var revision time.Time
	err := s.runner.Run(ctx, func(scope domain.WriteScope) error {
		// Role/kind compatibility resolves inside the transaction: a material
		// deleted between validation and write fails the whole save instead of
		// persisting a dangling binding.
		ids := make([]domain.UUID, 0, len(draft.References))
		for _, reference := range draft.References {
			ids = append(ids, reference.MaterialID)
		}
		kinds, err := s.materials.ResolveKindsInSession(ctx, scope.Tx(), owner, id, ids)
		if err != nil {
			return err
		}
		for _, reference := range draft.References {
			kind, ok := kinds[reference.MaterialID]
			if !ok || !reference.Role.AcceptsKind(kind) {
				return domain.ErrInvalidDraft
			}
		}
		var err2 error
		revision, err2 = s.repos.SaveDraft(ctx, scope.Tx(), owner, id, draft)
		return err2
	})
	return revision, err
}

// List pages the actor's active sessions.
func (s *SessionService) List(ctx context.Context, owner domain.UUID, cursor *domain.CompoundCursor, limit int) ([]domain.Session, *domain.CompoundCursor, error) {
	return s.repos.List(ctx, owner, cursor, limit)
}

// Rename continues work on a session under a new name.
func (s *SessionService) Rename(ctx context.Context, owner, id domain.UUID, rawName string) (domain.Session, error) {
	name, err := domain.NormalizeSessionName(rawName)
	if err != nil {
		return domain.Session{}, err
	}
	var renamed domain.Session
	err = s.runner.Run(ctx, func(scope domain.WriteScope) (err error) {
		renamed, err = s.repos.Rename(ctx, scope.Tx(), owner, id, name)
		return err
	})
	return renamed, err
}

// Delete logically hides the session and blocks all future generation entry;
// Task, Result, and media-asset lifecycles remain independent (ADR-0016).
func (s *SessionService) Delete(ctx context.Context, owner, id domain.UUID) error {
	return s.runner.Run(ctx, func(scope domain.WriteScope) error {
		return s.repos.Delete(ctx, scope.Tx(), owner, id)
	})
}
