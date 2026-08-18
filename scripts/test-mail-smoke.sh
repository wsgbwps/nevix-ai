#!/usr/bin/env bash
# Identity integration harness implementation. The supported local and CI entry
# is scripts/test-identity-integration.sh; this legacy filename remains callable
# for compatibility. On a clean host, the harness starts the pinned local
# Supabase stack, replays committed migrations, runs the real Go Identity
# integration suite, and tears down only the stack it owns.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_root/scripts/lib/supabase-local-harness.sh"
cd "$repo_root"

identity_test_log=""

# Loopback traffic must never go through a developer HTTP proxy: the Supabase
# CLI health checks, curl, and the Go tests all honor proxy variables.
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,${NO_PROXY}}"
export no_proxy="${NO_PROXY}"

cleanup() {
  local exit_status="$1"

  if [[ -n "$identity_test_log" ]] && ! rm -f "$identity_test_log"; then
    echo "error: failed to remove temporary Identity integration test output '$identity_test_log'" >&2
    if [[ "$exit_status" == "0" ]]; then
      exit_status=1
    fi
  fi
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

assert_identity_integration_executed() {
  local output_file="$1"
  local passed_count
  local skipped_count
  local test_name
  local -a representative_tests=(
    TestAcceptInvitationCreatesMemberAndConsumesCode
    TestRLSClientWriteBoundary
    TestCommittedOutboxRowIsDeliveredToMailpit
  )

  passed_count="$(grep -Ec '^--- PASS: Test[^/[:space:]]+[[:space:]]+\(' "$output_file" || true)"
  skipped_count="$(grep -Ec '^--- SKIP: Test[^/[:space:]]+[[:space:]]+\(' "$output_file" || true)"

  if [[ "$passed_count" -eq 0 ]]; then
    echo "error: Identity integration was requested, but zero top-level integration tests passed." >&2
    echo "Run ./scripts/test-identity-integration.sh from the repository root to start the supported harness; if this entry emitted the error, inspect the test output above." >&2
    return 1
  fi
  if [[ "$skipped_count" -ne 0 ]]; then
    echo "error: Identity integration was requested, but $skipped_count top-level integration test(s) skipped." >&2
    echo "Run ./scripts/test-identity-integration.sh from the repository root so the harness supplies every required NEVIX_* value." >&2
    return 1
  fi

  for test_name in "${representative_tests[@]}"; do
    if ! grep -Fq -- "--- PASS: ${test_name} " "$output_file"; then
      echo "error: requested Identity integration sentinel '$test_name' did not pass." >&2
      echo "Run ./scripts/test-identity-integration.sh from the repository root and inspect the test output above." >&2
      return 1
    fi
  done

  echo "==> Verified $passed_count Identity integration tests executed with zero skips"
  printf '    representative PASS: %s\n' "${representative_tests[@]}"
}

echo "==> Running Go Identity integration tests"
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
export NEVIX_IDENTITY_INTEGRATION_REQUESTED=1
export NEVIX_SUPABASE_URL="${supabase_url}"
export NEVIX_SUPABASE_PUBLISHABLE_KEY="${publishable_key}"
export NEVIX_MAILPIT_URL="${mailpit_url}"
export NEVIX_DATABASE_URL="${database_url}"
# The runtime credential: the Identity Module only constructs on a pool
# that authenticated directly as identity_app; NEVIX_DATABASE_URL stays the
# owner fixture/assertion credential.
identity_database_url="$(nevix_supabase_harness_identity_app_database_url nevix-ai 54322)"
export NEVIX_IDENTITY_DATABASE_URL="${identity_database_url}"
export NEVIX_SMTP_HOST="${mailpit_smtp_host}"
export NEVIX_SMTP_PORT="${mailpit_smtp_port}"
export NEVIX_SMTP_USER="mailpit"
export NEVIX_SMTP_PASSWORD="mailpit"
export NEVIX_OUTBOX_RETRY_DELAYS="1s,2s,3s,4s,5s"
export NEVIX_MAILPIT_CONTAINER="${mailpit_container}"
export NEVIX_VERIFICATION_CODE_HASH_KEY="mail-smoke-test-hash-key"
export NEVIX_SMTP_FROM="identity@nevix.test"
export NEVIX_AUTH_JWKS_URL="${supabase_url}/auth/v1/.well-known/jwks.json"
export NEVIX_CORS_ALLOWED_ORIGINS="http://127.0.0.1:5173"

identity_test_log="$(mktemp -t nevix-identity-integration.XXXXXX)"
set +e
go test -C server -race -count=1 -v ./internal/identity/integrationtest | tee "$identity_test_log"
test_status="${PIPESTATUS[0]}"
set -e
if [[ "$test_status" -ne 0 ]]; then
  exit "$test_status"
fi
assert_identity_integration_executed "$identity_test_log"

echo "==> Running database query-plan integration tests"
go test -C server -race -count=1 -v \
  -run '^(TestHistoricalInvitationCodeLookupUsesPartialIndex|TestIssuanceRateLimitQueriesConstrainCompositeIndexes)$' \
  ./internal/identity/invitations ./internal/identity/verification

echo "==> Identity integration tests passed"
