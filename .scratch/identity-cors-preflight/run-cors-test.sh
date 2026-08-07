#!/usr/bin/env bash
# Runs the CreateOrganization transport integration tests against the
# ALREADY-RUNNING local stack. Unlike scripts/test-mail-smoke.sh this never
# resets the database and never stops the stack.
set -euo pipefail
cd "$(dirname "$0")/../.."

export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,${NO_PROXY}}"
export no_proxy="${NO_PROXY}"

status_json="$(pnpm exec supabase status -o json)"
supabase_url="$(node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(s.API_URL??"")' <<<"${status_json}")"
publishable_key="$(node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(s.PUBLISHABLE_KEY??s.ANON_KEY??"")' <<<"${status_json}")"
database_url="$(node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(s.DB_URL??"")' <<<"${status_json}")"

NEVIX_SUPABASE_URL="${supabase_url}" \
NEVIX_SUPABASE_PUBLISHABLE_KEY="${publishable_key}" \
NEVIX_MAILPIT_URL="http://127.0.0.1:54324" \
NEVIX_DATABASE_URL="${database_url}" \
NEVIX_SMTP_HOST="127.0.0.1" \
NEVIX_SMTP_PORT="54325" \
NEVIX_SMTP_USER="mailpit" \
NEVIX_SMTP_PASSWORD="mailpit" \
NEVIX_OUTBOX_RETRY_DELAYS="1s,2s,3s,4s,5s" \
NEVIX_VERIFICATION_CODE_HASH_KEY="mail-smoke-test-hash-key" \
NEVIX_SMTP_FROM="identity@nevix.test" \
NEVIX_AUTH_JWKS_URL="${supabase_url}/auth/v1/.well-known/jwks.json" \
NEVIX_CORS_ALLOWED_ORIGINS="http://127.0.0.1:5173" \
  go test -C server -race -count=1 -run 'TestCreateOrganization' -v ./internal/identity/integrationtest/
