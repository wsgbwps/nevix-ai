#!/usr/bin/env bash
# Vendor build: export only tracked inputs; customers never build or pull.
set -euo pipefail
if [[ $# != 4 ]]; then
  echo 'usage: build-bundle.sh VERSION MIN_DESKTOP_VERSION MIN_SERVER_VERSION OUTPUT.tar.gz' >&2
  exit 1
fi
repo=$(git -C "$(dirname "$0")/../.." rev-parse --show-toplevel)
version=$1
min_desktop=$2
min_server=$3
output=$4
if [[ $output != /* ]]; then output="$PWD/$output"; fi
if ! git -C "$repo" diff --quiet HEAD -- deploy server; then
  echo 'Commit deployment/server changes before building the tracked release.' >&2
  exit 1
fi
commit=$(git -C "$repo" rev-parse HEAD)
inputs=$(mktemp -d)
trap 'rm -rf "$inputs"' EXIT
git -C "$repo" archive HEAD deploy server | tar -x -C "$inputs"
mkdir "$inputs/tools"
(cd "$inputs/server" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o "$inputs/tools/nevix-deploy" ./cmd/nevix-deploy)
docker build --platform linux/amd64 --build-arg "RELEASE_VERSION=$version" --build-arg "MIN_DESKTOP_VERSION=$min_desktop" -t "nevix-bundle-server:$version" -f "$inputs/deploy/Dockerfile.server" "$inputs/server"
docker build --platform linux/amd64 -t "nevix-bundle-cert-init:$version" "$inputs/deploy/cert-init"
postgres='postgres:17.5-alpine@sha256:6567bca8d7bc8c82c5922425a0baee57be8402df92bae5eacad5f01ae9544daa'
nginx='nginx:1.28.0-alpine@sha256:30f1c0d78e0ad60901648be663a710bdadf19e4c10ac6782c235200619158284'
docker pull --platform linux/amd64 "$postgres"
docker pull --platform linux/amd64 "$nginx"
docker tag "$postgres" "nevix-bundle-postgres:$version"
docker tag "$nginx" "nevix-bundle-nginx:$version"
docker image save --platform linux/amd64 --output "$inputs/images.tar" "nevix-bundle-server:$version" "nevix-bundle-cert-init:$version" "nevix-bundle-postgres:$version" "nevix-bundle-nginx:$version"
(cd "$inputs/server" && go run ./cmd/nevix-deploy pack --inputs "$inputs" --version "$version" --min-desktop-version "$min_desktop" --min-server-version "$min_server" --source-commit "$commit" --output "$output")
echo "Built $output from $commit; sign its exact URL, size and SHA-512 through the stable release workflow."
