#!/usr/bin/env bash
# Mail test harness: starts the pinned local Supabase stack (with Mailpit) from
# an empty database, replays committed migrations, runs the Go mail smoke tests,
# and always tears the stack down. Same entry point for local dev and CI.
set -euo pipefail

cd "$(dirname "$0")/.."

# Loopback traffic must never go through a developer HTTP proxy: the Supabase
# CLI health checks, curl, and the Go tests all honor proxy variables.
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,${NO_PROXY}}"
export no_proxy="${NO_PROXY}"

cleanup() {
  pnpm exec supabase stop --no-backup >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Supabase CLI version"
pnpm exec supabase --version

echo "==> Starting pinned local Supabase stack"
pnpm exec supabase start

echo "==> Resetting database from committed migrations"
pnpm exec supabase db reset --local

echo "==> Waiting for Mailpit readiness"
mailpit_url="http://127.0.0.1:54324"
for _ in $(seq 1 30); do
  if curl -fsS "${mailpit_url}/readyz" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS "${mailpit_url}/readyz" >/dev/null

echo "==> Reading local stack endpoints"
status_json="$(pnpm exec supabase status -o json)"
supabase_url="$(node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(s.API_URL??"")' <<<"${status_json}")"
publishable_key="$(node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(s.PUBLISHABLE_KEY??s.ANON_KEY??"")' <<<"${status_json}")"
if [[ -z "${supabase_url}" || -z "${publishable_key}" ]]; then
  echo "error: could not read API_URL or publishable key from 'supabase status -o json'" >&2
  exit 1
fi

echo "==> Running Go mail smoke tests"
NEVIX_SUPABASE_URL="${supabase_url}" \
NEVIX_SUPABASE_PUBLISHABLE_KEY="${publishable_key}" \
NEVIX_MAILPIT_URL="${mailpit_url}" \
  go test -C server -race -count=1 -v ./internal/identity/...

echo "==> Mail smoke tests passed"
