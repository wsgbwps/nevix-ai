#!/usr/bin/env bash
# Supported local and CI entry for the Server Identity integration suite.
# Starts one pinned, throwaway PostgreSQL container (pure Postgres — no
# Supabase stack since the user-system migration, issue #100), provisions the
# identity_app runtime credential, runs the real Go Identity integration suite
# against it, and tears down only the stack it owns.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

postgres_image="postgres:17.5-alpine"
postgres_host_port=54390
postgres_container="nevix-identity-test-pg"
identity_test_log=""

# Loopback traffic must never go through a developer HTTP proxy: readiness
# probes and the Go tests honor proxy variables.
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,${NO_PROXY}}"
export no_proxy="${NO_PROXY}"

lock_dir="${TMPDIR:-/tmp}/nevix-ai-identity-postgres-harness.lock"

acquire_lock() {
  if ! mkdir "$lock_dir" 2>/dev/null; then
    echo "error: another Identity integration harness owns $lock_dir" >&2
    if [[ -r "$lock_dir/owner" ]]; then
      echo "owner:" >&2
      sed 's/^/  /' "$lock_dir/owner" >&2
    fi
    echo "Refusing to start a second PostgreSQL test stack. Inspect the owner before recovery." >&2
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

cleanup() {
  local exit_status="$1"

  if [[ -n "$identity_test_log" ]] && ! rm -f "$identity_test_log"; then
    echo "error: failed to remove temporary Identity integration test output '$identity_test_log'" >&2
    if [[ "$exit_status" == "0" ]]; then
      exit_status=1
    fi
  fi
  docker rm -f "$postgres_container" >/dev/null 2>&1 || true
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

postgres_password="$(openssl rand -hex 32)"
identity_app_password="$(openssl rand -hex 32)"

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
    if [[ "$attempt" -lt 60 ]]; then
      sleep 1
    fi
  done
  echo "error: PostgreSQL was not ready after 60 attempts" >&2
  return 1
}

echo "==> Waiting for PostgreSQL readiness"
wait_for_postgres

# The readiness probe can observe the initdb temporary server: on a fresh
# volume pg_isready succeeds while the entrypoint is still initializing, and
# the first real connection then races the temp server's shutdown (socket
# gone) before the final server recreates it. Provisioning is idempotent, so
# a bounded retry closes that startup window deterministically.
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
# The migration baseline creates the role when missing; provisioning it here
# (with a password) lets the tests connect as identity_app from the start.
provision_identity_app

assert_identity_integration_executed() {
  local output_file="$1"
  local passed_count
  local skipped_count
  local test_name
  local -a representative_tests=(
    TestOpenClaimStatusAndSilentConstruction
    TestLoginIssuesOpaqueSessionStoredOnlyAsHash
    TestLoginRejectsBadCredentialsUniformly
    TestLoginAnswersDisabledAccountWithAccountDisabled
    TestLoginRateLimitsAfterWindowedFailures
    TestLogoutRevokesOnlyTheCallingSession
    TestPendingPasswordChangeBlocksBusinessEndpoints
    TestFirstLoginChangePasswordClearsFlagAndActivatesAccount
    TestChangePasswordRevokesAllOtherSessions
    TestChangePasswordSerializesConcurrentChanges
    TestUpdateMeChangesDisplayNameVisibleInDirectory
    TestSessionSurvivesModuleReconstruction
    TestSessionSlidingExpiryRefreshesOnUse
    TestExpiredSessionIsRejected
    TestSweepDeletesExpiredSessions
    TestCreateUserIssuesAccountWithInitialPassword
    TestDisableUserRevokesAllSessionsImmediately
    TestLastActiveAdminCannotBeDisabledOrDemoted
    TestDeleteOnlyAllowsAccountsThatNeverLoggedIn
    TestResetPasswordRevokesAllSessionsAndRearmsChange
    TestChangeEmailMovesTheLoginIdentifier
    TestChangeRoleAdjustsAdminAccessBothWays
    TestCreateJoinCodeReturnsPlaintextAndWritesAudit
    TestActiveJoinCodeCapBlocksTheFourthCreateUntilRevoked
    TestConcurrentCreatesCannotExceedTheActiveCap
    TestRevokeRemovesCodeFromListAndKeepsTheRow
    TestJoinCodeSurfaceIsAdminOnlyAndShapeChecked
    TestProtectedClaimStatusAndCodeDisclosure
    TestSetupStatusReturnsOnlyTheTwoBooleans
    TestOpenClaimCreatesFirstAdminWithoutACredential
    TestProtectedClaimDemandsTheCode
    TestClaimAnswersConflictOnceInitialized
    TestRestartRotatesTheSetupCode
    TestConcurrentClaimIsFirstWins
    TestDirectoryShowsActiveUsersToEveryActiveUser
    TestManagementListShowsEveryAccountToAdminsOnly
    TestAuditListIsAdminOnlyAndNewestFirst
    TestIdentityModuleConstructionRejectsOwnerCredential
    TestBaselineSchemaIsTheSingleTenantUserSystem
    TestIdentityAppGrantsMatchTheLeastPrivilegeContract
    TestReapplyingMigrationsIsANoOp
    TestBaselineDropsTheLegacyWorldAndRebuilds
    TestRunRejectsOwnerCredential
    TestRunAcceptsDirectIdentityAppCredential
    TestIssueInsertsSessionStampsLastLoginAndWritesNoAudit
    TestIssueRechecksActiveStatusAndCredentialStampUnderLock
    TestIssueRollsBackWithTheCallerTransaction
    TestValidateResolvesIdentityAndSlidesNearExpiryWithoutTouchingLastLogin
    TestValidateFailuresAndBestEffortRefresh
    TestLoginAdvancesLastLoginAtAndRefreshDoesNot
  )
  # Goose migration-engine sentinels live in the migration package.
  local -a migration_tests=(
    TestApplyCreatesBaselineAndGooseLedgerOnEmptyDatabase
    TestApplyIsIdempotentWhenAlreadyCurrent
    TestFailedMigrationRollsBackAndStaysUnrecorded
    TestConcurrentApplyRunsTheEmbeddedSetExactlyOnce
  )

  passed_count="$(grep -Ec '^--- PASS: Test[^/[:space:]]+[[:space:]]+\(' "$output_file" || true)"
  skipped_count="$(grep -Ec '^--- SKIP: Test[^/[:space:]]+[[:space:]]+\(' "$output_file" || true)"

  if [[ "$passed_count" -eq 0 ]]; then
    echo "error: Identity integration was requested, but zero top-level integration tests passed." >&2
    echo "Run ./scripts/test-identity-integration.sh from the repository root to start the supported harness; if this entry emitted the error, inspect the test output above." >&2
    return 1
  fi
  if [[ "$skipped_count" -ne 0 ]]; then
    echo "error: Identity integration was requested, but $skipped_count top-level integration test(s) skipped." >&2
    echo "Run ./scripts/test-identity-integration.sh from the repository root so the harness supplies every required NEVIX_* value." >&2
    return 1
  fi

  for test_name in "${representative_tests[@]}" "${migration_tests[@]}"; do
    if ! grep -Fq -- "--- PASS: ${test_name} " "$output_file"; then
      echo "error: requested Identity integration sentinel '$test_name' did not pass." >&2
      echo "Run ./scripts/test-identity-integration.sh from the repository root and inspect the test output above." >&2
      return 1
    fi
  done

  echo "==> Verified $passed_count Identity integration tests executed with zero skips"
  printf '    representative PASS: %s\n' "${representative_tests[@]}" "${migration_tests[@]}"
}

echo "==> Running Go Identity integration tests"
# The harness DSNs: NEVIX_DATABASE_URL is the owner (DDL + fixtures +
# assertions); NEVIX_IDENTITY_DATABASE_URL authenticates directly as
# identity_app — the production runtime credential the Module must see.
# The first admin is created through the public Instance Claim inside the
# suite; the per-test state resets run inside it.
export NEVIX_IDENTITY_INTEGRATION_REQUESTED=1
export NEVIX_DATABASE_URL="postgresql://postgres:${postgres_password}@127.0.0.1:${postgres_host_port}/postgres?sslmode=disable"
export NEVIX_IDENTITY_DATABASE_URL="postgresql://identity_app:${identity_app_password}@127.0.0.1:${postgres_host_port}/postgres?sslmode=disable"
export NEVIX_CORS_ALLOWED_ORIGINS="http://127.0.0.1:5173"

identity_test_log="$(mktemp -t nevix-identity-integration.XXXXXX)"
set +e
# One recursive, serialized invocation covers the identity and migration
# trees: the Module-seam integration suite, the writetx real-role evidence,
# the Goose-backed migration engine, and the package-local tests all ride one
# PostgreSQL stack. -p 1 serializes packages because they share one database
# whose state the tests reset between cases.
go test -C server -race -count=1 -p 1 -v ./internal/identity/... ./internal/migration/... | tee "$identity_test_log"
test_status="${PIPESTATUS[0]}"
set -e
if [[ "$test_status" -ne 0 ]]; then
  exit "$test_status"
fi
assert_identity_integration_executed "$identity_test_log"

echo "==> Identity integration tests passed"
