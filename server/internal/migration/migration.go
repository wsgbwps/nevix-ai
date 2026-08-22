// Package migration embeds the database migrations and applies them at
// server startup. It is a narrow adapter over Goose in library mode: Goose
// owns version resolution, execution order, per-migration transactions, and
// the goose_db_version ledger; this package owns only the embedded SQL set
// and the startup entry point. Migrations run with the DDL credential
// (MIGRATION_DATABASE_URL) before any application pool, Module, or listener
// exists (ADR-0013/0014); the application's identity_app credential never
// receives DDL.
package migration

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"

	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"

	// The pgx stdlib driver backs the *sql.DB Goose runs on.
	_ "github.com/jackc/pgx/v5/stdlib"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Apply connects to databaseURL with the migration credential and brings the
// cluster up to the newest embedded version, returning the migrations Goose
// applied on this call (nil when already current). A failing migration is
// rolled back by Goose and left unrecorded, so the caller must not start the
// HTTP listener on error.
func Apply(ctx context.Context, databaseURL string) ([]*goose.MigrationResult, error) {
	return applyFS(ctx, databaseURL, migrationFS)
}

// applyFS runs the same production startup path against an arbitrary
// migration filesystem whose SQL files live under migrations/, exactly like
// the embedded set; it exists so package tests can prove first-apply,
// no-op, rollback, and concurrency behavior with controlled migration sets.
func applyFS(ctx context.Context, databaseURL string, source fs.FS) ([]*goose.MigrationResult, error) {
	// Goose discovers migrations at the root of the filesystem it is given,
	// so hand it the migrations subdirectory rather than the package root.
	migrations, err := fs.Sub(source, "migrations")
	if err != nil {
		return nil, fmt.Errorf("migration: open migrations directory: %w", err)
	}
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("migration: open database: %w", err)
	}
	defer db.Close()

	// The session-level advisory lock serializes concurrent servers starting
	// against the same cluster (compose restarts overlap). Goose acquires and
	// releases it on one pinned connection around the whole run.
	sessionLocker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return nil, fmt.Errorf("migration: build session locker: %w", err)
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations, goose.WithSessionLocker(sessionLocker))
	if err != nil {
		return nil, fmt.Errorf("migration: build provider: %w", err)
	}

	applied, err := provider.Up(ctx)
	if err != nil {
		return nil, fmt.Errorf("migration: apply: %w", err)
	}
	return applied, nil
}
