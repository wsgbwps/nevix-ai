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
	// GetWithDraft resolves the session together with its recoverable draft
	// (nil when never saved); both shapes collapse misses into
	// ErrSessionNotFound.
	GetWithDraft(ctx context.Context, owner, id UUID) (Session, *SessionDraft, error)
	List(ctx context.Context, owner UUID, cursor *CompoundCursor, limit int) ([]Session, *CompoundCursor, error)
	Rename(ctx context.Context, tx TxExecutor, owner, id UUID, name string) (Session, error)
	// SaveDraft atomically replaces the draft scalars and the ordered
	// reference bindings inside the caller's write transaction and returns
	// the database's authoritative new revision (draft_updated_at), the
	// value submitters echo back as draft_revision. Missing session
	// collapses into ErrSessionNotFound; a reference to a material outside
	// the session collapses into ErrInvalidDraft.
	SaveDraft(ctx context.Context, tx TxExecutor, owner, id UUID, draft *SessionDraft) (time.Time, error)
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
	// LoadMaterialsInSession resolves the requested materials with full facts
	// inside the caller's transaction; materials outside the session are
	// absent, and admission treats absence as a rejection fact.
	LoadMaterialsInSession(ctx context.Context, tx TxExecutor, owner, sessionID UUID, ids []UUID) ([]ReferenceMaterial, error)
	// ResolveKindsInSession returns the kinds of the requested materials that
	// live under one active owned session; materials outside it are simply
	// absent from the result. Runs inside the caller's transaction so a
	// concurrent delete cannot slip between validation and draft write.
	ResolveKindsInSession(ctx context.Context, tx TxExecutor, owner, sessionID UUID, ids []UUID) (map[UUID]Kind, error)
}

// CompoundCursor is one opaque compound keyset token over (created_at, id).
// Repositories encode/decode their concrete ordering direction around this
// single pair — the shape that keeps page depth O(1) instead of OFFSET decay.
type CompoundCursor struct {
	CreatedAt time.Time
	ID        UUID
}

