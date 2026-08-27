#!/usr/bin/env bash
# Supported local and CI entry for the Creation Module integration suite
# (issue #156). Starts one pinned throwaway PostgreSQL plus one MinIO, runs
# the real Go Creation suites against both (zero skips, representative
# sentinels), and tears down only the stack it owns.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

postgres_image="postgres:17.5-alpine"
minio_image="minio/minio:RELEASE.2024-06-13T22-53-53Z"
postgres_host_port=54391
s3_host_port=9001
postgres_container="nevix-creation-test-pg"
s3_container="nevix-creation-test-s3"
test_log=""

export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,${NO_PROXY}}"
export no_proxy="${NO_PROXY}"

lock_dir="${TMPDIR:-/tmp}/nevix-ai-creation-postgres-harness.lock"

acquire_lock() {
  if ! mkdir "$lock_dir" 2>/dev/null; then
    echo "error: another Creation integration harness owns $lock_dir" >&2
    if [[ -r "$lock_dir/owner" ]]; then
      echo "owner:" >&2
      sed 's/^/  /' "$lock_dir/owner" >&2
    fi
    echo "Refusing to start a second PostgreSQL test stack. Inspect the owner before recovery." >&2
    return 1
  fi
  printf 'pid=%s\nworkspace=%s\n' "$$" "$repo_root" >"$lock_dir/owner"
}

# The /dev/tcp probe can false-positive against residual connection states
# right after a previous run tears down; give the kernel a bounded window to
# clear them before declaring the port occupied.
require_free_port() {
  local attempt
  for attempt in $(seq 1 20); do
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; then
      return 0
    fi
    exec 3>&- 3<&- || true
    sleep 1
  done
  echo "error: required harness port 127.0.0.1:$1 is already in use" >&2
  return 1
}

cleanup() {
  local exit_status="$1"

  # storage_root removal belongs here: a second `trap … EXIT` after the one
  # below would replace it and silently skip the lock release on every run.
  if [[ -n "${storage_root:-}" ]]; then
    rm -rf "$storage_root"
  fi
  if [[ -n "${secrets_dir:-}" ]]; then
    rm -rf "$secrets_dir"
  fi
  if [[ -n "$test_log" ]] && ! rm -f "$test_log"; then
    echo "error: failed to remove temporary Creation integration output '$test_log'" >&2
    [[ "$exit_status" == "0" ]] && exit_status=1
  fi
  docker rm -f "$postgres_container" >/dev/null 2>&1 || true
  docker rm -f "$s3_container" >/dev/null 2>&1 || true
  if [[ -d "$lock_dir" ]]; then
    rm -f "$lock_dir/owner"
    rmdir "$lock_dir" 2>/dev/null || true
  fi
  return "$exit_status"
}
trap 'exit_status=$?; trap - EXIT; cleanup "$exit_status"; exit $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

acquire_lock
require_free_port "$postgres_host_port"
require_free_port "$s3_host_port"

postgres_password="$(openssl rand -hex 32)"
identity_app_password="$(openssl rand -hex 32)"
storage_root="$(mktemp -d "${TMPDIR:-/tmp}/nevix-creation-storage.XXXXXX")"
secrets_dir="$(mktemp -d "${TMPDIR:-/tmp}/nevix-creation-secrets.XXXXXX")"

echo "==> Starting pinned PostgreSQL ($postgres_image) on 127.0.0.1:$postgres_host_port"
docker run --rm -d \
  --name "$postgres_container" \
  -e "POSTGRES_PASSWORD=$postgres_password" \
  -p "127.0.0.1:$postgres_host_port:5432" \
  "$postgres_image" >/dev/null

wait_for_postgres() {
  local attempt
  for attempt in $(seq 1 60); do
    if docker exec "$postgres_container" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
      return 0
    fi
    [[ "$attempt" -lt 60 ]] || return 1
    sleep 1
  done
}
echo "==> Waiting for PostgreSQL readiness"
wait_for_postgres

provision_identity_app() {
  local attempt
  for attempt in $(seq 1 10); do
    if docker exec -i "$postgres_container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 >/dev/null <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'identity_app') THEN
    CREATE ROLE identity_app LOGIN;
  END IF;
END
\$\$;
ALTER ROLE identity_app PASSWORD '$identity_app_password';
SQL
    then
      return 0
    fi
    echo "==> identity_app provisioning not reachable yet (attempt ${attempt}/10); retrying" >&2
    sleep 1
  done
  echo "error: could not provision the identity_app credential after 10 attempts" >&2
  return 1
}

echo "==> Provisioning the identity_app runtime credential"
provision_identity_app

s3_secret="$(openssl rand -hex 24)"
echo "==> Starting pinned MinIO ($minio_image) on 127.0.0.1:$s3_host_port"
docker run --rm -d \
  --name "$s3_container" \
  -e "MINIO_ROOT_USER=nevix-creation-test" \
  -e "MINIO_ROOT_PASSWORD=$s3_secret" \
  -p "127.0.0.1:$s3_host_port:9000" \
  "$minio_image" server /data >/dev/null

