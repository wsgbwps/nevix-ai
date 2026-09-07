package domain

import (
	"fmt"
	"time"
)

// Pure decision surface (ADR-0019): NextAction routes, VerdictFor projects
// one outcome onto a write-set; the six-field KernelState is their whole
// view, so both are table-testable.

// KernelState is the worker-facing snapshot of one task plus its active
// provider job; slots stay out — settle-then-aggregate is idempotent and
// self-guarding (ADR-0019).
type KernelState struct {
	TaskStatus      TaskStatus
	CancelRequested bool
	JobStatus       JobStatus
	HasExternalRef  bool
	JobOutcome      *string
	SubmitAttempts  int
}

// transientRejected reports the definitively identified transient submit
// rejection (explicit 429/503 — nothing executed externally), which makes a
// bounded re-submit provably safe.
func (s KernelState) transientRejected() bool {
	return s.JobOutcome != nil && *s.JobOutcome == JobOutcomeTransientRejected
}

// transientSubmitAttemptLimit matches the four-step 429/503 pressure
// ladders. The queue-wide allowance remains larger for accepted async jobs
// that need many safe polls; an unaccepted submit must surface its terminal
// verdict after this much provider pressure instead of waiting for that
// unrelated polling budget. Waiting between attempts stays application's;
// spending this budget is the state machine's.
const transientSubmitAttemptLimit = 4

// KernelAction names the next step for one claimed item: an external call,
// a convergence, or a guard park.
type KernelAction string

const (
	ActionSubmit            KernelAction = "submit"             // marker routine, then the external submit
	ActionPoll              KernelAction = "poll"               // accepted job: authoritative provider poll
	ActionCancelJob         KernelAction = "cancel_job"         // best-effort provider cancel, then poll
	ActionRecordCancel      KernelAction = "record_cancel"      // cancel intent onto the accepted job
	ActionConvergeCancelled KernelAction = "converge_cancelled" // nothing external started: cancel converges locally
	ActionConvergeLost      KernelAction = "converge_lost"      // unidentifiable outcome: fail-safe indeterminate
	ActionConvergeSettled   KernelAction = "converge_settled"   // job terminal, task unfinished: finish aggregation
	ActionPark              KernelAction = "park"               // nothing owed: retire the queue row
)

// NextAction routes one claimed item. A terminal task never owes external
// work:
// terminal+terminal parks the converged pair, and a terminal task whose job
// is somehow still moving is a should-never-commit shape (every
// task-terminal write lands the job terminal in the same transaction), so it
// parks fail-safe rather than resurrecting external calls.
func NextAction(state KernelState) (KernelAction, error) {
	if !kernelTaskStatusKnown(state.TaskStatus) {
		return "", fmt.Errorf("creation: unknown kernel task status %q", state.TaskStatus)
	}
	if !kernelJobStatusKnown(state.JobStatus) {
		return "", fmt.Errorf("creation: unknown kernel job status %q", state.JobStatus)
	}
	if TaskIsTerminal(state.TaskStatus) {
		return ActionPark, nil
	}
	if state.CancelRequested {
		switch {
		case state.JobStatus == JobPending:
			return ActionConvergeCancelled, nil
		case state.JobStatus == JobSubmitting && !state.HasExternalRef && state.transientRejected():
			// The provider definitively rejected the submit, so no external
			// work exists and the creator's cancel can converge locally.
			return ActionConvergeCancelled, nil
		case state.JobStatus == JobSubmitting && !state.HasExternalRef:
			// Crash between the submit marker and its outcome: the outcome
			// can never be identified now.
			return ActionConvergeLost, nil
		case state.JobStatus == JobSubmitting || state.JobStatus == JobProcessing:
			return ActionRecordCancel, nil
		case state.JobStatus == JobCancelling && state.HasExternalRef:
			return ActionCancelJob, nil
		case state.JobStatus == JobCancelling:
			// Ref-less cancelling has no durable proof that the provider
			// rejected the submit; fail safe instead of inventing cancel.
			return ActionConvergeLost, nil
		default:
			return ActionConvergeSettled, nil
		}
	}
	switch {
	case state.JobStatus == JobPending:
		return ActionSubmit, nil
	case state.JobStatus == JobSubmitting && state.HasExternalRef:
		return ActionPoll, nil
	case state.JobStatus == JobSubmitting && state.transientRejected():
		return ActionSubmit, nil
	case state.JobStatus == JobSubmitting:
		return ActionConvergeLost, nil
	case state.JobStatus == JobProcessing && state.HasExternalRef:
		return ActionPoll, nil
	case state.JobStatus == JobProcessing:
		// An accepted shape without an external identity can never resolve.
		return ActionPark, nil
	case state.JobStatus == JobCancelling && state.HasExternalRef:
		return ActionCancelJob, nil
	case state.JobStatus == JobCancelling:
		// cancelling is only ever written alongside a cancel intent, so this
		// shape should never commit; park instead of guessing.
		return ActionPark, nil
	default:
		return ActionConvergeSettled, nil
	}
}

