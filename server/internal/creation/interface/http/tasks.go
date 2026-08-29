package creationhttp

import (
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/nevix-ai/server/internal/creation/application"
	"github.com/nevix-ai/server/internal/creation/domain"
)

// GenerationTaskHandler owns the generation task routes (creator-private).
type GenerationTaskHandler struct {
	tasks *application.TaskService
	store domain.BlobStore
}

func NewGenerationTaskHandler(tasks *application.TaskService, store domain.BlobStore) *GenerationTaskHandler {
	return &GenerationTaskHandler{tasks: tasks, store: store}
}

// TaskSubmitRejected statuses carry the Retry-After advice seconds; the
// frequency window is 60s so the header stays honest for rate rejections.
const rateAdviceSeconds = 60

type taskSubmitRequest struct {
	IdempotencyKey *string `json:"idempotency_key"`
	DraftRevision  *string `json:"draft_revision"`
}

// SubmitTask answers POST /creation/sessions/{sessionID}/tasks.
func (h *GenerationTaskHandler) SubmitTask(w http.ResponseWriter, r *http.Request) {
	sessionID, ok := pathUUID(w, r, "sessionID")
	if !ok {
		return
	}
	var req taskSubmitRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.IdempotencyKey == nil || req.DraftRevision == nil {
		WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "The idempotency_key and draft_revision fields are required."})
		return
	}
	revision, err := time.Parse(time.RFC3339Nano, *req.DraftRevision)
	if err != nil {
		WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "The draft_revision field must be an RFC 3339 timestamp."})
		return
	}
	result, err := h.tasks.Submit(r.Context(), application.SubmitCommand{
		Owner:          creatorID(w, r),
		SessionID:      sessionID,
		IdempotencyKey: *req.IdempotencyKey,
		DraftRevision:  revision,
	})
	if err != nil {
		failTask(w, r, err)
		return
	}
	status := http.StatusCreated
	if result.Replayed {
		status = http.StatusOK
	}
	encodeJSON(w, status, toTaskDetail(result.Task, result.Slots))
}

// ListSessionTasks answers GET /creation/sessions/{sessionID}/tasks.
func (h *GenerationTaskHandler) ListSessionTasks(w http.ResponseWriter, r *http.Request) {
	sessionID, ok := pathUUID(w, r, "sessionID")
	if !ok {
		return
	}
	limit, cursor, ok := parsePageParams(w, r)
	if !ok {
		return
	}
	page, next, err := h.tasks.List(r.Context(), creatorID(w, r), sessionID, cursor, limit)
	if err != nil {
		fail(w, r, err)
		return
	}
	items := make([]generationTaskResource, 0, len(page))
	for _, task := range page {
		items = append(items, toTaskResource(task))
	}
	encodeJSON(w, http.StatusOK, listTasksResponse{Tasks: items, NextCursor: cursorToken(next)})
}

type listTasksResponse struct {
	Tasks      []generationTaskResource `json:"tasks"`
	NextCursor *string                  `json:"next_cursor"`
}

// GetTask answers GET /creation/tasks/{taskID}.
func (h *GenerationTaskHandler) GetTask(w http.ResponseWriter, r *http.Request) {
	taskID, ok := pathUUID(w, r, "taskID")
	if !ok {
		return
	}
	task, slots, err := h.tasks.Get(r.Context(), creatorID(w, r), taskID)
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusOK, toTaskDetail(task, slots))
}

// CancelTask answers POST /creation/tasks/{taskID}/cancel; repeated cancels
// answer with the task's current state (idempotent by contract).
func (h *GenerationTaskHandler) CancelTask(w http.ResponseWriter, r *http.Request) {
	taskID, ok := pathUUID(w, r, "taskID")
	if !ok {
		return
	}
	if err := h.tasks.Cancel(r.Context(), creatorID(w, r), taskID); err != nil {
		fail(w, r, err)
		return
	}
	task, slots, err := h.tasks.Get(r.Context(), creatorID(w, r), taskID)
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusOK, toTaskDetail(task, slots))
}

