# Plan: PR-based delivery on GitHub Free

- **Branch**: `pr-based-delivery`
- **Primary Domain**: 交付流程(仓库级架构规则,ADR 级决策)
- **Supersedes**: ADR-0010 verified-SHA landing(标记 superseded-by 0011)
- **Date**: 2026-04-30(会话批准)

## Decisions

- **No `make land`** — remove the verified-SHA machinery; `main` updates only via PR.
- **Squash merge** — one commit per task on `main`; `--delete-branch`; PR page is the acceptance record.
- **Keep guards, reword** — block `git commit` on main and direct `git push` to main in both `.codex/hooks.json` and `.pi/extensions/pi-hooks.ts`; messages point to the PR flow.
- **Path-aware E2E** — PR runs smoke E2E when e2e-relevant paths change; merge-push to main runs the full suite only for e2e-relevant diffs (classifier decides; never a blanket full run).

## Changes

A. Delete: `scripts/land.mjs`, `scripts/tests/land.test.mjs`, `.codex/hooks/final-state-evidence.mjs`, `.codex/hooks/final-state-evidence.test.mjs`, `docs/specs/final-state-evidence.md`
B. Makefile: drop `land` target; `harness-test` = review-lifecycle + classify-ci-changes + pi-hooks tests
C. ci-gate.yml: `push: branches: [main]`; push base = `github.event.before` (zeros → `HEAD^`); drop ancestor check; e2e suite input unchanged (`push` → full)
D. Hooks: reword both guard messages (commit-on-main, push-main) in `.codex/hooks.json`, `.pi/extensions/pi-hooks.ts`, `.pi/tests/pi-hooks.test.mjs`
E. classify-ci-changes.mjs: remove stale `land.mjs`/`land.test.mjs` harness entries; update test fixture path
F. Docs: rewrite `delivery.md`; add ADR-0011 (supersedes 0010); update README 分支与交付规范; simplify issue-tracker wrap-up + triage-labels (`in-verification` removed); reword implement/code-review skills
G. AGENTS.md rewrite (~20 lines): keep type-1 rules (routing, boundaries, ADR pointers, subagent delegation); Delivery = 4-line PR flow; high-risk = brief `.scratch/` note before implementation

## Verification

`make harness-test` green → self-land through the new flow: PR → checks green → squash merge → main push gate runs path-aware (harness only for this diff; no E2E as expected).

## Accepted tradeoffs

- GitHub Free private: no server-side branch protection; `gh pr checks --watch` is the actual gate.
- Rapid successive merges can cancel an in-flight post-merge run via `cancel-in-progress`.
- Shared-area callouts move from commit messages to PR descriptions.
- `docs/specs/` stays (README + other specs); only the evidence spec is deleted.
