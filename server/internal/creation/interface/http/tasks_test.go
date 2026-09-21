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

// A slot whose result was removed keeps its succeeded verdict but never
// projects the result itself (ADR-0021): the marker is the only thing that
// reaches the client.
func TestRemovedSlotResultIsNotProjected(t *testing.T) {
	status := domain.SlotSucceeded
	mime := "image/jpeg"
	size := int64(2048)
	blobKey := "creation/generation-results/task/slot-0"
	resource := toSlotResource(
		domain.GenerationTask{Status: domain.TaskSucceeded},
		domain.GenerationSlot{
			Index: 0, Status: &status, ResultMime: &mime, ResultByteSize: &size,
			ResultChecksum: make([]byte, 32), ResultBlobKey: &blobKey, ResultDeleted: true,
		},
	)

	if !resource.ResultDeleted {
		t.Fatal("result_deleted must carry the removal to the client")
	}
	if resource.Status != "succeeded" {
		t.Fatalf("status = %q, want the slot's own verdict", resource.Status)
	}
	if resource.Result != nil {
		t.Fatalf("result leaked for a removed slot: %+v", resource.Result)
	}
}

func TestUnsettledSlotResourceOmitsFailureGuidance(t *testing.T) {
	resource := toSlotResource(domain.GenerationTask{Status: domain.TaskProcessing}, domain.GenerationSlot{Index: 0})
	if resource.ActionSuggestion != nil || resource.Retryable != nil || resource.SupportNumber != nil {
		t.Fatalf("unsettled slot leaked failure guidance: %+v", resource)
	}
}
