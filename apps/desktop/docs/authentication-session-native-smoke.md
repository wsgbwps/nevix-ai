# Authentication native credential-storage smoke

The automated `@native-smoke` suite proves that the Desktop uses the target operating system's real
credential backend: Keychain on macOS and DPAPI on Windows. It runs with a fresh temporary
`userData` directory and does not start Go, PostgreSQL, Docker, TLS, or any external network request.

Run the source or packaged mode from `apps/desktop/`:

```bash
pnpm test:native:smoke
pnpm test:native:packaged
```

Source mode builds Electron in test mode first. Packaged mode searches `dist/` for exactly one
platform executable:

- macOS: `**/*.app/Contents/MacOS/Nevix AI`
- Windows: `**/win-unpacked/Nevix AI.exe`

Zero or multiple matches fail before launch. Both modes run the same specs serially and pass an
isolated `--user-data-dir`; packaged mode otherwise follows production behavior.

## Credential assertions

The suite uses the trusted Renderer IPC bridge to write a synthetic Session and Remembered Email,
then verifies all of the following:

1. The platform reports an available secure-storage backend. Unavailability is a failure, never a
   skip or plaintext fallback.
2. `authentication-session.enc` and `authentication-remembered-email.enc` each contain only
   `version: 1` and a non-empty base64 `ciphertext`; neither envelope contains the synthetic token,
   user id, or email in plaintext.
3. After quitting and relaunching under the same operating-system user and `userData`, both values
   can be read through their production IPC Channels.
4. Clearing both values removes their files.

The suite also covers the first Renderer commit, native editing menu, copy/cut/paste shortcuts, and
window-state restoration across restart. Electron and Renderer diagnostics are written beneath
`test-results/`; CI uploads failure diagnostics for seven days after first checking them for
credential material.

Windows source Native Smoke runs for every Desktop runtime PR. macOS is added for Main, Preload,
Shared, native window/storage, packaging, dependency, and Native Smoke changes. `v*` tags and manual
Desktop release-candidate workflows package both platforms and run packaged Native Smoke.

Linux is not a Desktop release target. The product still rejects Electron's Linux `basic_text`
backend and retains its explicit regression tests; removing Linux packaging does not permit
plaintext Session or Remembered Email persistence.

Native Smoke deliberately does not validate login, server-side Session acceptance, TLS/TOFU,
outages, revocation, or cross-layer contracts. Authentication, Session, connection/TLS,
security-boundary changes, and release candidates must additionally run `make test-e2e` on a local
Mac and record the result in the PR or release notes.
