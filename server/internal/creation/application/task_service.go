package application

import (
	"context"
	"errors"
	"time"
	"unicode/utf8"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// InvalidationSink receives one post-commit generation-change notification
// per owner; the transport layer implements it with the creator-scoped SSE
// hub. Persistence commits first — the sink is only invoked on the committed
// path — and payloads never carry private content.
type InvalidationSink interface {
	NotifyGenerationChanged(owner domain.UUID)
}

// TaskService orchestrates the generation task kernel's creator commands:
// idempotent admission with governance, best-effort cancel, retry of
// uncompleted slots, and creator-scoped task queries. Every write runs
// inside the domain-local verified transaction runner.
type TaskService struct {
	tasks       domain.GenerationTaskRepository
	materials   domain.MaterialRepository
	connections domain.ConnectionSignals
	governance  domain.GovernanceRepository
	manifest    *ManifestService
	runner      domain.WriteRunner
	notify      InvalidationSink
}

func NewTaskService(
	tasks domain.GenerationTaskRepository,
	materials domain.MaterialRepository,
	connections domain.ConnectionSignals,
	governance domain.GovernanceRepository,
	manifest *ManifestService,
	runner domain.WriteRunner,
	notify InvalidationSink,
) *TaskService {
	return &TaskService{
		tasks: tasks, materials: materials, connections: connections,
		governance: governance, manifest: manifest, runner: runner, notify: notify,
	}
}

// SubmitCommand is one idempotent submission: the key is creator-scoped and
// the intent is the device-local draft's complete values at submit time
// (ADR-0017) — the server stores no editable draft to point at.
type SubmitCommand struct {
	Owner          domain.UUID
	SessionID      domain.UUID
	IdempotencyKey string
	Intent         *domain.GenerationIntent
}

// SubmissionResult answers both fresh and replayed submissions.
type SubmissionResult struct {
	Task     domain.GenerationTask
	Slots    []domain.GenerationSlot
	Replayed bool
}

// Submit admits one generation task. The frozen specification is always
// derived from the request's generation intent — validated structurally,
// checked against the live capability manifest, and completed with verified
// material facts — inside the admission transaction, and the whole admission
// (attempt fact, governance evaluation, specification, task, slots, job,
// queue item, reservation) commits or rolls back as one. Governance
// rejections commit only the attempt fact. Replays (same key, same payload)
// return the prior task without counting anything a second time.
func (s *TaskService) Submit(ctx context.Context, cmd SubmitCommand) (SubmissionResult, error) {
	key := domain.NormalizeIdempotencyKey(cmd.IdempotencyKey)
	if key == "" {
		return SubmissionResult{}, domain.ErrInvalidIntent
	}
	if cmd.Intent == nil {
		return SubmissionResult{}, domain.ErrIntentNotReady
	}
	if err := cmd.Intent.Validate(); err != nil {
		return SubmissionResult{}, err
	}
	var (
		result  SubmissionResult
		blocked error
	)
	err := s.runner.Run(ctx, func(sc domain.WriteScope) error {
		if _, err := s.tasks.LoadSessionForAdmission(ctx, sc.Tx(), cmd.Owner, cmd.SessionID); err != nil {
			return err
		}

		connection, err := s.connections.GetActiveInTx(ctx, sc.Tx())
		if err != nil && !errors.Is(err, domain.ErrConnectionNotConfigured) {
			return err
		}
		var connectionView *domain.ProviderConnection
		if connection.ID != (domain.UUID{}) {
			connectionView = &connection
		}
		manifest := domain.DeriveCapabilityManifest(connectionView)

		spec, err := freezeSpecification(cmd.Intent, manifest)
		if err != nil {
			return err
		}

		// Idempotent replay: same key and same frozen payload returns the
		// prior task; nothing is counted, reserved, or created again.
		existing, found, err := s.tasks.FindByIdempotencyKey(ctx, sc.Tx(), cmd.Owner, key)
		if err != nil {
			return err
		}
		if found {
			if existing.PayloadHash != spec.PayloadHash() {
				return domain.ErrIdempotencyPayloadConflict
			}
			result.Replayed = true
			result.Task = existing
			return nil
		}

		task, err := s.admitSpecification(ctx, sc, cmd.Owner, cmd.SessionID, spec, key)
		if err != nil {
			// Governance rejections commit the attempt fact they recorded.
			var governanceBlocked *domain.GovernanceBlockedError
			if errors.As(err, &governanceBlocked) {
				blocked = err
				return nil
			}
			return err
		}
		result.Task = *task
		result.Slots = slotsFor(task)
		return nil
	})
	if err != nil {
		return SubmissionResult{}, err
	}
	if blocked != nil {
		return SubmissionResult{}, blocked
	}
	if result.Replayed {
		// The replayed task's slots are read after commit for the response.
		_, slots, err := s.tasks.GetForOwner(ctx, cmd.Owner, result.Task.ID)
		if err != nil {
			return SubmissionResult{}, err
		}
		result.Slots = slots
		return result, nil
	}
	if s.notify != nil {
		s.notify.NotifyGenerationChanged(cmd.Owner)
	}
	return result, nil
}

// admitSpecification runs the shared admission tail for fresh submissions
// and retries: manifest-vs-connection availability, the fixed-order
// governance evaluation, the attempt fact, and the atomic creation of
// specification, task, slots, job, queue item, and reservation.
func (s *TaskService) admitSpecification(ctx context.Context, sc domain.WriteScope, owner, sessionID domain.UUID, spec *domain.GenerationSpecification, idempotencyKey string) (*domain.GenerationTask, error) {
	// Reference identity/role/kind facts are re-verified inside the
	// transaction: a material deleted between draft save and admission
	// fails the whole admission instead of freezing a dangling reference.
	ids := make([]domain.UUID, 0, len(spec.References))
	for _, reference := range spec.References {
		ids = append(ids, reference.MaterialID)
	}
	materials, err := s.materials.LoadMaterialsInSession(ctx, sc.Tx(), owner, sessionID, ids)
	if err != nil {
		return nil, err
	}
	byID := make(map[domain.UUID]domain.ReferenceMaterial, len(materials))
	for _, material := range materials {
		byID[material.ID] = material
	}
	if err := validateSpecificationReferences(spec, byID); err != nil {
		return nil, err
	}

	// Attempt fact first: every structurally valid attempt counts in the
	// rolling window, even one another governance rule then rejects.
	if err := s.tasks.InsertAttempt(ctx, sc.Tx(), owner); err != nil {
		return nil, err
	}

	media := spec.MediaType
	connection, err := s.connections.GetActiveInTx(ctx, sc.Tx())
	if err != nil && !errors.Is(err, domain.ErrConnectionNotConfigured) {
		return nil, err
	}
	var connectionView *domain.ProviderConnection
	if connection.ID != (domain.UUID{}) {
		connectionView = &connection
	}
	manifest := domain.DeriveCapabilityManifest(connectionView)
	if err := mediaAvailability(manifest, media); err != nil {
		return nil, err
	}

	instancePolicy, userPolicies, err := s.governance.LoadPolicies(ctx, sc.Tx())
	if err != nil {
		return nil, err
	}
	var memberPolicy *domain.GovernancePolicy
	if policy, ok := userPolicies[owner]; ok {
		copied := policy
		memberPolicy = &copied
	}
	windowStart := time.Now().Add(-domain.GovernanceRateWindow)
	monthStart, _ := domain.MonthWindowUTC(time.Now())
	snapshot := domain.GovernanceSnapshot{
		CreditBlocked:  connectionView != nil && connectionView.CreditBlockedAt != nil,
		InstancePolicy: instancePolicy,
		MemberPolicy:   memberPolicy,
	}
	if snapshot.InstanceMonthlyCount, err = s.tasks.CountTasksCreatedSince(ctx, sc.Tx(), nil, monthStart); err != nil {
		return nil, err
	}
	if snapshot.MemberMonthlyCount, err = s.tasks.CountTasksCreatedSince(ctx, sc.Tx(), &owner, monthStart); err != nil {
		return nil, err
	}
	if snapshot.InstanceRateCount, err = s.tasks.CountAttemptsSince(ctx, sc.Tx(), nil, windowStart); err != nil {
		return nil, err
	}
	if snapshot.MemberRateCount, err = s.tasks.CountAttemptsSince(ctx, sc.Tx(), &owner, windowStart); err != nil {
		return nil, err
	}
	if snapshot.MemberImageReservations, err = s.tasks.CountActiveReservations(ctx, sc.Tx(), owner, domain.MediaImage); err != nil {
		return nil, err
	}
	if snapshot.MemberVideoReservations, err = s.tasks.CountActiveReservations(ctx, sc.Tx(), owner, domain.MediaVideo); err != nil {
		return nil, err
	}
	if reason := domain.EvaluateGovernance(&snapshot, media); reason != nil {
		return nil, &domain.GovernanceBlockedError{Reason: *reason}
	}

	now := time.Now().UTC()
	task := &domain.GenerationTask{
		ID:             domain.NewUUID(),
		SessionID:      sessionID,
		OwnerID:        owner,
		IdempotencyKey: idempotencyKey,
		PayloadHash:    spec.PayloadHash(),
		Media:          spec.MediaType,
		Spec:           *spec,
		Status:         domain.TaskQueued,
		SlotCount:      spec.Quantity,
	}
	admitted := &domain.AdmittedTask{
		Task:             task,
		Slots:            make([]domain.GenerationSlot, 0, spec.Quantity),
		Job:              &domain.ProviderJob{ID: domain.NewUUID(), TaskID: task.ID, Media: media, Status: domain.JobPending},
		RunAfter:         now,
		ReservationOwner: owner,
		ReservationMedia: media,
	}
	for _, index := range domain.StableSlotOrder(spec.Quantity) {
		admitted.Slots = append(admitted.Slots, domain.GenerationSlot{TaskID: task.ID, Index: index})
	}
	if err := s.tasks.InsertAdmittedTask(ctx, sc.Tx(), admitted); err != nil {
		return nil, err
	}
	return task, nil
}

// RetryUncompleted creates a new task from an original task's frozen
// specification, covering only that task's unfinished slots. The original
// task stays immutable; the new task passes the same governance admission
// with its own key, attempt, month count, and reservation.
func (s *TaskService) RetryUncompleted(ctx context.Context, owner, taskID domain.UUID, idempotencyKey string) (SubmissionResult, error) {
	key := domain.NormalizeIdempotencyKey(idempotencyKey)
	if key == "" {
		return SubmissionResult{}, domain.ErrNoIncompleteSlots
	}
	original, slots, err := s.tasks.GetForOwner(ctx, owner, taskID)
	if err != nil {
		return SubmissionResult{}, err
	}
	if !domain.TaskIsTerminal(original.Status) {
		return SubmissionResult{}, domain.ErrTaskNotTerminal
	}
	incomplete := 0
	for _, slot := range slots {
		if slot.Status == nil || *slot.Status != domain.SlotSucceeded {
			incomplete++
		}
	}
	if incomplete == 0 {
		return SubmissionResult{}, domain.ErrNoIncompleteSlots
	}
	spec := original.Spec
	spec.Quantity = incomplete

	var (
		result  SubmissionResult
		blocked error
	)
	err = s.runner.Run(ctx, func(sc domain.WriteScope) error {
		// Same-key replay returns the prior retried task unchanged.
		existing, found, err := s.tasks.FindByIdempotencyKey(ctx, sc.Tx(), owner, key)
		if err != nil {
			return err
		}
		if found {
			if existing.PayloadHash != spec.PayloadHash() {
				return domain.ErrIdempotencyPayloadConflict
			}
			result.Replayed = true
			result.Task = existing
			return nil
		}
		task, err := s.admitSpecification(ctx, sc, owner, original.SessionID, &spec, key)
		if err != nil {
			var governanceBlocked *domain.GovernanceBlockedError
			if errors.As(err, &governanceBlocked) {
				blocked = err
				return nil
			}
			return err
		}
		result.Task = *task
		result.Slots = slotsFor(task)
		return nil
	})
	if err != nil {
		return SubmissionResult{}, err
	}
	if blocked != nil {
		return SubmissionResult{}, blocked
	}
	if result.Replayed {
		_, retriedSlots, err := s.tasks.GetForOwner(ctx, owner, result.Task.ID)
		if err != nil {
			return SubmissionResult{}, err
		}
		result.Slots = retriedSlots
		return result, nil
	}
	if s.notify != nil {
		s.notify.NotifyGenerationChanged(owner)
	}
	return result, nil
}

// Cancel records the cancel intent and immediately converges work that has
// not started externally. Everything already accepted keeps converging in
// the worker; outputs obtained before the cancel retain.
func (s *TaskService) Cancel(ctx context.Context, owner, taskID domain.UUID) error {
	return s.runner.Run(ctx, func(sc domain.WriteScope) error {
		status, ok, err := s.tasks.RequestCancel(ctx, sc.Tx(), owner, taskID)
		if err != nil {
			return err
		}
		if !ok {
			return domain.ErrTaskNotFound
		}
		if status != domain.TaskQueued {
			// The worker drives cancelling for anything already accepted.
			return nil
		}
		transitioned, err := s.tasks.TransitionTask(ctx, sc.Tx(), taskID,
			[]domain.TaskStatus{domain.TaskQueued}, domain.TaskCancelled, nil)
		if err != nil {
			return err
		}
		if !transitioned {
			// A worker claimed the task between the read and the guarded
			// update; its cancel path converges from the intent marker.
			return nil
		}
		task, slots, job, err := s.tasks.GetForOwnerInTx(ctx, sc.Tx(), owner, taskID)
		if err != nil {
			return err
		}
		if job.ID != (domain.UUID{}) && job.Status == domain.JobPending {
			if _, err := s.tasks.TransitionJob(ctx, sc.Tx(), job.ID,
				[]domain.JobStatus{domain.JobPending}, domain.JobCancelled, nil); err != nil {
				return err
			}
		}
		for _, slot := range slots {
			if slot.Status == nil {
				if _, err := s.tasks.WriteSlotVerdict(ctx, sc.Tx(), task.ID, slot.Index,
					domain.SlotCancelled, nil, nil, nil); err != nil {
					return err
				}
			}
		}
		if _, err := s.tasks.ReleaseReservation(ctx, sc.Tx(), task.ID); err != nil {
			return err
		}
		queueID, _, _, err := s.tasks.GetQueueItemByTask(ctx, sc.Tx(), task.ID)
		if err != nil {
			return err
		}
		if err := s.tasks.RetireQueueItem(ctx, sc.Tx(), queueID); err != nil {
			return err
		}
		_ = task
		if s.notify != nil {
			sc.AfterCommit(func() { s.notify.NotifyGenerationChanged(owner) })
		}
		return nil
	})
}

// List pages one session's tasks for their creator.
func (s *TaskService) List(ctx context.Context, owner, sessionID domain.UUID, cursor *domain.CompoundCursor, limit int) ([]domain.GenerationTask, *domain.CompoundCursor, error) {
	return s.tasks.ListBySession(ctx, owner, sessionID, cursor, limit)
}

// Get resolves one task and its slots for its creator.
func (s *TaskService) Get(ctx context.Context, owner, taskID domain.UUID) (domain.GenerationTask, []domain.GenerationSlot, error) {
	return s.tasks.GetForOwner(ctx, owner, taskID)
}

// freezeSpecification derives the immutable generation intent from the
// submitted intent against the current manifest. Every mismatch blocks
// admission: missing intent is not ready, values outside the manifest are
// stale, and the manifest version must be current.
func freezeSpecification(intent *domain.GenerationIntent, manifest domain.CapabilityManifestView) (*domain.GenerationSpecification, error) {
	if intent == nil {
		return nil, domain.ErrIntentNotReady
	}
	// The prompt envelope counts Unicode characters (spec 图片合同) — the
	// same rune rule the intent gate applies — not bytes.
	promptRunes := utf8.RuneCountInString(intent.Prompt)
	if intent.MediaType == nil || intent.Model == nil || intent.Mode == nil ||
		intent.Prompt == "" || promptRunes > domain.PromptMaxChars {
		return nil, domain.ErrIntentNotReady
	}
	media := *intent.MediaType
	mediaView := manifest.Image
	if media == domain.DraftMediaVideo {
		mediaView = manifest.Video
	}
	if intent.ManifestVersion != manifest.ManifestVersion || !mediaView.Available {
		reason := mediaView.Reason
		if reason == "" {
			reason = "manifest_version_changed"
		}
		return nil, &domain.MediaUnavailableError{Reason: reason, Action: mediaView.Action}
	}
	// Resolution tiers are model-scoped: the intent's model must be a
	// published model and its resolution must be one of that model's tiers.
	modelView := publishedModel(mediaView.Models, *intent.Model)
	if modelView == nil || !valueInList(modelView.Resolutions, intent.Resolution) {
		return nil, domain.ErrCapabilityStale
	}
	modeKnown := false
	var modePolicy *domain.ReferenceMaterialPolicy
	for _, mode := range mediaView.Modes {
		if mode.ID == *intent.Mode {
			modeKnown = true
			policy := mode.ReferenceMaterial
			modePolicy = &policy
			break
		}
	}
	if !modeKnown {
		return nil, domain.ErrCapabilityStale
	}
	spec := &domain.GenerationSpecification{
		SchemaVersion:   domain.SpecificationSchemaVersion,
		MediaType:       domain.MediaType(media),
		Prompt:          intent.Prompt,
		Model:           *intent.Model,
		Mode:            *intent.Mode,
		ManifestVersion: manifest.ManifestVersion,
		References:      make([]domain.SpecificationReference, 0, len(intent.References)),
	}
	if media == domain.DraftMediaImage {
		if !valueInList(mediaView.Ratios, intent.Ratio) {
			return nil, domain.ErrCapabilityStale
		}
		if intent.Quantity == nil || !intInList(mediaView.Quantities, *intent.Quantity) {
			return nil, domain.ErrCapabilityStale
		}
		spec.Ratio = intent.Ratio
		spec.Resolution = intent.Resolution
		spec.Quantity = *intent.Quantity
	} else {
		if intent.DurationSeconds == nil || !intInList(mediaView.Durations, *intent.DurationSeconds) {
			return nil, domain.ErrCapabilityStale
		}
		spec.Resolution = intent.Resolution
		spec.DurationSeconds = intent.DurationSeconds
		spec.Quantity = 1
	}
	// Mode policy shapes the reference envelope: count first, then the
	// per-kind facts (validated against material rows by the caller).
	if modePolicy == nil {
		return nil, domain.ErrCapabilityStale
	}
	// The mode total is the widest cross-model bound; the selected image
	// model's published ceiling is the binding one (pro 10, base 14).
	maxReferences := modePolicy.Total.Max
	if modelView.MaxReferenceImages != nil && *modelView.MaxReferenceImages < maxReferences {
		maxReferences = *modelView.MaxReferenceImages
	}
	count := len(intent.References)
	if count < modePolicy.Total.Min || count > maxReferences {
		return nil, domain.ErrCapabilityStale
	}
	for _, reference := range intent.References {
		spec.References = append(spec.References, domain.SpecificationReference{
			MaterialID: reference.MaterialID,
			Role:       reference.Role,
		})
	}
	return spec, nil
}

// validateSpecificationReferences completes the frozen references with the
// verified kind and claims version from the material rows and checks each
// reference against the mode's per-kind envelope.
func validateSpecificationReferences(spec *domain.GenerationSpecification, byID map[domain.UUID]domain.ReferenceMaterial) error {
	for i := range spec.References {
		reference := &spec.References[i]
		material, ok := byID[reference.MaterialID]
		if !ok {
			// A reference to a material outside this session never freezes.
			return domain.ErrInvalidIntent
		}
		if !reference.Role.AcceptsKind(material.Kind) {
			return domain.ErrInvalidIntent
		}
		reference.Kind = material.Kind
		reference.ClaimsVersion = material.ClaimsVersion
		if err := referenceWithinEnvelope(spec, reference, material); err != nil {
			return err
		}
	}
	return nil
}

// referenceWithinEnvelope checks one material's recorded facts against the
// media's published reference envelope. The envelope numbers come from the
// manifest constants, not the request, so a stale composer cannot smuggle an
// out-of-envelope material past admission.
func referenceWithinEnvelope(spec *domain.GenerationSpecification, reference *domain.SpecificationReference, material domain.ReferenceMaterial) error {
	envelope := domain.MediaReferenceEnvelope(spec.MediaType)
	if envelope.PerMedia == nil {
		return domain.ErrCapabilityStale
	}
	var maxBytes int64
	switch reference.Kind {
	case domain.KindImage:
		if envelope.PerMedia.Image == nil {
			return domain.ErrCapabilityStale
		}
		maxBytes = int64(envelope.PerMedia.Image.MaxBytes)
	case domain.KindVideo:
		if envelope.PerMedia.Video == nil {
			return domain.ErrCapabilityStale
		}
		maxBytes = int64(envelope.PerMedia.Video.MaxBytes)
	case domain.KindAudio:
		if envelope.PerMedia.Audio == nil {
			return domain.ErrCapabilityStale
		}
		maxBytes = int64(envelope.PerMedia.Audio.MaxBytes)
	default:
		return domain.ErrInvalidIntent
	}
	if material.ByteSize > maxBytes {
		return domain.ErrCapabilityStale
	}
	return nil
}

// mediaAvailability projects the manifest's unavailability onto the
// admission error with the same stable reason the Workbench displays.
func mediaAvailability(manifest domain.CapabilityManifestView, media domain.MediaType) error {
	view := manifest.Image
	if media == domain.MediaVideo {
		view = manifest.Video
	}
	if view.Available {
		return nil
	}
	return &domain.MediaUnavailableError{Reason: view.Reason, Action: view.Action}
}

// publishedModel returns the media's published model entry for one model ID,
// or nil when the model is not currently submittable.
func publishedModel(models []domain.CapabilityModelView, model string) *domain.CapabilityModelView {
	for index := range models {
		if models[index].Model == model {
			return &models[index]
		}
	}
	return nil
}

func valueInList(values []string, value *string) bool {
	if value == nil {
		return false
	}
	for _, candidate := range values {
		if candidate == *value {
			return true
		}
	}
	return false
}

func intInList(values []int, value int) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func slotsFor(task *domain.GenerationTask) []domain.GenerationSlot {
	slots := make([]domain.GenerationSlot, 0, task.SlotCount)
	for _, index := range domain.StableSlotOrder(task.SlotCount) {
		slots = append(slots, domain.GenerationSlot{TaskID: task.ID, Index: index})
	}
	return slots
}
