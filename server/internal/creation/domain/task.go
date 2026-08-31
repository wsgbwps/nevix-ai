package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
	"time"

	// The governance month is fixed to Asia/Shanghai; embedding the tz
	// database keeps that boundary correct on zoneinfo-less container images.
	_ "time/tzdata"
)

// Generation Task kernel (spec #150): an immutable Generation Specification
// frozen at admission, one task progressing through one-way states, N stable
// ordered slots, and one AI Provider Job per external execution. Terminal
// states never reopen, internal retry never returns to queued, and an
// indeterminate provider outcome is never auto-retried.

// MediaType is the generation target media of a task.
type MediaType string

const (
	MediaImage MediaType = "image"
	MediaVideo MediaType = "video"
)

// TaskStatus is the task state machine. Non-terminal: queued, submitting,
// processing, persisting, cancelling. Terminal: succeeded,
// partially_succeeded, failed, cancelled, timed_out.
type TaskStatus string

const (
	TaskQueued             TaskStatus = "queued"
	TaskSubmitting         TaskStatus = "submitting"
	TaskProcessing         TaskStatus = "processing"
	TaskPersisting         TaskStatus = "persisting"
	TaskCancelling         TaskStatus = "cancelling"
	TaskSucceeded          TaskStatus = "succeeded"
	TaskPartiallySucceeded TaskStatus = "partially_succeeded"
	TaskFailed             TaskStatus = "failed"
	TaskCancelled          TaskStatus = "cancelled"
	TaskTimedOut           TaskStatus = "timed_out"
)

// JobStatus is the AI Provider Job state machine. Non-terminal: pending,
// submitting, processing, cancelling. Terminal: completed, failed,
// cancelled, timed_out, indeterminate.
type JobStatus string

const (
	JobPending       JobStatus = "pending"
	JobSubmitting    JobStatus = "submitting"
	JobProcessing    JobStatus = "processing"
	JobCancelling    JobStatus = "cancelling"
	JobCompleted     JobStatus = "completed"
	JobFailed        JobStatus = "failed"
	JobCancelled     JobStatus = "cancelled"
	JobTimedOut      JobStatus = "timed_out"
	JobIndeterminate JobStatus = "indeterminate"
)

// SlotStatus is a result slot's terminal verdict. While unset the slot is a
// derived projection of the task/job/queue states, never a stored state.
type SlotStatus string

const (
	SlotSucceeded     SlotStatus = "succeeded"
	SlotFailed        SlotStatus = "failed"
	SlotCancelled     SlotStatus = "cancelled"
	SlotTimedOut      SlotStatus = "timed_out"
	SlotIndeterminate SlotStatus = "indeterminate"
)

// FailureReason is the closed, externally stable result-reason taxonomy
// (spec #150). Every failure a creator can observe maps onto exactly one of
// these eight values plus a short action suggestion.
type FailureReason string

const (
	ReasonInvalidInput               FailureReason = "invalid_input"
	ReasonRightsConfirmationRequired FailureReason = "rights_confirmation_required"
	ReasonInputPolicyRejected        FailureReason = "input_policy_rejected"
	ReasonOutputPolicyRejected       FailureReason = "output_policy_rejected"
	ReasonActionRequired             FailureReason = "action_required"
	ReasonTemporarilyUnavailable     FailureReason = "temporarily_unavailable"
	ReasonProcessingIndeterminate    FailureReason = "processing_indeterminate"
	ReasonInternalError              FailureReason = "internal_error"
)

// taskTerminalStatus is the closed terminal set for aggregation checks.
func taskTerminalStatus(s TaskStatus) bool {
	switch s {
	case TaskSucceeded, TaskPartiallySucceeded, TaskFailed, TaskCancelled, TaskTimedOut:
		return true
	default:
		return false
	}
}

// TaskIsTerminal reports whether a task status is terminal.
func TaskIsTerminal(s TaskStatus) bool { return taskTerminalStatus(s) }

// TaskIsNonTerminal reports whether a task still owes work; the connection
// delete guard and pause semantics hang off this set.
func TaskIsNonTerminal(s TaskStatus) bool { return !taskTerminalStatus(s) }

// JobIsTerminal reports whether a provider job status is terminal.
func JobIsTerminal(s JobStatus) bool {
	switch s {
	case JobCompleted, JobFailed, JobCancelled, JobTimedOut, JobIndeterminate:
		return true
	default:
		return false
	}
}

