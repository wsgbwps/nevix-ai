#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_root="$(mktemp -d -t nevix-supabase-harness-test.XXXXXX)"
export TMPDIR="$test_root"
listener_pid=""
exec_sql_file="$test_root/provision.sql"
docker_exec_status=0

cleanup_test_root() {
  if [[ -n "$listener_pid" ]] && kill -0 "$listener_pid" >/dev/null 2>&1; then
    kill "$listener_pid" >/dev/null 2>&1 || true
    wait "$listener_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$test_root"
}
trap 'exit_status=$?; trap - EXIT; cleanup_test_root; exit "$exit_status"' EXIT

source "$repo_root/scripts/lib/supabase-local-harness.sh"

docker_state="clean"
pnpm_exit_status=0
pnpm_log="$test_root/pnpm.log"

fail() {
  echo "not ok - $1" >&2
  exit 1
}

docker() {
  case "$1 ${2:-}" in
    "info ")
      return 0
      ;;
    "container ls")
      [[ "$docker_state" != "container" ]] || echo "supabase_db_nevix-ai"
      ;;
    "volume ls")
      [[ "$docker_state" != "volume" ]] || echo "supabase_db_nevix-ai"
      ;;
    "network ls")
      [[ "$docker_state" != "network" ]] || echo "supabase_network_nevix-ai"
      ;;
    "exec -i")
      [[ "$3" == "supabase_db_nevix-ai" ]] || fail "unexpected provisioning container: $*"
      cat >"$exec_sql_file"
      return "$docker_exec_status"
      ;;
    *)
      fail "unexpected docker invocation: $*"
      ;;
  esac
}

pnpm() {
  printf '%s\n' "$*" >>"$pnpm_log"
  return "$pnpm_exit_status"
}

reset_guard() {
  NEVIX_SUPABASE_HARNESS_LOCK_HELD=0
  NEVIX_SUPABASE_HARNESS_STACK_OWNED=0
  NEVIX_SUPABASE_HARNESS_LOCK_DIR=""
  NEVIX_SUPABASE_HARNESS_REPO_ROOT=""
  NEVIX_SUPABASE_HARNESS_PROJECT_ID=""
  docker_state="clean"
  pnpm_exit_status=0
  : >"$pnpm_log"
}

expect_shared_state_refusal() {
  local state="$1"

  reset_guard
  docker_state="$state"
  nevix_supabase_harness_acquire "$repo_root" "test-$state"
  if nevix_supabase_harness_require_clean_projects nevix-ai >/dev/null 2>&1; then
    fail "$state state was accepted"
  fi
  nevix_supabase_harness_cleanup 0
  [[ ! -d "$NEVIX_SUPABASE_HARNESS_LOCK_DIR" ]] || fail "$state refusal left the lock behind"
}

expect_shared_state_refusal container
expect_shared_state_refusal volume
expect_shared_state_refusal network
echo "ok - existing containers, volumes, and networks fail closed"

reset_guard
nevix_supabase_harness_acquire "$repo_root" first
if bash -c 'source "$1/scripts/lib/supabase-local-harness.sh"; TMPDIR="$2"; nevix_supabase_harness_acquire "$1" second' \
  _ "$repo_root" "$test_root" >/dev/null 2>&1; then
  fail "concurrent harness acquired the lock"
fi
nevix_supabase_harness_cleanup 0
echo "ok - concurrent harness fails closed"

port_file="$test_root/listener.port"
node -e '
  const fs = require("node:fs")
  const net = require("node:net")
  const server = net.createServer()
  server.listen(0, "127.0.0.1", () => fs.writeFileSync(process.argv[1], String(server.address().port)))
' "$port_file" &
listener_pid=$!
for _ in $(seq 1 50); do
  [[ ! -s "$port_file" ]] || break
  sleep 0.02
done
[[ -s "$port_file" ]] || fail "temporary TCP listener did not start"
occupied_port="$(<"$port_file")"
if nevix_supabase_harness_require_free_tcp_ports "$occupied_port" >/dev/null 2>&1; then
  fail "occupied TCP port was accepted"
fi
kill "$listener_pid"
wait "$listener_pid" >/dev/null 2>&1 || true
listener_pid=""
nevix_supabase_harness_require_free_tcp_ports "$occupied_port"
echo "ok - occupied harness ports fail closed"

reset_guard
nevix_supabase_harness_acquire "$repo_root" cleanup-test
nevix_supabase_harness_require_clean_projects nevix-ai
nevix_supabase_harness_claim_stack nevix-ai
nevix_supabase_harness_cleanup 0
expected_stop="--dir $repo_root exec supabase stop --project-id nevix-ai --no-backup"
[[ "$(<"$pnpm_log")" == "$expected_stop" ]] || fail "cleanup was not scoped to the claimed project"
echo "ok - cleanup targets only the claimed project"

reset_guard
nevix_supabase_harness_acquire "$repo_root" cleanup-failure-test
nevix_supabase_harness_require_clean_projects nevix-ai
nevix_supabase_harness_claim_stack nevix-ai
pnpm_exit_status=1
if nevix_supabase_harness_cleanup 0 >/dev/null 2>&1; then
  fail "cleanup failure preserved a successful exit"
fi
[[ ! -d "$NEVIX_SUPABASE_HARNESS_LOCK_DIR" ]] || fail "cleanup failure left the lock behind"
echo "ok - cleanup failure makes a successful run fail"

# The identity_app runtime-credential provisioning rule shared by the Go
# integration and Desktop E2E harnesses.
runtime_url="$(nevix_supabase_harness_identity_app_database_url nevix-ai 54322)" \
  || fail "identity_app credential provisioning failed"
[[ "$runtime_url" =~ ^postgresql://identity_app:[0-9a-f]{64}@127\.0\.0\.1:54322/postgres\?sslmode=disable$ ]] \
  || fail "unexpected runtime url: $runtime_url"
grep -Eq "^ALTER ROLE identity_app PASSWORD '[0-9a-f]{64}';$" "$exec_sql_file" \
  || fail "provisioning did not set a random identity_app password via the db container"
second_url="$(nevix_supabase_harness_identity_app_database_url nevix-ai 54322)" \
  || fail "second identity_app credential provisioning failed"
[[ "$second_url" != "$runtime_url" ]] || fail "provisioning reused the previous password"
echo "ok - identity_app runtime credential is a fresh direct-login URL"

docker_exec_status=1
if nevix_supabase_harness_identity_app_database_url nevix-ai 54322 >/dev/null 2>&1; then
  fail "identity_app credential provisioning succeeded despite a failing db container"
fi
echo "ok - identity_app credential provisioning fails closed"
