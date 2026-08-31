#!/usr/bin/env bash
# make server 的实现：本地开发唯一入口（根 Makefile 调用）。
#
# 不变量与约束：
# - Go 服务器只监听明文 http://127.0.0.1:8080 —— "Go 不终结 TLS" 是 ADR-0014
#   不变量；HTTPS 由本脚本按需拉起的 Caddy sidecar 在边缘终结（加载本脚本签发
#   的长期自签证书，注入 X-Forwarded-Proto: https，与 deploy/nginx 的入站纪律
#   一致）。Desktop 一律连 https://127.0.0.1:8443。
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

# 媒体能力受 Production Readiness 门控（规格 #150，#158）：NEVIX_CREATION_
# READINESS_FILE 未设置时两个媒体都停在"尚未通过发布验收"，Workbench 不能
# 提交。变量已设置但文件尚不存在时，用本地合成证据生成一份（仅本地开发；
# 生产证据只能来自 scripts/production-readiness 对真实 Kapon 的执行）。
if [ -n "${NEVIX_CREATION_READINESS_FILE:-}" ] && [ ! -f "$NEVIX_CREATION_READINESS_FILE" ]; then
  node "$repo_root/scripts/dev/dev-readiness-evidence.mjs" --out "$NEVIX_CREATION_READINESS_FILE" \
    >"$log_dir/dev-readiness.log" 2>&1 || true
  if [ -f "$NEVIX_CREATION_READINESS_FILE" ]; then
    log "本地 readiness 证据已生成：$NEVIX_CREATION_READINESS_FILE（本地合成，非发布验收事实；详见 $log_dir/dev-readiness.log）"
  else
    warn "readiness 证据生成失败（见 $log_dir/dev-readiness.log），媒体能力将停在发布验收未通过。"
  fi
elif [ -z "${NEVIX_CREATION_READINESS_FILE:-}" ]; then
  warn "NEVIX_CREATION_READINESS_FILE 未设置：媒体能力将停在「尚未通过发布验收」，Workbench 无法提交（在 server/.env.local 设置该变量可获得本地合成证据）。"
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
    # Dev TLS 身份是本脚本自签的长期证书对，caddy 只负责加载。不用 caddy
    # `tls internal`：它的叶子证书只有 12 小时寿命，续期即换指纹，Desktop 的
    # TOFU pin 每半天就要重新确认。证书只在缺失或已过期时重签，SAN 仅含回环
    # 地址；清空 $cache_dir 才会换新身份，届时 Desktop 需重新确认一次指纹。
    tls_dir="$cache_dir/tls"
    tls_cert="$tls_dir/dev-server.pem"
    tls_key="$tls_dir/dev-server.key"
    mkdir -p "$tls_dir"
    if [ ! -f "$tls_cert" ] || ! openssl x509 -in "$tls_cert" -noout -checkend 0 >/dev/null 2>&1; then
      log "生成长期自签证书（10 年，SAN 仅回环）：$tls_cert"
      openssl_config="$tls_dir/openssl.cnf"
      cat >"$openssl_config" <<EOF
[req]
prompt = no
distinguished_name = dn
x509_extensions = v3_tls
[dn]
CN = Nevix Dev
[v3_tls]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = IP:127.0.0.1,IP:::1,DNS:localhost
EOF
      openssl req -x509 -newkey rsa:2048 -nodes -config "$openssl_config" -days 3650 \
        -keyout "$tls_key" -out "$tls_cert" >/dev/null 2>&1
      chmod 600 "$tls_key"
    fi
    caddyfile="$cache_dir/Caddyfile"
    cat >"$caddyfile" <<EOF
{
    admin off
}

https://127.0.0.1:$tls_port {
    tls "$tls_cert" "$tls_key"
    reverse_proxy 127.0.0.1:$server_port
}
EOF
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
