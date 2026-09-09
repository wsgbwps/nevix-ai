package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/creation/domain"
	"github.com/nevix-ai/server/internal/creation/infrastructure/writetx"
	"github.com/nevix-ai/server/internal/migration"
)

// Package-local real-database coverage for the provider connection SQL
// responsibilities (spec #150): the partial unique singleton index is the
// durable backstop for concurrent creates, and active/terminated envelope
// presence follows the CHECK. Runs only under the dedicated Creation
// integration harness (scripts/test-creation-integration.sh); ordinary runs
// skip, requested runs fail loudly on a missing environment.

func requireIntegrationEnv(t *testing.T) (ownerURL, runtimeURL string) {
	t.Helper()
	if os.Getenv("NEVIX_CREATION_INTEGRATION_REQUESTED") != "1" {
		t.Skip("skipping: dedicated Creation integration run not requested")
	}
	ownerURL = os.Getenv("NEVIX_DATABASE_URL")
	runtimeURL = os.Getenv("NEVIX_IDENTITY_DATABASE_URL")
	if ownerURL == "" || runtimeURL == "" {
		t.Fatal("requested Creation integration is missing NEVIX_DATABASE_URL / NEVIX_IDENTITY_DATABASE_URL")
	}
	return ownerURL, runtimeURL
}

func TestProviderConnectionSingletonConstraintRejectsSecondActiveRow(t *testing.T) {
	ownerURL, runtimeURL := requireIntegrationEnv(t)
	ctx := context.Background()
	if _, err := migration.Apply(ctx, ownerURL); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	pool, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatalf("connect identity_app pool: %v", err)
	}
	defer pool.Close()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect owner pool: %v", err)
	}
	defer owner.Close()
	if _, err := owner.Exec(ctx, `TRUNCATE public.provider_connections`); err != nil {
		t.Fatalf("reset table: %v", err)
	}

	repo := NewConnectionRepository(pool)
	runner := writetx.New(pool)
	creator := fixtureUser(t, ownerURL)

	first := activeConnection(domain.NewUUID(), creator)
	if err := runner.Run(ctx, func(sc domain.WriteScope) error {
		return repo.Insert(ctx, sc.Tx(), first)
	}); err != nil {
		t.Fatalf("insert first active connection: %v", err)
	}

	second := activeConnection(domain.NewUUID(), creator)
	err = runner.Run(ctx, func(sc domain.WriteScope) error {
		return repo.Insert(ctx, sc.Tx(), second)
	})
	if !errors.Is(err, domain.ErrConnectionExists) {
		t.Fatalf("second active insert error = %v, want ErrConnectionExists", err)
	}

	// Termination releases the slot: a fresh identity fits again.
	if err := runner.Run(ctx, func(sc domain.WriteScope) error {
		return repo.Terminate(ctx, sc.Tx(), first.ID)
	}); err != nil {
		t.Fatalf("terminate: %v", err)
	}
	third := activeConnection(domain.NewUUID(), creator)
	if err := runner.Run(ctx, func(sc domain.WriteScope) error {
		return repo.Insert(ctx, sc.Tx(), third)
	}); err != nil {
		t.Fatalf("insert after termination: %v", err)
	}
	newEnvelope := &domain.ProviderCredentialEnvelope{Version: 1, KeyID: "replacement-key", Nonce: []byte("abcdefghijkl"), Ciphertext: []byte("replacement")}
	if err := runner.Run(ctx, func(sc domain.WriteScope) error {
		return repo.ReplaceCredential(ctx, sc.Tx(), third.ID, newEnvelope,
			domain.CredentialStateValid, domain.MediaCapabilityAvailable, domain.MediaCapabilityAvailable,
			time.Now().UTC(), domain.CheckOutcomeCompleted)
	}); err != nil {
		t.Fatalf("replace credential: %v", err)
	}
	var staleMarked bool
	if err := runner.Run(ctx, func(sc domain.WriteScope) error {
		var err error
		staleMarked, err = repo.MarkCredentialUnavailableIfKeyID(ctx, sc.Tx(), third.ID, "test-key")
		return err
	}); err != nil {
		t.Fatalf("stale fail-closed CAS: %v", err)
	}
	if staleMarked {
		t.Fatal("stale key id marked the replacement credential unavailable")
	}
	loaded, err := repo.GetActive(ctx)
	if err != nil {
		t.Fatalf("get replacement connection: %v", err)
	}
	if loaded.CredentialState != domain.CredentialStateValid || loaded.Envelope == nil || loaded.Envelope.KeyID != "replacement-key" {
		t.Fatalf("replacement connection changed by stale fail-closed CAS: %+v", loaded)
	}

	// The database CHECK itself rejects an active row without its envelope.
	_, err = owner.Exec(ctx, `
		UPDATE public.provider_connections SET credential_ciphertext = NULL WHERE id = $1`, third.ID.String())
	if err == nil {
		t.Fatal("database accepted an active connection without ciphertext")
	}
}

// fixtureUser inserts one user row the connection's created_by FK can point
// at (owner credential: fixtures only, ADR-0014). The fixture owns its
// connections: cleanups run after the test's deferred pools close.
func fixtureUser(t *testing.T, ownerURL string) domain.UUID {
	t.Helper()
	ctx := context.Background()
	id := domain.NewUUID()
	email := "connection-fixture-" + id.String() + "@nevix.test"
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("open fixture pool: %v", err)
	}
	defer owner.Close()
	_, err = owner.Exec(ctx, `
		INSERT INTO public.users (id, email, password_hash, display_name, role, status)
		VALUES ($1, $2, 'x', 'connection-fixture', 'member', 'active')`,
		id, email)
	if err != nil {
		t.Fatalf("insert fixture user: %v", err)
	}
	// The integrationtest package's Instance Claim requires an empty users
	// table; package binaries run serialized, so removing the fixture here
	// restores that precondition for every later suite. Cleanups run after
	// the test's deferred pool closes, so this owns its fresh connection.
	t.Cleanup(func() {
		cleanupPool, err := pgxpool.New(context.Background(), ownerURL)
		if err != nil {
			t.Fatalf("open cleanup pool: %v", err)
		}
		defer cleanupPool.Close()
		if _, err := cleanupPool.Exec(context.Background(), `TRUNCATE public.provider_connections`); err != nil {
			t.Fatalf("cleanup provider connections: %v", err)
		}
		if _, err := cleanupPool.Exec(context.Background(), `DELETE FROM public.users WHERE id = $1`, id); err != nil {
			t.Fatalf("cleanup fixture user: %v", err)
		}
	})
	return id
}

// activeConnection builds one minimal valid active aggregate for SQL tests.
func activeConnection(id, creator domain.UUID) *domain.ProviderConnection {
	checkedAt := time.Now().UTC()
	completed := domain.CheckOutcomeCompleted
	return &domain.ProviderConnection{
		ID:               id,
		AdminState:       domain.AdminStateEnabled,
		CredentialState:  domain.CredentialStateValid,
		ImageCapability:  domain.MediaCapabilityAvailable,
		VideoCapability:  domain.MediaCapabilityAvailable,
		Envelope:         &domain.ProviderCredentialEnvelope{Version: 1, KeyID: "test-key", Nonce: []byte("123456789012"), Ciphertext: []byte("ciphertext")},
		LastCheckedAt:    &checkedAt,
		LastCheckOutcome: &completed,
		CreatedByUserID:  creator,
	}
}
