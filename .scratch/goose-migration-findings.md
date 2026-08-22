# Code-review findings ledger — issue #108 (Goose migration runner)

schema: code-review-findings/v1
fixedPoint: 2b8ffcb (main)
branch: user-system/108-goose-migration-runner
commits: 3759dd9
initialBundle: /tmp/nevix-108-review-bundle.diff
fullReviewCount: 1
targetedReviewRound: 1
relevantCheck:
    name: "./scripts/test-identity-integration.sh + go vet ./... + go test ./..." (server)
    result: PASS
    coverage: 77 real-PostgreSQL integration tests, zero skips, all sentinels; vet + unit suites green
    diffDigest: sha256:18500674d26d31e3365021d519d41b62546cb1d06e07d83ff846b668f83d2344
outcome: closed

Task pathspec:
- .scratch/goose-migration-plan.md
- scripts/test-identity-integration.sh
- server/cmd/server/main.go
- server/go.mod, server/go.sum
- server/internal/identity/integrationtest/migration_integration_test.go
- server/internal/migration/**

## Findings

### CR-STANDARDS-0001
- axis: standards
- level: advisory
- identity:
    owner: server/internal/migration/
    source: server/AGENTS.md — test-support placement rule ("shared infrastructure helpers ... live in their own named test-support files inside the owning test package")
    anchor: server/internal/migration/migration_integration_test.go:requireOwnerURL/scratchDatabase/openDB
    defect: shared environment-gating, scratch-database-provisioning, and connection helpers are embedded in the scenario file instead of a named test-support file (identity precedent: harness_test.go)
- disposition: deferred
- dispositionReason: Advisory placement convention, not acceptance-blocking; nevertheless applied in-task alongside the blocker repair because the split is mechanical (helpers moved to harness_test.go), keeping the package aligned with the identity package's documented layout.
- status: closed
- reviewedDiffDigest: sha256:c03c2b4aac1c467736929ca5d05a7bd2de49c2ff9854c90068611fb3742b66a6
- evidence: reviewer e2dcde51 (Standards), 2025-audit of frozen bundle; scenario file carries helpers + scenarios together.

### CR-SPEC-0001
- axis: spec
- level: blocker
- identity:
    owner: README.md
    source: issue #108 — "由 #100 runner 创建的本地/测试数据库在本票落地时一次性重建，并在开发说明中写明"
    anchor: .scratch/goose-migration-plan.md §One-time rebuild / README.md 本地开发启动顺序（Server 侧）
    defect: required one-time local-database rebuild documented only in the ephemeral .scratch plan (the repo deletes landed .scratch content); the durable developer-facing README local-start instructions carry no rebuild warning, so existing #100 databases fail on Goose's 0001 re-run with no recovery note
- disposition: accepted
- dispositionReason: The spec explicitly requires the rebuild to be written into development notes; .scratch is transient (a landed-work cleanup commit removed prior plans), so the durable README server local-dev section must carry the one-time drop/recreate instruction. Repairing in current scope.
- status: closed
- reviewedDiffDigest: sha256:c03c2b4aac1c467736929ca5d05a7bd2de49c2ff9854c90068611fb3742b66a6
- evidence: reviewer bc05a43f (Spec); README.md lines 261-271 direct `make server` with no rebuild note; goose applies 0001 to a #100-era database (no goose_db_version) and fails on existing objects.

## Repair records

### repair-1 (2025, after initial review)
- fixFor: [CR-SPEC-0001] (+ in-task application of deferred CR-STANDARDS-0001, not part of the blocker queue)
- beforeDigest: sha256:c03c2b4aac1c467736929ca5d05a7bd2de49c2ff9854c90068611fb3742b66a6
- afterDigest: sha256:18500674d26d31e3365021d519d41b62546cb1d06e07d83ff846b668f83d2344
- commit: f619a9e
- touchedPaths:
    - README.md — Server 本地开发启动顺序 section: added one-time local-database drop/recreate warning for the Goose clean cut (drop schema_migrations-era DB, no compat bridge)
    - server/internal/migration/harness_test.go — new; helpers (requireOwnerURL, scratchDatabase, openDB) moved here per server/AGENTS.md test-support placement (CR-STANDARDS-0001)
    - server/internal/migration/migration_integration_test.go — now scenarios only; header cross-references harness_test.go
- checks:
    - go -C server vet ./... — PASS
    - go -C server test ./internal/migration — PASS
    - ./scripts/test-identity-integration.sh — PASS (77 integration tests, zero skips, all sentinels incl. TestConcurrentApplyRunsBaselineExactlyOnce)

## Targeted reviews

### round 1 (reviewer: targeted-rereview)
- targets: [CR-SPEC-0001]
- verdict: CR-SPEC-0001 fixed-pending-review -> closed (README.md:265 durably documents the one-time rebuild, goose_db_version transition, clean-cut consequence; accurate)
- repair-hunk regression scan: none (harness_test.go extraction behavior-preserving, complies with server/AGENTS.md)
- reviewedDiffDigest: sha256:18500674d26d31e3365021d519d41b62546cb1d06e07d83ff846b668f83d2344

## Stop gate (outcome: closed)

- no blocker open / fixed-pending-review / escalated (CR-SPEC-0001 closed)
- CR-STANDARDS-0001 advisory: disposition deferred, status closed (applied in-task anyway)
- no false-positives recorded
- final relevant check PASS bound to sha256:18500674d26d31e3365021d519d41b62546cb1d06e07d83ff846b668f83d2344 (commit f619a9e tree)
- final diff and check result reviewed together in targeted round 1