// taskTransitions is the migration contract from #150 (提交合同): keyed by
// source, listing the reachable statuses. A "zero-success terminal" edge is
// expanded to failed/cancelled/timed_out — succeeded shapes are impossible
// before persisting has run.
var taskTransitions = map[TaskStatus][]TaskStatus{
	TaskQueued:     {TaskSubmitting, TaskCancelling, TaskCancelled},
	TaskSubmitting: {TaskProcessing, TaskPersisting, TaskCancelling, TaskFailed, TaskCancelled, TaskTimedOut},
	TaskProcessing: {TaskPersisting, TaskCancelling, TaskFailed, TaskCancelled, TaskTimedOut},
	TaskPersisting: {TaskCancelling, TaskSucceeded, TaskPartiallySucceeded, TaskFailed, TaskCancelled, TaskTimedOut},
	TaskCancelling: {TaskSucceeded, TaskPartiallySucceeded, TaskFailed, TaskCancelled, TaskTimedOut},
}

// TaskCanTransition reports whether one task status may move to another.
// Terminal states transition nowhere; unknown statuses never transition.
func TaskCanTransition(from, to TaskStatus) bool {
	if from == to || taskTerminalStatus(from) {
		return false
	}
	for _, next := range taskTransitions[from] {
		if next == to {
			return true
		}
	}
	return false
}

// jobTransitions is the AI Provider Job migration contract from #150.
var jobTransitions = map[JobStatus][]JobStatus{
	JobPending:    {JobSubmitting, JobCancelled},
	JobSubmitting: {JobProcessing, JobCompleted, JobCancelling, JobFailed, JobCancelled, JobTimedOut, JobIndeterminate},
	JobProcessing: {JobCompleted, JobCancelling, JobCancelled, JobFailed, JobTimedOut},
	JobCancelling: {JobCompleted, JobCancelled, JobFailed, JobTimedOut, JobIndeterminate},
}

// JobCanTransition reports whether one provider job status may move to
// another. cancelling may race to completed (the provider answered after the
// cancel intent); indeterminate is terminal and never auto-retried.
func JobCanTransition(from, to JobStatus) bool {
	if from == to || JobIsTerminal(from) {
		return false
	}
	for _, next := range jobTransitions[from] {
		if next == to {
			return true
		}
	}
	return false
}

// SlotIsTerminal reports whether a slot status is one of the five terminal
// verdicts. Slot writes are write-once: a stored verdict is never rewritten.
func SlotIsTerminal(s SlotStatus) bool {
	switch s {
	case SlotSucceeded, SlotFailed, SlotCancelled, SlotTimedOut, SlotIndeterminate:
		return true
	default:
		return false
	}
}

// TerminalCause is the internal zero-success aggregation cause. The only V1
// value marks a task whose slots ended indeterminate; the wire maps it to
// the processing_indeterminate result reason.
type TerminalCause string

// TerminalCauseProviderIndeterminate marks zero-success tasks whose slots
// ended indeterminate — the creator must confirm repeat-generation risk
// before redoing; the system never retries them automatically.
const TerminalCauseProviderIndeterminate TerminalCause = "provider_outcome_indeterminate"

// GenerationSpecification is the task-owned immutable generation intent
// frozen at admission: prompt, ordered references with roles, media mode,
// model, the governing manifest version, and the chosen parameters. It is a
// value, never a second aggregate; the JSON shape is stable because the
// canonical hash below feeds idempotency.
type GenerationSpecification struct {
	SchemaVersion   int                      `json:"schema_version"`
	MediaType       MediaType                `json:"media_type"`
	Prompt          string                   `json:"prompt"`
	Model           string                   `json:"model"`
	Mode            string                   `json:"mode"`
	ManifestVersion int                      `json:"manifest_version"`
	Ratio           *string                  `json:"ratio,omitempty"`
	Resolution      *string                  `json:"resolution,omitempty"`
	Quantity        int                      `json:"quantity"`
	DurationSeconds *int                     `json:"duration_seconds,omitempty"`
	References      []SpecificationReference `json:"references"`
}

// SpecificationSpecificationSchemaVersion is the stored spec shape version.
const SpecificationSchemaVersion = 1

// SpecificationReference freezes one reference material's identity, role,
// verified kind, and the claims version the material carried at admission.
type SpecificationReference struct {
	MaterialID    UUID      `json:"material_id"`
	Role          DraftRole `json:"role"`
	Kind          Kind      `json:"kind"`
	ClaimsVersion int       `json:"claims_version"`
}

// CanonicalPayload renders the specification as a deterministic string for
// the idempotency hash: struct field order is fixed by the struct definition,
// reference order is the generation order, and there are no timestamps. Two
// submissions with the same intent must hash equally; any value difference
// must hash differently.
func (s *GenerationSpecification) CanonicalPayload() string {
	encoded, err := json.Marshal(s)
	if err != nil {
		// The shape is plain JSON-safe values; marshalling cannot fail.
		return ""
	}
	return string(encoded)
}