// ProviderConnectionRepository is the persistence port for the instance's
// single AI Provider Connection aggregate. Every method addresses the active
// (non-terminated) row; the singleton partial unique index is the durable
// backstop for concurrent creates.
type ProviderConnectionRepository interface {
	// Insert persists the first active connection inside the caller's write
	// transaction; a concurrent winner surfaces ErrConnectionExists.
	Insert(ctx context.Context, tx TxExecutor, c *ProviderConnection) error
	// GetActive resolves the active connection or ErrConnectionNotConfigured.
	GetActive(ctx context.Context) (ProviderConnection, error)
	// ReplaceCredential atomically switches the envelope and the credential/
	// media states inside the caller's write transaction.
	ReplaceCredential(ctx context.Context, tx TxExecutor, id UUID, envelope *ProviderCredentialEnvelope, credentialState CredentialState, image, video MediaCapability, checkedAt time.Time, outcome CheckOutcome) error
	// SetAdminState flips enabled/paused and returns the updated aggregate.
	SetAdminState(ctx context.Context, tx TxExecutor, id UUID, state AdminState) (ProviderConnection, error)
	// SetCheckResult persists a recheck's credential/media verdicts.
	SetCheckResult(ctx context.Context, tx TxExecutor, id UUID, credentialState CredentialState, image, video MediaCapability, checkedAt time.Time, outcome CheckOutcome) error
	// MarkCredentialUnavailable fails the connection closed (master key or
	// envelope failure) with both media unavailable.
	MarkCredentialUnavailable(ctx context.Context, tx TxExecutor, id UUID) error
	// Terminate clears the envelope columns and stamps terminated_at inside
	// the caller's write transaction; the identity row is retained.
	Terminate(ctx context.Context, tx TxExecutor, id UUID) error
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

// GenerationTaskRepository is the persistence port for the generation task
// kernel. Admission methods run inside the caller's verified write
// transaction so specification, task, slots, job, queue item, and
// reservation commit or roll back together; queries are creator-scoped by
// the SQL predicates themselves; guarded transitions return false when the
// one-way migration loses a race so callers can never fabricate state.
type GenerationTaskRepository interface {
	// LoadSessionDraftForAdmission resolves the active owned session and its
	// draft inside the admission transaction, so the frozen specification
	// and the revision check share one snapshot.
	LoadSessionDraftForAdmission(ctx context.Context, tx TxExecutor, owner, sessionID UUID) (Session, *SessionDraft, error)
	// FindByIdempotencyKey resolves a prior admitted task for the same
	// creator-scoped key inside the admission transaction; ok is false when
	// the key is fresh.
	FindByIdempotencyKey(ctx context.Context, tx TxExecutor, owner UUID, key string) (GenerationTask, bool, error)
	// InsertAttempt records one structurally valid submission attempt for
	// the rolling rate window (including attempts later rejected by other
	// governance rules).
	InsertAttempt(ctx context.Context, tx TxExecutor, userID UUID) error
	// CountAttemptsSince counts structurally valid attempts inside the
	// rolling window; a nil user counts the whole instance.
	CountAttemptsSince(ctx context.Context, tx TxExecutor, userID *UUID, since time.Time) (int, error)
	// CountTasksCreatedSince counts admitted tasks since the given instant;
	// a nil user counts the whole instance (Asia/Shanghai monthly window).
	CountTasksCreatedSince(ctx context.Context, tx TxExecutor, userID *UUID, since time.Time) (int, error)
	// CountActiveReservations counts the creator's unreleased concurrency
	// reservations for one media pool.
	CountActiveReservations(ctx context.Context, tx TxExecutor, owner UUID, media MediaType) (int, error)
	// InsertAdmittedTask persists task, all slots, the first pending job,
	// the queue item, and the reservation atomically in the caller's
	// transaction. Any failure rolls the whole admission back.
	InsertAdmittedTask(ctx context.Context, tx TxExecutor, admitted *AdmittedTask) error

	// ListBySession pages one session's tasks newest-first (creator-scoped).
	ListBySession(ctx context.Context, owner, sessionID UUID, cursor *CompoundCursor, limit int) ([]GenerationTask, *CompoundCursor, error)
	// GetForOwner resolves one task and its slots for its creator; every
	// miss collapses into ErrTaskNotFound.
	GetForOwner(ctx context.Context, owner, taskID UUID) (GenerationTask, []GenerationSlot, error)
	// GetForWorker resolves one task with its slots outside any transaction
	// for the queue worker; ownership is already proven by the queue row.
	GetForWorker(ctx context.Context, taskID UUID) (GenerationTask, []GenerationSlot, ProviderJob, error)
	// GetForOwnerInTx resolves one owned task plus slots on the caller's
	// transaction (cancel convergence reads the exact state it mutates).
	GetForOwnerInTx(ctx context.Context, tx TxExecutor, owner, taskID UUID) (GenerationTask, []GenerationSlot, ProviderJob, error)
	// ExistsNonTerminal reports whether any task still owes work — the
	// durable connection-delete guard.
	ExistsNonTerminal(ctx context.Context) (bool, error)

	// TransitionTask performs one guarded one-way migration and stamps
	// terminal_at on terminal arrivals. It returns false when the current
	// status is not in from — an expected race, not an error.
	TransitionTask(ctx context.Context, tx TxExecutor, taskID UUID, from []TaskStatus, to TaskStatus, cause *TerminalCause) (bool, error)
	// ReleaseReservation marks the task's reservation released exactly once
	// (guarded by released_at IS NULL) inside the caller's transaction; the
	// boolean is the release fact.
	ReleaseReservation(ctx context.Context, tx TxExecutor, taskID UUID) (bool, error)
	// RequestCancel records the cancel intent on an owned task (idempotent)
	// and returns its current status; ok is false when the task is not the
	// caller's at all.
	RequestCancel(ctx context.Context, tx TxExecutor, owner, taskID UUID) (TaskStatus, bool, error)
	// TransitionJob performs one guarded job migration, optionally binding
	// the external reference on first submission.
	TransitionJob(ctx context.Context, tx TxExecutor, jobID UUID, from []JobStatus, to JobStatus, externalRef *string) (bool, error)
	// BeginJobSubmitAttempt commits the pending/submitting marker, clears a
	// prior transient outcome, and increments the provider-call count exactly
	// once immediately before one external submit. attempts is valid when ok.
	BeginJobSubmitAttempt(ctx context.Context, tx TxExecutor, jobID UUID, from []JobStatus) (attempts int, ok bool, err error)
	// MarkJobSubmitRetryable records that the in-flight submit ended in a
	// definitively identified transient rejection (explicit 429/503), which
	// makes a bounded re-submit safe; the next submit attempt clears it.
	MarkJobSubmitRetryable(ctx context.Context, tx TxExecutor, jobID UUID) error
	// WriteSlotVerdict writes one slot's terminal verdict write-once; an
	// already-settled slot keeps its first verdict and returns false.
	WriteSlotVerdict(ctx context.Context, tx TxExecutor, taskID UUID, index int, status SlotStatus, reason *FailureReason, diagnostic *FailureDiagnostic, result *SlotResult) (bool, error)
	// LoadSlotOutcomes reads every slot's current verdict (nil for pending).
	LoadSlotOutcomes(ctx context.Context, tx TxExecutor, taskID UUID) ([]SlotOutcome, error)

	// ClaimNextQueueItem atomically claims the next runnable queue item with
	// FOR UPDATE SKIP LOCKED outside any long transaction; ok is false when
	// nothing is runnable. The lease bounds the claim; worker crashes
	// release it by expiry.
	ClaimNextQueueItem(ctx context.Context, leaseOwner string, lease time.Duration) (ClaimedQueueItem, bool, error)
	// ReleaseQueueItem makes a claimed item runnable again at runAfter and
	// drops the lease, inside the caller's transaction.
	ReleaseQueueItem(ctx context.Context, tx TxExecutor, queueID UUID, runAfter time.Time) error
	// ResetQueueBudget zeroes a claimed item's attempt counter for holds
	// that must not consume the bounded retry budget (pause, pressure).
	ResetQueueBudget(ctx context.Context, tx TxExecutor, queueID UUID) error
	// RetireQueueItem saturates a finished item's attempts so the claim
	// predicate skips it forever without deleting history.
	RetireQueueItem(ctx context.Context, tx TxExecutor, queueID UUID) error
	// GetQueueItemByTask resolves the queue row for one task (worker paths).
	GetQueueItemByTask(ctx context.Context, tx TxExecutor, taskID UUID) (UUID, int, int, error)
}

// GovernanceRepository is the persistence port for the governance policy
// rows. Limits are independently optional: nil means unset (unlimited) and
// zero explicitly forbids.
type GovernanceRepository interface {
	// LoadPolicies resolves the instance row and the per-user overrides for
	// admission inside the caller's transaction.
	LoadPolicies(ctx context.Context, tx TxExecutor) (*GovernancePolicy, map[UUID]GovernancePolicy, error)
	// PutInstancePolicy upserts the instance row (full-row replacement).
	PutInstancePolicy(ctx context.Context, tx TxExecutor, policy GovernancePolicy, updatedBy UUID) error
	// PutUserPolicy upserts one user's override row (full-row replacement).
	PutUserPolicy(ctx context.Context, tx TxExecutor, policy GovernancePolicy, updatedBy UUID) error
	// ListPolicies resolves every policy row for the admin view (pool read).
	ListPolicies(ctx context.Context) (*GovernancePolicy, []GovernancePolicy, error)
}

// ConnectionSignals is the narrow port the task kernel uses to persist
// provider signals on the connection aggregate: the persistent 402 credit
// block. Pause/resume stays on the connection commands; this port only
// records and clears the block inside the caller's transaction.
type ConnectionSignals interface {
	// MarkCreditBlocked stamps credit_blocked_at on the active connection;
	// idempotent when already blocked.
	MarkCreditBlocked(ctx context.Context, tx TxExecutor) error
	// ClearCreditBlocked lifts the persistent credit block.
	ClearCreditBlocked(ctx context.Context, tx TxExecutor) error
	// GetActive re-exported read for worker admission checks.
	GetActive(ctx context.Context) (ProviderConnection, error)
	// GetActiveInTx reads the active connection on the caller's transaction
	// so admission's manifest projection shares the admission snapshot.
	GetActiveInTx(ctx context.Context, tx TxExecutor) (ProviderConnection, error)
}
