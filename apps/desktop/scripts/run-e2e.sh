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
setup_server_container=""
setup_server_port=8081
setup_server_url=""
setup_code=""
open_server_container=""
open_server_port=8082
open_server_url=""
e2e_network=""
setup_wizard_database="setup_wizard"
open_claim_database="instance_claim"
tls_terminator_pid=""
tls_terminator_dir=""
tls_terminator_log=""
postgres_container=""
database_url=""
identity_database_url=""
postgres_password=""
identity_app_password=""
admin_email="e2e.admin@nevix.test"
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
setup_server_image="alpine:3.21"
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

# The two disposable empty-instance servers for the Instance Claim specs (issue
# #128): each is a second server binary in a container — the port is hardcoded
# :8080 in the product and PORT configurability belongs to the Docker-delivery
# issue — against its own never-claimed database on the same PostgreSQL. One
# runs protected (NEVIX_SETUP_CODE_REQUIRED=true; its operations log holds the
# one-time setup code the spec redeems), the other runs the default open
# claim.
stop_setup_server() {
  if [[ -n "$setup_server_container" ]]; then
    docker logs "$setup_server_container" >>"$identity_server_log" 2>&1 || true
    docker rm -f "$setup_server_container" >/dev/null 2>&1 || true
    setup_server_container=""
  fi
  if [[ -n "$open_server_container" ]]; then
    docker logs "$open_server_container" >>"$identity_server_log" 2>&1 || true
    docker rm -f "$open_server_container" >/dev/null 2>&1 || true
    open_server_container=""
  fi
  if [[ -n "$e2e_network" ]]; then
    if [[ -n "$postgres_container" ]]; then
      docker network disconnect -f "$e2e_network" "$postgres_container" >/dev/null 2>&1 || true
    fi
    docker network rm "$e2e_network" >/dev/null 2>&1 || true
    e2e_network=""
  fi
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
  stop_setup_server
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

# The postgres entrypoint's initdb phase briefly runs a temporary server that
# accepts connections before shutting down; pg_isready can answer from it, so
# provisioning SQL retries until any accepting server commits it. Provisioning
# committed against the temporary server persists — the data directory carries
# it into the real one.
psql_until_ready() {
  local attempt
  for attempt in $(seq 1 30); do
    if docker exec -i "$postgres_container" psql -U postgres -d postgres -v ON_ERROR_STOP=1; then
      return 0
    fi
    sleep 1
  done
  echo "error: PostgreSQL never accepted provisioning SQL" >&2
  return 1
}

start_postgres() {
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
  psql_until_ready >/dev/null <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'identity_app') THEN
    CREATE ROLE identity_app LOGIN;
  END IF;
END
\$\$;
ALTER ROLE identity_app PASSWORD '$identity_app_password';
SQL

  # The Instance Claim specs need instances that have never been claimed: two
  # more databases on the same PostgreSQL, migrated (and protected or not) by
  # their own server processes.
  psql_until_ready >/dev/null <<SQL
SELECT 'CREATE DATABASE $setup_wizard_database'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$setup_wizard_database')\gexec
SELECT 'CREATE DATABASE $open_claim_database'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$open_claim_database')\gexec
SQL

  # The empty-instance server runs as a container (its port is the product's
  # hardcoded :8080); a user-defined bridge network lets it reach this
  # PostgreSQL by name.
  e2e_network="nevix-desktop-e2e-net-$$"
  docker network create "$e2e_network" >/dev/null
  docker network connect --alias postgres "$e2e_network" "$postgres_container" >/dev/null

  # MIGRATION_DATABASE_URL stays with the Goose owner credential; the runtime
  # DATABASE_URL authenticates directly as identity_app — the same startup
  # contract as production (ADR-0015).
  database_url="postgresql://identity_app:${identity_app_password}@127.0.0.1:${postgres_host_port}/postgres?sslmode=disable"
  identity_database_url="postgresql://postgres:${postgres_password}@127.0.0.1:${postgres_host_port}/postgres?sslmode=disable"
}

# Builds the linux server binary both disposable instances share, then boots
# one of them. run_disposable_server takes container name, host port, target
# database, and extra env (KEY=VALUE strings); it waits for health and echoes
# nothing on success.
build_linux_server_binary() {
  local docker_arch goarch

  docker_arch="$(docker version --format '{{.Server.Arch}}')"
  case "$docker_arch" in
    arm64 | aarch64) goarch=arm64 ;;
    *) goarch=amd64 ;;
  esac
  (cd "$repo_root/server" &&
    CGO_ENABLED=0 GOOS=linux GOARCH="$goarch" go build \
      -o "$identity_server_binary_dir/server-linux" ./cmd/server)
}

