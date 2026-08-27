package domain

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// SessionRepository is the persistence port for the session aggregate. Every
// method is creator-scoped: ownership and logical deletion are enforced by
// the queries themselves, so a repository caller can never observe another
// member's session even by guessing ids (ADR-0016 visibility model). Write
// methods receive the caller's verified transaction; reads run off the pool.
type SessionRepository interface {
	Create(ctx context.Context, tx TxExecutor, owner UUID, name string) (Session, error)
	// Get resolves one active (non-deleted) session owned by the acting user.
	// Ingestion reuses it to fail before streaming bytes.
	Get(ctx context.Context, owner, id UUID) (Session, error)
	List(ctx context.Context, owner UUID, cursor *CompoundCursor, limit int) ([]Session, *CompoundCursor, error)
	Rename(ctx context.Context, tx TxExecutor, owner, id UUID, name string) (Session, error)
	Delete(ctx context.Context, tx TxExecutor, owner, id UUID) error
}

// MaterialRepository is the persistence port for reference materials. Reads
// join the owning session so a deleted session's materials disappear with it.
type MaterialRepository interface {
	// Insert persists one fully validated material inside the caller's write
	// transaction scope; blob placement happened earlier outside any tx.
	Insert(ctx context.Context, tx TxExecutor, m *ReferenceMaterial) error
	// GetForRead resolves one material for its creator through an active
	// session; every failure shape collapses into ErrMaterialNotFound.
	GetForRead(ctx context.Context, owner, id UUID) (ReferenceMaterial, error)
	ListBySession(ctx context.Context, owner, sessionID UUID, cursor *CompoundCursor, limit int) ([]ReferenceMaterial, *CompoundCursor, error)
	// Delete removes the material row only when both the material and its
	// session belong to the acting creator and the session is still active.
	// The returned blob key schedules after-commit cleanup.
	Delete(ctx context.Context, tx TxExecutor, owner, id UUID) (blobKey string, err error)
}

// CompoundCursor is one opaque compound keyset token over (created_at, id).
// Repositories encode/decode their concrete ordering direction around this
// single pair — the shape that keeps page depth O(1) instead of OFFSET decay.
type CompoundCursor struct {
	CreatedAt time.Time
	ID        UUID
}

// WriteScope is the domain view of one in-flight verified write
// transaction: statement execution plus after-commit effect registration.
// Application callbacks see only this; begin/commit/rollback discipline
// stays inside the Module's write-transaction implementation.
type WriteScope interface {
	Tx() TxExecutor
	AfterCommit(effect func())
}

// WriteRunner executes one callback exactly once inside a verified write
// transaction (ADR-0016 creation write transactions).
type WriteRunner interface {
	Run(ctx context.Context, fn func(WriteScope) error) error
}

// Row and TxExecutor alias the pgx surfaces write transactions hand out.
// Aliasing keeps every repository signature honest about the single database
// driver this Module binds to while staying one indirection away from it.
type (
	Row        = pgx.Row
	TxExecutor = pgx.Tx
)
