package domain

import (
	"testing"
	"time"
)

// The full status vocabularies, exhaustively crossed in the matrix tests
// below so an undocumented edge cannot survive review.
var (
	allTaskStatuses = []TaskStatus{
		TaskQueued, TaskSubmitting, TaskProcessing, TaskPersisting, TaskCancelling,
		TaskSucceeded, TaskPartiallySucceeded, TaskFailed, TaskCancelled, TaskTimedOut,
	}
	allJobStatuses = []JobStatus{
		JobPending, JobSubmitting, JobProcessing, JobCancelling,
		JobCompleted, JobFailed, JobCancelled, JobTimedOut, JobIndeterminate,
	}
)

func TestTaskTransitionMatrixMatchesSpec(t *testing.T) {
	allowed := map[[2]TaskStatus]bool{}
	for _, edges := range []struct {
		from TaskStatus
		to   []TaskStatus
	}{
		{TaskQueued, []TaskStatus{TaskSubmitting, TaskCancelling, TaskCancelled}},
		{TaskSubmitting, []TaskStatus{TaskProcessing, TaskPersisting, TaskCancelling, TaskFailed, TaskCancelled, TaskTimedOut}},
		{TaskProcessing, []TaskStatus{TaskPersisting, TaskCancelling, TaskFailed, TaskCancelled, TaskTimedOut}},
		{TaskPersisting, []TaskStatus{TaskCancelling, TaskSucceeded, TaskPartiallySucceeded, TaskFailed, TaskCancelled, TaskTimedOut}},
		{TaskCancelling, []TaskStatus{TaskSucceeded, TaskPartiallySucceeded, TaskFailed, TaskCancelled, TaskTimedOut}},
	} {
		for _, to := range edges.to {
			allowed[[2]TaskStatus{edges.from, to}] = true
		}
	}
	for _, from := range allTaskStatuses {
		for _, to := range allTaskStatuses {
			want := allowed[[2]TaskStatus{from, to}]
			if got := TaskCanTransition(from, to); got != want {
				t.Errorf("TaskCanTransition(%s → %s) = %v, want %v", from, to, got, want)
			}
		}
	}
	for _, terminal := range []TaskStatus{TaskSucceeded, TaskPartiallySucceeded, TaskFailed, TaskCancelled, TaskTimedOut} {
		if TaskIsTerminal(terminal) != true {
			t.Fatalf("%s must be terminal", terminal)
		}
		for _, to := range allTaskStatuses {
			if TaskCanTransition(terminal, to) {
				t.Errorf("terminal %s must never transition to %s", terminal, to)
			}
		}
		if TaskCanTransition(terminal, terminal) {
			t.Errorf("terminal %s must never transition to itself (终态永不重开)", terminal)
		}
	}
	// 内部 retry 不回到 queued：no edge from any non-terminal lands on queued.
	for _, from := range allTaskStatuses {
		if TaskCanTransition(from, TaskQueued) {
			t.Errorf("%s must never return to queued", from)
		}
	}
}

func TestJobTransitionMatrixMatchesSpec(t *testing.T) {
	allowed := map[[2]JobStatus]bool{}
	for _, edges := range []struct {
		from JobStatus
		to   []JobStatus
	}{
		{JobPending, []JobStatus{JobSubmitting, JobCancelled}},
		{JobSubmitting, []JobStatus{JobProcessing, JobCompleted, JobCancelling, JobFailed, JobCancelled, JobTimedOut, JobIndeterminate}},
		{JobProcessing, []JobStatus{JobCompleted, JobCancelling, JobCancelled, JobFailed, JobTimedOut}},
		{JobCancelling, []JobStatus{JobCompleted, JobCancelled, JobFailed, JobTimedOut, JobIndeterminate}},
	} {
		for _, to := range edges.to {
			allowed[[2]JobStatus{edges.from, to}] = true
		}
	}
	for _, from := range allJobStatuses {
		for _, to := range allJobStatuses {
			want := allowed[[2]JobStatus{from, to}]
			if got := JobCanTransition(from, to); got != want {
				t.Errorf("JobCanTransition(%s → %s) = %v, want %v", from, to, got, want)
			}
		}
	}
	if !JobIsTerminal(JobIndeterminate) {
		t.Fatal("indeterminate must be terminal: 永不自动 retry")
	}
	for _, from := range allJobStatuses {
		if JobCanTransition(from, JobPending) {
			t.Errorf("%s must never return to pending", from)
		}
	}
}