run_disposable_server() {
  local container="$1"
  local host_port="$2"
  local target_database="$3"
  shift 3

  docker run -d \
    --name "$container" \
    --network "$e2e_network" \
    -p "127.0.0.1:$host_port:8080" \
    -e DATABASE_URL="postgresql://identity_app:${identity_app_password}@postgres:5432/${target_database}?sslmode=disable" \
    -e MIGRATION_DATABASE_URL="postgresql://postgres:${postgres_password}@postgres:5432/${target_database}?sslmode=disable" \
    -e CORS_ALLOWED_ORIGINS="http://127.0.0.1:5173" \
    "$@" \
    -v "$identity_server_binary_dir:/binaries:ro" \
    "$setup_server_image" /binaries/server-linux >/dev/null

  for _ in $(seq 1 120); do
    if curl -fsS "http://127.0.0.1:$host_port/health" >/dev/null 2>&1; then
      return
    fi
    if ! docker container inspect "$container" >/dev/null 2>&1; then
      echo "error: disposable server $container stopped before its health endpoint was ready" >&2
      docker logs "$container" >&2 || true
      return 1
    fi
    sleep 0.5
  done

  echo "error: disposable server $container did not become ready" >&2
  docker logs "$container" >&2 || true
  return 1
}

# The protected empty instance: NEVIX_SETUP_CODE_REQUIRED=true makes its
# startup generate the one-time setup code, printed once to its log, which
# this function parses and exports for the setup-wizard spec.
start_setup_server() {
  build_linux_server_binary

  # No --rm: an early exit keeps its logs for the failure report; cleanup
  # removes the container either way.
  setup_server_container="nevix-desktop-e2e-setup-$$"
  run_disposable_server "$setup_server_container" "$setup_server_port" "$setup_wizard_database" \
    -e NEVIX_SETUP_CODE_REQUIRED=true || return 1

  setup_code="$(docker logs "$setup_server_container" 2>&1 \
    | grep -oE 'setup_code=[0-9A-Z]{4}-[0-9A-Z]{4}' | head -1 | cut -d= -f2)"
  if [[ -z "$setup_code" ]]; then
    echo "error: protected empty-instance server started without disclosing a setup code" >&2
    docker logs "$setup_server_container" >&2 || true
    return 1
  fi
  setup_server_url="http://127.0.0.1:$setup_server_port"
  echo "==> Protected empty-instance server ready on $setup_server_url (setup wizard target)"
}

# The open empty instance: default claim, no credential and no log line.
start_open_server() {
  open_server_container="nevix-desktop-e2e-open-$$"
  run_disposable_server "$open_server_container" "$open_server_port" "$open_claim_database" \
    || return 1
  open_server_url="http://127.0.0.1:$open_server_port"
  echo "==> Open empty-instance server ready on $open_server_url (instance claim target)"
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
    "$identity_server_binary" >"$identity_server_log" 2>&1 &
  identity_server_pid=$!
  wait_for_identity_server
}

# The suite's test admin comes from the public Instance Claim — the same open
# channel an operator's first administrator uses — never from deleted
# environment bootstrap variables. The claimer chose the password, so no
# first-login change is owed: the credential is stable for the whole suite.
# The display name derives from the email local part, as the audit list's
# actor column shows it.
claim_main_instance() {
  curl -fsS -X POST http://127.0.0.1:8080/identity/setup/initialize \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$admin_email\",\"password\":\"$admin_initial_password\"}" \
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
require_free_port "$setup_server_port"
require_free_port "$open_server_port"

start_postgres
start_identity_server
claim_main_instance
start_tls_terminator
server_url="http://127.0.0.1:8080"
# The disposable empty instances exist for the Instance Claim specs, which run
# in the full suite only.
if [[ "$mode" == "full" ]]; then
  start_setup_server
  start_open_server
fi

pnpm exec electron-vite build --mode test

# The suite shares one identity server: join-code state is global to it, and
# settings specs assert the active-code list's emptiness. Registration specs
# (tests/auth) mint and revoke codes too, so parallel files could expose an
# active code to those assertions — the suite runs serially, keeping every
# global-state assertion deterministic.
playwright_args=(--workers=1)
if [[ "$mode" == "smoke" ]]; then
  playwright_args+=(--grep '@smoke')
elif [[ "$mode" == "settings" ]]; then
  playwright_args+=(
    tests/settings/settings-page.spec.ts
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
  NEVIX_TEST_SETUP_SERVER_URL="$setup_server_url" \
  NEVIX_TEST_SETUP_CODE="$setup_code" \
  NEVIX_TEST_OPEN_SERVER_URL="$open_server_url" \
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