// PayloadHash is the sha256 hex digest of the canonical payload.
func (s *GenerationSpecification) PayloadHash() string {
	sum := sha256.Sum256([]byte(s.CanonicalPayload()))
	return hex.EncodeToString(sum[:])
}

// GenerationTask is the creator-private generation aggregate root. The
// specification is frozen at admission and never mutated; the only progress
// is the one-way status machine, the cancel intent, and the per-slot
// verdicts.
type GenerationTask struct {
	ID             UUID
	SessionID      UUID
	OwnerID        UUID
	IdempotencyKey string
	PayloadHash    string
	// Media mirrors the row's media_type so summary projections (which do
	// not decode the frozen specification) still carry it; Spec.MediaType is
	// the authoritative freeze.
	Media           MediaType
	Spec            GenerationSpecification
	Status          TaskStatus
	SlotCount       int
	TerminalCause   *TerminalCause
	CancelRequested bool
	DraftRevision   time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
	TerminalAt      *time.Time
}

// GenerationSlot is one stable, ordered, non-reusable result position. The
// terminal verdict and (when succeeded) the verified output facts are
// write-once; nil status means the slot is still a derived projection.
type GenerationSlot struct {
	TaskID UUID
	Index  int
	Status *SlotStatus
	Reason *FailureReason
	// Result facts exist only for succeeded slots; they describe the
	// transferred, verified output stored under the module's storage seam.
	ResultMime       *string
	ResultByteSize   *int64
	ResultChecksum   []byte
	ResultBlobKey    *string
	ResultWidthPx    *int
	ResultHeightPx   *int
	ResultDurationMS *int
}

// JobOutcomeTransientRejected marks a submit whose outcome was definitively
// identified as a transient rejection (explicit 429/503 answer: nothing
// executed externally), so a bounded re-submit is provably safe. A nil/empty
// outcome state on a submitting job without an external reference means the
// outcome was never identified — that path converges indeterminate, never a
// guessed re-submit.
const JobOutcomeTransientRejected = "transient_rejected"

// ProviderJob is one external execution attempt owned by a task.
type ProviderJob struct {
	ID          UUID
	TaskID      UUID
	Status      JobStatus
	Media       MediaType
	ExternalRef *string
	Outcome     *string
	CreatedAt   time.Time
	UpdatedAt   time.Time
	TerminalAt  *time.Time
}

// SlotOutcomes carries one slot's terminal verdict for aggregation.
type SlotOutcome struct {
	Index  int
	Status SlotStatus
}

// AggregateTaskStatus computes the task terminal verdict from the slot
// verdicts (spec #150 Task 终态聚合): all succeeded → succeeded; any success
// with a non-success → partially_succeeded; zero success all cancelled →
// cancelled; zero success all provider-authoritative timed_out → timed_out;
// any other zero-success shape → failed, marking the indeterminate cause
// when any slot ended indeterminate. The verdicts slice must be complete
// (one outcome per slot, indices 0..n-1).
func AggregateTaskStatus(slotCount int, outcomes []SlotOutcome) (TaskStatus, *TerminalCause, bool) {
	if len(outcomes) != slotCount {
		return "", nil, false
	}
	seen := make(map[int]bool, len(outcomes))
	succeeded, cancelled, timedOut, indeterminate := 0, 0, 0, 0
	for _, outcome := range outcomes {
		if outcome.Index < 0 || outcome.Index >= slotCount || seen[outcome.Index] {
			return "", nil, false
		}
		seen[outcome.Index] = true
		switch outcome.Status {
		case SlotSucceeded:
			succeeded++
		case SlotCancelled:
			cancelled++
		case SlotTimedOut:
			timedOut++
		case SlotIndeterminate:
			indeterminate++
		case SlotFailed:
		default:
			return "", nil, false
		}
	}
	switch {
	case succeeded == slotCount:
		return TaskSucceeded, nil, true
	case succeeded > 0:
		return TaskPartiallySucceeded, nil, true
	case cancelled == slotCount:
		return TaskCancelled, nil, true
	case timedOut == slotCount:
		return TaskTimedOut, nil, true
	default:
		status := TaskFailed
		var cause *TerminalCause
		if indeterminate > 0 {
			marked := TerminalCauseProviderIndeterminate
			cause = &marked
		}
		return status, cause, true
	}
}