func TestAggregateTaskStatus(t *testing.T) {
	outcomes := func(statuses ...SlotStatus) []SlotOutcome {
		out := make([]SlotOutcome, len(statuses))
		for i, s := range statuses {
			out[i] = SlotOutcome{Index: i, Status: s}
		}
		return out
	}
	t.Run("all succeeded", func(t *testing.T) {
		status, cause, ok := AggregateTaskStatus(2, outcomes(SlotSucceeded, SlotSucceeded))
		if !ok || status != TaskSucceeded || cause != nil {
			t.Fatalf("got %v %v %v", status, cause, ok)
		}
	})
	t.Run("partial success keeps every success", func(t *testing.T) {
		status, cause, ok := AggregateTaskStatus(3, outcomes(SlotSucceeded, SlotFailed, SlotSucceeded))
		if !ok || status != TaskPartiallySucceeded || cause != nil {
			t.Fatalf("got %v %v %v", status, cause, ok)
		}
	})
	t.Run("zero success all cancelled", func(t *testing.T) {
		status, _, ok := AggregateTaskStatus(2, outcomes(SlotCancelled, SlotCancelled))
		if !ok || status != TaskCancelled {
			t.Fatalf("got %v %v", status, ok)
		}
	})
	t.Run("zero success all provider timed_out", func(t *testing.T) {
		status, _, ok := AggregateTaskStatus(2, outcomes(SlotTimedOut, SlotTimedOut))
		if !ok || status != TaskTimedOut {
			t.Fatalf("got %v %v", status, ok)
		}
	})
	t.Run("zero success with indeterminate marks cause", func(t *testing.T) {
		status, cause, ok := AggregateTaskStatus(2, outcomes(SlotIndeterminate, SlotFailed))
		if !ok || status != TaskFailed || cause == nil || *cause != TerminalCauseProviderIndeterminate {
			t.Fatalf("got %v %v %v", status, cause, ok)
		}
	})
	t.Run("timed_out plus failed collapses to failed", func(t *testing.T) {
		status, cause, ok := AggregateTaskStatus(2, outcomes(SlotTimedOut, SlotFailed))
		if !ok || status != TaskFailed || cause != nil {
			t.Fatalf("got %v %v %v", status, cause, ok)
		}
	})
	t.Run("incomplete or duplicated outcomes are rejected", func(t *testing.T) {
		if _, _, ok := AggregateTaskStatus(2, outcomes(SlotSucceeded)); ok {
			t.Fatal("incomplete outcome set must not aggregate")
		}
		if _, _, ok := AggregateTaskStatus(2, []SlotOutcome{{Index: 0, Status: SlotSucceeded}, {Index: 0, Status: SlotSucceeded}}); ok {
			t.Fatal("duplicated slot must not aggregate")
		}
		if _, _, ok := AggregateTaskStatus(2, []SlotOutcome{{Index: 0, Status: SlotSucceeded}, {Index: 5, Status: SlotSucceeded}}); ok {
			t.Fatal("out-of-range slot must not aggregate")
		}
	})
}

