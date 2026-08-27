// Package application orchestrates Creation use-cases over the domain
// ports: every write runs inside the domain-local verified transaction
// runner, every read stays creator-scoped, and no transport vocabulary
// leaks into these functions.
package application

import (
	"context"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// SessionService handles the session aggregate's lifecycle commands.
type SessionService struct {
	repos  domain.SessionRepository
	runner domain.WriteRunner
}

func NewSessionService(repos domain.SessionRepository, runner domain.WriteRunner) *SessionService {
	return &SessionService{repos: repos, runner: runner}
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
