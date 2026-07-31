# 07 — Enforce a runtime IPC channel allowlist in the preload

**What to build:** `apps/desktop/src/preload/index.ts` exposes a generic `invoke` whose channel argument is only constrained at compile time by `IpcChannelMap`. At runtime any string is passed straight to `ipcRenderer.invoke`, so a compromised renderer's reachable surface is every registered channel rather than a declared subset. Add a runtime allowlist in the preload so `invoke` and `on` reject channels outside the declared contract.

**Blocked by:** None, but the preload is a shared area — the change must be called out with impact and tests and needs maintainer approval before merge.

**Status:** needs-triage

## Proposed direction

- Derive or maintain a literal allowlist of channel names in the preload (kept adjacent to the `@ipc/channels` declarations so drift is caught by a test).
- `typedInvoke`/`typedOn` throw on any channel not in the list before touching `ipcRenderer`.
- Extend `tests/auth/electron-security.spec.ts` with a case proving an unlisted channel is rejected in the renderer without reaching the main process.

## Comments

- Raised by the PR #5 security review (medium-low severity): defence-in-depth for the XSS-compromised-renderer scenario; every existing session channel already re-verifies the sender in the main process.
