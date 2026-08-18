#!/usr/bin/env bash

set -euo pipefail

# full  — Full E2E Suite: configuration-failure builds, then every spec (default).
# smoke — Smoke Suite: one test-mode build, then only specs tagged @smoke.
# settings — Settings Information Architecture: one test-mode build, then the Settings and Members specs.
mode="${1:-full}"
case "$mode" in
  full | smoke | settings) ;;
  *)
    echo "usage: $0 [full|smoke|settings]" >&2
    exit 2
    ;;
esac

desktop_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$desktop_root/../.." && pwd)"
identity_server_pid=""
identity_server_log=""
identity_server_binary_dir=""
identity_server_failure_injector_pid=""
identity_server_artifact="$desktop_root/test-results/identity-server.log"
identity_server_failure_marker_dir=""
database_url=""
identity_database_url=""
publishable_key=""
service_role_key=""
identity_server_hash_key="desktop-e2e-test-hash-key"
identity_server_smtp_password="mailpit"
failure_injection="${NEVIX_TEST_INJECT_IDENTITY_SERVER_FAILURE:-}"

case "$failure_injection" in
  "" | after-renderer-launch) ;;
  *)
    echo "error: NEVIX_TEST_INJECT_IDENTITY_SERVER_FAILURE must be 'after-renderer-launch'" >&2
    exit 2
    ;;
esac

source "$repo_root/scripts/lib/supabase-local-harness.sh"

# Loopback traffic must never go through a developer HTTP proxy: the Supabase
# CLI, the Go server health check, and Electron's local test traffic all need
# to reach the pinned stack directly.
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,${NO_PROXY}}"
export no_proxy="${NO_PROXY}"

stop_identity_server_process() {
  if [[ -n "$identity_server_pid" ]]; then
    if kill -0 "$identity_server_pid" >/dev/null 2>&1; then
      kill "$identity_server_pid" >/dev/null 2>&1 || true
    fi
    wait "$identity_server_pid" >/dev/null 2>&1 || true
  fi
  identity_server_pid=""
}

stop_identity_server_failure_injector() {
  if [[ -n "$identity_server_failure_injector_pid" ]]; then
    if kill -0 "$identity_server_failure_injector_pid" >/dev/null 2>&1; then
      kill "$identity_server_failure_injector_pid" >/dev/null 2>&1 || true
    fi
    wait "$identity_server_failure_injector_pid" >/dev/null 2>&1 || true
  fi
  identity_server_failure_injector_pid=""
}

inject_identity_server_failure_after_renderer_launch() {
  for _ in $(seq 1 240); do
    if [[ -f "$identity_server_failure_marker_dir/request-ready" ]]; then
      if ! kill -0 "$identity_server_pid" >/dev/null 2>&1; then
        echo "controlled failure injection failed: identity server was already stopped" \
          >>"$identity_server_log"
        return 1
      fi

      kill "$identity_server_pid"
      for _ in $(seq 1 50); do
        if ! curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then
          echo "controlled failure injection: identity server stopped after renderer launch before the representative Desktop request" \
            >>"$identity_server_log"
          touch "$identity_server_failure_marker_dir/server-stopped"
          return
        fi
        sleep 0.1
      done

      echo "controlled failure injection failed: identity server remained healthy" \
        >>"$identity_server_log"
      return 1
    fi
    sleep 0.25
  done

  echo "controlled failure injection failed: the representative Desktop request was not armed" \
    >>"$identity_server_log"
  return 1
}

