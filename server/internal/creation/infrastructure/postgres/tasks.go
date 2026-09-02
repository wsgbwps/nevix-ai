package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// GenerationTaskRepository implements the task-kernel port over PostgreSQL.
// Every guarded transition is a single conditional UPDATE whose WHERE clause
// is the durable twin of the domain one-way state machine: a lost race
// updates zero rows and reports false instead of fabricating state.
type GenerationTaskRepository struct {
	pool *pgxpool.Pool
}

func NewGenerationTaskRepository(pool *pgxpool.Pool) *GenerationTaskRepository {
	return &GenerationTaskRepository{pool: pool}
}

// nonTerminalTaskStatuses is the shared non-terminal set used by predicates
// and guarded updates; it mirrors the domain vocabulary and the CHECK.
var nonTerminalTaskStatuses = []string{
	string(domain.TaskQueued), string(domain.TaskSubmitting), string(domain.TaskProcessing),
	string(domain.TaskPersisting), string(domain.TaskCancelling),
}

// LoadSessionForAdmission reads the active owned session on the admission
// transaction so liveness and ownership share the caller's snapshot.
func (r *GenerationTaskRepository) LoadSessionForAdmission(ctx context.Context, tx domain.TxExecutor, owner, sessionID domain.UUID) (domain.Session, error) {
	row := tx.QueryRow(ctx,
		`SELECT id, name, created_at, updated_at FROM creation_sessions
		 WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`,
		sessionID, owner)
	var s domain.Session
	if err := row.Scan(&s.ID, &s.Name, &s.CreatedAt, &s.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Session{}, domain.ErrSessionNotFound
		}
		return domain.Session{}, fmt.Errorf("creation: load session for admission: %w", err)
	}
	s.OwnerID = owner
	return s, nil
}

// FindByIdempotencyKey resolves a prior task for the creator-scoped key on
// the admission transaction.
func (r *GenerationTaskRepository) FindByIdempotencyKey(ctx context.Context, tx domain.TxExecutor, owner domain.UUID, key string) (domain.GenerationTask, bool, error) {
	row := tx.QueryRow(ctx, `
		SELECT id, session_id, owner_user_id, idempotency_key, payload_hash, media_type,
		       specification, manifest_version, status, slot_count,
		       terminal_cause, cancel_requested_at IS NOT NULL, created_at, updated_at, terminal_at
		FROM creation_generation_tasks WHERE owner_user_id = $1 AND idempotency_key = $2`,
		owner, key)
	task, err := scanTaskFull(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.GenerationTask{}, false, nil
	}
	if err != nil {
		return domain.GenerationTask{}, false, fmt.Errorf("creation: find idempotent task: %w", err)
	}
	return task, true, nil
}

// InsertAttempt records one structurally valid attempt row.
func (r *GenerationTaskRepository) InsertAttempt(ctx context.Context, tx domain.TxExecutor, userID domain.UUID) error {
	if _, err := tx.Exec(ctx,
		`INSERT INTO creation_generation_attempts (user_id) VALUES ($1)`, userID); err != nil {
		return fmt.Errorf("creation: insert generation attempt: %w", err)
	}
	return nil
}

// CountAttemptsSince counts attempts in the rolling window; a nil user is
// the instance-wide count.
func (r *GenerationTaskRepository) CountAttemptsSince(ctx context.Context, tx domain.TxExecutor, userID *domain.UUID, since time.Time) (int, error) {
	var count int
	var err error
	if userID == nil {
		err = tx.QueryRow(ctx,
			`SELECT count(*) FROM creation_generation_attempts WHERE attempted_at >= $1`, since).Scan(&count)
	} else {
		err = tx.QueryRow(ctx,
			`SELECT count(*) FROM creation_generation_attempts WHERE user_id = $1 AND attempted_at >= $2`,
			*userID, since).Scan(&count)
	}
	if err != nil {
		return 0, fmt.Errorf("creation: count generation attempts: %w", err)
	}
	return count, nil
}

