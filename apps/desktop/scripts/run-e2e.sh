#!/usr/bin/env bash

set -euo pipefail

# full  — Full E2E Suite: configuration-failure builds, then every spec (default).
# smoke — Smoke Suite: one test-mode build, then only specs tagged @smoke.
mode="${1:-full}"
case "$mode" in
  full | smoke) ;;
  *)
    echo "usage: $0 [full|smoke]" >&2
    exit 2
    ;;
esac

desktop_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$desktop_root/../.." && pwd)"
identity_server_pid=""
identity_server_log=""
identity_server_binary_dir=""

source "$repo_root/scripts/lib/supabase-local-harness.sh"

# Loopback traffic must never go through a developer HTTP proxy: the Supabase
# CLI, the Go server health check, and Electron's local test traffic all need
# to reach the pinned stack directly.
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,${NO_PROXY}}"
export no_proxy="${NO_PROXY}"

stop_identity_server() {
  if [[ -n "$identity_server_pid" ]] && kill -0 "$identity_server_pid" >/dev/null 2>&1; then
    kill "$identity_server_pid" >/dev/null 2>&1 || true
    wait "$identity_server_pid" >/dev/null 2>&1 || true
  fi
  identity_server_pid=""
  if [[ -n "$identity_server_log" ]]; then
    rm -f "$identity_server_log"
  fi
  if [[ -n "$identity_server_binary_dir" ]]; then
    rm -rf "$identity_server_binary_dir"
  fi
}

cleanup() {
  local exit_status="$1"

  stop_identity_server
  nevix_supabase_harness_cleanup "$exit_status"
}

json_value() {
  STATUS_JSON="$1" STATUS_KEY="$2" node -e '
    const status = JSON.parse(process.env.STATUS_JSON)
    const value = status[process.env.STATUS_KEY]
    if (typeof value !== "string" || value.length === 0) process.exit(1)
    process.stdout.write(value)
  '
}

wait_for_identity_server() {
  for _ in $(seq 1 120); do
    if curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then
      return
    fi
    if ! kill -0 "$identity_server_pid" >/dev/null 2>&1; then
      echo "error: identity server stopped before its health endpoint was ready" >&2
      cat "$identity_server_log" >&2
      return 1
    fi
    sleep 0.5
  done

  echo "error: identity server did not become ready" >&2
  cat "$identity_server_log" >&2
  return 1
}

start_identity_server() {
  local database_url="$1"
  local supabase_url="$2"
  local identity_server_binary

  identity_server_binary_dir="$(mktemp -d -t nevix-identity-e2e.XXXXXX)"
  identity_server_binary="$identity_server_binary_dir/server"
  (
    cd "$repo_root/server"
    go build -o "$identity_server_binary" ./cmd/server
  )

  identity_server_log="$(mktemp -t nevix-identity-e2e.XXXXXX.log)"
  DATABASE_URL="$database_url" \
    AUTH_JWKS_URL="$supabase_url/auth/v1/.well-known/jwks.json" \
    CORS_ALLOWED_ORIGINS="http://127.0.0.1:5173" \
    VERIFICATION_CODE_HASH_KEY="desktop-e2e-test-hash-key" \
    SMTP_FROM="identity@nevix.test" \
    SMTP_HOST="127.0.0.1" \
    SMTP_PORT="54325" \
    SMTP_USER="mailpit" \
    SMTP_PASSWORD="mailpit" \
    OUTBOX_RETRY_DELAYS="1s,2s,3s,4s,5s" \
    "$identity_server_binary" >"$identity_server_log" 2>&1 &
  identity_server_pid=$!
  wait_for_identity_server
}

trap 'exit_status=$?; trap - EXIT; cleanup "$exit_status"; exit $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

nevix_supabase_harness_acquire "$repo_root" desktop-e2e
nevix_supabase_harness_require_clean_projects nevix-ai nevix-authentication-e2e
nevix_supabase_harness_require_free_tcp_ports 54320 54321 54322 54324 54325 8080

cd "$desktop_root"

if [[ "$mode" == "full" ]]; then
  pnpm typecheck

  env \
    -u VITE_SUPABASE_URL \
    -u VITE_SUPABASE_PUBLISHABLE_KEY \
    -u VITE_SERVER_URL \
    pnpm exec electron-vite build --mode production
  NEVIX_EXPECT_INVALID_SUPABASE_CONFIG=1 \
    pnpm exec playwright test tests/auth/configuration.spec.ts --workers=1

  env \
    -u VITE_SERVER_URL \
    VITE_SUPABASE_URL=https://example.supabase.co \
    VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_invalid \
    pnpm exec electron-vite build --mode production
  NEVIX_EXPECT_INVALID_SUPABASE_CONFIG=1 \
    pnpm exec playwright test tests/auth/configuration.spec.ts --workers=1

  env \
    -u VITE_SERVER_URL \
    VITE_SUPABASE_URL=https://example.supabase.co \
    VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_abcdefghijklmnopqrst \
    pnpm exec electron-vite build --mode production
  NEVIX_EXPECT_INVALID_SERVER_CONFIG=1 \
    pnpm exec playwright test tests/auth/configuration.spec.ts --workers=1
fi

nevix_supabase_harness_claim_stack nevix-ai
pnpm --dir "$repo_root" exec supabase start \
  -x realtime,storage-api,imgproxy,postgres-meta,studio,edge-runtime,logflare,vector,supavisor \
  >/dev/null
pnpm --dir "$repo_root" exec supabase db reset --local >/dev/null

status_json="$(pnpm --dir "$repo_root" exec supabase status -o json)"
api_url="$(json_value "$status_json" API_URL)"
publishable_key="$(json_value "$status_json" PUBLISHABLE_KEY)"
service_role_key="$(json_value "$status_json" SERVICE_ROLE_KEY)"
mailpit_url="$(json_value "$status_json" INBUCKET_URL)"
database_url="$(json_value "$status_json" DB_URL)"
server_url="http://127.0.0.1:8080"

start_identity_server "$database_url" "$api_url"

if [[ "$mode" == "full" ]]; then
  env \
    -u VITE_SERVER_URL \
    VITE_SUPABASE_URL=http://192.168.1.50:8000 \
    VITE_SUPABASE_PUBLISHABLE_KEY="$publishable_key" \
    pnpm exec electron-vite build --mode production
  NEVIX_EXPECT_PRODUCTION_PRIVATE_HTTP_BLOCK=1 \
    pnpm exec playwright test tests/auth/configuration.spec.ts --workers=1
fi

VITE_SUPABASE_URL="$api_url" \
  VITE_SUPABASE_PUBLISHABLE_KEY="$publishable_key" \
  VITE_SERVER_URL="$server_url" \
  pnpm exec electron-vite build --mode test

playwright_args=(--workers=2)
if [[ "$mode" == "smoke" ]]; then
  playwright_args+=(--grep '@smoke')
fi

NEVIX_TEST_SUPABASE_URL="$api_url" \
  NEVIX_TEST_SUPABASE_PUBLISHABLE_KEY="$publishable_key" \
  NEVIX_TEST_SUPABASE_SERVICE_ROLE_KEY="$service_role_key" \
  NEVIX_TEST_DATABASE_URL="$database_url" \
  NEVIX_TEST_MAILPIT_URL="$mailpit_url" \
  NEVIX_TEST_SERVER_URL="$server_url" \
  pnpm exec playwright test "${playwright_args[@]}"

if [[ "$mode" == "full" ]]; then
  NEVIX_TEST_SUPABASE_SERVICE_ROLE_KEY="$service_role_key" \
    pnpm verify:auth-artifacts
fi
