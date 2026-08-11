#!/usr/bin/env bash
# Mail test harness: on a clean host, starts the pinned local Supabase stack
# (with Mailpit) from an empty database, replays committed migrations, runs the
# Go mail smoke tests, and tears down only the stack it owns. Same entry point
# for local dev and CI.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_root/scripts/lib/supabase-local-harness.sh"
cd "$repo_root"

# Loopback traffic must never go through a developer HTTP proxy: the Supabase
# CLI health checks, curl, and the Go tests all honor proxy variables.
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,${NO_PROXY}}"
export no_proxy="${NO_PROXY}"

cleanup() {
  local exit_status="$1"

  nevix_supabase_harness_cleanup "$exit_status"
}
trap 'exit_status=$?; trap - EXIT; cleanup "$exit_status"; exit $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

nevix_supabase_harness_acquire "$repo_root" mail-smoke
nevix_supabase_harness_require_clean_projects nevix-ai
nevix_supabase_harness_require_free_tcp_ports 54320 54321 54322 54324 54325

echo "==> Supabase CLI version"
pnpm exec supabase --version

echo "==> Starting pinned local Supabase stack"
nevix_supabase_harness_claim_stack nevix-ai
pnpm exec supabase start

echo "==> Stack service versions"
pnpm exec supabase services

echo "==> Resetting database from committed migrations"
pnpm exec supabase db reset --local

mailpit_url="http://127.0.0.1:54324"
mailpit_smtp_host="127.0.0.1"
mailpit_smtp_port="54325"

probe_smtp_endpoint() {
  node - "$1" "$2" <<'NODE'
const net = require("node:net")

const [host, rawPort] = process.argv.slice(2)
const port = Number(rawPort)
if (!host || !Number.isInteger(port)) {
  process.exit(1)
}

const socket = new net.Socket()
let settled = false
let timer
let greeting = ""
const finish = (exitCode) => {
  if (settled) return
  settled = true
  clearTimeout(timer)
  socket.destroy()
  process.exitCode = exitCode
}

socket.setEncoding("utf8")
socket.on("data", (chunk) => {
  greeting += chunk
  if (greeting.includes("\n")) {
    finish(/^220(?:[ -])/.test(greeting) ? 0 : 1)
  }
})
socket.once("error", () => finish(1))
timer = setTimeout(() => finish(1), 1000)
socket.connect(port, host)
NODE
}

wait_for_mailpit() {
  local http_ready=0
  local smtp_ready=0
  local attempt

  for attempt in $(seq 1 30); do
    http_ready=0
    smtp_ready=0
    if curl --connect-timeout 1 --max-time 2 -fsS "${mailpit_url}/readyz" >/dev/null 2>&1; then
      http_ready=1
    fi
    if probe_smtp_endpoint "${mailpit_smtp_host}" "${mailpit_smtp_port}" >/dev/null 2>&1; then
      smtp_ready=1
    fi
    if [[ "${http_ready}" -eq 1 && "${smtp_ready}" -eq 1 ]]; then
      return 0
    fi
    if [[ "${attempt}" -lt 30 ]]; then
      sleep 1
    fi
  done

  if [[ "${http_ready}" -ne 1 ]]; then
    echo "error: Mailpit HTTP API ${mailpit_url}/readyz was not ready after 30 attempts" >&2
  fi
  if [[ "${smtp_ready}" -ne 1 ]]; then
    echo "error: Mailpit SMTP ${mailpit_smtp_host}:${mailpit_smtp_port} was not ready after 30 attempts" >&2
  fi
  return 1
}

echo "==> Waiting for Mailpit HTTP and SMTP readiness"
wait_for_mailpit

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
mailpit_container="$(docker ps \
  --filter 'label=com.supabase.cli.project=nevix-ai' \
  --format '{{.Names}} {{.Image}}' | awk '$2 ~ /mailpit/ {print $1}' | head -n 1)"
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
# NEVIX_AUTH_JWKS_URL / NEVIX_CORS_ALLOWED_ORIGINS satisfy the Bearer JWT
# transport contract; the Bearer command tests mint their own ES256 sessions
# against a test key set, so the stack's JWKS URL only needs to be well-formed.
NEVIX_SUPABASE_URL="${supabase_url}" \
NEVIX_SUPABASE_PUBLISHABLE_KEY="${publishable_key}" \
NEVIX_MAILPIT_URL="${mailpit_url}" \
NEVIX_DATABASE_URL="${database_url}" \
NEVIX_SMTP_HOST="${mailpit_smtp_host}" \
NEVIX_SMTP_PORT="${mailpit_smtp_port}" \
NEVIX_SMTP_USER="mailpit" \
NEVIX_SMTP_PASSWORD="mailpit" \
NEVIX_OUTBOX_RETRY_DELAYS="1s,2s,3s,4s,5s" \
NEVIX_MAILPIT_CONTAINER="${mailpit_container}" \
NEVIX_VERIFICATION_CODE_HASH_KEY="mail-smoke-test-hash-key" \
NEVIX_SMTP_FROM="identity@nevix.test" \
NEVIX_AUTH_JWKS_URL="${supabase_url}/auth/v1/.well-known/jwks.json" \
NEVIX_CORS_ALLOWED_ORIGINS="http://127.0.0.1:5173" \
  go test -C server -race -count=1 -v ./internal/identity/...

echo "==> Mail smoke tests passed"
