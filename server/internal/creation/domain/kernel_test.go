package domain

import (
	"testing"
)

// Kernel decision-surface tests in ADR-0019's three mandated layers.

func kernelState(task TaskStatus, cancel bool, job JobStatus, ref bool, outcome *string, attempts int) KernelState {
	return KernelState{
		TaskStatus:      task,
		CancelRequested: cancel,
		JobStatus:       job,
		HasExternalRef:  ref,
		JobOutcome:      outcome,
		SubmitAttempts:  attempts,
	}
}

// jobShape collapses the job factors (status × ref × outcome) into the
// distinct routing classes the expectation table is keyed by.
type jobShape struct {
	status  JobStatus
	ref     bool
	outcome *string // nil, transient, or other
}

var (
	outcomeTransient  = JobOutcomeTransientRejected
	outcomeOther      = "never_a_known_marker"
	outcomeCandidates = []*string{nil, &outcomeTransient, &outcomeOther}
)

func shapeOf(status JobStatus, ref bool, outcome *string) jobShape {
	return jobShape{status: status, ref: ref, outcome: outcome}
}

type routingKey struct {
	cancel bool
	shape  jobShape
}

// The nine reachable routing classes, one row each in the expectation table.
var (
	shapePending        = shapeOf(JobPending, false, nil)
	shapeSubmittingRef  = shapeOf(JobSubmitting, true, nil)
	shapeSubmittingHeld = shapeOf(JobSubmitting, false, &outcomeTransient)
	shapeSubmittingBare = shapeOf(JobSubmitting, false, nil)
	shapeProcessingRef  = shapeOf(JobProcessing, true, nil)
	shapeProcessingBare = shapeOf(JobProcessing, false, nil)
	shapeCancellingRef  = shapeOf(JobCancelling, true, nil)
	shapeCancellingBare = shapeOf(JobCancelling, false, nil)
	shapeSettledJob     = shapeOf(JobCompleted, true, nil)
)

// classify normalizes one enumerated combination onto its routing class.
// Precedence mirrors the routing contract's factor order: an accepted ref or
// an identified transient marker dominates the submitting class, and any
// terminal job converges the same way.
func classify(job JobStatus, ref bool, outcome *string) jobShape {
	transient := outcome != nil && *outcome == JobOutcomeTransientRejected
	switch {
	case JobIsTerminal(job):
		return shapeSettledJob
	case job == JobPending:
		return shapePending
	case job == JobSubmitting && ref:
		return shapeSubmittingRef
	case job == JobSubmitting && transient:
		return shapeSubmittingHeld
	case job == JobSubmitting:
		return shapeSubmittingBare
	case job == JobProcessing && ref:
		return shapeProcessingRef
	case job == JobProcessing:
		return shapeProcessingBare
	case job == JobCancelling && ref:
		return shapeCancellingRef
	default:
		return shapeCancellingBare
	}
}

// routingExpectations is the literal expectation table: one row per
// (cancel intent × routing class), reviewed directly against ADR-0019's
// routing contract.
var routingExpectations = map[routingKey]KernelAction{
	{true, shapePending}:        ActionConvergeCancelled,
	{true, shapeSubmittingRef}:  ActionRecordCancel,
	{true, shapeSubmittingHeld}: ActionConvergeCancelled,
	{true, shapeSubmittingBare}: ActionConvergeLost,
	{true, shapeProcessingRef}:  ActionRecordCancel,
	{true, shapeProcessingBare}: ActionRecordCancel,
	{true, shapeCancellingRef}:  ActionCancelJob,
	{true, shapeCancellingBare}: ActionConvergeLost,
	{true, shapeSettledJob}:     ActionConvergeSettled,

	{false, shapePending}:        ActionSubmit,
	{false, shapeSubmittingRef}:  ActionPoll,
	{false, shapeSubmittingHeld}: ActionSubmit,
	{false, shapeSubmittingBare}: ActionConvergeLost,
	{false, shapeProcessingRef}:  ActionPoll,
	{false, shapeProcessingBare}: ActionPark,
	{false, shapeCancellingRef}:  ActionCancelJob,
	{false, shapeCancellingBare}: ActionPark,
	{false, shapeSettledJob}:     ActionConvergeSettled,
}

