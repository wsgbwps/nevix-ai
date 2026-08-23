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

# For Linux
$ pnpm build:linux
```

### E2E tests

The E2E Suite starts a disposable loopback stack — a pinned throwaway PostgreSQL container, a
temporary Go identity server binary built from `server/` and bootstrapped with the first Admin,
and a self-signed TLS terminator for the TOFU specs — builds the Desktop app in test mode, and
runs the Electron Playwright suite. Docker must be running.

```bash
$ pnpm test:e2e        # Full E2E Suite: typecheck plus every spec
$ pnpm test:e2e:smoke  # Smoke Suite: one test-mode build, only specs tagged @smoke
$ pnpm test:e2e:settings # Settings Information Architecture: focused Settings spec
```

The focused commands skip the typecheck that Desktop CI already covers. The command takes the
repository Desktop E2E harness lock and refuses to run if another E2E stack already owns it, or
when a required loopback port (PostgreSQL, the identity server's port 8080, or the TLS
terminator) is already in use, so tests cannot silently connect to an unowned local service. On
a clean host, the command owns the stack it starts and tears it down on success, failure, SIGINT,
or SIGTERM. The bootstrap Admin completes the forced first-login password change over raw HTTP
before the suite, leaving a stable administrative credential; it exists only in the Playwright
process, and the Electron launcher removes it from the Desktop process environment.

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