type taskRetryRequest struct {
	IdempotencyKey *string `json:"idempotency_key"`
}

// RetryUncompleted answers POST /creation/tasks/{taskID}/retry.
func (h *GenerationTaskHandler) RetryUncompleted(w http.ResponseWriter, r *http.Request) {
	taskID, ok := pathUUID(w, r, "taskID")
	if !ok {
		return
	}
	var req taskRetryRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.IdempotencyKey == nil {
		WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "The idempotency_key field is required."})
		return
	}
	result, err := h.tasks.RetryUncompleted(r.Context(), creatorID(w, r), taskID, *req.IdempotencyKey)
	if err != nil {
		failTask(w, r, err)
		return
	}
	status := http.StatusCreated
	if result.Replayed {
		status = http.StatusOK
	}
	encodeJSON(w, status, toTaskDetail(result.Task, result.Slots))
}

// DownloadSlotResult answers GET /creation/tasks/{taskID}/slots/{slotIndex}/result
// with a bounded streaming transfer of the verified output.
func (h *GenerationTaskHandler) DownloadSlotResult(w http.ResponseWriter, r *http.Request) {
	taskID, ok := pathUUID(w, r, "taskID")
	if !ok {
		return
	}
	index, err := strconv.Atoi(chi.URLParam(r, "slotIndex"))
	if err != nil || index < 0 {
		WriteError(w, &Error{Status: http.StatusNotFound, Code: CodeNotFound, Message: "The requested resource was not found."})
		return
	}
	task, slots, err := h.tasks.Get(r.Context(), creatorID(w, r), taskID)
	if err != nil {
		fail(w, r, err)
		return
	}
	if index >= len(slots) || index >= task.SlotCount {
		WriteError(w, &Error{Status: http.StatusNotFound, Code: CodeNotFound, Message: "The requested resource was not found."})
		return
	}
	slot := slots[index]
	if slot.Status == nil || *slot.Status != domain.SlotSucceeded || slot.ResultBlobKey == nil {
		WriteError(w, &Error{Status: http.StatusNotFound, Code: CodeNotFound, Message: "The requested resource was not found."})
		return
	}
	reader, _, err := h.store.Open(r.Context(), *slot.ResultBlobKey, domain.FullBlobRange)
	if err != nil {
		fail(w, r, err)
		return
	}
	defer reader.Close()
	if slot.ResultMime != nil {
		w.Header().Set("Content-Type", *slot.ResultMime)
	}
	w.WriteHeader(http.StatusOK)
	// Bounded copy through a modest buffer; the blob was already capped at
	// transfer time so this loop cannot buffer the object whole.
	buf := make([]byte, 128<<10)
	if _, err := copyBuffer(w, reader, buf); err != nil {
		_ = r.Context().Err()
	}
}

func copyBuffer(w http.ResponseWriter, src interface{ Read([]byte) (int, error) }, buf []byte) (int64, error) {
	var total int64
	for {
		n, err := src.Read(buf)
		if n > 0 {
			written, writeErr := w.Write(buf[:n])
			total += int64(written)
			if writeErr != nil {
				return total, writeErr
			}
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return total, nil
			}
			return total, err
		}
	}
}

// --- wire shapes -------------------------------------------------------------

type generationTaskResource struct {
	ID              string  `json:"id"`
	SessionID       string  `json:"session_id"`
	Status          string  `json:"status"`
	MediaType       string  `json:"media_type"`
	SlotCount       int     `json:"slot_count"`
	CancelRequested bool    `json:"cancel_requested"`
	TerminalCause   *string `json:"terminal_cause"`
	CreatedAt       string  `json:"created_at"`
	UpdatedAt       string  `json:"updated_at"`
	TerminalAt      *string `json:"terminal_at"`
}

