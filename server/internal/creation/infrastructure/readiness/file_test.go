package readiness

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/nevix-ai/server/internal/creation/domain"
)

func TestLoadEvidenceFileWithoutPathIsEmpty(t *testing.T) {
	evidence, err := LoadEvidenceFile("")
	if err != nil {
		t.Fatalf("unset path must load empty evidence: %v", err)
	}
	if len(evidence.Entries) != 0 {
		t.Fatalf("unset path must carry no entries, got %d", len(evidence.Entries))
	}
}

func TestLoadEvidenceFileMissingFileIsEmpty(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "absent.json")
	evidence, err := LoadEvidenceFile(missing)
	if err != nil {
		t.Fatalf("missing file is the valid factory state: %v", err)
	}
	if len(evidence.Entries) != 0 {
		t.Fatalf("missing file must carry no entries, got %d", len(evidence.Entries))
	}
}

func TestLoadEvidenceFileParsesValidDocument(t *testing.T) {
	path := filepath.Join(t.TempDir(), "production-readiness.json")
	raw := `{"schema_version": 3, "manifest_version": 3, "generated_at": "2026-08-28T00:00:00Z", "entries": [{"slot_id": "image.resolution.pro-2k", "status": "passed", "checked_at": "2026-08-28T00:00:00Z", "evidence_ref": "runs/2k"}]}`
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatalf("write evidence: %v", err)
	}
	evidence, err := LoadEvidenceFile(path)
	if err != nil {
		t.Fatalf("valid evidence must load: %v", err)
	}
	if len(evidence.Entries) != 1 || evidence.Entries[0].Status != domain.EvidencePassed {
		t.Fatalf("entries must round-trip: %+v", evidence.Entries)
	}
}

func TestLoadEvidenceFileRejectsCorruptDocument(t *testing.T) {
	path := filepath.Join(t.TempDir(), "production-readiness.json")
	if err := os.WriteFile(path, []byte(`{"schema_version": 3, "manifest_version": 3, "entries": [{"slot_id": "nope", "status": "passed"}]}`), 0o600); err != nil {
		t.Fatalf("write evidence: %v", err)
	}
	_, err := LoadEvidenceFile(path)
	if !errors.Is(err, domain.ErrEvidenceSlot) {
		t.Fatalf("unknown slot must surface ErrEvidenceSlot, got %v", err)
	}
}

func TestLoadEvidenceFileRejectsUnreadableFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "production-readiness.json")
	if err := os.WriteFile(path, []byte(`{}`), 0o600); err != nil {
		t.Fatalf("write evidence: %v", err)
	}
	// A directory at the same path makes the read fail with something other
	// than NotExist — the loader must not swallow it into "empty".
	_, err := LoadEvidenceFile(dir)
	if err == nil || errors.Is(err, domain.ErrEvidenceShape) {
		t.Fatalf("a read failure must surface as a loud error, got %v", err)
	}
}
