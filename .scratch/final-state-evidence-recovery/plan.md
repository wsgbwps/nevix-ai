# Final-state evidence recovery plan

## Goal

Recover the archived final-state-evidence workflow onto a dedicated feature
branch, preserving the current `main` history and submitting it through the
repository's required PR route.

## Scope and ownership

- **Primary domain:** developer workflow.
- **Existing ownership boundaries:** `.codex/` for local agent configuration
  and hooks; root `AGENTS.md` for repository instructions; `docs/agents/` and
  `docs/specs/` for workflow documentation; `.scratch/` for this delivery plan.
- **Out of scope:** application, server, database, and CI workflow changes.

## Delivery steps

1. Merge `codex/archive-main-before-origin-sync-20260811` into
   `codex/recover-final-state-evidence` without altering unrelated mainline
   changes.
2. Verify the hook's focused Node test suite and JSON configuration.
3. Review the resulting diff for the declared scope, then push a PR for CI and
   review. Keep the archive branch until the PR has merged.

## Acceptance and rollback

The focused hook test suite must pass, the hook configuration must parse, and
the final diff must contain only the declared developer-workflow files. If the
change proves unsuitable, close the PR and delete the recovery branch; the
archive branch remains an intact rollback source.
