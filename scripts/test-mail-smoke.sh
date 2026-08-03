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

echo "==> Stack service versions"
pnpm exec supabase services

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
database_url="$(node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(s.DB_URL??"")' <<<"${status_json}")"
if [[ -z "${supabase_url}" || -z "${publishable_key}" || -z "${database_url}" ]]; then
  echo "error: could not read API_URL, publishable key, or DB_URL from 'supabase status -o json'" >&2
  exit 1
fi

echo "==> Discovering Mailpit container"
# Retry tests manipulate real SMTP availability by stopping and starting the
# captured-mailbox container; docker is present wherever the stack runs.
# Match by image: the CLI names the container supabase_inbucket_<project> even
# though it runs the supabase/mailpit image.
mailpit_container="$(docker ps --format '{{.Names}} {{.Image}}' | awk '$2 ~ /mailpit/ {print $1}' | head -n 1)"
if [[ -z "${mailpit_container}" ]]; then
  echo "error: could not find a running Mailpit container" >&2
  exit 1
fi

echo "==> Running Go mail smoke tests"
# SMTP host port 54325 maps to the stack's Mailpit ([local_smtp].smtp_port), so
# the identity Outbox Worker delivers into the same captured mailbox as GoTrue.
# Mailpit ignores credentials; the values only satisfy the four-variable contract.
# NEVIX_OUTBOX_RETRY_DELAYS compresses the production backoff schedule
# (1m,5m,15m,1h,6h) so retry and terminal-failure tests finish in seconds.
# NEVIX_VERIFICATION_CODE_HASH_KEY / NEVIX_SMTP_FROM satisfy the code
# issuance contract; the hash key is a throwaway value for captured mail only.
NEVIX_SUPABASE_URL="${supabase_url}" \
NEVIX_SUPABASE_PUBLISHABLE_KEY="${publishable_key}" \
NEVIX_MAILPIT_URL="${mailpit_url}" \
NEVIX_DATABASE_URL="${database_url}" \
NEVIX_SMTP_HOST="127.0.0.1" \
NEVIX_SMTP_PORT="54325" \
NEVIX_SMTP_USER="mailpit" \
NEVIX_SMTP_PASSWORD="mailpit" \
NEVIX_OUTBOX_RETRY_DELAYS="1s,2s,3s,4s,5s" \
NEVIX_MAILPIT_CONTAINER="${mailpit_container}" \
NEVIX_VERIFICATION_CODE_HASH_KEY="mail-smoke-test-hash-key" \
NEVIX_SMTP_FROM="identity@nevix.test" \
  go test -C server -race -count=1 -v ./internal/identity/...

echo "==> Mail smoke tests passed"
