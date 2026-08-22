# Plan: migrate the migration runner to Goose (issue #108, parent spec #99)

High-risk category: persistent data / migrations. Frozen boundaries: ADR-0013
(up-only versioned migrations, auto-apply at startup, no down), ADR-0014/0015
(`identity_app` least privilege; DDL belongs to the migration credential).

## Boundary declaration

- Acceptance boundary: production startup path (`cmd/server` →
  `migration.Apply`) and the migration package's public contract, observed
  against a real PostgreSQL (HTTP-visible behavior is unchanged).
- Fixed point: `main` @ 2b8ffcb.
- Primary Domain: Server / identity storage baseline (issue #108).
- Task-owned paths (new or rewritten; tracked paths for /code-review):
  - `server/internal/migration/` (shared area; adapter + tests + SQL)
  - `server/cmd/server/main.go` (logging of applied migrations only)
  - `scripts/test-identity-integration.sh` (runs the migration tree too)
  - `server/go.mod`, `server/go.sum`
  - `server/internal/identity/integrationtest/{harness_test.go,migration_integration_test.go,legacy_upgrade_test.go}` (return-type adaptation + deleted self-built-engine test)

## Design

1. Pin `github.com/pressly/goose/v3 v3.27.3`, library mode only. No Goose CLI
   in any image/start path; SQL stays in `embed.FS`.
2. `server/internal/migration` becomes a thin adapter:
   - `Apply(ctx, databaseURL) ([]*goose.MigrationResult, error)`:
     opens `*sql.DB` via pgx stdlib driver, builds
     `goose.NewProvider(goose.DialectPostgres, db, embeddedFS,
     goose.WithSessionLocker(postgres session locker))`, runs `provider.Up`,
     closes the DB. Version resolution, ordering, per-file transactions,
     rollback, and the version ledger (`goose_db_version`) are Goose's.
   - Concurrency safety = Goose's Postgres session-level advisory lock
     (`pg_try_advisory_lock`, pinned connection). Not a self-built ledger.
   - Internal seam `applyFS(ctx, url, fsys)` (unexported) is the only
     testability addition; production callers see only the embedded set.
3. Baseline conversion: `migrations/0001_baseline_user_system.sql` gains
   `-- +goose Up` (no `-- +goose Down` — up-only per ADR-0013) and
   `-- +goose StatementBegin/End` around the `DO $$ … $$` role block
   (embedded semicolons require explicit statement fencing). SQL semantics
   unchanged: same teardown, users/sessions/audit_logs, identity_app grants.
4. Deleted: `Migration`/`Available`, filename parsing, `schema_migrations`
   DDL/DML, per-file transaction and rollback code, advisory-lock code,
   phantom-version strictness (Goose owns ledger semantics now).

## One-time rebuild (clean cut)

No `schema_migrations → goose_db_version` bridge. A database created by the
#100 runner carries `schema_migrations` + baseline objects; Goose will not see
a `goose_db_version` ledger, attempt 0001, and fail on existing objects —
by design. Local databases must be dropped and recreated once when this lands
(the CI/local harness already provisions a throwaway PostgreSQL per run, so CI
needs no change). Documented here and in the PR.

## Test plan

- Unit (no DB): embedded files discoverable + naming discipline
  (`<version>_<name>.sql`); every file is up-only (`-- +goose Up` present,
  `-- +goose Down` forbidden); baseline still creates the single-tenant world.
- Integration (real PostgreSQL, env-gated exactly like identity: skip without
  `NEVIX_IDENTITY_INTEGRATION_REQUESTED`, fail with it when env missing;
  scratch databases derived from `NEVIX_DATABASE_URL`):
  1. First apply on an empty database → users/sessions/audit_logs + grants +
     role, ledger only in `goose_db_version`, no `public.schema_migrations`.
  2. Re-apply → no results (no-op).
  3. Failure rollback via `applyFS` + `fstest.MapFS`: migration that fails
     mid-file is not recorded and its earlier statements roll back.
  4. Concurrent `Apply` (two goroutines, same fresh DB) → both succeed,
     baseline recorded exactly once.
- Identity integrationtest: re-apply no-op and legacy drop-rebuild tests
  adapt to the new return type; the phantom-version test is deleted with the
  self-built engine it proved.
- Harness `scripts/test-identity-integration.sh` additionally runs
  `./internal/migration/...` and asserts new sentinels; full suite must stay
  zero-skip.

## Verification commands

- `go -C server vet ./...`
- `go -C server test ./...`
- `./scripts/test-identity-integration.sh`
