# main merge acceptance enforcement

Primary Domain: repository delivery governance.

Owner boundaries:

- `.github/workflows/` owns stable pull-request check reporting.
- `AGENTS.md` owns the repository-wide delivery workflow that sends every `main` change through a PR.
- GitHub repository rules own the real server-side merge boundary.
- `docs/adr/0007-e2e-test-tiering.md` owns the E2E pre-merge/post-merge decision.
- `.scratch/merge-acceptance-enforcement/` owns this change plan and captured evidence.

External GitHub settings writes, validation branches, pull requests, and merges were authorized for this task on 2026-08-11. Billing changes, repository visibility changes, and choosing a new collaborator remain separate user decisions.

## Locked implementation

1. Remove top-level `pull_request.paths` from all four CI workflows while preserving push filters and job names. This makes every `main` PR report the five intended required contexts instead of leaving path-filtered required workflows Pending. Update `AGENTS.md` so its docs/local-tooling rule matches the all-PR server boundary.
2. Deliver that workflow change through a feature branch and PR. Confirm all five contexts exist on the PR head and reach terminal success.
3. After GitHub enables protection for this private repository and an independent reviewer exists, create one active branch ruleset targeting `refs/heads/main`:
   - require a pull request, one approval, stale-review dismissal, last-push approval, and conversation resolution;
   - require the five exact check names from GitHub Actions App `15368`, with strict/up-to-date behavior;
   - block deletion and non-fast-forward updates;
   - allow no `always` bypass; any emergency administrator bypass must be pull-request-only.
4. Read back both the ruleset and effective rules before updating ADR-0007. Never document the server gate as active before the read-back succeeds.

## Verification

- Negative check: a deterministic red required check must make the merge API reject the PR without changing the base SHA.
- Negative review: five green checks with zero valid approvals must be rejected without changing the base SHA.
- Positive path: the latest head has five green checks, an approval from another authorized reviewer, resolved conversations, and an up-to-date base; a normal non-bypass merge succeeds.
- Emergency path: bypass requires task-specific authorization recorded in the PR before use. Preserve the merge actor/time/commit, ruleset snapshots, and any available rule-suite event. A personal repository must not claim organization audit-log coverage.

## Stop conditions

- Current evidence records HTTP 403 for rulesets, effective rules, and branch protection on this private repository. Do not make the repository public or purchase a plan without a separate user decision.
- Current evidence records only one collaborator. Do not activate `required_approving_review_count: 1` until another reviewer can produce a counting approval, or normal green PRs will be permanently blocked.
