#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
policy_project_id="nevix-auth-policy"
policy_project_root="$(mktemp -d -t nevix-auth-policy.XXXXXX)"
auth_container="supabase_auth_${policy_project_id}"
database_container="supabase_db_${policy_project_id}"
auth_image="public.ecr.aws/supabase/gotrue:v2.193.0"
auth_url="http://127.0.0.1:55326"
auth_container_owned=0

source "$repo_root/scripts/lib/supabase-local-harness.sh"

stop_auth_container() {
  if [[ "$auth_container_owned" == "1" ]]; then
    docker rm --force "$auth_container" >/dev/null
    auth_container_owned=0
  fi
}

cleanup() {
  local exit_status="$1"
  local cleanup_status="$exit_status"

  if ! stop_auth_container; then
    cleanup_status=1
  fi
  if ! nevix_supabase_harness_cleanup "$cleanup_status"; then
    cleanup_status=1
  fi
  if ! rm -rf "$policy_project_root"; then
    cleanup_status=1
  fi
  return "$cleanup_status"
}

wait_for_auth() {
  for _ in $(seq 1 120); do
    if curl -fsS "$auth_url/health" >/dev/null 2>&1; then
      return
    fi
    if ! docker container inspect "$auth_container" >/dev/null 2>&1; then
      echo "error: the pinned Auth container stopped before becoming healthy" >&2
      return 1
    fi
    sleep 0.25
  done

  echo "error: the pinned Auth container did not become healthy" >&2
  docker logs "$auth_container" >&2 || true
  return 1
}

contains_fixed_string() {
  local value="$1"

  if command -v rg >/dev/null 2>&1; then
    rg -Fq "$value"
  else
    grep -Fq "$value"
  fi
}

start_auth_container() {
  local mode="$1"
  local -a mode_args=()

  case "$mode" in
    bootstrap)
      mode_args+=(--env GOTRUE_PASSWORD_HIBP_ENABLED=false)
      ;;
    normal)
      mode_args+=(--env GOTRUE_PASSWORD_HIBP_ENABLED=true)
      ;;
    fail-open)
      mode_args+=(--add-host api.pwnedpasswords.com:127.0.0.1)
      ;;
    *)
      echo "error: unknown Auth policy container mode '$mode'" >&2
      return 2
      ;;
  esac

  docker run --detach \
    --name "$auth_container" \
    --network "supabase_network_${policy_project_id}" \
    --publish "127.0.0.1:55326:9999" \
    --env-file "$repo_root/supabase/auth-policy.env.example" \
    --env GOTRUE_API_HOST=0.0.0.0 \
    --env GOTRUE_API_PORT=9999 \
    --env API_EXTERNAL_URL="$auth_url" \
    --env GOTRUE_SITE_URL=http://127.0.0.1:3000 \
    --env GOTRUE_DB_DRIVER=postgres \
    --env GOTRUE_DB_DATABASE_URL="postgresql://supabase_auth_admin:postgres@${database_container}:5432/postgres" \
    --env GOTRUE_DB_MIGRATIONS_PATH=/usr/local/etc/auth/migrations \
    --env GOTRUE_DISABLE_SIGNUP=false \
    --env GOTRUE_EXTERNAL_EMAIL_ENABLED=true \
    --env GOTRUE_MAILER_AUTOCONFIRM=true \
    --env GOTRUE_JWT_SECRET=nevix-auth-policy-harness-secret-at-least-32-characters \
    --env GOTRUE_JWT_AUD=authenticated \
    --env GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated \
    --env GOTRUE_JWT_ADMIN_ROLES=service_role \
    "${mode_args[@]}" \
    "$auth_image" >/dev/null
  auth_container_owned=1
  wait_for_auth
}

trap 'exit_status=$?; trap - EXIT; cleanup "$exit_status"; exit $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$(pnpm --dir "$repo_root" exec supabase --version)" != "2.110.0" ]]; then
  echo "error: Supabase CLI must remain pinned to 2.110.0 for the Auth policy harness" >&2
  exit 1
fi

nevix_supabase_harness_acquire "$repo_root" auth-policy
nevix_supabase_harness_require_clean_projects "$policy_project_id"
nevix_supabase_harness_require_free_tcp_ports 55322 55326
if docker container inspect "$auth_container" >/dev/null 2>&1; then
  echo "error: Auth policy container '$auth_container' already exists" >&2
  exit 1
fi

cp -R "$repo_root/supabase" "$policy_project_root/supabase"
perl -0pi -e \
  's/project_id = "nevix-ai"/project_id = "nevix-auth-policy"/; s/5432([0-9])/5532$1/g' \
  "$policy_project_root/supabase/config.toml"

nevix_supabase_harness_claim_stack "$policy_project_id"
pnpm --dir "$repo_root" exec supabase --workdir "$policy_project_root" start \
  -x gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor \
  >/dev/null

legacy_email="legacy-weak-$(date +%s)-$(node -e 'process.stdout.write(crypto.randomUUID())')@nevix.test"

start_auth_container bootstrap
NEVIX_AUTH_POLICY_URL="$auth_url" \
  NEVIX_AUTH_POLICY_LEGACY_EMAIL="$legacy_email" \
  node "$repo_root/scripts/auth-policy-harness.mjs" bootstrap
stop_auth_container

start_auth_container normal
NEVIX_AUTH_POLICY_URL="$auth_url" \
  NEVIX_AUTH_POLICY_DATABASE_CONTAINER="$database_container" \
  NEVIX_AUTH_POLICY_LEGACY_EMAIL="$legacy_email" \
  node "$repo_root/scripts/auth-policy-harness.mjs" normal
stop_auth_container

start_auth_container fail-open
NEVIX_AUTH_POLICY_URL="$auth_url" node "$repo_root/scripts/auth-policy-harness.mjs" fail-open
if ! docker logs "$auth_container" 2>&1 | contains_fixed_string \
  'Unable to perform password strength check with HaveIBeenPwned.org, pwned passwords are being allowed'; then
  echo "error: HIBP fail-open did not emit the expected internal warning" >&2
  exit 1
fi
echo "ok - HIBP fail-open emits an internal warning"
