package domain

import (
	"errors"
	"testing"
	"time"
)

func validEvidenceDoc() string {
	return `{
		"schema_version": 1,
		"generated_at": "2026-08-28T00:00:00Z",
		"entries": [
			{"slot_id": "image.resolution.2k", "status": "passed", "checked_at": "2026-08-28T00:00:00Z", "evidence_ref": "runs/2026-08-28/2k"},
			{"slot_id": "image.resolution.1k", "status": "failed", "checked_at": "2026-08-28T00:01:00Z", "evidence_ref": "runs/2026-08-28/1k"}
		]
	}`
}

func TestParseReadinessEvidenceAcceptsValidDocument(t *testing.T) {
	evidence, err := ParseReadinessEvidence([]byte(validEvidenceDoc()))
	if err != nil {
		t.Fatalf("valid evidence must parse: %v", err)
	}
	if len(evidence.Entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(evidence.Entries))
	}
	if evidence.Entries[0].Status != EvidencePassed || evidence.Entries[1].Status != EvidenceFailed {
		t.Fatalf("statuses must round-trip")
	}
	if evidence.Entries[0].EvidenceRef != "runs/2026-08-28/2k" {
		t.Fatalf("evidence_ref must round-trip")
	}
}

func TestParseReadinessEvidenceRejectsForeignSchemaVersion(t *testing.T) {
	_, err := ParseReadinessEvidence([]byte(`{"schema_version": 99, "entries": []}`))
	if !errors.Is(err, ErrEvidenceSchema) {
		t.Fatalf("foreign schema version must be ErrEvidenceSchema, got %v", err)
	}
}

func TestParseReadinessEvidenceRejectsUnknownSlot(t *testing.T) {
	_, err := ParseReadinessEvidence([]byte(`{"schema_version": 1, "entries": [{"slot_id": "image.resolution.8k", "status": "passed"}]}`))
	if !errors.Is(err, ErrEvidenceSlot) {
		t.Fatalf("unknown slot must be ErrEvidenceSlot, got %v", err)
	}
}

func TestParseReadinessEvidenceRejectsInvalidStatus(t *testing.T) {
	_, err := ParseReadinessEvidence([]byte(`{"schema_version": 1, "entries": [{"slot_id": "image.resolution.2k", "status": "skipped"}]}`))
	if !errors.Is(err, ErrEvidenceStatus) {
		t.Fatalf("invalid status must be ErrEvidenceStatus, got %v", err)
	}
}

func TestParseReadinessEvidenceRejectsMalformedJSON(t *testing.T) {
	_, err := ParseReadinessEvidence([]byte(`{"schema_version": 1,`))
	if !errors.Is(err, ErrEvidenceShape) {
		t.Fatalf("malformed JSON must be ErrEvidenceShape, got %v", err)
	}
}

// TestReadinessEvidenceRerunOverridesByRunOrder: a later failed run after an
// earlier pass (or the reverse) must be honored by run order, so evidence
// reflects the latest truth per slot.
func TestReadinessEvidenceRerunOverridesByRunOrder(t *testing.T) {
	slot, ok := ReadinessSlotForValue("image", "resolution", "2K")
	if !ok {
		t.Fatal("image 2K slot must exist")
	}
	evidence := ReadinessEvidence{Entries: []EvidenceEntry{
		{SlotID: slot.ID, Status: EvidencePassed, CheckedAt: time.Now()},
		{SlotID: slot.ID, Status: EvidenceFailed, CheckedAt: time.Now().Add(time.Minute)},
	}}
	if got := evidence.passedValues("image", "resolution"); got["2K"] {
		t.Fatal("a later failed rerun must deactivate the slot")
	}
	evidence.Entries = append(evidence.Entries, EvidenceEntry{SlotID: slot.ID, Status: EvidencePassed})
	if got := evidence.passedValues("image", "resolution"); !got["2K"] {
		t.Fatal("a later passed rerun must reactivate the slot")
	}
}