// SlotVerdictForJob projects a job-level terminal outcome onto the slots
// that did not produce output. Provider-authoritative timeouts end slots
// timed_out (never a locally fabricated timeout); a lost submit outcome ends
// them indeterminate; cancel convergence ends them cancelled; an explicit
// job failure carries its classified reason, defaulting to
// temporarily_unavailable when no detail survived.
func SlotVerdictForJob(job JobStatus, reason *FailureReason) (SlotStatus, *FailureReason) {
	switch job {
	case JobTimedOut:
		return SlotTimedOut, reason
	case JobIndeterminate:
		indeterminate := ReasonProcessingIndeterminate
		return SlotIndeterminate, &indeterminate
	case JobCancelled:
		return SlotCancelled, nil
	case JobFailed:
		if reason != nil {
			return SlotFailed, reason
		}
		unavailable := ReasonTemporarilyUnavailable
		return SlotFailed, &unavailable
	default:
		return SlotFailed, nil
	}
}

// GovernanceLimit is one optional ceiling; nil means "not set" (unlimited)
// and zero explicitly forbids the covered scope.
type GovernanceLimit = *int

// GovernanceScope addresses a policy row.
type GovernanceScope string

const (
	GovernanceScopeInstance GovernanceScope = "instance"
	GovernanceScopeUser     GovernanceScope = "user"
)

// GovernancePolicy is one stored governance row: instance-wide defaults or a
// per-user override. Every field is independently optional; user rows
// override field-by-field over the instance row.
type GovernancePolicy struct {
	Scope            GovernanceScope
	UserID           *UUID
	ImageConcurrency GovernanceLimit
	VideoConcurrency GovernanceLimit
	RateLimit        GovernanceLimit // structurally-valid attempts per rolling 60s, cross-media
	MonthlyTaskLimit GovernanceLimit // admitted tasks per Asia/Shanghai natural month, cross-media
}

// GovernanceReason is the closed machine-reason vocabulary returned by
// admission rejections (spec #150 治理 machine reasons). The evaluation
// order below is fixed so concurrent conditions cannot drift the answer.
type GovernanceReason string

const (
	ReasonProviderCreditBlocked  GovernanceReason = "provider_credit_blocked"
	ReasonInstanceMonthlyReached GovernanceReason = "instance_monthly_generation_limit_reached"
	ReasonMemberMonthlyReached   GovernanceReason = "member_monthly_generation_limit_reached"
	ReasonInstanceRateLimited    GovernanceReason = "instance_generation_rate_limited"
	ReasonMemberRateLimited      GovernanceReason = "member_generation_rate_limited"
	ReasonMemberConcurrency      GovernanceReason = "member_generation_concurrency_limited"
	ReasonProviderRateLimited    GovernanceReason = "provider_rate_limited"
	ReasonProviderUnavailable    GovernanceReason = "provider_temporarily_unavailable"
)

// GovernanceWindow bounds one rolling rate window.
const GovernanceRateWindow = 60 * time.Second

// GovernanceSnapshot is everything admission's fixed-order evaluation reads:
// the resolved limits plus the live counts. Counts are captured inside the
// admission transaction so the verdict cannot race the writes.
type GovernanceSnapshot struct {
	CreditBlocked           bool
	InstanceMonthlyCount    int
	MemberMonthlyCount      int
	InstanceRateCount       int
	MemberRateCount         int
	MemberImageReservations int
	MemberVideoReservations int
	InstancePolicy          *GovernancePolicy
	MemberPolicy            *GovernancePolicy
}

// governanceLimit resolves one field: the user override wins, else the
// instance default, else unset (unlimited).
func governanceLimit(user, instance *int) *int {
	if user != nil {
		return user
	}
	return instance
}

