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

The E2E Suite uses the pinned Supabase CLI to start a disposable loopback-only Auth stack (the Auth
Harness) with Mailpit, builds the Desktop app with only the generated local publishable key, and
runs the Electron Playwright suite with one worker. Docker must be running.

```bash
$ pnpm test:e2e        # Full E2E Suite: configuration-failure builds plus every spec
$ pnpm test:e2e:smoke  # Smoke Suite: one test-mode build, only specs tagged @smoke
$ pnpm test:e2e:settings # Settings Information Architecture: focused Settings and Members specs
```

The full command first verifies that missing and invalid public configuration block the app; the
focused commands skip those phases and the typecheck that Desktop CI already covers. Before any
command builds or changes the database, it takes the repository Supabase harness lock and refuses
to run if the `nevix-ai` project (or the legacy Auth harness project) already has labeled Docker
containers, volumes, or networks. E2E and Mail Smoke therefore cannot run concurrently or reset a
developer's shared local stack. On a clean host, the command owns the stack it starts and removes
that exact project with `--no-backup` on success, failure, SIGINT, or SIGTERM. It also refuses to
start when a required Supabase port or the identity server's port 8080 is already in use, so tests
cannot silently connect to an unowned local service. If the process is
SIGKILLed or the host crashes, the next run fails closed on the residual lock or Docker state;
inspect both before manually recovering them. GitHub's one-use runners keep the same disposable
start/reset/stop lifecycle. The local admin credential exists only in the Playwright process; the
Electron launcher removes it from the Desktop process environment.

Development and test builds accept a Supabase HTTP Origin only when its host is `localhost`, an
exact loopback address, or an RFC1918 private IPv4 address. Production builds require HTTPS. The
policy comes from the electron-vite build mode; there is no environment switch that can relax a
production build.

Only the public URL and publishable key are configured:

```bash
VITE_SUPABASE_URL=http://192.168.1.50:8000
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx
```

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
