#!/usr/bin/env bash

set -euo pipefail

desktop_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$desktop_root"

stop_auth_stack() {
  pnpm exec supabase --workdir tests/auth/harness stop --no-backup >/dev/null 2>&1 || true
}

json_value() {
  STATUS_JSON="$1" STATUS_KEY="$2" node -e '
    const status = JSON.parse(process.env.STATUS_JSON)
    const value = status[process.env.STATUS_KEY]
    if (typeof value !== "string" || value.length === 0) process.exit(1)
    process.stdout.write(value)
  '
}

trap stop_auth_stack EXIT INT TERM
stop_auth_stack

pnpm typecheck

env \
  -u VITE_SUPABASE_URL \
  -u VITE_SUPABASE_PUBLISHABLE_KEY \
  pnpm exec electron-vite build --mode production
NEVIX_EXPECT_INVALID_SUPABASE_CONFIG=1 \
  pnpm exec playwright test tests/auth/configuration.spec.ts --workers=1

VITE_SUPABASE_URL=https://example.supabase.co \
  VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_invalid \
  pnpm exec electron-vite build --mode production
NEVIX_EXPECT_INVALID_SUPABASE_CONFIG=1 \
  pnpm exec playwright test tests/auth/configuration.spec.ts --workers=1

pnpm exec supabase --workdir tests/auth/harness start \
  -x realtime,storage-api,imgproxy,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor \
  >/dev/null

status_json="$(pnpm exec supabase --workdir tests/auth/harness status -o json)"
api_url="$(json_value "$status_json" API_URL)"
publishable_key="$(json_value "$status_json" PUBLISHABLE_KEY)"
service_role_key="$(json_value "$status_json" SERVICE_ROLE_KEY)"
mailpit_url="$(json_value "$status_json" INBUCKET_URL)"

VITE_SUPABASE_URL=http://192.168.1.50:8000 \
  VITE_SUPABASE_PUBLISHABLE_KEY="$publishable_key" \
  pnpm exec electron-vite build --mode production
NEVIX_EXPECT_PRODUCTION_PRIVATE_HTTP_BLOCK=1 \
  pnpm exec playwright test tests/auth/configuration.spec.ts --workers=1

VITE_SUPABASE_URL="$api_url" \
  VITE_SUPABASE_PUBLISHABLE_KEY="$publishable_key" \
  pnpm exec electron-vite build --mode test

NEVIX_TEST_SUPABASE_URL="$api_url" \
  NEVIX_TEST_SUPABASE_PUBLISHABLE_KEY="$publishable_key" \
  NEVIX_TEST_SUPABASE_SERVICE_ROLE_KEY="$service_role_key" \
  NEVIX_TEST_MAILPIT_URL="$mailpit_url" \
  pnpm exec playwright test --workers=1

NEVIX_TEST_SUPABASE_SERVICE_ROLE_KEY="$service_role_key" \
  pnpm verify:auth-artifacts