func toTaskResource(task domain.GenerationTask) generationTaskResource {
	resource := generationTaskResource{
		ID:              task.ID.String(),
		SessionID:       task.SessionID.String(),
		Status:          string(task.Status),
		MediaType:       string(task.Spec.MediaType),
		SlotCount:       task.SlotCount,
		CancelRequested: task.CancelRequested,
		CreatedAt:       task.CreatedAt.UTC().Format(timeRFC3339),
		UpdatedAt:       task.UpdatedAt.UTC().Format(timeRFC3339),
	}
	if task.TerminalCause != nil {
		cause := string(*task.TerminalCause)
		resource.TerminalCause = &cause
	}
	if task.TerminalAt != nil {
		at := task.TerminalAt.UTC().Format(timeRFC3339)
		resource.TerminalAt = &at
	}
	return resource
}

type generationSlotResource struct {
	Index         int                 `json:"index"`
	Status        string              `json:"status"`
	FailureReason *string             `json:"failure_reason"`
	Result        *slotResultResource `json:"result"`
}

type slotResultResource struct {
	MimeType   string `json:"mime_type"`
	ByteSize   int64  `json:"byte_size"`
	Checksum   string `json:"checksum_sha256"`
	WidthPx    *int   `json:"width_px"`
	HeightPx   *int   `json:"height_px"`
	DurationMS *int   `json:"duration_ms"`
}

func toSlotResource(task domain.GenerationTask, slot domain.GenerationSlot) generationSlotResource {
	status := domain.SlotProjection(task.Status, slot.Status)
	resource := generationSlotResource{Index: slot.Index, Status: status}
	if slot.Reason != nil {
		reason := string(*slot.Reason)
		resource.FailureReason = &reason
	}
	if slot.Status != nil && *slot.Status == domain.SlotSucceeded && slot.ResultBlobKey != nil {
		checksum := ""
		if len(slot.ResultChecksum) == 32 {
			checksum = hex.EncodeToString(slot.ResultChecksum)
		}
		mime := ""
		if slot.ResultMime != nil {
			mime = *slot.ResultMime
		}
		size := int64(0)
		if slot.ResultByteSize != nil {
			size = *slot.ResultByteSize
		}
		resource.Result = &slotResultResource{
			MimeType:   mime,
			ByteSize:   size,
			Checksum:   checksum,
			WidthPx:    slot.ResultWidthPx,
			HeightPx:   slot.ResultHeightPx,
			DurationMS: slot.ResultDurationMS,
		}
	}
	return resource
}

type generationTaskDetailResource struct {
	Task          generationTaskResource   `json:"task"`
	Slots         []generationSlotResource `json:"slots"`
	Specification *generationSpecResource  `json:"specification"`
}

type generationSpecResource struct {
	SchemaVersion   int                       `json:"schema_version"`
	MediaType       string                    `json:"media_type"`
	Prompt          string                    `json:"prompt"`
	Model           string                    `json:"model"`
	Mode            string                    `json:"mode"`
	ManifestVersion int                       `json:"manifest_version"`
	Ratio           *string                   `json:"ratio"`
	Resolution      *string                   `json:"resolution"`
	Quantity        int                       `json:"quantity"`
	DurationSeconds *int                      `json:"duration_seconds"`
	References      []generationSpecReference `json:"references"`
}

type generationSpecReference struct {
	MaterialID    string `json:"material_id"`
	Role          string `json:"role"`
	Kind          string `json:"kind"`
	ClaimsVersion int    `json:"claims_version"`
}

func toTaskDetail(task domain.GenerationTask, slots []domain.GenerationSlot) generationTaskDetailResource {
	detail := generationTaskDetailResource{
		Task:  toTaskResource(task),
		Slots: make([]generationSlotResource, 0, len(slots)),
	}
	for _, slot := range slots {
		detail.Slots = append(detail.Slots, toSlotResource(task, slot))
	}
	refs := make([]generationSpecReference, 0, len(task.Spec.References))
	for _, reference := range task.Spec.References {
		refs = append(refs, generationSpecReference{
			MaterialID:    reference.MaterialID.String(),
			Role:          string(reference.Role),
			Kind:          string(reference.Kind),
			ClaimsVersion: reference.ClaimsVersion,
		})
	}
	detail.Specification = &generationSpecResource{
		SchemaVersion:   task.Spec.SchemaVersion,
		MediaType:       string(task.Spec.MediaType),
		Prompt:          task.Spec.Prompt,
		Model:           task.Spec.Model,
		Mode:            task.Spec.Mode,
		ManifestVersion: task.Spec.ManifestVersion,
		Ratio:           task.Spec.Ratio,
		Resolution:      task.Spec.Resolution,
		Quantity:        task.Spec.Quantity,
		DurationSeconds: task.Spec.DurationSeconds,
		References:      refs,
	}
	return detail
}