func kernelTaskStatusKnown(s TaskStatus) bool {
	for _, known := range allTaskStatuses {
		if s == known {
			return true
		}
	}
	return false
}

func kernelJobStatusKnown(s JobStatus) bool {
	for _, known := range allJobStatuses {
		if s == known {
			return true
		}
	}
	return false
}

// KernelEventKind names one external outcome (or crash recovery) the worker
// observed for the claimed item.
type KernelEventKind string

const (
	EventSubmitAccepted  KernelEventKind = "submit_accepted"  // async acceptance; ExternalRef required
	EventSubmitTransient KernelEventKind = "submit_transient" // identified 429/503 rejection
	EventCreditBlocked   KernelEventKind = "credit_blocked"   // explicit provider 402
	EventSubmitRejected  KernelEventKind = "submit_rejected"  // definitive classified rejection
	EventSubmitTimedOut  KernelEventKind = "submit_timed_out" // provider-authoritative submit timeout
	EventPollProcessing  KernelEventKind = "poll_processing"  // first poll promoted the job
	EventPollCompleted   KernelEventKind = "poll_completed"   // outputs ready; transfer before applying
	EventPollFailed      KernelEventKind = "poll_failed"      // provider-authoritative failure
	EventPollCancelled   KernelEventKind = "poll_cancelled"   // provider-authoritative cancel
	EventPollTimedOut    KernelEventKind = "poll_timed_out"   // provider-authoritative expiry
	EventCancelAccepted  KernelEventKind = "cancel_accepted"  // record the intent on the accepted job
	EventCancelUnstarted KernelEventKind = "cancel_unstarted" // nothing external started
	EventOutcomeLost     KernelEventKind = "outcome_lost"     // crash-window fail-safe convergence
	EventConvergeSettled KernelEventKind = "converge_settled" // finish from the already-terminal job
)

// KernelEvent carries one outcome's classified data: the failure taxonomy
// reason, the creator-private diagnostic, and the async external identity.
type KernelEvent struct {
	Kind        KernelEventKind
	ExternalRef *string
	Reason      *FailureReason
	Diagnostic  *FailureDiagnostic
}

// KernelVerdictKind selects the write-set shape the application routine
// applies (ADR-0019: application only applies, never adjudicates edges).
type KernelVerdictKind string

const (
	VerdictSubmitMarker KernelVerdictKind = "submit_marker" // license exactly one external submit
	VerdictRefBound     KernelVerdictKind = "ref_bound"     // async acceptance: bind the identity, park for poll
	VerdictPromoted     KernelVerdictKind = "promoted"      // first poll promoted the job
	VerdictCancelMarked KernelVerdictKind = "cancel_marked" // intent recorded on the accepted job
	VerdictTransferred  KernelVerdictKind = "transferred"   // outputs landed: completed + slot results
	VerdictRetryHold    KernelVerdictKind = "retry_hold"    // transient rejection under budget: hold, don't converge
	VerdictTerminal     KernelVerdictKind = "terminal"      // full convergence write-set
)

// SlotVerdictWrite is one transferred output's write-once slot verdict
// inside a VerdictTransferred.
type SlotVerdictWrite struct {
	Index      int
	Status     SlotStatus
	Reason     *FailureReason
	Diagnostic *FailureDiagnostic
	Result     *SlotResult
}

