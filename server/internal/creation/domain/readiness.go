package domain

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

// Production Readiness is the Nevix release-level gate (spec #150): a media's
// capability values activate into the Capability Manifest only after their
// real-invocation checklist slot has passed. It is deliberately orthogonal to
// the instance's Provider Connection — readiness gates declarations, never
// rewriting a connection's own check facts.

// Readiness evidence media/dimension vocabulary. Media names double as the
// CapabilityManifest keys; dimensions name the manifest value lists a slot
// activates.
const (
	ReadinessMediaImage = "image"
	ReadinessMediaVideo = "video"
)

// ReadinessSlot is one traceable checklist entry: a public mode, parameter,
// resolution, async query, temporary-URL transfer, or actual-media probe.
// The embedded readiness-checklist.json is the single source of truth shared
// verbatim with the manual readiness runner (scripts/production-readiness).
// Model is empty for media-scoped dimensions; resolution slots carry the
// model because the vendor tier set (and its pixel sizes) is model-specific.
type ReadinessSlot struct {
	ID        string `json:"id"`
	Media     string `json:"media"`
	Dimension string `json:"dimension"`
	Value     string `json:"value"`
	Model     string `json:"model,omitempty"`
	Kind      string `json:"kind"`
	Title     string `json:"title"`
	Detail    string `json:"detail"`
}

// EvidenceStatus is one slot run's outcome in an evidence document. Only
// passed entries activate anything; failed entries are recorded history.
type EvidenceStatus string

const (
	EvidencePassed EvidenceStatus = "passed"
	EvidenceFailed EvidenceStatus = "failed"
)

// readinessSchemaVersion is the schema version of the readiness document
// family — the embedded checklist and the evidence documents it produces.
// A foreign document must be rejected loudly, never partially trusted.
// v3 adds model-scoped resolution slots (slot.model).
const readinessSchemaVersion = 3

// Evidence errors. Loaders map these onto loud startup failures — a malformed
// authority document must never silently deactivate every media.
var (
	// ErrEvidenceSchema reports an evidence document whose schema_version is
	// not the one this server understands.
	ErrEvidenceSchema = errors.New("production readiness evidence has an unsupported schema version")
	// ErrEvidenceManifestVersion reports evidence collected for a different
	// capability content version. Model changes must rerun real-invocation
	// acceptance instead of inheriting the previous model's results.
	ErrEvidenceManifestVersion = errors.New("production readiness evidence targets a different manifest version")
	// ErrEvidenceSlot reports an evidence entry citing a slot id outside the
	// embedded checklist.
	ErrEvidenceSlot = errors.New("production readiness evidence cites an unknown checklist slot")
	// ErrEvidenceStatus reports an entry status outside passed|failed.
	ErrEvidenceStatus = errors.New("production readiness evidence entry has an invalid status")
	// ErrEvidenceShape reports JSON that does not decode into the evidence
	// document shape at all.
	ErrEvidenceShape = errors.New("production readiness evidence is not a valid evidence document")
)

// readinessChecklistDoc mirrors readiness-checklist.json's envelope.
type readinessChecklistDoc struct {
	SchemaVersion   int             `json:"schema_version"`
	ManifestVersion int             `json:"manifest_version"`
	Slots           []ReadinessSlot `json:"slots"`
}

// readinessRegistry is the parsed, index-checked checklist.
type readinessRegistry struct {
	byID      map[string]ReadinessSlot
	binding   map[string]string // "media|dimension|value|model" -> slot id
	slotOrder []string
}

var (
	registryOnce sync.Once
	registry     *readinessRegistry
	registryErr  error
)

//go:embed readiness-checklist.json
var readinessChecklistJSON []byte

