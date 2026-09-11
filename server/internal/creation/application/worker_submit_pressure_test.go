package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

type submitMarkerErrorConnections struct {
	connection domain.ProviderConnection
}

func (c submitMarkerErrorConnections) GetActive(context.Context) (domain.ProviderConnection, error) {
	return c.connection, nil
}

func (submitMarkerErrorConnections) GetActiveInTx(context.Context, domain.TxExecutor) (domain.ProviderConnection, error) {
	return domain.ProviderConnection{}, nil
}

func (submitMarkerErrorConnections) MarkCreditBlocked(context.Context, domain.TxExecutor) error {
	return nil
}

func (submitMarkerErrorConnections) ClearCreditBlocked(context.Context, domain.TxExecutor) error {
	return nil
}

type submitMarkerErrorCredential struct{}

func (submitMarkerErrorCredential) ActiveCallCredential(context.Context) (string, error) {
	return "credential", nil
}

type submitMarkerErrorGateway struct {
	prepareCalls int
	releaseCalls int
	submitCalls  int
}

func (g *submitMarkerErrorGateway) PrepareReferences(context.Context, domain.UUID, domain.SubmitRequest) (domain.PreparedSubmitRequest, error) {
	g.prepareCalls++
	return domain.PreparedSubmitRequest{}, nil
}

func (g *submitMarkerErrorGateway) ReleaseReference(context.Context, domain.UUID, int) error {
	g.releaseCalls++
	return nil
}

func (g *submitMarkerErrorGateway) Submit(context.Context, string, domain.PreparedSubmitRequest) (domain.SubmitOutcome, error) {
	g.submitCalls++
	return domain.SubmitOutcome{}, nil
}

func (*submitMarkerErrorGateway) Poll(context.Context, string, string) (domain.PollOutcome, error) {
	return domain.PollOutcome{}, nil
}

func (*submitMarkerErrorGateway) Cancel(context.Context, string, string) error { return nil }

type submitMarkerErrorRunner struct{ err error }

func (r submitMarkerErrorRunner) Run(context.Context, func(domain.WriteScope) error) error {
	return r.err
}

func TestSubmitRetryHoldPreservesProviderPressureClass(t *testing.T) {
	tests := []struct {
		name      string
		pressure  domain.SubmitRetryPressure
		wantDelay time.Duration
	}{
		{name: "confirmed unsent", wantDelay: domain.BackoffLadder(0)},
		{name: "safe 429", pressure: domain.SubmitRetryBackoff, wantDelay: domain.BackoffLadder(0)},
		{name: "safe 503", pressure: domain.SubmitRetryCooldown, wantDelay: domain.CooldownLadder(0)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			worker := &TaskWorker{}
			retryable := &domain.SubmitRetryableError{
				Reason: domain.ReasonProviderRouteUnavailable, Pressure: tt.pressure,
			}
			started := time.Now()
			until := worker.submitRetryHoldUntil("connection:image", domain.MediaImage, retryable)
			delay := until.Sub(started)
			if delay < tt.wantDelay-time.Second || delay > tt.wantDelay+time.Second {
				t.Fatalf("retry delay = %s, want about %s", delay, tt.wantDelay)
			}
		})
	}
}

func TestSafeRetryKeepsPreparedRequestWhenMarkerTransactionFails(t *testing.T) {
	markerErr := errors.New("marker transaction failed")
	connectionID := domain.NewUUID()
	jobID := domain.NewUUID()
	prepared := domain.PreparedSubmitRequest{
		Media: domain.MediaImage,
		References: []domain.GatewayReference{{
			Role: domain.RoleReference, Kind: domain.KindImage,
			URL: "https://provider-transfer.example/reference", ExpiresAt: time.Now().Add(time.Hour),
		}},
	}
	gateway := &submitMarkerErrorGateway{}
	worker := &TaskWorker{
		connections: submitMarkerErrorConnections{connection: domain.ProviderConnection{
			ID: connectionID, AdminState: domain.AdminStateEnabled,
		}},
		credentials: submitMarkerErrorCredential{},
		gateway:     gateway,
		runner:      submitMarkerErrorRunner{err: markerErr},
		prepared:    map[domain.UUID]domain.PreparedSubmitRequest{jobID: prepared},
	}
	outcome := domain.JobOutcomeTransientRejected
	job := domain.ProviderJob{
		ID: jobID, Status: domain.JobSubmitting, Outcome: &outcome, SubmitAttempts: 1,
	}
	task := domain.GenerationTask{
		ID: domain.NewUUID(),
		Spec: domain.GenerationSpecification{
			MediaType:  domain.MediaImage,
			References: []domain.SpecificationReference{{MaterialID: domain.NewUUID()}},
		},
	}
	state := kernelState(task, job)

	err := worker.driveSubmit(context.Background(), domain.NewUUID(), task, job, state, domain.MediaImage)
	if !errors.Is(err, markerErr) {
		t.Fatalf("driveSubmit error = %v, want marker transaction error", err)
	}
	retained, ok := worker.prepared[jobID]
	if !ok || len(retained.References) != 1 || retained.References[0].URL != prepared.References[0].URL {
		t.Fatalf("safe retry lost its prepared request: %+v", retained)
	}
	if gateway.prepareCalls != 0 || gateway.releaseCalls != 0 || gateway.submitCalls != 0 {
		t.Fatalf("gateway calls = prepare %d, release %d, submit %d; want all zero", gateway.prepareCalls, gateway.releaseCalls, gateway.submitCalls)
	}
}

