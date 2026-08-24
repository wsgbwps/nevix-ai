# Join-code copy button — clipboard write permission plan

## Scope

Feature: a per-row Copy button on the active join-code list
(`features/user-management/ui/join-codes-settings.tsx`) using
`navigator.clipboard.writeText`. Issue: Cmd+C / right-click have no effect in
this renderer, so the plaintext codes were practically uncopyable.

## Security boundary touched

`src/main/window/main-window.ts` installs a deny-all permission posture:

```ts
session.setPermissionCheckHandler(() => false)
session.setPermissionRequestHandler((_, __, callback) => callback(false))
```

Chromium gates `navigator.clipboard.writeText` behind the
`clipboard-sanitized-write` permission check; deny-all rejects it
(`NotAllowedError`), confirmed by the failed E2E run
(`admin-join-codes.spec.ts`, button never reached the copied state).

## Change

Allowlist exactly `clipboard-sanitized-write` in both handlers; every other
permission stays denied:

```ts
session.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write')
session.setPermissionRequestHandler((_wc, permission, callback) => {
  callback(permission === 'clipboard-sanitized-write')
})
```

## Risk analysis

- `clipboard-sanitized-write` grants **write-only, sanitized** clipboard
  access (`writeText` / sanitized `write`). It does **not** grant
  `clipboard-read`; reading stays denied.
- The renderer document is this app's own trusted surface: `setWindowOpenHandler`
  denies new windows and `will-navigate` locks the window to its single URL,
  so only first-party UI can ever hold this permission.
- Failure mode of NOT making this change: the copy feature silently does
  nothing (swallowed rejection), which is exactly what E2E caught.

## Verification

- `admin-join-codes.spec.ts` asserts both the copied-state button flip and the
  real system clipboard content via `electronApp.evaluate(clipboard.readText)`.
- Full E2E suite green locally (81 passed) with the allowlist in place.

## Out of scope

Global Cmd+C / right-click native menu (user chose the minimal button-only fix).
