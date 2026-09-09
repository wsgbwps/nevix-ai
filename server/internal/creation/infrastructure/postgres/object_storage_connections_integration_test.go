package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/creation/domain"
	"github.com/nevix-ai/server/internal/creation/infrastructure/writetx"
	"github.com/nevix-ai/server/internal/migration"
)

func TestObjectStorageConnectionSingletonAndMonotonicRevision(t *testing.T) {
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
	if _, err := owner.Exec(ctx, `TRUNCATE public.object_storage_connections`); err != nil {
		t.Fatalf("reset table: %v", err)
	}

	repo := NewObjectStorageConnectionRepository(pool)
	runner := writetx.New(pool)
	creator := fixtureUser(t, ownerURL)
	t.Cleanup(func() {
		cleanupPool, err := pgxpool.New(context.Background(), ownerURL)
		if err != nil {
			t.Errorf("open object storage cleanup pool: %v", err)
			return
		}
		defer cleanupPool.Close()
		if _, err := cleanupPool.Exec(context.Background(), `TRUNCATE public.object_storage_connections`); err != nil {
			t.Errorf("cleanup object storage connections: %v", err)
		}
	})

	first := objectStorageConnectionFixture(creator)
	if err := runner.Run(ctx, func(sc domain.WriteScope) error {
		return repo.Insert(ctx, sc.Tx(), first)
	}); err != nil {
		t.Fatalf("insert first connection: %v", err)
	}
	if first.Revision < 1 {
		t.Fatalf("first revision = %d", first.Revision)
	}

	second := objectStorageConnectionFixture(creator)
	err = runner.Run(ctx, func(sc domain.WriteScope) error {
		return repo.Insert(ctx, sc.Tx(), second)
	})
	if !errors.Is(err, domain.ErrObjectStorageConnectionExists) {
		t.Fatalf("second active insert error = %v", err)
	}

	if err := runner.Run(ctx, func(sc domain.WriteScope) error {
		_, err := sc.Tx().Exec(ctx, `
			UPDATE object_storage_connections SET
				envelope_version = NULL, credential_key_id = NULL,
				credential_nonce = NULL, credential_ciphertext = NULL,
				terminated_at = now()
			WHERE id = $1`, first.ID)
		return err
	}); err != nil {
		t.Fatalf("terminate fixture: %v", err)
	}

	third := objectStorageConnectionFixture(creator)
	if err := runner.Run(ctx, func(sc domain.WriteScope) error {
		return repo.Insert(ctx, sc.Tx(), third)
	}); err != nil {
		t.Fatalf("insert after termination: %v", err)
	}
	if third.Revision <= first.Revision {
		t.Fatalf("revision reused or moved backwards: first=%d third=%d", first.Revision, third.Revision)
	}

	loaded, err := repo.GetActive(ctx)
	if err != nil {
		t.Fatalf("get active: %v", err)
	}
	if loaded.ID != third.ID || loaded.State != domain.ObjectStorageStateReady || loaded.AccessKeyIDMasked != "****1234" {
		t.Fatalf("loaded connection = %+v", loaded)
	}
}

func objectStorageConnectionFixture(creator domain.UUID) *domain.ObjectStorageConnection {
	return &domain.ObjectStorageConnection{
		ID: domain.NewUUID(),
		ObjectStorageLocation: domain.ObjectStorageLocation{
			Provider: domain.ObjectStorageProviderOSS,
			Region:   "cn-hangzhou",
			Bucket:   "nevix-private",
		},
		State: domain.ObjectStorageStateReady,
		Envelope: &domain.ObjectStorageCredentialEnvelope{
			Version: 1, KeyID: "test-key", Nonce: []byte("123456789012"), Ciphertext: []byte("ciphertext"),
		},
		AccessKeyIDMasked: "****1234",
		LastCheckedAt:     time.Now().UTC(),
		LastCheckOutcome:  domain.CheckOutcomeCompleted,
		CreatedByUserID:   creator,
	}
}
