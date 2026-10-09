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
  if [[ -f $scratch/docker.pid ]]; then sudo kill "$(cat "$scratch/docker.pid")" 2>/dev/null || true; fi
  if [[ -f $scratch/containerd.pid ]]; then sudo kill "$(cat "$scratch/containerd.pid")" 2>/dev/null || true; fi
  if [[ -n ${daemon_pid:-} ]]; then wait "$daemon_pid" 2>/dev/null || true; fi
  sudo rm -rf "$scratch"
}
trap cleanup EXIT
"$repo/deploy/scripts/build-bundle.sh" 1.2.3 1.0.0 1.0.0 "$scratch/runtime.tar.gz"
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
for attempt in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then break; fi
  if ! kill -0 "$daemon_pid" 2>/dev/null; then cat "$scratch/daemon.log" >&2; exit 1; fi
  sleep 1
done
docker info >/dev/null
export NEVIX_DEPLOY_ISOLATED_DAEMON=1 NEVIX_DEPLOY_INTEGRATION_REQUESTED=1
export NEVIX_DEPLOY_RUNTIME_BUNDLE="$scratch/runtime.tar.gz"
(cd "$repo/server" && go test ./internal/deployment -run '^TestOfflineFirstInstallWithRealImages$' -v -count=1)