// Enumerates all 540 reachable (task, cancel, job shape) rows against the
// literal expectation table above.
func TestNextActionEnumeratesEveryReachableState(t *testing.T) {
	nonTerminalTasks := []TaskStatus{TaskQueued, TaskSubmitting, TaskProcessing, TaskPersisting, TaskCancelling}
	for _, task := range nonTerminalTasks {
		for _, cancel := range []bool{false, true} {
			for _, job := range allJobStatuses {
				for _, ref := range []bool{false, true} {
					for _, outcome := range outcomeCandidates {
						attempts := 0
						if outcome != nil && *outcome == JobOutcomeTransientRejected {
							attempts = 1
						}
						state := kernelState(task, cancel, job, ref, outcome, attempts)
						got, err := NextAction(state)
						if err != nil {
							t.Fatalf("NextAction(%+v) errored: %v", state, err)
						}
						want := routingExpectations[routingKey{cancel: cancel, shape: classify(job, ref, outcome)}]
						if !cancel && want == ActionSubmit {
							freshPending := task == TaskQueued && job == JobPending && !ref && outcome == nil && attempts == 0
							safeRetry := task == TaskSubmitting && job == JobSubmitting && !ref &&
								outcome != nil && *outcome == JobOutcomeTransientRejected && attempts < SubmitAttemptLimit
							if !freshPending && !safeRetry {
								want = ActionPark
							}
						}
						if got != want {
							t.Errorf("NextAction(task=%s cancel=%v job=%s ref=%v outcome=%v) = %s, want %s",
								task, cancel, job, ref, outcome, got, want)
						}
					}
				}
			}
		}
	}
}

func TestNextActionGuardRulesParksTerminalTasks(t *testing.T) {
	terminalTasks := []TaskStatus{TaskSucceeded, TaskPartiallySucceeded, TaskFailed, TaskCancelled, TaskTimedOut}
	for _, task := range terminalTasks {
		for _, job := range allJobStatuses {
			for _, ref := range []bool{false, true} {
				for _, cancel := range []bool{false, true} {
					state := kernelState(task, cancel, job, ref, nil, 0)
					got, err := NextAction(state)
					if err != nil {
						t.Fatalf("NextAction(%+v) errored: %v", state, err)
					}
					if got != ActionPark {
						t.Errorf("terminal task %s with job %s must park, got %s", task, job, got)
					}
				}
			}
		}
	}
	// Explicit rows for the two named guard shapes (issue #212 acceptance).
	converged := kernelState(TaskSucceeded, false, JobCompleted, true, nil, 0)
	if action, err := NextAction(converged); err != nil || action != ActionPark {
		t.Fatalf("terminal+terminal must park, got %s %v", action, err)
	}
	resurrecting := kernelState(TaskCancelled, false, JobSubmitting, true, nil, 1)
	if action, err := NextAction(resurrecting); err != nil || action != ActionPark {
		t.Fatalf("terminal task + non-terminal job must park, got %s %v", action, err)
	}
}

func TestNextActionRejectsUnknownStatuses(t *testing.T) {
	if _, err := NextAction(kernelState("bogus", false, JobPending, false, nil, 0)); err == nil {
		t.Fatal("unknown task status must error")
	}
	if _, err := NextAction(kernelState(TaskQueued, false, "bogus", false, nil, 0)); err == nil {
		t.Fatal("unknown job status must error")
	}
	if _, err := NextAction(KernelState{}); err == nil {
		t.Fatal("empty statuses must error")
	}
}

