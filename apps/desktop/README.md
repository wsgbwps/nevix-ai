# react-ts

An Electron application with React and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ pnpm install
```

### Development

```bash
$ pnpm dev
```

### Build

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac
```

### Native Smoke

The `@native-smoke` suite launches the real Electron app without Go, PostgreSQL, Docker, TLS, or
external network access. It checks the first Renderer commit, native editing menu and clipboard
shortcuts, window-state restoration, and real Keychain/DPAPI persistence for Session and Remembered
Email. A missing native secure-storage backend fails the suite; it is never skipped or downgraded.

```bash
$ pnpm test:native:smoke     # Build in test mode, then launch the source app
$ pnpm test:native:packaged  # Launch the unique packaged .app or win-unpacked .exe in dist/
```

CI runs the source suite on Windows for Desktop runtime changes and adds macOS for Main, Preload,
Shared, native window/storage, packaging, dependency, and Native Smoke changes. A `v*` tag or manual
Desktop workflow packages both platforms and runs the packaged suite; it does not exercise DMG or
NSIS installation.

### Full E2E tests

The E2E Suite starts a disposable loopback stack — a pinned throwaway PostgreSQL container, a
temporary Go identity server binary built from `server/` and bootstrapped with the first Admin,
and a self-signed TLS terminator for the TOFU specs — builds the Desktop app in test mode, and
runs the Electron Playwright suite. Run it on a local Mac with Docker available for authentication,
Session, connection/TLS, security-boundary changes, and before release; record the result in the PR
or release notes.

```bash
$ pnpm test:e2e        # Required local Full E2E: typecheck plus every spec
$ pnpm test:e2e:smoke  # Optional focused backend E2E: specs tagged @smoke
$ pnpm test:e2e:settings # Settings Information Architecture: focused Settings spec
```

The focused commands skip the typecheck that Desktop CI already covers. The command takes the
repository Desktop E2E harness lock and refuses to run if another E2E stack already owns it, or
when a required loopback port (PostgreSQL, the identity server's port 8080, or the TLS
terminator) is already in use, so tests cannot silently connect to an unowned local service. On
a clean host, the command owns the stack it starts and tears it down on success, failure, SIGINT,
or SIGTERM. The suite's test admin is created through the public Instance Claim over raw HTTP
before the specs run — the same open channel an operator's first administrator uses — so it owes
no first-login password change; its credentials exist only in the Playwright process, and the
Electron launcher removes them from the Desktop process environment.

Platform-native Session persistence must also pass the
[native credential-backend smoke](docs/authentication-session-native-smoke.md) before support is
claimed for that backend.

### Architecture verification

One deterministic command checks the accepted Domain-first Desktop architecture rules — Main
adapter placement and registration discovery, cross-process Channel naming, the generic preload
bridge, and renderer Feature interfaces — and is the single architecture acceptance entry for both
local work and CI:

```bash
$ pnpm verify:architecture
```

It first runs the verifier's fixture-driven contract tests
(`scripts/architecture/verifier.test.mjs`), then verifies the real `src/` tree and exits non-zero
on any violation. Documented pre-migration debt is carried only by the exact-path entries in
`scripts/architecture/migration-debt-allowlist.mjs`; each entry records a reason and a removal
trigger, and unused entries fail so the documented debt list can only shrink. Responsibility
placement, interface depth, and deletion tests stay review decisions and are not automated.
