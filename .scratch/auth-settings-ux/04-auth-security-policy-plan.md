# 04 — Authentication security policy implementation plan

## Boundary

- **Fixed point:** `21b3873098bf9bd7eb5dfab08fe1826f73edfa8b`
- **Acceptance boundary:** registration and recovery preserve the original password bytes, show a stable bilingual recommendation instead of a byte counter, distinguish too-short, too-long, and leaked-password failures, and keep unknown provider failures retryable. The pinned Supabase Auth stack must enforce the 12–72 UTF-8 byte boundary, no character-class rule, HIBP rejection with fail-open logging, a one-hour JWT, refresh rotation, a 14-day inactivity timeout, and a 90-day time-box. A successful password login remains an ordinary login even if the provider response includes a weak-password signal.
- **Primary Domain:** Desktop Authentication Domain.
- **No responsibility change:** Desktop continues to call Supabase Auth directly under ADR-0004. No database schema, RLS, Go trusted command, Session persistence interface, public contract, route, modal, or shared error abstraction changes.

## Task-owned paths

- `apps/desktop/src/renderer/src/features/authentication/` — password policy result, provider error mapping, UI hints/errors, and bilingual resources.
- `apps/desktop/tests/auth/` — observable Authentication Desktop behavior at the existing Electron/real-Auth seam.
- `supabase/config.toml` — deployment-equivalent Auth settings supported by the pinned CLI.
- `scripts/test-auth-policy.sh` and narrowly required harness support — real pinned GoTrue policy verification, including HIBP failure behavior.
- `.github/workflows/` and root package manifests only if needed to make the policy harness a named CI gate.
- `.scratch/auth-settings-ux/` — this plan, finding ledger, and ticket review state.

## Test-first slices

1. Change the existing signup/recovery Electron expectations to the stable recommendation and boundary errors, then minimally update the Authentication Feature until those tests pass.
2. Add provider-response cases at the Electron Auth boundary for leaked, same-password, unknown errors, and successful login with a weak-password signal; then add the smallest local error mapping needed.
3. Add a pinned real-GoTrue policy harness that proves policy behavior through Auth HTTP responses and JWT/refresh results, not by only parsing `config.toml`; then set the supported Auth configuration and CI command until the harness passes.
4. Rerun existing Session persistence, recovery, runtime revocation, localization, lint, typecheck, build, and the focused/full E2E suites required by the ticket.

## Delivery and rollback

- Freeze the task-owned diff against the fixed point, run one full Standards/Spec review, repair accepted blockers only, and close the ledger through targeted review when required.
- Bind the post-edit relevant check and closed ledger with `docs/specs/final-state-evidence.md`, then commit, push `codex/auth-security-policy`, and open a PR.
- Before real Users exist, rollback is the cohesive PR revert under an explicit security decision. After real Users exist, do not silently lower the password or Session floor.
