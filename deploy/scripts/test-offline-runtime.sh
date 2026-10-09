#!/usr/bin/env bash
# Native CI acceptance, all fixed Nevix resources stay in an isolated network namespace.
set -euo pipefail
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo 'Offline runtime acceptance requires native Linux x86_64; emulation is not acceptance evidence.' >&2
  exit 1
fi
repo=$(git -C "$(dirname "$0")/../.." rev-parse --show-toplevel)
scratch=$(mktemp -d)
store=${NEVIX_DEPLOY_TEST_STORE:-containerd}
if [[ $store != classic && $store != containerd ]]; then echo 'store must be classic or containerd' >&2; exit 1; fi
cleanup() {
  # This socket is created only after vendor export; never fall back to the host daemon.
  if [[ -S $scratch/docker.sock ]]; then
    containers=$(env -u DOCKER_CONTEXT DOCKER_HOST="unix://$scratch/docker.sock" docker ps --all --quiet 2>/dev/null || true)
    if [[ -n $containers ]]; then
      env -u DOCKER_CONTEXT DOCKER_HOST="unix://$scratch/docker.sock" docker rm --force $containers >/dev/null 2>&1 || true
    fi
  fi
  if [[ -f $scratch/docker.pid ]]; then sudo kill "$(cat "$scratch/docker.pid")" 2>/dev/null || true; fi
  if [[ -n ${daemon_pid:-} ]]; then wait "$daemon_pid" 2>/dev/null || true; fi
  if [[ -f $scratch/containerd.pid ]]; then
    private_containerd_pid=$(cat "$scratch/containerd.pid")
    sudo kill "$private_containerd_pid" 2>/dev/null || true
    for attempt in $(seq 1 60); do
      if ! sudo kill -0 "$private_containerd_pid" 2>/dev/null; then break; fi
      sleep 0.1
    done
  fi
  sudo rm -rf "$scratch"
}
trap cleanup EXIT
"$repo/deploy/scripts/build-bundle.sh" 1.2.3 1.0.0 1.0.0 "$scratch/runtime.tar.gz"
"$repo/deploy/scripts/build-upgrade-fixtures.sh" "$scratch"
printf '{}\n' > "$scratch/daemon.json"
feature=false
if [[ $store == containerd ]]; then feature=true; fi
# No veth or outgoing route: the daemon and containers cannot reach any registry.
sudo unshare --net bash -c '
  ip link set lo up
  scratch=$1; shift
  containerd --root "$scratch/containerd-root" --state "$scratch/containerd-state" --address "$scratch/containerd.sock" > "$scratch/containerd.log" 2>&1 &
  echo $! > "$scratch/containerd.pid"
  for attempt in $(seq 1 60); do
    [[ -S $scratch/containerd.sock ]] && break
    sleep 1
  done
  exec dockerd "$@"
' bash "$scratch" \
  --config-file "$scratch/daemon.json" --host "unix://$scratch/docker.sock" \
  --group "$(id -gn)" --data-root "$scratch/data" --exec-root "$scratch/exec" \
  --pidfile "$scratch/docker.pid" --bridge none --iptables=false --ip-masq=false \
  --containerd "$scratch/containerd.sock" --containerd-namespace nevix-runtime --containerd-plugins-namespace nevix-runtime-plugins \
  --feature "containerd-snapshotter=$feature" > "$scratch/daemon.log" 2>&1 &
daemon_pid=$!
unset DOCKER_CONTEXT
export DOCKER_HOST="unix://$scratch/docker.sock"
# sudo retains its root HOME after dropping uid; avoid an unreadable inherited client config.
export DOCKER_CONFIG="$scratch/docker-client"
mkdir -m 0700 "$DOCKER_CONFIG"
printf '{}\n' > "$DOCKER_CONFIG/config.json"
for attempt in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then break; fi
  if ! kill -0 "$daemon_pid" 2>/dev/null; then cat "$scratch/daemon.log" >&2; exit 1; fi
  sleep 1
done
docker info >/dev/null
export NEVIX_DEPLOY_ISOLATED_DAEMON=1 NEVIX_DEPLOY_INTEGRATION_REQUESTED=1
export NEVIX_DEPLOY_RUNTIME_BUNDLE="$scratch/runtime.tar.gz"
export NEVIX_DEPLOY_UPGRADE_FIXTURES="$scratch"
(cd "$repo/server" && CGO_ENABLED=0 go test -c ./internal/deployment -o "$scratch/deployment.test")
# The real CLI HTTP client must share the daemon's otherwise isolated network namespace.
sudo --preserve-env=DOCKER_CONFIG,DOCKER_HOST,NEVIX_DEPLOY_ISOLATED_DAEMON,NEVIX_DEPLOY_INTEGRATION_REQUESTED,NEVIX_DEPLOY_RUNTIME_BUNDLE,NEVIX_DEPLOY_UPGRADE_FIXTURES \
  nsenter --net --target "$(cat "$scratch/docker.pid")" \
  setpriv --reuid "$(id -u)" --regid "$(id -g)" --init-groups \
  "$scratch/deployment.test" -test.run '^TestOfflineFirstInstallWithRealImages$' -test.v -test.count=1