cleanup() {
  local exit_status="$1"
  local cleanup_status="$exit_status"

  stop_identity_server_failure_injector
  stop_identity_server_process
  if [[ -n "$identity_server_log" ]]; then
    if ! NEVIX_E2E_REDACT_DATABASE_URL="$database_url" \
      NEVIX_E2E_REDACT_IDENTITY_DATABASE_URL="$identity_database_url" \
      NEVIX_E2E_REDACT_SUPABASE_PUBLISHABLE_KEY="$publishable_key" \
      NEVIX_E2E_REDACT_SUPABASE_SERVICE_ROLE_KEY="$service_role_key" \
      NEVIX_E2E_REDACT_VERIFICATION_CODE_HASH_KEY="$identity_server_hash_key" \
      NEVIX_E2E_REDACT_SMTP_PASSWORD="$identity_server_smtp_password" \
      node "$desktop_root/scripts/finalize-e2e-server-log.mjs" \
        "$identity_server_log" "$identity_server_artifact" "$repo_root" "$exit_status"; then
      echo "error: failed to finalize the identity server E2E log" >&2
      rm -f "$identity_server_log"
      if [[ "$cleanup_status" == "0" ]]; then
        cleanup_status=1
      fi
    fi
    identity_server_log=""
  fi
  if [[ -n "$identity_server_binary_dir" ]]; then
    rm -rf "$identity_server_binary_dir"
    identity_server_binary_dir=""
  fi
  nevix_supabase_harness_cleanup "$cleanup_status"
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
      echo "A sanitized server log will be retained in test-results." >&2
      return 1
    fi
    sleep 0.5
  done

  echo "error: identity server did not become ready" >&2
  echo "A sanitized server log will be retained in test-results." >&2
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
    VERIFICATION_CODE_HASH_KEY="$identity_server_hash_key" \
    SMTP_FROM="identity@nevix.test" \
    SMTP_HOST="127.0.0.1" \
    SMTP_PORT="54325" \
    SMTP_USER="mailpit" \
    SMTP_PASSWORD="$identity_server_smtp_password" \
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
rm -f "$identity_server_artifact"

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
# The real Server runs on the ephemeral runtime credential that
# authenticates directly as identity_app — the same startup contract as
# production. The owner DB_URL above stays with the Playwright fixtures
# (seeding and authoritative assertions) and never reaches the server.
identity_database_url="$(nevix_supabase_harness_identity_app_database_url nevix-ai 54322)"
server_url="http://127.0.0.1:8080"

start_identity_server "$identity_database_url" "$api_url"

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
elif [[ "$mode" == "settings" ]]; then
  playwright_args=(
    tests/settings/settings-page.spec.ts
    tests/settings/settings-organization-picker.spec.ts
    tests/organization/members-management.spec.ts
    --workers=1
  )
fi
if [[ "$failure_injection" == "after-renderer-launch" ]]; then
  echo "==> Arming a controlled identity server failure after renderer launch"
  identity_server_failure_marker_dir="$identity_server_binary_dir/failure-injection"
  mkdir -p "$identity_server_failure_marker_dir"
  playwright_args=(tests/organization/onboarding.spec.ts --workers=1 --grep '@smoke')
  inject_identity_server_failure_after_renderer_launch &
  identity_server_failure_injector_pid=$!
fi

NEVIX_TEST_SUPABASE_URL="$api_url" \
  NEVIX_TEST_SUPABASE_PUBLISHABLE_KEY="$publishable_key" \
  NEVIX_TEST_SUPABASE_SERVICE_ROLE_KEY="$service_role_key" \
  NEVIX_TEST_DATABASE_URL="$database_url" \
  NEVIX_TEST_IDENTITY_SERVER_FAILURE_MARKER_DIR="$identity_server_failure_marker_dir" \
  NEVIX_TEST_MAILPIT_URL="$mailpit_url" \
  NEVIX_TEST_SERVER_URL="$server_url" \
  pnpm exec playwright test "${playwright_args[@]}"

if [[ -n "$identity_server_failure_injector_pid" ]]; then
  wait "$identity_server_failure_injector_pid"
  identity_server_failure_injector_pid=""
fi

if [[ "$mode" == "full" ]]; then
  NEVIX_TEST_SUPABASE_SERVICE_ROLE_KEY="$service_role_key" \
    pnpm verify:auth-artifacts
fi
