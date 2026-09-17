package creationhttp

import (
	"testing"

	"github.com/nevix-ai/server/internal/creation/domain"
)

func TestFailedSlotResourceIncludesStableGuidanceAndNevixSupportNumber(t *testing.T) {
	taskID, err := domain.ParseUUID("11111111-2222-4333-8444-555555555555")
	if err != nil {
		t.Fatal(err)
	}
	reason := domain.ReasonOutputPolicyRejected
	status := domain.SlotFailed
	resource := toSlotResource(
		domain.GenerationTask{ID: taskID, Status: domain.TaskPartiallySucceeded},
		domain.GenerationSlot{Index: 1, Status: &status, Reason: &reason},
	)

	if resource.ActionSuggestion == nil || *resource.ActionSuggestion != "revise_request" {
		t.Fatalf("action_suggestion = %v", resource.ActionSuggestion)
	}
	if resource.Retryable == nil || *resource.Retryable {
		t.Fatalf("retryable = %v, want false", resource.Retryable)
	}
	if resource.SupportNumber == nil || *resource.SupportNumber != "NVX-11111111-2222-4333-8444-555555555555-02" {
		t.Fatalf("support_number = %v", resource.SupportNumber)
	}
}

func TestUnsettledSlotResourceOmitsFailureGuidance(t *testing.T) {
	resource := toSlotResource(domain.GenerationTask{Status: domain.TaskProcessing}, domain.GenerationSlot{Index: 0})
	if resource.ActionSuggestion != nil || resource.Retryable != nil || resource.SupportNumber != nil {
		t.Fatalf("unsettled slot leaked failure guidance: %+v", resource)
	}
}
