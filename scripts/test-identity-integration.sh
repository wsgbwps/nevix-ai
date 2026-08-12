#!/usr/bin/env bash
# Supported local and CI entry for the Server Identity integration suite.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
exec "$repo_root/scripts/test-mail-smoke.sh" "$@"