func TestSubmitMarkerRoutingUsesOnlyFreshSafeState(t *testing.T) {
	cases := []struct {
		name  string
		state KernelState
		want  bool
	}{
		{"fresh pending", kernelState(TaskQueued, false, JobPending, false, nil, 0), true},
		{"safe retry below budget", kernelState(TaskSubmitting, false, JobSubmitting, false, &outcomeTransient, SubmitAttemptLimit-1), true},
		{"cancel requested", kernelState(TaskQueued, true, JobPending, false, nil, 0), false},
		{"pending with stale outcome", kernelState(TaskQueued, false, JobPending, false, &outcomeTransient, 0), false},
		{"submitting without safe outcome", kernelState(TaskSubmitting, false, JobSubmitting, false, nil, 1), false},
		{"submitting with external reference", kernelState(TaskSubmitting, false, JobSubmitting, true, &outcomeTransient, 1), false},
		{"safe retry budget exhausted", kernelState(TaskSubmitting, false, JobSubmitting, false, &outcomeTransient, SubmitAttemptLimit), false},
		{"terminal task", kernelState(TaskFailed, false, JobPending, false, nil, 0), false},
		{"wrong task phase", kernelState(TaskProcessing, false, JobPending, false, nil, 0), false},
		{"wrong job phase", kernelState(TaskQueued, false, JobProcessing, false, nil, 0), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			action, err := NextAction(tc.state)
			if err != nil {
				t.Fatal(err)
			}
			if got := action == ActionSubmit; got != tc.want {
				t.Fatalf("NextAction(%+v) = %s, submit=%v, want %v", tc.state, action, got, tc.want)
			}
		})
	}
}

// Pins ADR-0019's four crash-recovery entries verbatim (#212 acceptance).
func TestKernelCrashRecoveryIsPinned(t *testing.T) {
	t.Run("submitting without ref and without outcome converges indeterminate", func(t *testing.T) {
		for _, cancel := range []bool{false, true} {
			state := kernelState(TaskSubmitting, cancel, JobSubmitting, false, nil, 1)
			action, err := NextAction(state)
			if err != nil {
				t.Fatal(err)
			}
			if action != ActionConvergeLost {
				t.Fatalf("crash between marker and outcome must route converge_lost, got %s", action)
			}
			verdict, err := VerdictFor(state, KernelEvent{Kind: EventOutcomeLost})
			if err != nil {
				t.Fatal(err)
			}
			if verdict.Kind != VerdictTerminal || verdict.JobTo != JobIndeterminate {
				t.Fatalf("lost outcome must converge the job indeterminate, got %+v", verdict)
			}
			if status, reason := SlotVerdictForJob(verdict.JobTo, verdict.Reason); status != SlotIndeterminate || reason == nil || *reason != ReasonProcessingIndeterminate {
				t.Fatalf("indeterminate convergence must settle slots indeterminate, got %s %v", status, reason)
			}
		}
	})

	t.Run("proven-safe submit outcome re-submits within the bounded budget", func(t *testing.T) {
		outcome := JobOutcomeTransientRejected
		state := kernelState(TaskSubmitting, false, JobSubmitting, false, &outcome, 1)
		action, err := NextAction(state)
		if err != nil {
			t.Fatal(err)
		}
		if action != ActionSubmit {
			t.Fatalf("proven-safe outcome must license a bounded re-submit, got %s", action)
		}
		verdict, err := VerdictFor(state, KernelEvent{Kind: EventSubmitTransient})
		if err != nil {
			t.Fatal(err)
		}
		if verdict.Kind != VerdictRetryHold {
			t.Fatalf("under budget the proven-safe outcome must hold, got %+v", verdict)
		}
	})

	t.Run("ref-less cancelling fails safe to indeterminate", func(t *testing.T) {
		state := kernelState(TaskCancelling, true, JobCancelling, false, nil, 1)
		action, err := NextAction(state)
		if err != nil {
			t.Fatal(err)
		}
		if action != ActionConvergeLost {
			t.Fatalf("ref-less cancelling must fail safe, got %s", action)
		}
		verdict, err := VerdictFor(state, KernelEvent{Kind: EventOutcomeLost})
		if err != nil {
			t.Fatal(err)
		}
		if verdict.Kind != VerdictTerminal || verdict.JobTo != JobIndeterminate {
			t.Fatalf("ref-less cancelling must converge indeterminate, got %+v", verdict)
		}
	})

	t.Run("spending the submit budget converges JobFailed", func(t *testing.T) {
		reason := ReasonProviderRouteUnavailable
		state := kernelState(TaskSubmitting, false, JobSubmitting, false, &outcomeTransient, SubmitAttemptLimit)
		verdict, err := VerdictFor(state, KernelEvent{Kind: EventSubmitTransient, Reason: &reason})
		if err != nil {
			t.Fatal(err)
		}
		if verdict.Kind != VerdictTerminal || verdict.JobTo != JobFailed || verdict.Reason == nil || *verdict.Reason != reason {
			t.Fatalf("exhausted budget must converge JobFailed with the classified reason, got %+v", verdict)
		}
		// The boundary is exact: one attempt under the limit still holds.
		state.SubmitAttempts = SubmitAttemptLimit - 1
		verdict, err = VerdictFor(state, KernelEvent{Kind: EventSubmitTransient, Reason: &reason})
		if err != nil {
			t.Fatal(err)
		}
		if verdict.Kind != VerdictRetryHold {
			t.Fatalf("the attempt under the limit must still hold, got %+v", verdict)
		}
	})
}