// readinessChecklist returns the embedded checklist slots. The document is
// build data: a malformed checklist is a programming error and fails every
// subsequent call identically.
func readinessChecklist() ([]ReadinessSlot, error) {
	parseReadinessRegistry()
	if registryErr != nil {
		return nil, registryErr
	}
	slots := make([]ReadinessSlot, 0, len(registry.slotOrder))
	for _, id := range registry.slotOrder {
		slots = append(slots, registry.byID[id])
	}
	return slots, nil
}

func parseReadinessRegistry() {
	registryOnce.Do(func() {
		var doc readinessChecklistDoc
		if err := json.Unmarshal(readinessChecklistJSON, &doc); err != nil {
			registryErr = fmt.Errorf("creation: embedded readiness checklist is not valid JSON: %w", err)
			return
		}
		if doc.SchemaVersion != readinessSchemaVersion {
			registryErr = fmt.Errorf("creation: embedded readiness checklist schema version %d, want %d", doc.SchemaVersion, readinessSchemaVersion)
			return
		}
		if doc.ManifestVersion != ManifestVersion {
			registryErr = fmt.Errorf("creation: embedded readiness checklist manifest version %d, want %d", doc.ManifestVersion, ManifestVersion)
			return
		}
		reg := &readinessRegistry{byID: map[string]ReadinessSlot{}, binding: map[string]string{}}
		for _, slot := range doc.Slots {
			if slot.ID == "" {
				registryErr = errors.New("creation: embedded readiness checklist contains a slot without an id")
				return
			}
			if _, dup := reg.byID[slot.ID]; dup {
				registryErr = fmt.Errorf("creation: embedded readiness checklist duplicates slot %q", slot.ID)
				return
			}
			key := readinessBindingKey(slot.Media, slot.Dimension, slot.Value, slot.Model)
			if existing, clash := reg.binding[key]; clash {
				registryErr = fmt.Errorf("creation: slots %s and %s bind the same capability value %s", existing, slot.ID, key)
				return
			}
			reg.byID[slot.ID] = slot
			reg.binding[key] = slot.ID
			reg.slotOrder = append(reg.slotOrder, slot.ID)
		}
		registry = reg
	})
}

func readinessBindingKey(media, dimension, value, model string) string {
	return media + "|" + dimension + "|" + value + "|" + model
}

// readinessSlotForValue resolves the slot that activates one capability
// value; model is empty for media-scoped dimensions. ok is false when the
// manifest content and checklist disagree (a build-time invariant enforced
// by tests).
func readinessSlotForValue(media, dimension, value, model string) (ReadinessSlot, bool) {
	parseReadinessRegistry()
	if registryErr != nil {
		return ReadinessSlot{}, false
	}
	id, ok := registry.binding[readinessBindingKey(media, dimension, value, model)]
	if !ok {
		return ReadinessSlot{}, false
	}
	return registry.byID[id], true
}

// ReadinessEvidence is one deployment's parsed evidence document: when each
// checklist slot last ran and how it ended.
type ReadinessEvidence struct {
	GeneratedAt time.Time
	Entries     []EvidenceEntry
}

// EvidenceEntry is one recorded slot run.
type EvidenceEntry struct {
	SlotID      string
	Status      EvidenceStatus
	CheckedAt   time.Time
	EvidenceRef string
}

// evidenceDoc mirrors the evidence file's JSON shape.
type evidenceDoc struct {
	SchemaVersion   int                `json:"schema_version"`
	ManifestVersion int                `json:"manifest_version"`
	GeneratedAt     time.Time          `json:"generated_at"`
	Entries         []evidenceEntryDoc `json:"entries"`
}

type evidenceEntryDoc struct {
	SlotID      string         `json:"slot_id"`
	Status      EvidenceStatus `json:"status"`
	CheckedAt   time.Time      `json:"checked_at"`
	EvidenceRef string         `json:"evidence_ref"`
}