// CountTasksCreatedSince counts admitted tasks since the instant (monthly
// governance window); a nil user is the instance-wide count.
func (r *GenerationTaskRepository) CountTasksCreatedSince(ctx context.Context, tx domain.TxExecutor, userID *domain.UUID, since time.Time) (int, error) {
	var count int
	var err error
	if userID == nil {
		err = tx.QueryRow(ctx,
			`SELECT count(*) FROM creation_generation_tasks WHERE created_at >= $1`, since).Scan(&count)
	} else {
		err = tx.QueryRow(ctx,
			`SELECT count(*) FROM creation_generation_tasks WHERE owner_user_id = $1 AND created_at >= $2`,
			*userID, since).Scan(&count)
	}
	if err != nil {
		return 0, fmt.Errorf("creation: count monthly tasks: %w", err)
	}
	return count, nil
}

// CountActiveReservations counts unreleased reservations in one media pool.
func (r *GenerationTaskRepository) CountActiveReservations(ctx context.Context, tx domain.TxExecutor, owner domain.UUID, media domain.MediaType) (int, error) {
	var count int
	err := tx.QueryRow(ctx, `
		SELECT count(*) FROM creation_generation_reservations
		WHERE owner_user_id = $1 AND media_type = $2 AND released_at IS NULL`,
		owner, string(media)).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("creation: count active reservations: %w", err)
	}
	return count, nil
}

