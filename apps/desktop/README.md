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

### Authentication integration tests

The Authentication suite uses the pinned Supabase CLI to start a disposable loopback-only Auth
stack with Mailpit, builds the Desktop app with only the generated local publishable key, and runs
the Electron Playwright suite with one worker. Docker must be running.

```bash
$ pnpm test:auth
```

The command first verifies that missing and invalid public configuration block the app. It always
stops the local stack with `--no-backup`, including when the build or tests fail. The local admin
credential exists only in the Playwright process; the Electron launcher removes it from the Desktop
process environment.

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