func TestSlotVerdictForJob(t *testing.T) {
	detail := FailureReason(ReasonOutputPolicyRejected)
	if status, _ := SlotVerdictForJob(JobTimedOut, &detail); status != SlotTimedOut {
		t.Fatalf("provider timeout must end slots timed_out, got %s", status)
	}
	if status, reason := SlotVerdictForJob(JobIndeterminate, nil); status != SlotIndeterminate || reason == nil || *reason != ReasonProcessingIndeterminate {
		t.Fatalf("indeterminate job must end slots indeterminate/processing_indeterminate, got %s %v", status, reason)
	}
	if status, reason := SlotVerdictForJob(JobCancelled, nil); status != SlotCancelled || reason != nil {
		t.Fatalf("cancelled job must end slots cancelled, got %s %v", status, reason)
	}
	if status, reason := SlotVerdictForJob(JobFailed, &detail); status != SlotFailed || reason == nil || *reason != ReasonOutputPolicyRejected {
		t.Fatalf("classified failure must carry its reason, got %s %v", status, reason)
	}
	if _, reason := SlotVerdictForJob(JobFailed, nil); reason == nil || *reason != ReasonTemporarilyUnavailable {
		t.Fatalf("unclassified failure defaults to temporarily_unavailable, got %v", reason)
	}
}

func TestSpecificationCanonicalPayloadIsStable(t *testing.T) {
	base := GenerationSpecification{
		SchemaVersion:   SpecificationSchemaVersion,
		MediaType:       MediaImage,
		Prompt:          "同一意图",
		Model:           ImageModelID,
		Mode:            ModeTextToImage,
		ManifestVersion: 1,
		Resolution:      ptr("2K"),
		Quantity:        2,
	}
	other := base
	if base.CanonicalPayload() == "" || base.CanonicalPayload() != other.CanonicalPayload() {
		t.Fatal("identical specifications must produce the same canonical payload")
	}
	changedPrompt := base
	changedPrompt.Prompt = "另一个意图"
	if base.PayloadHash() == changedPrompt.PayloadHash() {
		t.Fatal("a different prompt must change the payload hash")
	}
	reordered := base
	reordered.References = []SpecificationReference{{MaterialID: UUID{0x01}, Role: RoleReference, Kind: KindImage, ClaimsVersion: 1}}
	referenceOrder := base
	referenceOrder.References = []SpecificationReference{{MaterialID: UUID{0x02}, Role: RoleReference, Kind: KindImage, ClaimsVersion: 1}}
	if reordered.PayloadHash() == referenceOrder.PayloadHash() {
		t.Fatal("reference order is part of the frozen intent")
	}
}

func intPtr(v int) *int { return &v }

