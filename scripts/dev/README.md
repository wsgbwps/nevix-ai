# 本地开发服务器栈（make server）

`make server` 是本地开发唯一入口，由 `scripts/dev/dev-server.sh` 实现，一条命令拉起：

| 组件 | 地址 | 启动条件 |
| --- | --- | --- |
| Go 服务器 | http://127.0.0.1:8080 | 总是（前台 `go run ./cmd/server`，只听明文 HTTP） |
| Caddy TLS 终结 | https://127.0.0.1:8443 | 安装了 caddy（`brew install caddy`） |
| fake Kapon | http://127.0.0.1:9399 | `server/.env.local` 的 `KAPON_BASE_URL` 指向 `http://127.0.0.1:9399`（或 `localhost`）且端口空闲 |
| readiness 本地证据 | `$HOME/.cache/nevix-dev/readiness/local.json` | `server/.env.local` 设置了 `NEVIX_CREATION_READINESS_FILE` 且文件尚不存在时自动生成 |

使用要点：

- Desktop 的服务器连接填 **https://127.0.0.1:8443**；首次连接需在 Desktop 确认一次自签证书指纹（TOFU），之后不再提示。
- Provider Key / 重认证端点要求"已证明的 HTTPS"（`server/internal/authz` 的 `SecureTransportProven`）。直连 8080 明文会被 `secure_transport_required` 拒绝——这是规格 #150 的明确要求，**没有开发旁路**；Caddy 的作用是把生产形态的可信入口（TLS 在边缘终结 + 注入 `X-Forwarded-Proto`）做成一条命令，而不是放宽服务器。
- fake Kapon 实现 `GET /v1/models`（Connection Check）与切片 10 图片生成路径的 `POST /v1/images/generations` 及临时 URL 输出（issue #160），密钥 `test-key`，其他密钥一律 401（用于验证"候选被拒绝"路径）。自动化测试不得注入生产 Kapon Token（规格 #150）。
- `KAPON_BASE_URL` 指向其他地址（如真实路由）时不会启动 fake Kapon。
- **媒体能力受 Production Readiness 门控**（规格 #150，#158）：`NEVIX_CREATION_READINESS_FILE` 未设置时，两个媒体都停在「能力尚未通过发布验收」，Workbench 不能提交——这是设计行为，不是故障。在 `server/.env.local` 设置该变量（建议 `$HOME/.cache/nevix-dev/readiness/local.json`），启动时会用 `scripts/dev/dev-readiness-evidence.mjs` 自动生成本地合成证据并激活媒体。红线：本地合成证据只存在于开发栈；生产 evidence 只能由 `scripts/production-readiness/probe.mjs` 对真实 Kapon 执行产生（T16 #166），生产环境出现 `local-dev/` 前缀的证据即违规。
- 未安装 caddy 时：仍会启动 8080 并打印安装提示；此时密钥/重认证命令会被拒绝（预期行为）。
- 日志在 `~/.cache/nevix-dev/logs/`（`caddy.log` / `fake-kapon.log`）；Dev TLS 证书是脚本自签的长期证书对（10 年，SAN 仅回环地址），落在 `~/.cache/nevix-dev/tls/`，只在缺失或过期时重签——指纹跨重启稳定，TOFU 只需确认一次；仅当清空缓存目录换发新证书时才需在 Desktop 重新确认。
- Ctrl-C / TERM / 退出时脚本清理自己拉起的全部 sidecar，不留孤儿进程；8080 已被占用时友好报错退出。

**生产不使用本目录任何内容**：生产 TLS 终结者是 `deploy/` 的 Nginx（ADR-0013/0016 冻结），Go 永远只听明文 HTTP（ADR-0014）；Caddy 仅是本地开发工具，不进生产。