// InsertAdmittedTask persists task, slots, job, queue item, and reservation
// inside the caller's transaction. Lock ordering is stable by construction:
// task → slots (ordered) → job → queue → reservation.
func (r *GenerationTaskRepository) InsertAdmittedTask(ctx context.Context, tx domain.TxExecutor, admitted *domain.AdmittedTask) error {
	task := admitted.Task
	specJSON, err := json.Marshal(task.Spec)
	if err != nil {
		return fmt.Errorf("creation: encode generation specification: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO creation_generation_tasks (
			id, session_id, owner_user_id, idempotency_key, payload_hash, media_type,
			specification, manifest_version, status, slot_count
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		task.ID, task.SessionID, task.OwnerID, task.IdempotencyKey, task.PayloadHash,
		string(task.Spec.MediaType), specJSON, task.Spec.ManifestVersion,
		string(task.Status), task.SlotCount); err != nil {
		return fmt.Errorf("creation: insert generation task: %w", err)
	}
	for _, slot := range admitted.Slots {
		if _, err := tx.Exec(ctx, `
			INSERT INTO creation_generation_slots (task_id, slot_index) VALUES ($1, $2)`,
			task.ID, slot.Index); err != nil {
			return fmt.Errorf("creation: insert generation slot: %w", err)
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO creation_provider_jobs (id, task_id, media_type, status) VALUES ($1, $2, $3, $4)`,
		admitted.Job.ID, task.ID, string(admitted.Job.Media), string(domain.JobPending)); err != nil {
		return fmt.Errorf("creation: insert provider job: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO creation_generation_queue (task_id, media_type, run_after) VALUES ($1, $2, $3)`,
		task.ID, string(admitted.Job.Media), admitted.RunAfter); err != nil {
		return fmt.Errorf("creation: insert queue item: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO creation_generation_reservations (task_id, owner_user_id, media_type) VALUES ($1, $2, $3)`,
		task.ID, admitted.ReservationOwner, string(admitted.ReservationMedia)); err != nil {
		return fmt.Errorf("creation: insert concurrency reservation: %w", err)
	}
	return nil
}

// --- creator-scoped queries -------------------------------------------------

const taskSummaryColumns = `id, session_id, owner_user_id, media_type, status, slot_count,
	terminal_cause, cancel_requested_at IS NOT NULL, created_at, updated_at, terminal_at`

func scanTaskSummary(row pgx.Row) (domain.GenerationTask, error) {
	var t domain.GenerationTask
	var media, status string
	var cause *string
	if err := row.Scan(&t.ID, &t.SessionID, &t.OwnerID, &media, &status, &t.SlotCount,
		&cause, &t.CancelRequested, &t.CreatedAt, &t.UpdatedAt, &t.TerminalAt); err != nil {
		return domain.GenerationTask{}, err
	}
	t.Media = domain.MediaType(media)
	t.Status = domain.TaskStatus(status)
	if cause != nil {
		marked := domain.TerminalCause(*cause)
		t.TerminalCause = &marked
	}
	return t, nil
}

func scanTaskFull(row pgx.Row) (domain.GenerationTask, error) {
	var t domain.GenerationTask
	var media, status string
	var cause *string
	var specJSON []byte
	var manifestVersion int
	err := row.Scan(&t.ID, &t.SessionID, &t.OwnerID, &t.IdempotencyKey, &t.PayloadHash,
		&media, &specJSON, &manifestVersion, &status, &t.SlotCount,
		&cause, &t.CancelRequested, &t.CreatedAt, &t.UpdatedAt, &t.TerminalAt)
	if err != nil {
		return domain.GenerationTask{}, err
	}
	t.Media = domain.MediaType(media)
	t.Status = domain.TaskStatus(status)
	if cause != nil {
		marked := domain.TerminalCause(*cause)
		t.TerminalCause = &marked
	}
	if err := json.Unmarshal(specJSON, &t.Spec); err != nil {
		return domain.GenerationTask{}, fmt.Errorf("creation: decode generation specification: %w", err)
	}
	return t, nil
}

// ListBySession pages one session's tasks newest-first, creator-scoped.
func (r *GenerationTaskRepository) ListBySession(ctx context.Context, owner, sessionID domain.UUID, cursor *domain.CompoundCursor, limit int) ([]domain.GenerationTask, *domain.CompoundCursor, error) {
	args := []any{owner, sessionID, cursorTime(cursor), cursorID(cursor), limit + 1}
	rows, err := r.pool.Query(ctx, `
		SELECT `+taskSummaryColumns+` FROM creation_generation_tasks
		WHERE owner_user_id = $1 AND session_id = $2
		  AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
		ORDER BY created_at DESC, id DESC
		LIMIT $5`, args...)
	if err != nil {
		return nil, nil, fmt.Errorf("creation: list generation tasks: %w", err)
	}
	defer rows.Close()
	tasks := make([]domain.GenerationTask, 0, limit)
	for rows.Next() {
		task, err := scanTaskSummary(rows)
		if err != nil {
			return nil, nil, fmt.Errorf("creation: scan generation task: %w", err)
		}
		tasks = append(tasks, task)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("creation: list generation tasks rows: %w", err)
	}
	next := nextCursor(len(tasks), limit, func(i int) (time.Time, domain.UUID) {
		return tasks[i].CreatedAt, tasks[i].ID
	})
	tasks = truncatePage(tasks, limit)
	return tasks, next, nil
}

// GetForOwner resolves one task plus slots for its creator (pool read).
func (r *GenerationTaskRepository) GetForOwner(ctx context.Context, owner, taskID domain.UUID) (domain.GenerationTask, []domain.GenerationSlot, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return domain.GenerationTask{}, nil, fmt.Errorf("creation: begin task read: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	task, slots, _, err := readTaskWithSlotsAndJob(ctx, tx, owner, taskID)
	return task, slots, err
}

// GetForWorker resolves task, slots, and the active job for the queue
// worker (pool read; ownership proven by the queue row).
func (r *GenerationTaskRepository) GetForWorker(ctx context.Context, taskID domain.UUID) (domain.GenerationTask, []domain.GenerationSlot, domain.ProviderJob, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return domain.GenerationTask{}, nil, domain.ProviderJob{}, fmt.Errorf("creation: begin worker read: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	return readTaskWithSlotsAndJob(ctx, tx, domain.UUID{}, taskID)
}

// taskReadExec is the statement surface a task detail read needs; both the
// pool and a caller's transaction satisfy it.
type taskReadExec interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// readTaskWithSlotsAndJob shares the task detail read; a zero owner skips
// the ownership predicate (worker path).
func readTaskWithSlotsAndJob(ctx context.Context, exec taskReadExec, owner, taskID domain.UUID) (domain.GenerationTask, []domain.GenerationSlot, domain.ProviderJob, error) {
	ownerPredicate := "AND owner_user_id = $2"
	args := []any{taskID, owner}
	if owner == (domain.UUID{}) {
		ownerPredicate = ""
		args = []any{taskID}
	}
	task, err := scanTaskFull(exec.QueryRow(ctx, `
		SELECT id, session_id, owner_user_id, idempotency_key, payload_hash, media_type,
		       specification, manifest_version, status, slot_count,
		       terminal_cause, cancel_requested_at IS NOT NULL, created_at, updated_at, terminal_at
		FROM creation_generation_tasks WHERE id = $1 `+ownerPredicate, args...))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.GenerationTask{}, nil, domain.ProviderJob{}, domain.ErrTaskNotFound
	}
	if err != nil {
		return domain.GenerationTask{}, nil, domain.ProviderJob{}, fmt.Errorf("creation: get generation task: %w", err)
	}

	slotRows, err := exec.Query(ctx, `
		SELECT slot_index, status, failure_reason,
		       failure_diagnostic_source, failure_diagnostic_code, failure_diagnostic_message,
		       failure_diagnostic_http_status, failure_diagnostic_provider_type, failure_diagnostic_request_id,
		       result_mime, result_byte_size, result_checksum,
		       result_blob_key, result_width_px, result_height_px, result_duration_ms
		FROM creation_generation_slots WHERE task_id = $1 ORDER BY slot_index ASC`, taskID)
	if err != nil {
		return domain.GenerationTask{}, nil, domain.ProviderJob{}, fmt.Errorf("creation: list slots: %w", err)
	}
	defer slotRows.Close()
	slots := make([]domain.GenerationSlot, 0, task.SlotCount)
	for slotRows.Next() {
		slot, err := scanSlot(slotRows)
		if err != nil {
			return domain.GenerationTask{}, nil, domain.ProviderJob{}, err
		}
		slots = append(slots, slot)
	}
	if err := slotRows.Err(); err != nil {
		return domain.GenerationTask{}, nil, domain.ProviderJob{}, fmt.Errorf("creation: list slots rows: %w", err)
	}

	var job domain.ProviderJob
	var status *string
	err = exec.QueryRow(ctx, `
		SELECT id, task_id, media_type, status, external_ref, last_outcome, submit_attempts, created_at, updated_at, terminal_at
		FROM creation_provider_jobs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1`, taskID).
		Scan(&job.ID, &job.TaskID, &job.Media, &status, &job.ExternalRef, &job.Outcome, &job.SubmitAttempts, &job.CreatedAt, &job.UpdatedAt, &job.TerminalAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return task, slots, domain.ProviderJob{}, nil
	}
	if err != nil {
		return domain.GenerationTask{}, nil, domain.ProviderJob{}, fmt.Errorf("creation: get provider job: %w", err)
	}
	if status != nil {
		job.Status = domain.JobStatus(*status)
	}
	return task, slots, job, nil
}

func scanSlot(row pgx.Row) (domain.GenerationSlot, error) {
	var s domain.GenerationSlot
	var status, reason, diagnosticSource, diagnosticCode, diagnosticMessage *string
	var diagnosticHTTPStatus *int
	var diagnosticProviderType, diagnosticRequestID *string
	if err := row.Scan(
		&s.Index, &status, &reason,
		&diagnosticSource, &diagnosticCode, &diagnosticMessage,
		&diagnosticHTTPStatus, &diagnosticProviderType, &diagnosticRequestID,
		&s.ResultMime, &s.ResultByteSize,
		&s.ResultChecksum, &s.ResultBlobKey, &s.ResultWidthPx, &s.ResultHeightPx, &s.ResultDurationMS); err != nil {
		return domain.GenerationSlot{}, fmt.Errorf("creation: scan slot: %w", err)
	}
	if status != nil {
		verdict := domain.SlotStatus(*status)
		s.Status = &verdict
	}
	if reason != nil {
		parsed := domain.FailureReason(*reason)
		s.Reason = &parsed
	}
	if diagnosticSource != nil && diagnosticCode != nil && diagnosticMessage != nil {
		s.Diagnostic = &domain.FailureDiagnostic{
			Source:       domain.FailureDiagnosticSource(*diagnosticSource),
			Code:         *diagnosticCode,
			Message:      *diagnosticMessage,
			HTTPStatus:   diagnosticHTTPStatus,
			ProviderType: diagnosticProviderType,
			RequestID:    diagnosticRequestID,
		}
	}
	return s, nil
}

// ExistsNonTerminal is the durable connection-delete guard predicate.
func (r *GenerationTaskRepository) ExistsNonTerminal(ctx context.Context) (bool, error) {
	var exists bool
	err := r.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM creation_generation_tasks
			WHERE status = ANY($1::text[])
		)`, nonTerminalTaskStatuses).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("creation: exists non-terminal task: %w", err)
	}
	return exists, nil
}

// --- guarded transitions -----------------------------------------------------

func statusesArg[T ~string](statuses []T) []string {
	values := make([]string, len(statuses))
	for i, s := range statuses {
		values[i] = string(s)
	}
	return values
}

// terminalTaskStatuses mirrors the CHECK's terminal set for terminal_at.
var terminalTaskStatuses = []string{
	string(domain.TaskSucceeded), string(domain.TaskPartiallySucceeded), string(domain.TaskFailed),
	string(domain.TaskCancelled), string(domain.TaskTimedOut),
}

var terminalJobStatuses = []string{
	string(domain.JobCompleted), string(domain.JobFailed), string(domain.JobCancelled),
	string(domain.JobTimedOut), string(domain.JobIndeterminate),
}

// TransitionTask performs one guarded one-way migration. Terminal arrivals
// stamp terminal_at in the same statement; the reservation is released by
// the caller in the same transaction on the returned true-and-terminal path.
func (r *GenerationTaskRepository) TransitionTask(ctx context.Context, tx domain.TxExecutor, taskID domain.UUID, from []domain.TaskStatus, to domain.TaskStatus, cause *domain.TerminalCause) (bool, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE creation_generation_tasks SET
			status = $2,
			terminal_cause = $3,
			terminal_at = CASE WHEN $2 = ANY($4::text[]) THEN now() ELSE NULL END,
			updated_at = now()
		WHERE id = $1 AND status = ANY($5::text[])`,
		taskID, string(to), terminalCauseArg(cause), terminalTaskStatuses, statusesArg(from))
	if err != nil {
		return false, fmt.Errorf("creation: transition task: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

func terminalCauseArg(cause *domain.TerminalCause) any {
	if cause == nil {
		return nil
	}
	return string(*cause)
}

// ReleaseReservation marks the reservation released exactly once; the WHERE
// guard makes the second call a no-op, so Job retries and duplicate
// completions can never double-release.
func (r *GenerationTaskRepository) ReleaseReservation(ctx context.Context, tx domain.TxExecutor, taskID domain.UUID) (bool, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE creation_generation_reservations SET released_at = now()
		WHERE task_id = $1 AND released_at IS NULL`, taskID)
	if err != nil {
		return false, fmt.Errorf("creation: release reservation: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// RequestCancel records the cancel intent once on an owned task and returns
// its current status so the service can decide the immediate-cancel path.
func (r *GenerationTaskRepository) RequestCancel(ctx context.Context, tx domain.TxExecutor, owner, taskID domain.UUID) (domain.TaskStatus, bool, error) {
	row := tx.QueryRow(ctx, `
		UPDATE creation_generation_tasks SET
			cancel_requested_at = COALESCE(cancel_requested_at, now()), updated_at = now()
		WHERE id = $2 AND owner_user_id = $1
		RETURNING status`, owner, taskID)
	var status string
	err := row.Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("creation: request cancel: %w", err)
	}
	return domain.TaskStatus(status), true, nil
}

// TransitionJob performs one guarded job migration, binding the external
// reference on first submission when provided.
func (r *GenerationTaskRepository) TransitionJob(ctx context.Context, tx domain.TxExecutor, jobID domain.UUID, from []domain.JobStatus, to domain.JobStatus, externalRef *string) (bool, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE creation_provider_jobs SET
			status = $2,
			external_ref = COALESCE($3, external_ref),
			last_outcome = NULL,
			terminal_at = CASE WHEN $2 = ANY($4::text[]) THEN now() ELSE NULL END,
			updated_at = now()
		WHERE id = $1 AND status = ANY($5::text[])`,
		jobID, string(to), externalRef, terminalJobStatuses, statusesArg(from))
	if err != nil {
		return false, fmt.Errorf("creation: transition provider job: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// BeginJobSubmitAttempt persists the crash-recovery marker and the dedicated
// provider-call count in one short transaction immediately before Submit.
func (r *GenerationTaskRepository) BeginJobSubmitAttempt(ctx context.Context, tx domain.TxExecutor, jobID domain.UUID, from []domain.JobStatus) (int, bool, error) {
	var attempts int
	err := tx.QueryRow(ctx, `
		UPDATE creation_provider_jobs SET
			status = 'submitting', submit_attempts = submit_attempts + 1,
			last_outcome = NULL, terminal_at = NULL, updated_at = now()
		WHERE id = $1 AND status = ANY($2::text[])
		RETURNING submit_attempts`, jobID, statusesArg(from)).Scan(&attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("creation: begin provider submit attempt: %w", err)
	}
	return attempts, true, nil
}

// WriteSlotVerdict writes one slot's terminal verdict write-once; an
// already-settled slot keeps its first verdict and reports false.
func (r *GenerationTaskRepository) WriteSlotVerdict(ctx context.Context, tx domain.TxExecutor, taskID domain.UUID, index int, status domain.SlotStatus, reason *domain.FailureReason, diagnostic *domain.FailureDiagnostic, result *domain.SlotResult) (bool, error) {
	var mime, blobKey any
	var size any
	var checksum any
	var width, height, duration any
	var diagnosticSource, diagnosticCode, diagnosticMessage any
	var diagnosticHTTPStatus, diagnosticProviderType, diagnosticRequestID any
	if diagnostic != nil {
		diagnosticSource = string(diagnostic.Source)
		diagnosticCode = diagnostic.Code
		diagnosticMessage = diagnostic.Message
		diagnosticHTTPStatus = diagnostic.HTTPStatus
		diagnosticProviderType = diagnostic.ProviderType
		diagnosticRequestID = diagnostic.RequestID
	}
	if result != nil {
		mime, size, checksum, blobKey = result.Mime, result.ByteSize, result.Checksum, result.BlobKey
		width, height, duration = result.WidthPx, result.HeightPx, result.DurationMS
	}
	tag, err := tx.Exec(ctx, `
		UPDATE creation_generation_slots SET
			status = $3, failure_reason = $4,
			failure_diagnostic_source = $5, failure_diagnostic_code = $6,
			failure_diagnostic_message = $7, failure_diagnostic_http_status = $8,
			failure_diagnostic_provider_type = $9, failure_diagnostic_request_id = $10,
			result_mime = $11, result_byte_size = $12, result_checksum = $13, result_blob_key = $14,
			result_width_px = $15, result_height_px = $16, result_duration_ms = $17
		WHERE task_id = $1 AND slot_index = $2 AND status IS NULL`,
		taskID, index, string(status), failureReasonArg(reason),
		diagnosticSource, diagnosticCode, diagnosticMessage, diagnosticHTTPStatus,
		diagnosticProviderType, diagnosticRequestID,
		mime, size, checksum, blobKey, width, height, duration)
	if err != nil {
		return false, fmt.Errorf("creation: write slot verdict: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

func failureReasonArg(reason *domain.FailureReason) any {
	if reason == nil {
		return nil
	}
	return string(*reason)
}

// LoadSlotOutcomes reads every settled slot's verdict.
func (r *GenerationTaskRepository) LoadSlotOutcomes(ctx context.Context, tx domain.TxExecutor, taskID domain.UUID) ([]domain.SlotOutcome, error) {
	rows, err := tx.Query(ctx, `
		SELECT slot_index, status FROM creation_generation_slots
		WHERE task_id = $1 AND status IS NOT NULL ORDER BY slot_index ASC`, taskID)
	if err != nil {
		return nil, fmt.Errorf("creation: load slot outcomes: %w", err)
	}
	defer rows.Close()
	outcomes := []domain.SlotOutcome{}
	for rows.Next() {
		var index int
		var status string
		if err := rows.Scan(&index, &status); err != nil {
			return nil, fmt.Errorf("creation: scan slot outcome: %w", err)
		}
		outcomes = append(outcomes, domain.SlotOutcome{Index: index, Status: domain.SlotStatus(status)})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("creation: load slot outcomes rows: %w", err)
	}
	return outcomes, nil
}

// --- queue ------------------------------------------------------------------

// ClaimNextQueueItem atomically claims the next runnable item with FOR
// UPDATE SKIP LOCKED in one statement — no held transaction, no double
// claim, and a crashed worker's lease expires back to the pool.
func (r *GenerationTaskRepository) ClaimNextQueueItem(ctx context.Context, leaseOwner string, lease time.Duration) (domain.ClaimedQueueItem, bool, error) {
	row := r.pool.QueryRow(ctx, `
		UPDATE creation_generation_queue SET
			lease_owner = $1, lease_until = now() + ($2 * interval '1 second'),
			attempts = attempts + 1, updated_at = now()
		WHERE id = (
			SELECT id FROM creation_generation_queue
			WHERE run_after <= now() AND attempts < max_attempts
			  AND (lease_until IS NULL OR lease_until <= now())
			ORDER BY run_after, id
			LIMIT 1
			FOR UPDATE SKIP LOCKED
		)
		RETURNING id, task_id, attempts, max_attempts`, leaseOwner, int(lease.Seconds()))
	var item domain.ClaimedQueueItem
	err := row.Scan(&item.QueueID, &item.TaskID, &item.Attempts, &item.Max)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ClaimedQueueItem{}, false, nil
	}
	if err != nil {
		return domain.ClaimedQueueItem{}, false, fmt.Errorf("creation: claim queue item: %w", err)
	}
	return item, true, nil
}

// ReleaseQueueItem drops the lease and makes the item runnable at runAfter.
func (r *GenerationTaskRepository) ReleaseQueueItem(ctx context.Context, tx domain.TxExecutor, queueID domain.UUID, runAfter time.Time) error {
	if _, err := tx.Exec(ctx, `
		UPDATE creation_generation_queue SET
			run_after = $2, lease_owner = NULL, lease_until = NULL, updated_at = now()
		WHERE id = $1`, queueID, runAfter); err != nil {
		return fmt.Errorf("creation: release queue item: %w", err)
	}
	return nil
}

// RetireQueueItem saturates attempts so the claim predicate skips a finished
// item forever without deleting its row.
func (r *GenerationTaskRepository) RetireQueueItem(ctx context.Context, tx domain.TxExecutor, queueID domain.UUID) error {
	if _, err := tx.Exec(ctx, `
		UPDATE creation_generation_queue SET
			attempts = max_attempts, lease_owner = NULL, lease_until = NULL, updated_at = now()
		WHERE id = $1`, queueID); err != nil {
		return fmt.Errorf("creation: retire queue item: %w", err)
	}
	return nil
}

// GetQueueItemByTask resolves the queue row for one task on the caller's
// transaction.
func (r *GenerationTaskRepository) GetQueueItemByTask(ctx context.Context, tx domain.TxExecutor, taskID domain.UUID) (domain.UUID, int, int, error) {
	var id domain.UUID
	var attempts, max int
	err := tx.QueryRow(ctx, `
		SELECT id, attempts, max_attempts FROM creation_generation_queue WHERE task_id = $1`, taskID).
		Scan(&id, &attempts, &max)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.UUID{}, 0, 0, domain.ErrTaskNotFound
	}
	if err != nil {
		return domain.UUID{}, 0, 0, fmt.Errorf("creation: get queue item: %w", err)
	}
	return id, attempts, max, nil
}

// GetForOwnerInTx resolves one owned task plus slots on the caller's
// transaction, so cancel convergence reads the exact state it mutates.
func (r *GenerationTaskRepository) GetForOwnerInTx(ctx context.Context, tx domain.TxExecutor, owner, taskID domain.UUID) (domain.GenerationTask, []domain.GenerationSlot, domain.ProviderJob, error) {
	return readTaskWithSlotsAndJob(ctx, tx, owner, taskID)
}

// ResetQueueBudget zeroes the attempt counter of a claimed item so holds
// (pause, provider pressure) never exhaust the bounded retry budget.
func (r *GenerationTaskRepository) ResetQueueBudget(ctx context.Context, tx domain.TxExecutor, queueID domain.UUID) error {
	if _, err := tx.Exec(ctx, `
		UPDATE creation_generation_queue SET attempts = 0, updated_at = now() WHERE id = $1`, queueID); err != nil {
		return fmt.Errorf("creation: reset queue budget: %w", err)
	}
	return nil
}

// MarkJobSubmitRetryable records a definitively identified transient submit
// rejection on the submitting job, licensing the next bounded re-submit.
func (r *GenerationTaskRepository) MarkJobSubmitRetryable(ctx context.Context, tx domain.TxExecutor, jobID domain.UUID) error {
	if _, err := tx.Exec(ctx, `
		UPDATE creation_provider_jobs SET last_outcome = 'transient_rejected', updated_at = now()
		WHERE id = $1 AND status = 'submitting'`, jobID); err != nil {
		return fmt.Errorf("creation: mark job submit retryable: %w", err)
	}
	return nil
}