// EvaluateGovernance applies the fixed rejection order and returns the first
// blocking reason, or nil when the submission is admitted. Order: provider
// credit, instance monthly, member monthly, instance rate, member rate,
// member media concurrency. Monthly limits compare admitted tasks (the
// current task would be count+1); rate limits compare structurally-valid
// attempts including the current one.
func EvaluateGovernance(snapshot *GovernanceSnapshot, media MediaType) *GovernanceReason {
	if snapshot.CreditBlocked {
		blocked := ReasonProviderCreditBlocked
		return &blocked
	}
	instance := snapshot.InstancePolicy
	member := snapshot.MemberPolicy
	resolve := func(user, instance *int) *int { return governanceLimit(user, instance) }

	var instanceRateLimit, memberRateLimit, instanceMonthly, memberMonthly *int
	var imageConcurrency, videoConcurrency *int
	if instance != nil {
		instanceRateLimit = resolve(instance.RateLimit, nil)
		instanceMonthly = resolve(instance.MonthlyTaskLimit, nil)
		imageConcurrency = resolve(instance.ImageConcurrency, nil)
		videoConcurrency = resolve(instance.VideoConcurrency, nil)
	}
	if member != nil {
		memberRateLimit = resolve(member.RateLimit, instanceRateLimit)
		memberMonthly = resolve(member.MonthlyTaskLimit, instanceMonthly)
		imageConcurrency = resolve(member.ImageConcurrency, imageConcurrency)
		videoConcurrency = resolve(member.VideoConcurrency, videoConcurrency)
	}

	limitReached := func(limit *int, count int, extra int) bool {
		return limit != nil && count+extra > *limit
	}
	if limitReached(instanceMonthly, snapshot.InstanceMonthlyCount, 1) {
		blocked := ReasonInstanceMonthlyReached
		return &blocked
	}
	if limitReached(memberMonthly, snapshot.MemberMonthlyCount, 1) {
		blocked := ReasonMemberMonthlyReached
		return &blocked
	}
	if limitReached(instanceRateLimit, snapshot.InstanceRateCount, 1) {
		blocked := ReasonInstanceRateLimited
		return &blocked
	}
	if limitReached(memberRateLimit, snapshot.MemberRateCount, 1) {
		blocked := ReasonMemberRateLimited
		return &blocked
	}
	reservations := snapshot.MemberImageReservations
	if media == MediaVideo {
		reservations = snapshot.MemberVideoReservations
	}
	mediaConcurrency := imageConcurrency
	if media == MediaVideo {
		mediaConcurrency = videoConcurrency
	}
	if limitReached(mediaConcurrency, reservations, 1) {
		blocked := ReasonMemberConcurrency
		return &blocked
	}
	return nil
}

// MonthWindowUTC returns the UTC instants of the Asia/Shanghai natural month
// containing now. The window computation is the single place the governance
// month boundary exists so the SQL predicates can never drift from it.
func MonthWindowUTC(now time.Time) (start, end time.Time) {
	location := shanghaiLocation()
	local := now.In(location)
	year, month, day := local.Date()
	start = time.Date(year, month, day, 0, 0, 0, 0, location)
	return start.UTC(), start.AddDate(0, 1, 0).UTC()
}

// NormalizeIdempotencyKey trims surrounding whitespace; an empty key is the
// caller's contract error.
func NormalizeIdempotencyKey(raw string) string {
	return strings.TrimSpace(raw)
}

// StableSlotOrder returns indices 0..n-1; admission materializes every slot
// up front so results never reorder or renumber.
func StableSlotOrder(n int) []int {
	indices := make([]int, n)
	for i := range indices {
		indices[i] = i
	}
	sort.Ints(indices)
	return indices
}

// shanghaiLocation resolves the fixed governance timezone. time/tzdata is
// embedded (see imports), so this cannot fail on zoneinfo-less hosts.
func shanghaiLocation() *time.Location {
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		panic("creation: embedded tzdata missing Asia/Shanghai: " + err.Error())
	}
	return location
}

// SlotProjection is the wire projection of a slot while it has no stored
// terminal verdict: a derived view of the task's own state (reserved/
// queued/generating/persisting collapse into these stable names). Stored
// terminal verdicts always win.
func SlotProjection(taskStatus TaskStatus, slotStatus *SlotStatus) string {
	if slotStatus != nil {
		return string(*slotStatus)
	}
	switch taskStatus {
	case TaskQueued:
		return "queued"
	case TaskSubmitting, TaskProcessing:
		return "generating"
	case TaskPersisting:
		return "persisting"
	case TaskCancelling:
		return "cancelling"
	default:
		return string(taskStatus)
	}
}

// SlotResult carries the verified output facts written beside a succeeded
// slot verdict. The blob lives under the module's storage seam; these facts
// are what download and later asset formation read.
type SlotResult struct {
	Mime       string
	ByteSize   int64
	Checksum   []byte
	BlobKey    string
	WidthPx    *int
	HeightPx   *int
	DurationMS *int
}

// AdmittedTask bundles everything one atomic admission write persists:
// the frozen task, its N slots, the first pending provider job, the queue
// item, and the per-media concurrency reservation.
type AdmittedTask struct {
	Task             *GenerationTask
	Slots            []GenerationSlot
	Job              *ProviderJob
	RunAfter         time.Time
	ReservationOwner UUID
	ReservationMedia MediaType
}

// ClaimedQueueItem is one SKIP LOCKED claim result.
type ClaimedQueueItem struct {
	QueueID  UUID
	TaskID   UUID
	Attempts int
	Max      int
}