// ParseReadinessEvidence validates a raw evidence document against the
// embedded checklist and current capability content version. Unknown slot
// ids, foreign schema/manifest versions, and invalid statuses are rejections,
// never ignored entries: the evidence file is an authority document and a
// drifted runner must fail loudly.
func ParseReadinessEvidence(raw []byte) (ReadinessEvidence, error) {
	var doc evidenceDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		return ReadinessEvidence{}, fmt.Errorf("%w: %s", ErrEvidenceShape, err)
	}
	if doc.SchemaVersion != readinessSchemaVersion {
		return ReadinessEvidence{}, fmt.Errorf("%w: %d", ErrEvidenceSchema, doc.SchemaVersion)
	}
	if doc.ManifestVersion != ManifestVersion {
		return ReadinessEvidence{}, fmt.Errorf("%w: got %d, want %d", ErrEvidenceManifestVersion, doc.ManifestVersion, ManifestVersion)
	}
	parseReadinessRegistry()
	if registryErr != nil {
		return ReadinessEvidence{}, registryErr
	}
	evidence := ReadinessEvidence{GeneratedAt: doc.GeneratedAt}
	for _, entry := range doc.Entries {
		if _, known := registry.byID[entry.SlotID]; !known {
			return ReadinessEvidence{}, fmt.Errorf("%w: %q", ErrEvidenceSlot, entry.SlotID)
		}
		if entry.Status != EvidencePassed && entry.Status != EvidenceFailed {
			return ReadinessEvidence{}, fmt.Errorf("%w: %q", ErrEvidenceStatus, entry.Status)
		}
		evidence.Entries = append(evidence.Entries, EvidenceEntry{
			SlotID:      entry.SlotID,
			Status:      entry.Status,
			CheckedAt:   entry.CheckedAt,
			EvidenceRef: entry.EvidenceRef,
		})
	}
	return evidence, nil
}

// passedValues returns the set of capability values whose slot has a passed
// entry for one media dimension's media-scoped slots (model-scoped slots are
// only visible through passedValuesForModel). Later duplicate entries
// override earlier ones, so a re-run after a failure (or vice versa) is
// honored by run order.
func (e ReadinessEvidence) passedValues(media, dimension string) map[string]bool {
	parseReadinessRegistry()
	passed := map[string]bool{}
	if registryErr != nil {
		return passed
	}
	for _, entry := range e.Entries {
		slot, ok := registry.byID[entry.SlotID]
		if !ok || slot.Media != media || slot.Dimension != dimension || slot.Model != "" {
			continue
		}
		passed[slot.Value] = entry.Status == EvidencePassed
	}
	return passed
}

// passedValuesForModel returns the passed value set of one media dimension's
// slots bound to one model — the resolution tiers, whose pixel sizes differ
// per model. Run-order override follows passedValues.
func (e ReadinessEvidence) passedValuesForModel(media, dimension, model string) map[string]bool {
	parseReadinessRegistry()
	passed := map[string]bool{}
	if registryErr != nil {
		return passed
	}
	for _, entry := range e.Entries {
		slot, ok := registry.byID[entry.SlotID]
		if !ok || slot.Media != media || slot.Dimension != dimension || slot.Model != model {
			continue
		}
		passed[slot.Value] = entry.Status == EvidencePassed
	}
	return passed
}

// anyModelPassed reports whether any model-scoped slot of the dimension
// currently holds a passed entry — the readiness gate for a media whose
// resolution tiers are model-scoped. A later failed re-run of the same slot
// overrides an earlier pass, matching the run-order rule above.
func (e ReadinessEvidence) anyModelPassed(media, dimension string) bool {
	parseReadinessRegistry()
	if registryErr != nil {
		return false
	}
	passedByModel := map[string]map[string]bool{}
	for _, slot := range registry.byID {
		if slot.Media != media || slot.Dimension != dimension || slot.Model == "" {
			continue
		}
		if passedByModel[slot.Model] == nil {
			passedByModel[slot.Model] = e.passedValuesForModel(media, dimension, slot.Model)
		}
		if passedByModel[slot.Model][slot.Value] {
			return true
		}
	}
	return false
}