func TestFreshSubmitCleansPreparedRequestWhenMarkerTransactionFails(t *testing.T) {
	markerErr := errors.New("marker transaction failed")
	connectionID := domain.NewUUID()
	jobID := domain.NewUUID()
	gateway := &submitMarkerErrorGateway{}
	worker := &TaskWorker{
		connections: submitMarkerErrorConnections{connection: domain.ProviderConnection{
			ID: connectionID, AdminState: domain.AdminStateEnabled,
		}},
		credentials: submitMarkerErrorCredential{},
		gateway:     gateway,
		runner:      submitMarkerErrorRunner{err: markerErr},
		prepared: map[domain.UUID]domain.PreparedSubmitRequest{
			jobID: {Media: domain.MediaImage},
		},
	}
	job := domain.ProviderJob{ID: jobID, Status: domain.JobPending}
	task := domain.GenerationTask{
		ID: domain.NewUUID(),
		Spec: domain.GenerationSpecification{
			MediaType:  domain.MediaImage,
			References: []domain.SpecificationReference{{MaterialID: domain.NewUUID()}},
		},
	}

	err := worker.driveSubmit(context.Background(), domain.NewUUID(), task, job, kernelState(task, job), domain.MediaImage)
	if !errors.Is(err, markerErr) {
		t.Fatalf("driveSubmit error = %v, want marker transaction error", err)
	}
	if _, ok := worker.prepared[jobID]; ok {
		t.Fatal("fresh submit retained its prepared request after marker transaction failure")
	}
	if gateway.prepareCalls != 0 || gateway.releaseCalls != 1 || gateway.submitCalls != 0 {
		t.Fatalf("gateway calls = prepare %d, release %d, submit %d; want 0/1/0", gateway.prepareCalls, gateway.releaseCalls, gateway.submitCalls)
	}
}

func TestSafeRetryRepreparesAfterWorkerCacheLoss(t *testing.T) {
	markerErr := errors.New("marker transaction failed")
	connectionID := domain.NewUUID()
	jobID := domain.NewUUID()
	gateway := &submitMarkerErrorGateway{}
	worker := &TaskWorker{
		connections: submitMarkerErrorConnections{connection: domain.ProviderConnection{
			ID: connectionID, AdminState: domain.AdminStateEnabled,
		}},
		credentials: submitMarkerErrorCredential{},
		gateway:     gateway,
		runner:      submitMarkerErrorRunner{err: markerErr},
		prepared:    make(map[domain.UUID]domain.PreparedSubmitRequest),
	}
	outcome := domain.JobOutcomeTransientRejected
	job := domain.ProviderJob{
		ID: jobID, Status: domain.JobSubmitting, Outcome: &outcome, SubmitAttempts: 1,
	}
	task := domain.GenerationTask{
		ID: domain.NewUUID(),
		Spec: domain.GenerationSpecification{
			MediaType: domain.MediaImage, Model: domain.ImageModelID, Quantity: 1,
		},
	}

	err := worker.driveSubmit(context.Background(), domain.NewUUID(), task, job, kernelState(task, job), domain.MediaImage)
	if !errors.Is(err, markerErr) {
		t.Fatalf("driveSubmit error = %v, want marker transaction error", err)
	}
	if _, ok := worker.prepared[jobID]; !ok {
		t.Fatal("safe retry did not rebuild its process-local prepared request")
	}
	if gateway.prepareCalls != 1 || gateway.releaseCalls != 0 || gateway.submitCalls != 0 {
		t.Fatalf("gateway calls = prepare %d, release %d, submit %d; want 1/0/0", gateway.prepareCalls, gateway.releaseCalls, gateway.submitCalls)
	}
}
