#!/usr/bin/env bash
# make server 的实现：本地开发唯一入口（根 Makefile 调用）。
#
# 不变量与约束：
# - Go 服务器只监听明文 http://127.0.0.1:8080 —— "Go 不终结 TLS" 是 ADR-0014
#   不变量；HTTPS 由本脚本按需拉起的 Caddy sidecar 在边缘终结（tls internal
#   自签，注入 X-Forwarded-Proto: https，与 deploy/nginx 的入站纪律一致）。
#   Desktop 一律连 https://127.0.0.1:8443。
# - Provider Key / 重认证端点要求"已证明的 HTTPS"（authz.SecureTransportProven），
#   没有开发旁路；未装 caddy 时只有 8080，这些命令会被 secure_transport_required 拒绝。
# - fake Kapon 仅在 server/.env.local 的 KAPON_BASE_URL 指向本机 :9399 时启动；
#   自动化测试不得注入生产 Kapon Token（规格 #150）。
# - 生产 TLS 终结者是 deploy/ 的 Nginx（ADR-0013/0016 冻结），本脚本不进生产。
#
# Ctrl-C / TERM / EXIT 时清理本脚本拉起的全部 sidecar。兼容 macOS 自带 bash 3.2。
# bash 3.2 坑：$var 后紧跟多字节字符（如全角标点）时，该字符的首字节会被并入
# 变量名（C locale 下高位字节被判为字母字符）导致 unbound variable——凡是
# 变量后非 ASCII 字符直接相邻的拼接，一律写成 ${var}。
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
server_port=8080
tls_port=8443
fake_kapon_port=9399
cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/nevix-dev"
log_dir="$cache_dir/logs"

go_pid=
caddy_pid=
kapon_pid=

log() { printf '==> %s\n' "$*"; }
warn() { printf '==> %s\n' "$*" >&2; }
port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

cleanup() {
  trap - EXIT INT TERM
  # go run 不会把信号转发给它拉起的 server 二进制，必须显式清掉其子进程，
  # 否则退出后 8080 仍被占、下次启动会报端口冲突。
  if [ -n "$go_pid" ]; then
    pkill -P "$go_pid" >/dev/null 2>&1 || true
    kill "$go_pid" >/dev/null 2>&1 || true
  fi
  local pid
  for pid in "$kapon_pid" "$caddy_pid"; do
    if [ -n "$pid" ]; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if port_busy "$server_port"; then
  warn "端口 $server_port 已被占用（可能是上一轮 make server），请先停掉它再运行。"
  exit 1
fi

mkdir -p "$log_dir"

cd "$repo_root/server"

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
  log "已加载 server/.env.local"
else
  warn "未找到 server/.env.local，按当前 shell 环境变量启动。"
fi

case "${KAPON_BASE_URL:-}" in
  "http://127.0.0.1:$fake_kapon_port" | "http://localhost:$fake_kapon_port")
    if port_busy "$fake_kapon_port"; then
      log "端口 $fake_kapon_port 已被占用，假定 fake Kapon 已在运行。"
    else
      node "$repo_root/scripts/dev/fake-kapon.mjs" >"$log_dir/fake-kapon.log" 2>&1 &
      kapon_pid=$!
      log "fake Kapon：http://127.0.0.1:${fake_kapon_port}（密钥 test-key，日志 $log_dir/fake-kapon.log）"
    fi
    ;;
  *)
    log "KAPON_BASE_URL=${KAPON_BASE_URL:-（未设置）}，不启动 fake Kapon。"
    ;;
esac

if command -v caddy >/dev/null 2>&1; then
  if port_busy "$tls_port"; then
    warn "端口 $tls_port 已被占用，跳过 Caddy，本次没有 HTTPS。"
  else
    caddyfile="$cache_dir/Caddyfile"
    cat >"$caddyfile" <<EOF
{
    admin off
}

https://127.0.0.1:$tls_port {
    tls internal
    reverse_proxy 127.0.0.1:$server_port
}
EOF
    # 私有 CA 与证书状态落在本缓存目录，跨重启指纹稳定，Desktop TOFU 只需确认一次。
    XDG_DATA_HOME="$cache_dir/caddy-data" XDG_CONFIG_HOME="$cache_dir/caddy-config" \
      caddy run --config "$caddyfile" --adapter caddyfile >"$log_dir/caddy.log" 2>&1 &
    caddy_pid=$!
    sleep 0.5
    if kill -0 "$caddy_pid" 2>/dev/null; then
      log "Caddy TLS：https://127.0.0.1:$tls_port -> 127.0.0.1:${server_port}（日志 $log_dir/caddy.log）"
    else
      warn "Caddy 启动失败（见 $log_dir/caddy.log），本次只有明文 8080。"
      caddy_pid=
    fi
  fi
else
  warn "未检测到 caddy：Provider Key / 重认证命令会被 secure_transport_required 拒绝（无开发旁路，属预期）。"
  warn "brew install caddy 后重启 make server，即可获得 https://127.0.0.1:${tls_port}。"
fi

wait_healthy() {
  local i
  for i in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$server_port/health" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$go_pid" 2>/dev/null; then
      return 1
    fi
    sleep 0.5
  done
  return 1
}

log "启动 Go 服务器：go run ./cmd/server（明文 :${server_port}）"
go run ./cmd/server &
go_pid=$!

if ! wait_healthy; then
  warn "Go 服务器未在 30s 内就绪（判定为启动失败），退出。"
  exit 1
fi

log "Nevix 本地开发栈就绪："
echo "    Go 服务器   http://127.0.0.1:$server_port"
if [ -n "$caddy_pid" ]; then
  echo "    TLS 终结    https://127.0.0.1:$tls_port"
  echo "    Desktop 请连接 https://127.0.0.1:${tls_port}（首次连接需确认一次自签证书指纹）"
else
  echo "    Desktop 连接 暂无 HTTPS，密钥/重认证命令会被拒绝"
fi
if [ -n "$kapon_pid" ]; then
  echo "    fake Kapon  http://127.0.0.1:${fake_kapon_port}（密钥 test-key）"
fi
echo "    日志        $log_dir/"
echo "    Ctrl-C 退出并清理全部子进程"

wait "$go_pid"
