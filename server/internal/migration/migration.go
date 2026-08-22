// Package migration owns the Server's versioned, up-only schema migrations:
// the embedded SQL files under migrations/, the schema_migrations bookkeeping
// table, and the startup application path. One migration file runs in exactly
// one transaction and is recorded with its version on commit; there is no down
// path (ADR-0013: upgrades pull a new image and restart, migrations run
// automatically at startup). The caller supplies a DDL-capable database URL —
// the application's runtime pool (identity_app) must never own DDL
// (ADR-0014).
package migration

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// advisoryLockKey serializes concurrent servers migrating the same cluster
// (compose restarts overlap; docker exec runs race the server). Any fixed
// constant works as long as it never changes.
const advisoryLockKey = 0x6E767831 // "nvx1"

// Migration is one embedded, versioned SQL file.
type Migration struct {
	Version int64
	Name    string
	SQL     string
}

// Available returns every embedded migration in version order. The filenames
// are the versioning discipline: exactly `<version>_<name>.sql`.
func Available() ([]Migration, error) {
	entries, err := fs.Glob(migrationFS, "migrations/*.sql")
	if err != nil {
		return nil, fmt.Errorf("migration: list embedded migrations: %w", err)
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("migration: no embedded migrations found")
	}
	migrations := make([]Migration, 0, len(entries))
	for _, entry := range entries {
		fileName := strings.TrimPrefix(strings.TrimSuffix(entry, ".sql"), "migrations/")
		versionText, name, found := strings.Cut(fileName, "_")
		if !found {
			return nil, fmt.Errorf("migration: %q must be named <version>_<name>.sql", fileName)
		}
		version, err := strconv.ParseInt(versionText, 10, 64)
		if err != nil || version < 1 {
			return nil, fmt.Errorf("migration: %q has a non-numeric or non-positive version %q", fileName, versionText)
		}
		sql, err := migrationFS.ReadFile(entry)
		if err != nil {
			return nil, fmt.Errorf("migration: read %q: %w", entry, err)
		}
		migrations = append(migrations, Migration{Version: version, Name: name, SQL: string(sql)})
	}
	sort.Slice(migrations, func(i, j int) bool { return migrations[i].Version < migrations[j].Version })
	for index := 1; index < len(migrations); index++ {
		if migrations[index].Version == migrations[index-1].Version {
			return nil, fmt.Errorf("migration: duplicate version %d", migrations[index].Version)
		}
	}
	return migrations, nil
}

// Apply connects to databaseURL, takes the migration advisory lock, and brings
// the cluster up to the newest embedded version, returning the migrations it
// applied on this call (nil when already current). Each pending migration runs
// in its own transaction together with its bookkeeping row, so a failed file
// leaves earlier migrations applied and itself unrecorded.
func Apply(ctx context.Context, databaseURL string) ([]Migration, error) {
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("migration: connect: %w", err)
	}
	defer conn.Close(context.WithoutCancel(ctx))

	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", advisoryLockKey); err != nil {
		return nil, fmt.Errorf("migration: acquire advisory lock: %w", err)
	}
	defer conn.Exec(context.WithoutCancel(ctx), "SELECT pg_advisory_unlock($1)", advisoryLockKey)

	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS public.schema_migrations (
		version    bigint                     NOT NULL,
		name       text                       NOT NULL,
		applied_at timestamp with time zone NOT NULL DEFAULT now(),
		CONSTRAINT schema_migrations_pkey PRIMARY KEY (version)
	)`); err != nil {
		return nil, fmt.Errorf("migration: ensure schema_migrations: %w", err)
	}

	applied, err := appliedVersions(ctx, conn)
	if err != nil {
		return nil, err
	}

	available, err := Available()
	if err != nil {
		return nil, err
	}

	ran := []Migration{}
	for _, m := range available {
		if applied[m.Version] {
			continue
		}
		tx, err := conn.Begin(ctx)
		if err != nil {
			return nil, fmt.Errorf("migration %d (%s): begin: %w", m.Version, m.Name, err)
		}
		if _, err := tx.Exec(ctx, m.SQL); err != nil {
			return nil, rollbackMigration(ctx, tx, m, err)
		}
		if _, err := tx.Exec(ctx, "INSERT INTO public.schema_migrations (version, name) VALUES ($1, $2)", m.Version, m.Name); err != nil {
			return nil, rollbackMigration(ctx, tx, m, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, fmt.Errorf("migration %d (%s): commit: %w", m.Version, m.Name, err)
		}
		ran = append(ran, m)
	}
	return ran, nil
}

// appliedVersions reads the bookkeeping table. A recorded version that no
// longer exists on disk is an error: the embedded set must only grow.
func appliedVersions(ctx context.Context, conn *pgx.Conn) (map[int64]bool, error) {
	rows, err := conn.Query(ctx, "SELECT version FROM public.schema_migrations")
	if err != nil {
		return nil, fmt.Errorf("migration: read schema_migrations: %w", err)
	}
	defer rows.Close()
	applied := map[int64]bool{}
	for rows.Next() {
		var version int64
		if err := rows.Scan(&version); err != nil {
			return nil, fmt.Errorf("migration: scan schema_migrations row: %w", err)
		}
		applied[version] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("migration: iterate schema_migrations: %w", err)
	}

	available, err := Available()
	if err != nil {
		return nil, err
	}
	known := map[int64]bool{}
	for _, m := range available {
		known[m.Version] = true
	}
	for version := range applied {
		if !known[version] {
			return nil, fmt.Errorf("migration: database records version %d, which is not embedded; the embedded set must only grow", version)
		}
	}
	return applied, nil
}

func rollbackMigration(ctx context.Context, tx pgx.Tx, m Migration, cause error) error {
	if err := tx.Rollback(context.WithoutCancel(ctx)); err != nil {
		return fmt.Errorf("migration %d (%s): %w; rollback also failed: %w", m.Version, m.Name, cause, err)
	}
	return fmt.Errorf("migration %d (%s): %w", m.Version, m.Name, cause)
}
