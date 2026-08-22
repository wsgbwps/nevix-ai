#!/usr/bin/env bash

set -euo pipefail

# full  — Full E2E Suite: configuration-failure builds, then every spec (default).
# smoke — Smoke Suite: one test-mode build, then only specs tagged @smoke.
# settings — Settings Information Architecture: one test-mode build, then the Settings spec.
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
tls_terminator_pid=""
tls_terminator_dir=""
tls_terminator_log=""
postgres_container=""
database_url=""
identity_database_url=""
admin_email="bootstrap.admin@nevix.test"
admin_initial_password="initial-horse-battery-staple"
tls_host=127.0.0.1
tls_port=8443
failure_injection="${NEVIX_TEST_INJECT_IDENTITY_SERVER_FAILURE:-}"

case "$failure_injection" in
  "" | after-renderer-launch) ;;
  *)
    echo "error: NEVIX_TEST_INJECT_IDENTITY_SERVER_FAILURE must be 'after-renderer-launch'" >&2
    exit 2
    ;;
esac

# Loopback traffic must never go through a developer HTTP proxy: the Go server
# health check, PostgreSQL provisioning, and Electron's local test traffic all
# need to reach the pinned stack directly.
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,${NO_PROXY}}"
export no_proxy="${NO_PROXY}"

postgres_image="postgres:17.5-alpine"
postgres_host_port=54391
lock_dir="${TMPDIR:-/tmp}/nevix-ai-desktop-e2e-postgres.lock"

acquire_lock() {
  if ! mkdir "$lock_dir" 2>/dev/null; then
    echo "error: another Desktop E2E harness owns $lock_dir" >&2
    if [[ -r "$lock_dir/owner" ]]; then
      echo "owner:" >&2
      sed 's/^/  /' "$lock_dir/owner" >&2
    fi
    echo "Refusing to start a second Desktop E2E stack. Inspect the owner before recovery." >&2
    return 1
  fi
  printf 'pid=%s\nworkspace=%s\n' "$$" "$repo_root" >"$lock_dir/owner"
}