// failTask maps task-command errors onto the contract's stable statuses:
// 403 for the persistent governance blocks, 429 (+Retry-After) for the
// retryable ones, 409 for idempotency/revision conflicts, 422 for draft and
// capability rejections.
func failTask(w http.ResponseWriter, r *http.Request, err error) {
	var governanceBlocked *domain.GovernanceBlockedError
	var mediaUnavailable *domain.MediaUnavailableError
	switch {
	case errorsIs(err, domain.ErrIdempotencyPayloadConflict):
		WriteError(w, &Error{Status: http.StatusConflict, Code: CodeIdempotencyConflict, Message: "This idempotency key was already used with a different payload."})
	case errorsIs(err, domain.ErrDraftRevisionConflict):
		WriteError(w, &Error{Status: http.StatusConflict, Code: CodeDraftRevisionConflict, Message: "The draft changed since the submitted revision; reload and resubmit."})
	case errorsIs(err, domain.ErrDraftNotReady):
		WriteError(w, &Error{Status: http.StatusUnprocessableEntity, Code: CodeDraftNotReady, Message: "The stored draft does not carry a complete generation intent."})
	case errorsIs(err, domain.ErrDraftCapabilityStale):
		WriteError(w, &Error{Status: http.StatusUnprocessableEntity, Code: CodeDraftCapabilityStale, Message: "Draft values are outside the current capability manifest; the draft was preserved."})
	case errorsAs(err, &mediaUnavailable):
		WriteError(w, &Error{Status: http.StatusUnprocessableEntity, Code: CodeMediaUnavailable, Message: "The target media is not available for generation right now."})
	case errorsAs(err, &governanceBlocked):
		mapGovernanceBlocked(w, governanceBlocked.Reason)
	default:
		fail(w, r, err)
	}
}

// mapGovernanceBlocked keeps the status split stable: persistent ceilings
// (credit, monthly) are 403; windowed pressure (rate, concurrency) is 429
// with Retry-After.
func mapGovernanceBlocked(w http.ResponseWriter, reason domain.GovernanceReason) {
	switch reason {
	case domain.ReasonProviderCreditBlocked,
		domain.ReasonInstanceMonthlyReached,
		domain.ReasonMemberMonthlyReached:
		WriteError(w, &Error{Status: http.StatusForbidden, Code: string(reason), Message: "Generation is blocked by a governance limit; see the reason code."})
	default:
		w.Header().Set("Retry-After", strconv.Itoa(rateAdviceSeconds))
		WriteError(w, &Error{Status: http.StatusTooManyRequests, Code: string(reason), Message: "Generation is temporarily limited; retry after the advised wait."})
	}
}

// The small local reflect-free error helpers reuse http.go's isError for
// sentinel identity; errorsAs covers the structured task errors.
func errorsIs(err, target error) bool { return isError(err, target) }

func errorsAs(err error, target any) bool {
	switch t := target.(type) {
	case **domain.GovernanceBlockedError:
		for err != nil {
			if candidate, ok := err.(*domain.GovernanceBlockedError); ok {
				*t = candidate
				return true
			}
			unwrapper, ok := err.(interface{ Unwrap() error })
			if !ok {
				return false
			}
			err = unwrapper.Unwrap()
		}
		return false
	case **domain.MediaUnavailableError:
		for err != nil {
			if candidate, ok := err.(*domain.MediaUnavailableError); ok {
				*t = candidate
				return true
			}
			unwrapper, ok := err.(interface{ Unwrap() error })
			if !ok {
				return false
			}
			err = unwrapper.Unwrap()
		}
		return false
	default:
		return false
	}
}