func TestVerdictForProjectsEveryEvent(t *testing.T) {
	reason := ReasonOutputPolicyRejected
	diagnostic := NewFailureDiagnostic(DiagnosticSourceProvider, "code", "message", nil, "", "")
	ref := "ext-1"

	cases := []struct {
		name  string
		state KernelState
		event KernelEvent
		want  KernelVerdict
	}{
		{
			name:  "async acceptance binds the ref on the submitting job",
			event: KernelEvent{Kind: EventSubmitAccepted, ExternalRef: &ref},
			want:  KernelVerdict{Kind: VerdictRefBound, JobTo: JobSubmitting, ExternalRef: &ref},
		},
		{
			name:  "proven-safe outcome under budget holds",
			state: kernelState(TaskSubmitting, false, JobSubmitting, false, nil, 1),
			event: KernelEvent{Kind: EventSubmitTransient},
			want:  KernelVerdict{Kind: VerdictRetryHold},
		},
		{
			name:  "proven-safe outcome at the budget converges JobFailed",
			state: kernelState(TaskSubmitting, false, JobSubmitting, false, &outcomeTransient, SubmitAttemptLimit),
			event: KernelEvent{Kind: EventSubmitTransient, Reason: &reason, Diagnostic: diagnostic},
			want:  KernelVerdict{Kind: VerdictTerminal, JobTo: JobFailed, Reason: &reason, Diagnostic: diagnostic},
		},
		{
			name:  "lost submit converges indeterminate",
			event: KernelEvent{Kind: EventOutcomeLost, Diagnostic: diagnostic},
			want:  KernelVerdict{Kind: VerdictTerminal, JobTo: JobIndeterminate, Diagnostic: diagnostic},
		},
		{
			name:  "credit block fails the job and carries its effect",
			event: KernelEvent{Kind: EventCreditBlocked, Diagnostic: diagnostic},
			want: KernelVerdict{Kind: VerdictTerminal, JobTo: JobFailed, Reason: ptrFailureReason(ReasonActionRequired),
				Diagnostic: diagnostic, CreditBlocked: true},
		},
		{
			name:  "definitive submit rejection converges JobFailed",
			event: KernelEvent{Kind: EventSubmitRejected, Reason: &reason, Diagnostic: diagnostic},
			want:  KernelVerdict{Kind: VerdictTerminal, JobTo: JobFailed, Reason: &reason, Diagnostic: diagnostic},
		},
		{
			name:  "provider-authoritative submit timeout converges JobTimedOut",
			event: KernelEvent{Kind: EventSubmitTimedOut, Reason: &reason, Diagnostic: diagnostic},
			want:  KernelVerdict{Kind: VerdictTerminal, JobTo: JobTimedOut, Reason: &reason, Diagnostic: diagnostic},
		},
		{
			name:  "first poll promotes both machines",
			event: KernelEvent{Kind: EventPollProcessing},
			want:  KernelVerdict{Kind: VerdictPromoted, JobTo: JobProcessing, TaskTo: TaskProcessing},
		},
		{
			name:  "completed outputs transfer then aggregate",
			event: KernelEvent{Kind: EventPollCompleted},
			want:  KernelVerdict{Kind: VerdictTransferred, JobTo: JobCompleted, TaskTo: TaskPersisting},
		},
		{
			name:  "poll failure converges JobFailed",
			event: KernelEvent{Kind: EventPollFailed, Reason: &reason, Diagnostic: diagnostic},
			want:  KernelVerdict{Kind: VerdictTerminal, JobTo: JobFailed, Reason: &reason, Diagnostic: diagnostic},
		},
		{
			name:  "poll cancel converges JobCancelled",
			event: KernelEvent{Kind: EventPollCancelled},
			want:  KernelVerdict{Kind: VerdictTerminal, JobTo: JobCancelled},
		},
		{
			name:  "poll expiry converges JobTimedOut",
			event: KernelEvent{Kind: EventPollTimedOut, Diagnostic: diagnostic},
			want:  KernelVerdict{Kind: VerdictTerminal, JobTo: JobTimedOut, Diagnostic: diagnostic},
		},
		{
			name:  "cancel intent on the accepted job marks both machines",
			event: KernelEvent{Kind: EventCancelAccepted},
			want:  KernelVerdict{Kind: VerdictCancelMarked, JobTo: JobCancelling, TaskTo: TaskCancelling},
		},
		{
			name:  "unstarted cancel converges JobCancelled",
			event: KernelEvent{Kind: EventCancelUnstarted},
			want:  KernelVerdict{Kind: VerdictTerminal, JobTo: JobCancelled},
		},
		{
			name:  "settle convergence targets the already-terminal job",
			state: kernelState(TaskProcessing, false, JobFailed, true, nil, 1),
			event: KernelEvent{Kind: EventConvergeSettled},
			want:  KernelVerdict{Kind: VerdictTerminal, JobTo: JobFailed},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := VerdictFor(tc.state, tc.event)
			if err != nil {
				t.Fatal(err)
			}
			if got.Kind != tc.want.Kind || got.JobTo != tc.want.JobTo || got.TaskTo != tc.want.TaskTo ||
				got.CreditBlocked != tc.want.CreditBlocked || got.ExternalRef != tc.want.ExternalRef ||
				!sameFailureReason(got.Reason, tc.want.Reason) || got.Diagnostic != tc.want.Diagnostic {
				t.Fatalf("VerdictFor = %+v, want %+v", got, tc.want)
			}
		})
	}

	t.Run("async acceptance without a reference is rejected", func(t *testing.T) {
		if _, err := VerdictFor(KernelState{}, KernelEvent{Kind: EventSubmitAccepted}); err == nil {
			t.Fatal("async acceptance must carry an external reference")
		}
	})

	t.Run("unknown events are rejected", func(t *testing.T) {
		if _, err := VerdictFor(KernelState{}, KernelEvent{Kind: "bogus"}); err == nil {
			t.Fatal("unknown event must error")
		}
	})
}

func ptrFailureReason(reason FailureReason) *FailureReason { return &reason }

func sameFailureReason(a, b *FailureReason) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
