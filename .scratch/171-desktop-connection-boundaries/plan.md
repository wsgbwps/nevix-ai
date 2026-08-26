# #171 — Desktop Connection 模型边界与测试卫生

Spec source: GitHub issue #171. Primary Domain: **Desktop Connection**.

High-risk class: **TLS security seam and Authentication startup evaluation**. This
plan records the bounded decision before implementation as required by root
`AGENTS.md`.

## Fixed point and acceptance boundary

- Fixed point: `2637d0bd9179986e4d629dcb6cb16df5f37d3356` (`origin/main`).
- Task branch: `issue-171-desktop-connection-boundaries`.
- Move the 90-day certificate near-expiry calculation into the Connection
  Feature `model/`; the UI receives and renders a derived warning state.
- Make `ServerConnectionEditorState` require `validTo` only on the
  `certificate-expired` failure variant.
- Replace the duplicated certificate rotation implementation in the expiry,
  TOFU, and rotation E2E specs with one helper under
  `tests/connection/helpers/`.
- Evaluate, without silently changing #153 behavior, whether persisted startup
  should probe Connection before restoring Authentication.

The 90-day horizon, probe results, persisted connection format, TLS pin rules,
startup copy, and Session lifecycle are unchanged.

## Startup probe decision

Do **not** add a second Connection Probe before Authentication restore in this
slice. The saved Server URL already enters the Authentication restore seam,
whose validation request is the authoritative reachability and Session check.
Adding a probe would duplicate a network round trip on every launch, add a new
pre-authentication state hand-off across Connection and Authentication, and
still require the validation request to handle a race after a successful probe.

The current restore interface preserves the required guarantees:

- `unavailable` validation keeps the stored Session and shows a retryable,
  network/server-framed failure;
- Retry re-reads persistence and validates again, refetching authoritative User
  and Session state;
- only `session-rejected` clears the stored Session and asks for sign-in.

These guarantees remain owned and verified by
`tests/component/authentication-runtime-restore.spec.tsx`; this task runs that
spec as QA evidence but does not modify the Authentication Domain.

## Task-owned paths

- `.scratch/171-desktop-connection-boundaries/`
- `apps/desktop/src/renderer/src/features/connection/model/use-server-connection-editor.ts`
- `apps/desktop/src/renderer/src/features/connection/ui/server-connection-editor-fields.tsx`
- `apps/desktop/tests/component/connection-screen.spec.tsx`
- `apps/desktop/tests/connection/helpers/tls-rotation.ts`
- `apps/desktop/tests/connection/connection-expiry.spec.ts`
- `apps/desktop/tests/connection/connection-rotation.spec.ts`
- `apps/desktop/tests/connection/connection-tofu.spec.ts`

No new or moved source file changes a documented owner: model rules stay in the
Connection Feature, UI only renders model state, and the new test helper stays
inside the existing Connection E2E support boundary. No Main, preload, IPC,
Authentication, public contract, persistence, or architecture seam changes.

## Verification

1. Baseline component and type checks, then change the state interface first so
   typechecking exposes every stale UI/model caller before the implementation
   returns green.
2. Focused Connection component spec for reachable near/far expiry and expired
   certificate output.
3. Focused Authentication restore component spec for stored-Session retention,
   retry/refetch recovery, and rejected-Session clearing.
4. Desktop typecheck, unit, component, architecture, lint, and format checks.
5. Connection Electron E2E through the repository harness, including real TLS
   expiry and rotation coverage.

## Rollback

One PR and one squash commit. Reverting it restores only the prior type shape,
UI-local derivation, and duplicated test helper; no persisted data migration or
runtime compatibility action is required.