require_free_port() {
  if (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; then
    echo "error: required harness port 127.0.0.1:$1 is already in use" >&2
    echo "Refusing to attach tests to an unowned local service." >&2
    return 1
  fi
}

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

stop_tls_terminator() {
  if [[ -n "$tls_terminator_pid" ]]; then
    if kill -0 "$tls_terminator_pid" >/dev/null 2>&1; then
      kill "$tls_terminator_pid" >/dev/null 2>&1 || true
    fi
    wait "$tls_terminator_pid" >/dev/null 2>&1 || true
  fi
  tls_terminator_pid=""
  if [[ -n "$tls_terminator_log" ]]; then
    cat "$tls_terminator_log" >>"$identity_server_log" 2>/dev/null || true
    rm -f "$tls_terminator_log"
    tls_terminator_log=""
  fi
  if [[ -n "$tls_terminator_dir" ]]; then
    rm -rf "$tls_terminator_dir"
    tls_terminator_dir=""
  fi
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
  stop_tls_terminator
  stop_identity_server_process
  if [[ -n "$identity_server_log" ]]; then
    if ! NEVIX_E2E_REDACT_DATABASE_URL="$database_url" \
      NEVIX_E2E_REDACT_IDENTITY_DATABASE_URL="$identity_database_url" \
      NEVIX_E2E_REDACT_ADMIN_INITIAL_PASSWORD="$admin_initial_password" \
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
  if [[ -n "$postgres_container" ]]; then
    docker rm -f "$postgres_container" >/dev/null 2>&1 || true
    postgres_container=""
  fi
  if [[ -d "$lock_dir" ]]; then
    rm -f "$lock_dir/owner"
    rmdir "$lock_dir" 2>/dev/null || true
  fi
  return "$cleanup_status"
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

start_postgres() {
  local postgres_password
  local identity_app_password

  postgres_password="$(openssl rand -hex 32)"
  identity_app_password="$(openssl rand -hex 32)"
  postgres_container="nevix-desktop-e2e-pg-$$"

  echo "==> Starting pinned PostgreSQL ($postgres_image) on 127.0.0.1:$postgres_host_port"
  docker run --rm -d \
    --name "$postgres_container" \
    -e "POSTGRES_PASSWORD=$postgres_password" \
    -p "127.0.0.1:$postgres_host_port:5432" \
    "$postgres_image" >/dev/null

  for attempt in $(seq 1 60); do
    if docker exec "$postgres_container" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
      break
    fi
    if [[ "$attempt" -eq 60 ]]; then
      echo "error: PostgreSQL was not ready after 60 attempts" >&2
      return 1
    fi
    sleep 1
  done

  echo "==> Provisioning the identity_app runtime credential"
  docker exec -i "$postgres_container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 >/dev/null <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'identity_app') THEN
    CREATE ROLE identity_app LOGIN;
  END IF;
END
\$\$;
ALTER ROLE identity_app PASSWORD '$identity_app_password';
SQL

  # MIGRATION_DATABASE_URL stays with the Goose owner credential; the runtime
  # DATABASE_URL authenticates directly as identity_app — the same startup
  # contract as production (ADR-0015).
  database_url="postgresql://identity_app:${identity_app_password}@127.0.0.1:${postgres_host_port}/postgres?sslmode=disable"
  identity_database_url="postgresql://postgres:${postgres_password}@127.0.0.1:${postgres_host_port}/postgres?sslmode=disable"
}

start_identity_server() {
  local identity_server_binary

  identity_server_binary_dir="$(mktemp -d -t nevix-identity-e2e.XXXXXX)"
  identity_server_binary="$identity_server_binary_dir/server"
  (
    cd "$repo_root/server"
    go build -o "$identity_server_binary" ./cmd/server
  )

  identity_server_log="$(mktemp -t nevix-identity-e2e.XXXXXX.log)"
  DATABASE_URL="$database_url" \
    MIGRATION_DATABASE_URL="$identity_database_url" \
    CORS_ALLOWED_ORIGINS="http://127.0.0.1:5173" \
    ADMIN_EMAIL="$admin_email" \
    ADMIN_INITIAL_PASSWORD="$admin_initial_password" \
    "$identity_server_binary" >"$identity_server_log" 2>&1 &
  identity_server_pid=$!
  wait_for_identity_server
}

# The bootstrap admin owes the first-login password change; completing it once over
# raw HTTP leaves a stable administrative credential for the whole suite, exactly
# like an operator would after first boot.
stabilize_bootstrap_admin() {
  local login_body
  local admin_token

  login_body="$(curl -fsS -X POST http://127.0.0.1:8080/identity/auth/login \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$admin_email\",\"password\":\"$admin_initial_password\"}")"
  admin_token="$(LOGIN_BODY="$login_body" node -e '
    const body = JSON.parse(process.env.LOGIN_BODY)
    if (typeof body.token !== "string" || body.token.length === 0) process.exit(1)
    process.stdout.write(body.token)
  ')"

  curl -fsS -X POST http://127.0.0.1:8080/identity/auth/change-password \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $admin_token" \
    -d "{\"current_password\":\"$admin_initial_password\",\"new_password\":\"$admin_initial_password\"}" \
    >/dev/null
}

# The TLS terminator fronts the identity server with a self-signed certificate
# so the TOFU specs exercise a genuinely untrusted chain, and can rotate to a
# second certificate mid-run for the fingerprint-change warning.
start_tls_terminator() {
  tls_terminator_dir="$(mktemp -d -t nevix-desktop-e2e-tls.XXXXXX)"
  for cert in a b; do
    openssl req -x509 -newkey rsa:2048 -sha256 -days 2 -nodes \
      -keyout "$tls_terminator_dir/key-$cert.pem" \
      -out "$tls_terminator_dir/cert-$cert.pem" \
      -subj "/CN=localhost" \
      -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" >/dev/null 2>&1
  done
  printf '{"cert":"cert-a.pem","key":"key-a.pem"}' >"$tls_terminator_dir/rotation.json"

  tls_terminator_log="$(mktemp -t nevix-desktop-e2e-tls.XXXXXX.log)"
  node "$desktop_root/tests/connection/helpers/tls-terminator.mjs" \
    --listen="$tls_host:$tls_port" \
    --target="http://127.0.0.1:8080" \
    --rotation-file="$tls_terminator_dir/rotation.json" >"$tls_terminator_log" 2>&1 &
  tls_terminator_pid=$!

  for _ in $(seq 1 40); do
    if curl -fsk "https://$tls_host:$tls_port/health" >/dev/null 2>&1; then
      return
    fi
    if ! kill -0 "$tls_terminator_pid" >/dev/null 2>&1; then
      echo "error: TLS terminator stopped before its health endpoint was ready" >&2
      return 1
    fi
    sleep 0.25
  done

  echo "error: TLS terminator did not become ready" >&2
  return 1
}

tls_fingerprint() {
  openssl x509 -in "$tls_terminator_dir/cert-$1.pem" -noout -fingerprint -sha256 \
    | cut -d= -f2
}

trap 'exit_status=$?; trap - EXIT; cleanup "$exit_status"; exit $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$desktop_root"
rm -f "$identity_server_artifact"

if [[ "$mode" == "full" ]]; then
  pnpm typecheck
fi

acquire_lock
require_free_port "$postgres_host_port"
require_free_port 8080
require_free_port "$tls_port"

start_postgres
start_identity_server
stabilize_bootstrap_admin
start_tls_terminator
server_url="http://127.0.0.1:8080"

pnpm exec electron-vite build --mode test

playwright_args=(--workers=2)
if [[ "$mode" == "smoke" ]]; then
  playwright_args+=(--grep '@smoke')
elif [[ "$mode" == "settings" ]]; then
  playwright_args=(
    tests/settings/settings-page.spec.ts
    --workers=1
  )
fi
if [[ "$failure_injection" == "after-renderer-launch" ]]; then
  echo "==> Arming a controlled identity server failure after renderer launch"
  identity_server_failure_marker_dir="$identity_server_binary_dir/failure-injection"
  mkdir -p "$identity_server_failure_marker_dir"
  playwright_args=(tests/auth/first-login-change-password.spec.ts --workers=1 --grep '@smoke')
  inject_identity_server_failure_after_renderer_launch &
  identity_server_failure_injector_pid=$!
fi

NEVIX_TEST_SERVER_URL="$server_url" \
  NEVIX_TEST_ADMIN_EMAIL="$admin_email" \
  NEVIX_TEST_ADMIN_INITIAL_PASSWORD="$admin_initial_password" \
  NEVIX_TEST_IDENTITY_SERVER_FAILURE_MARKER_DIR="$identity_server_failure_marker_dir" \
  NEVIX_TEST_TLS_URL="https://$tls_host:$tls_port" \
  NEVIX_TEST_TLS_DIR="$tls_terminator_dir" \
  NEVIX_TEST_TLS_FINGERPRINT_A="$(tls_fingerprint a)" \
  NEVIX_TEST_TLS_FINGERPRINT_B="$(tls_fingerprint b)" \
  NEVIX_E2E_RUN_ID="$(date +%s)-$$" \
  pnpm exec playwright test "${playwright_args[@]}"

if [[ -n "$identity_server_failure_injector_pid" ]]; then
  wait "$identity_server_failure_injector_pid"
  identity_server_failure_injector_pid=""
fi

if [[ "$mode" == "full" ]]; then
  NEVIX_TEST_ADMIN_INITIAL_PASSWORD="$admin_initial_password" \
    pnpm verify:auth-artifacts
fi