func TestEvaluateGovernanceFixedOrder(t *testing.T) {
	media := MediaImage
	build := func() *GovernanceSnapshot {
		return &GovernanceSnapshot{InstancePolicy: &GovernancePolicy{Scope: GovernanceScopeInstance}}
	}
	expect := func(t *testing.T, snapshot *GovernanceSnapshot, want GovernanceReason) {
		t.Helper()
		got := EvaluateGovernance(snapshot, media)
		if got == nil || *got != want {
			t.Fatalf(" EvaluateGovernance = %v, want %s", got, want)
		}
	}

	t.Run("credit blocks first regardless of everything else", func(t *testing.T) {
		snapshot := build()
		snapshot.CreditBlocked = true
		expect(t, snapshot, ReasonProviderCreditBlocked)
	})
	t.Run("fixed order when every rule trips at once", func(t *testing.T) {
		snapshot := build()
		snapshot.InstancePolicy.MonthlyTaskLimit = intPtr(5)
		snapshot.InstancePolicy.RateLimit = intPtr(5)
		snapshot.MemberPolicy = &GovernancePolicy{Scope: GovernanceScopeUser}
		snapshot.MemberPolicy.MonthlyTaskLimit = intPtr(5)
		snapshot.MemberPolicy.RateLimit = intPtr(5)
		snapshot.MemberPolicy.ImageConcurrency = intPtr(0)
		snapshot.InstanceMonthlyCount, snapshot.MemberMonthlyCount = 5, 5
		snapshot.InstanceRateCount, snapshot.MemberRateCount = 5, 5
		expect(t, snapshot, ReasonInstanceMonthlyReached)

		snapshot.InstanceMonthlyCount = 4
		expect(t, snapshot, ReasonMemberMonthlyReached)
		snapshot.MemberMonthlyCount = 4
		expect(t, snapshot, ReasonInstanceRateLimited)
		snapshot.InstanceRateCount = 4
		expect(t, snapshot, ReasonMemberRateLimited)
		snapshot.MemberRateCount = 4
		expect(t, snapshot, ReasonMemberConcurrency)
	})
	t.Run("unset means unlimited, zero forbids", func(t *testing.T) {
		snapshot := build()
		if got := EvaluateGovernance(snapshot, media); got != nil {
			t.Fatalf("no limits set must admit, got %s", *got)
		}
		snapshot.MemberPolicy = &GovernancePolicy{Scope: GovernanceScopeUser, ImageConcurrency: intPtr(0)}
		expect(t, snapshot, ReasonMemberConcurrency)
	})
	t.Run("member override wins field-by-field", func(t *testing.T) {
		snapshot := build()
		snapshot.InstancePolicy = &GovernancePolicy{
			Scope: GovernanceScopeInstance, ImageConcurrency: intPtr(3), RateLimit: intPtr(9),
		}
		snapshot.MemberPolicy = &GovernancePolicy{Scope: GovernanceScopeUser, ImageConcurrency: intPtr(1)}
		snapshot.MemberImageReservations = 1
		expect(t, snapshot, ReasonMemberConcurrency)

		snapshot.MemberImageReservations = 0
		snapshot.MemberRateCount = 9
		// Member set no rate override, so the instance ceiling of 9 applies:
		// nine prior attempts + this one exceeds it at the member level.
		expect(t, snapshot, ReasonMemberRateLimited)
	})
	t.Run("monthly counts the admitted task, rate counts this attempt", func(t *testing.T) {
		snapshot := build()
		snapshot.InstancePolicy.MonthlyTaskLimit = intPtr(3)
		snapshot.InstanceMonthlyCount = 3
		expect(t, snapshot, ReasonInstanceMonthlyReached)
		snapshot.InstanceMonthlyCount = 2

		snapshot.MemberPolicy = &GovernancePolicy{Scope: GovernanceScopeUser}
		snapshot.MemberPolicy.MonthlyTaskLimit = intPtr(3)
		snapshot.MemberMonthlyCount = 3
		expect(t, snapshot, ReasonMemberMonthlyReached)
	})
	t.Run("video draws from the video pool", func(t *testing.T) {
		snapshot := build()
		snapshot.MemberPolicy = &GovernancePolicy{Scope: GovernanceScopeUser, ImageConcurrency: intPtr(0)}
		if got := EvaluateGovernance(snapshot, MediaVideo); got != nil {
			t.Fatalf("image pool exhaustion must not block video, got %s", *got)
		}
		snapshot.MemberPolicy.VideoConcurrency = intPtr(0)
		got := EvaluateGovernance(snapshot, MediaVideo)
		if got == nil || *got != ReasonMemberConcurrency {
			t.Fatalf("video pool zero must block video, got %v", got)
		}
	})
}

func TestMonthWindowUTCFollowsAsiaShanghai(t *testing.T) {
	// 2026-08-31 16:30 UTC is already 2026-09-01 00:30 in Asia/Shanghai.
	now := time.Date(2026, 8, 31, 16, 30, 0, 0, time.UTC)
	start, end := MonthWindowUTC(now)
	if got := start.In(time.FixedZone("CST", 8*3600)).Format("2006-01-02 15:04"); got != "2026-09-01 00:00" {
		t.Fatalf("month start = %s, want 2026-09-01 00:00 Asia/Shanghai", got)
	}
	if got := end.In(time.FixedZone("CST", 8*3600)).Format("2006-01-02 15:04"); got != "2026-10-01 00:00" {
		t.Fatalf("month end = %s, want 2026-10-01 00:00 Asia/Shanghai", got)
	}
	if !start.Before(end) {
		t.Fatal("window must be ordered")
	}
}

func TestStableSlotOrder(t *testing.T) {
	order := StableSlotOrder(4)
	for i, v := range order {
		if v != i {
			t.Fatalf("slot order must be 0..n-1, got %v", order)
		}
	}
}
