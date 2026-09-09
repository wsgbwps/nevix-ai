package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/migration"
)

func TestSessionGetInTxLocksAgainstConcurrentSoftDelete(t *testing.T) {
	ownerURL, runtimeURL := requireIntegrationEnv(t)
	ctx := context.Background()
	if _, err := migration.Apply(ctx, ownerURL); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	runtime, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatalf("connect identity_app pool: %v", err)
	}
	defer runtime.Close()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect owner pool: %v", err)
	}
	defer owner.Close()

	creator := fixtureUser(t, ownerURL)
	sessionID := fixtureSession(t, ownerURL, owner, creator)
	tx, err := runtime.Begin(ctx)
	if err != nil {
		t.Fatalf("begin material transaction: %v", err)
	}
	defer tx.Rollback(ctx)
	if _, err := NewSessionRepository(runtime).GetInTx(ctx, tx, creator, sessionID); err != nil {
		t.Fatalf("lock active session: %v", err)
	}

	updater, err := owner.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire delete connection: %v", err)
	}
	defer updater.Release()
	if _, err := updater.Exec(ctx, `SET lock_timeout = '100ms'`); err != nil {
		t.Fatalf("set delete barrier timeout: %v", err)
	}
	_, err = updater.Exec(ctx, `UPDATE creation_sessions SET deleted_at = now() WHERE id = $1`, sessionID)
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) || postgresError.Code != "55P03" {
		t.Fatalf("concurrent soft delete error=%v, want lock_not_available", err)
	}

	if err := tx.Rollback(ctx); err != nil {
		t.Fatalf("release material transaction: %v", err)
	}
	if _, err := updater.Exec(ctx, `SET lock_timeout = '1s'`); err != nil {
		t.Fatalf("restore delete timeout: %v", err)
	}
	deleteCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	if _, err := updater.Exec(deleteCtx, `UPDATE creation_sessions SET deleted_at = now() WHERE id = $1`, sessionID); err != nil {
		t.Fatalf("soft delete after finalize lock released: %v", err)
	}
}