// KernelVerdict is one write-set's data. It never carries CAS from-sets: the
// application routine re-reads fresh state inside its transaction to build
// them. RunAfter is worker-filled pacing, not an edge.
type KernelVerdict struct {
	Kind        KernelVerdictKind
	JobTo       JobStatus
	TaskTo      TaskStatus
	TaskGuard   TaskStatus // terminal only: abort the whole convergence unless the fresh task still sits here
	ExternalRef *string
	Reason      *FailureReason
	Diagnostic  *FailureDiagnostic
	// CreditBlocked is the verdict-carried connection-level 402 effect.
	CreditBlocked bool
	Slots         []SlotVerdictWrite
	RunAfter      time.Time
}

// VerdictFor turns one external outcome into the write-set data for the
// state the worker read. The transient-rejection event is where the durable
// submit budget is spent: exhausted attempts produce the JobFailed terminal
// verdict here rather than a silent hold.
func VerdictFor(state KernelState, event KernelEvent) (KernelVerdict, error) {
	switch event.Kind {
	case EventSubmitAccepted:
		if event.ExternalRef == nil || *event.ExternalRef == "" {
			return KernelVerdict{}, fmt.Errorf("creation: async submit acceptance requires an external reference")
		}
		return KernelVerdict{Kind: VerdictRefBound, JobTo: JobSubmitting, ExternalRef: event.ExternalRef}, nil
	case EventSubmitTransient:
		if state.SubmitAttempts >= transientSubmitAttemptLimit {
			return KernelVerdict{Kind: VerdictTerminal, JobTo: JobFailed, Reason: event.Reason, Diagnostic: event.Diagnostic}, nil
		}
		return KernelVerdict{Kind: VerdictRetryHold}, nil
	case EventOutcomeLost:
		return KernelVerdict{Kind: VerdictTerminal, JobTo: JobIndeterminate, Diagnostic: event.Diagnostic}, nil
	case EventCreditBlocked:
		reason := ReasonActionRequired
		return KernelVerdict{Kind: VerdictTerminal, JobTo: JobFailed, Reason: &reason, Diagnostic: event.Diagnostic, CreditBlocked: true}, nil
	case EventSubmitRejected:
		return KernelVerdict{Kind: VerdictTerminal, JobTo: JobFailed, Reason: event.Reason, Diagnostic: event.Diagnostic}, nil
	case EventSubmitTimedOut:
		return KernelVerdict{Kind: VerdictTerminal, JobTo: JobTimedOut, Reason: event.Reason, Diagnostic: event.Diagnostic}, nil
	case EventPollProcessing:
		return KernelVerdict{Kind: VerdictPromoted, JobTo: JobProcessing, TaskTo: TaskProcessing}, nil
	case EventPollCompleted:
		return KernelVerdict{Kind: VerdictTransferred, JobTo: JobCompleted, TaskTo: TaskPersisting}, nil
	case EventPollFailed:
		return KernelVerdict{Kind: VerdictTerminal, JobTo: JobFailed, Reason: event.Reason, Diagnostic: event.Diagnostic}, nil
	case EventPollCancelled:
		return KernelVerdict{Kind: VerdictTerminal, JobTo: JobCancelled, Reason: event.Reason, Diagnostic: event.Diagnostic}, nil
	case EventPollTimedOut:
		return KernelVerdict{Kind: VerdictTerminal, JobTo: JobTimedOut, Reason: event.Reason, Diagnostic: event.Diagnostic}, nil
	case EventCancelAccepted:
		return KernelVerdict{Kind: VerdictCancelMarked, JobTo: JobCancelling, TaskTo: TaskCancelling}, nil
	case EventCancelUnstarted:
		return KernelVerdict{Kind: VerdictTerminal, JobTo: JobCancelled, Reason: event.Reason, Diagnostic: event.Diagnostic}, nil
	case EventConvergeSettled:
		return KernelVerdict{Kind: VerdictTerminal, JobTo: state.JobStatus}, nil
	}
	return KernelVerdict{}, fmt.Errorf("creation: unknown kernel event %q", event.Kind)
}
