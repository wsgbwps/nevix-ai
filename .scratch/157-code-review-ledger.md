# #157 code-review ledger

Two-axis review (Standards + Spec) over `main...feat/157-kapon-byok-connection`, aggregated 2026-08-27. Dispositions below; fixes landed in commit "refactor(creation): 吸收 #157 代码评审意见".

## Standards axis (no hard violations; judgement calls)

| Finding | Disposition |
| --- | --- |
| P2 duplicated `request`/`readErrorCode` between the two creation api clients | Fixed — helpers exported from `go-creation-http.ts`, `PUT` added to the method union, provider-connection client reuses them |
| P2 run-e2e.sh comment claimed a Node fake-Kapon fixture that does not exist | Fixed — comment now states the override is optional and unset keeps the fixed route |
| P3 trusted-HTTPS predicate duplicated across modules | Fixed — promoted to `authz.SecureTransportProven`; identity routes and creationhttp both use it; the unit test moved to `authz` |
| P3 `domain.ErrInsecureTransport` declared but never returned | Fixed — sentinel and MapError arm removed |
| P3 dead `admin := …; _ = admin` in the permission-matrix test | Fixed |
| P3 zero-value guard policy could let a future admin route omit its guard | Kept — mirrors identity's established zero-value pattern (documented repo precedent overrides the baseline smell) |

## Spec axis (all 11 acceptance criteria implemented)

| Finding | Disposition |
| --- | --- |
| P3 `Configure` returned the pre-insert aggregate (zero `created_at`/`updated_at`) | Fixed — re-reads the row after commit |
| P3 `last_checked_at` updated on transient attempts while the contract said "最近一次完成" | Fixed — contract wording now includes attempts ending `temporarily_unavailable` (persisted states still never rewritten, per spec) |
| P3 `checking` states unreachable in the synchronous V1 flow | Accepted — the closed enums, CHECK constraints, and member derivation keep the spec'd vocabulary; reachability arrives with async checks in later slices |
| `KAPON_BASE_URL` env override beyond the letter of "固定路由" | Accepted — required by the spec's own testing decisions (fake Kapon in automation); process-wide startup config, never per-connection, never in Desktop; documented in `.scratch/157-kapon-byok-connection/plan.md` |
| `provider_key` maxLength 4096 vs the 4096-byte body cap | Accepted — harmless upper bound; the body cap is the effective limit |