wait_for_minio() {
  local attempt
  for attempt in $(seq 1 60); do
    if curl -fsS --noproxy '*' "http://127.0.0.1:$s3_host_port/minio/health/live" >/dev/null 2>&1; then
      return 0
    fi
    [[ "$attempt" -lt 60 ]] || return 1
    sleep 1
  done
}
echo "==> Waiting for MinIO readiness"
wait_for_minio

assert_creation_integration_executed() {
  local output_file="$1"
  local passed_count skipped_count test_name
  local -a representative_tests=(
    TestCreationSessionLifecycleCreatorPrivateMatrix
    TestSessionDeletionHidesAndBlocksMaterialRoutes
    TestSessionListKeysetPaginationIsStableAndCompound
    TestUploadRecordsAtomicRightsFacts
    TestUploadValidationPipelineStableReasons
    TestUploadRejectsFormsWithoutFilePart
    TestDownloadServesRangeAndChecksumHeaders
    TestDeleteMaterialRemovesRowAndBlobCleanupSchedules
    TestContractErrorEnvelopeShapeOnEveryCreationErrorPath
    TestProviderConnectionPermissionMatrix
    TestConfigureProviderConnectionLifecycle
    TestReplaceCandidateFailureKeepsOldCredentialAndSuccessSwitchesIndependently
    TestMasterKeyFailureFailsClosedWithoutSilentRegeneration
    TestProviderConnectionSingletonConstraintRejectsSecondActiveRow
    TestStreamSmokeParallelFileFlows
    TestFilesystemConformance
    TestS3ConformanceSuiteAgainstMinIO
    TestApplyIsIdempotentWhenAlreadyCurrent
  )

  passed_count="$(grep -Ec '^--- PASS: Test[^/[:space:]]+[[:space:]]+\(' "$output_file" || true)"
  skipped_count="$(grep -Ec '^--- SKIP: Test[^/[:space:]]+[[:space:]]+\(' "$output_file" || true)"

  if [[ "$passed_count" -eq 0 ]]; then
    echo "error: Creation integration was requested, but zero top-level integration tests passed." >&2
    return 1
  fi
  if [[ "$skipped_count" -ne 0 ]]; then
    echo "error: Creation integration was requested, but $skipped_count top-level integration test(s) skipped." >&2
    echo "Run ./scripts/test-creation-integration.sh from the repository root so the harness supplies every NEVIX_* value." >&2
    return 1
  fi

  for test_name in "${representative_tests[@]}"; do
    if ! grep -Fq -- "--- PASS: ${test_name} " "$output_file"; then
      echo "error: requested Creation integration sentinel '$test_name' did not pass." >&2
      return 1
    fi
  done

  echo "==> Verified $passed_count Creation integration tests executed with zero skips"
  printf '    representative PASS: %s\n' "${representative_tests[@]}"
}

echo "==> Running Go Creation integration tests"
# Harness DSN conventions mirror the Identity suite: NEVIX_DATABASE_URL is
# the owner credential; NEVIX_IDENTITY_DATABASE_URL authenticates directly as
# identity_app — the production runtime role every write must prove.
export NEVIX_CREATION_INTEGRATION_REQUESTED=1
export NEVIX_DATABASE_URL="postgresql://postgres:${postgres_password}@127.0.0.1:${postgres_host_port}/postgres?sslmode=disable"
export NEVIX_IDENTITY_DATABASE_URL="postgresql://identity_app:${identity_app_password}@127.0.0.1:${postgres_host_port}/postgres?sslmode=disable"
export NEVIX_CORS_ALLOWED_ORIGINS="http://127.0.0.1:5173"
export STORAGE_FS_ROOT="$storage_root"
export NEVIX_CREATION_SECRETS_DIR="$secrets_dir"
export NEVIX_CREATION_TEST_S3_ENDPOINT="127.0.0.1:$s3_host_port"
export NEVIX_CREATION_TEST_S3_ACCESS_KEY_ID="nevix-creation-test"
export NEVIX_CREATION_TEST_S3_SECRET_ACCESS_KEY="$s3_secret"
export NEVIX_CREATION_TEST_S3_SECURE="false"
export NEVIX_CREATION_SMOKE_SECONDS="${NEVIX_CREATION_SMOKE_SECONDS:-60}"

test_log="$(mktemp -t nevix-creation-integration.XXXXXX)"
set +e
# One serialized run covers the Module-seam integration suite, storage
# conformance on both adapters, and the short file-stream smoke.
go test -C server -race -count=1 -p 1 -v ./internal/creation/... ./internal/migration/... | tee "$test_log"
test_status="${PIPESTATUS[0]}"
set -e
if [[ "$test_status" -ne 0 ]]; then
  exit "$test_status"
fi
assert_creation_integration_executed "$test_log"

echo "==> Creation integration tests passed"
