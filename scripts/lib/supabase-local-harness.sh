#!/usr/bin/env bash

# Shared lifecycle guard for the repository's destructive local Supabase test
# harnesses. Callers must acquire the lock, require clean project state, and
# claim ownership immediately before `supabase start`.

NEVIX_SUPABASE_HARNESS_LOCK_HELD=0
NEVIX_SUPABASE_HARNESS_STACK_OWNED=0
NEVIX_SUPABASE_HARNESS_LOCK_DIR=""
NEVIX_SUPABASE_HARNESS_REPO_ROOT=""
NEVIX_SUPABASE_HARNESS_PROJECT_ID=""

nevix_supabase_harness_acquire() {
  local repo_root="$1"
  local harness_name="$2"
  local lock_parent="${TMPDIR:-/tmp}"
  local owner_file

  NEVIX_SUPABASE_HARNESS_LOCK_DIR="${lock_parent%/}/nevix-ai-supabase-local-harness.lock"
  owner_file="$NEVIX_SUPABASE_HARNESS_LOCK_DIR/owner"

  if ! mkdir "$NEVIX_SUPABASE_HARNESS_LOCK_DIR" 2>/dev/null; then
    echo "error: another Supabase integration harness owns $NEVIX_SUPABASE_HARNESS_LOCK_DIR" >&2
    if [[ -r "$owner_file" ]]; then
      echo "owner:" >&2
      sed 's/^/  /' "$owner_file" >&2
    fi
    echo "Refusing to start, stop, or reset Supabase. Inspect the owner and Docker state before recovery." >&2
    return 1
  fi

  NEVIX_SUPABASE_HARNESS_LOCK_HELD=1
  NEVIX_SUPABASE_HARNESS_REPO_ROOT="$repo_root"
  if ! printf 'pid=%s\nharness=%s\nworkspace=%s\n' \
    "$$" "$harness_name" "$repo_root" >"$owner_file"; then
    rmdir "$NEVIX_SUPABASE_HARNESS_LOCK_DIR" 2>/dev/null || true
    NEVIX_SUPABASE_HARNESS_LOCK_HELD=0
    echo "error: could not record Supabase integration harness ownership" >&2
    return 1
  fi
}

nevix_supabase_harness_require_clean_projects() {
  local project_id
  local containers
  local volumes
  local networks

  if ! docker info >/dev/null 2>&1; then
    echo "error: Docker is unavailable; refusing to run the Supabase integration harness" >&2
    return 1
  fi

  for project_id in "$@"; do
    if ! containers="$(docker container ls --all \
      --filter "label=com.supabase.cli.project=$project_id" \
      --format '{{.Names}}')"; then
      echo "error: could not inspect Supabase containers for project '$project_id'" >&2
      return 1
    fi
    if ! volumes="$(docker volume ls \
      --filter "label=com.supabase.cli.project=$project_id" \
      --format '{{.Name}}')"; then
      echo "error: could not inspect Supabase volumes for project '$project_id'" >&2
      return 1
    fi
    if ! networks="$(docker network ls \
      --filter "label=com.supabase.cli.project=$project_id" \
      --format '{{.Name}}')"; then
      echo "error: could not inspect Supabase networks for project '$project_id'" >&2
      return 1
    fi

    if [[ -n "$containers" || -n "$volumes" || -n "$networks" ]]; then
      echo "error: Supabase project '$project_id' already has local Docker state" >&2
      [[ -z "$containers" ]] || echo "containers: ${containers//$'\n'/, }" >&2
      [[ -z "$volumes" ]] || echo "volumes: ${volumes//$'\n'/, }" >&2
      [[ -z "$networks" ]] || echo "networks: ${networks//$'\n'/, }" >&2
      echo "Refusing to stop or reset shared state. Use a clean runner, or inspect and recover the existing stack manually." >&2
      return 1
    fi
  done
}

nevix_supabase_harness_require_free_tcp_ports() {
  local port

  for port in "$@"; do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      echo "error: required harness port 127.0.0.1:$port is already in use" >&2
      echo "Refusing to start Supabase or connect tests to an unowned local service." >&2
      return 1
    fi
  done
}

nevix_supabase_harness_claim_stack() {
  local project_id="$1"

  if [[ "$NEVIX_SUPABASE_HARNESS_LOCK_HELD" != "1" ]]; then
    echo "error: cannot claim a Supabase stack without the harness lock" >&2
    return 1
  fi
  if [[ "$NEVIX_SUPABASE_HARNESS_STACK_OWNED" == "1" ]]; then
    echo "error: the harness already owns project '$NEVIX_SUPABASE_HARNESS_PROJECT_ID'" >&2
    return 1
  fi

  NEVIX_SUPABASE_HARNESS_PROJECT_ID="$project_id"
  NEVIX_SUPABASE_HARNESS_STACK_OWNED=1
}

nevix_supabase_harness_cleanup() {
  local exit_status="$1"
  local cleanup_failed=0
  local owner_file="$NEVIX_SUPABASE_HARNESS_LOCK_DIR/owner"

  if [[ "$NEVIX_SUPABASE_HARNESS_STACK_OWNED" == "1" ]]; then
    echo "==> Tearing down harness-owned Supabase project '$NEVIX_SUPABASE_HARNESS_PROJECT_ID'"
    if ! pnpm --dir "$NEVIX_SUPABASE_HARNESS_REPO_ROOT" exec supabase stop \
      --project-id "$NEVIX_SUPABASE_HARNESS_PROJECT_ID" --no-backup >/dev/null; then
      echo "error: failed to remove the harness-owned Supabase stack; inspect Docker before recovery" >&2
      cleanup_failed=1
    fi
    NEVIX_SUPABASE_HARNESS_STACK_OWNED=0
  fi

  if [[ "$NEVIX_SUPABASE_HARNESS_LOCK_HELD" == "1" ]]; then
    if ! rm -f "$owner_file" || ! rmdir "$NEVIX_SUPABASE_HARNESS_LOCK_DIR"; then
      echo "error: failed to release Supabase harness lock '$NEVIX_SUPABASE_HARNESS_LOCK_DIR'" >&2
      cleanup_failed=1
    else
      NEVIX_SUPABASE_HARNESS_LOCK_HELD=0
    fi
  fi

  if [[ "$cleanup_failed" == "1" && "$exit_status" == "0" ]]; then
    return 1
  fi
  return "$exit_status"
}
