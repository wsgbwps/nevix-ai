#!/usr/bin/env bash
# Test-only synthetic tracked releases; none are customer publication artifacts.
set -euo pipefail
repo=$(git -C "$(dirname "$0")/../.." rev-parse --show-toplevel)
output=$1
inputs=$(mktemp -d)
trap 'rm -rf "$inputs"' EXIT
for variant in success migration-failure health-failure; do
  copy="$inputs/$variant"
  mkdir -p "$copy"
  git -C "$repo" archive HEAD deploy server | tar -x -C "$copy"
  git -C "$copy" init --quiet --initial-branch fixture
  cat > "$copy/server/internal/migration/migrations/9000_operator_upgrade_fixture.sql" <<'SQL'
-- +goose Up
CREATE TABLE public.operator_upgrade_fixture (id integer PRIMARY KEY);
-- +goose Down
DROP TABLE public.operator_upgrade_fixture;
SQL
  version=1.2.4
  if [[ $variant == migration-failure ]]; then
    version=1.2.5
    printf '%s\n' '-- +goose Up' 'SELECT 1 / 0;' '-- +goose Down' 'SELECT 1;' > "$copy/server/internal/migration/migrations/9001_operator_upgrade_failure.sql"
  fi
  if [[ $variant == health-failure ]]; then
    version=1.2.6
    sed -i 's/wget -q -O \/dev\/null http:\/\/127.0.0.1:8080\/health || exit 1/exit 1/' "$copy/deploy/runtime-compose.template.yaml"
  fi
  git -C "$copy" add deploy server
  git -C "$copy" -c user.name='Nevix isolated fixture' -c user.email='fixture@invalid.example' commit --quiet -m "Test-only $variant release"
  "$copy/deploy/scripts/build-bundle.sh" "$version" 1.0.0 1.0.0 "$output/$variant.tar.gz"
done
