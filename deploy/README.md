# Nevix 官方公网部署手册

本目录是官方公网交付资产的 canonical owner（ADR-0013）：`docker-compose.yml`（唯一
对外暴露 443 的完整栈）、`nginx/nginx.conf`（TLS/流式/限速边缘）、`cert-init/`
（自签证书生命周期）、`postgres/init-identity-app.sh`（首启凭据预置）、
`Dockerfile.server`（Go server 镜像）与 `.env.example`。备份与恢复脚本及手册归
仓库 `scripts/`（后续切片交付；本手册先给入口）。

目标形态：面向**固定公网 IP** 的单租户部署。Go、PostgreSQL 与未来 filesystem
Storage 只存在于 Docker internal network，宿主机唯一发布端口是 nginx 的 443；
所有上游镜像按 digest 钉扎。V1 分发渠道即本仓库检出（镜像由部署机本地构建），
正式镜像分发渠道推迟到打包分发阶段（ADR-0013）。

## 1. 前置条件

- Linux 主机，可安装 Docker Engine 与 Compose v2（`docker compose version`）。
- 一个**固定公网 IP**，防火墙/安全组放行 TCP 443 入站，且不放行其他本栈端口。
- 规划 ~300 用户、峰值 ≤10 并发生成任务的规模画像（ADR-0013）。
- 规划磁盘：pgdata（数据库）、tls（证书私钥，极小）。参考素材 blob 卷随存储
  切片交付，届时单独规划。

## 2. 首次部署

```bash
cd deploy
cp .env.example .env
chmod 600 .env
# 编辑 .env：NEVIX_PUBLIC_IP、POSTGRES_PASSWORD、
# NEVIX_IDENTITY_APP_PASSWORD（三者全部必填；密码用随机值）
docker compose build
docker compose up -d
docker compose ps          # cert-init 应为 exited (0)，其余 running/healthy
```

启动顺序由 compose 保证：postgres 健康 → server 迁移并就绪 → cert-init 成功 →
nginx 挂载证书对外服务。首次启动 cert-init 会为 `NEVIX_PUBLIC_IP` 生成**五年**
自签证书（私钥 0600，独立 `tls` 卷持久化）并打印 SHA-256 指纹。

### 完成 Instance Claim 再分发 URL

公网基线默认 `NEVIX_SETUP_CODE_REQUIRED=true`：空实例的 server 启动时在运维日志
打印一次性设置码：

```bash
docker compose logs server | grep -oE 'setup_code=[0-9A-Z]{4}-[0-9A-Z]{4}'
```

部署方在 Desktop 首连向导中用它完成首位 Admin 认领（自选 email/密码），**然后**
才向团队分发 `https://<NEVIX_PUBLIC_IP>`。这是防止"先拿到 URL 者成为管理员"的
交付纪律；产品不做 IP 白名单或网段推断（ADR-0013）。认领后设置码即失效。

> 受隔离内网（确认无未授权访问路径）可显式设 `NEVIX_SETUP_CODE_REQUIRED=false`
> 放开认领。该决定必须由部署方显式做出——公网部署保持 true。

### 连通性验收

```bash
curl -vk https://<NEVIX_PUBLIC_IP>/health        # {"status":"ok"}
docker compose exec nginx ss -tlnp               # 容器内只有 443
docker ps --format '{{.Names}} {{.Ports}}'       # 宿主机只有 nginx 0.0.0.0:443
```

## 3. 证书指纹交接（TOFU）

Desktop 首次连接必须核对指纹（用户从独立渠道获得）后确认钉扎。查询指纹的固定
命令：

```bash
docker compose exec cert-watch openssl x509 -in /etc/nginx/tls/server.pem \
  -noout -fingerprint -sha256
```

（nginx 官方 alpine 镜像不含 openssl；cert-watch 与 nginx 挂载同一 tls 卷并携带
openssl，是固定的查询入口。）

生成时 cert-init 也会打印同一指纹。把 `SHA256 Fingerprint=...` 通过独立于
Server URL 的渠道（如部署交付邮件/当面）交给用户核对。重启与升级**复用**证书，
指纹不变。

## 4. 证书生命周期：显式轮换 / 公网 IP 变化 / 损坏

系统**从不自动轮换**：只有 tls 卷为空（首次部署）或操作员显式
`CERT_FORCE_NEW=true` 才会生成新证书。已持久化的证书一旦损坏、过期、key 不配对
或不再匹配配置的公网 IP，cert-init 会**拒绝处理并退出非零**（fail closed），栈的
边缘因此拒绝启动，直到操作员显式决定轮换——因为每一次指纹变化都要求所有
Desktop 重新确认信任（TOFU），这必须是人做出的决定：

```bash
docker compose run --rm -e CERT_FORCE_NEW=true cert-init
docker compose restart nginx
```

各触发场景：

- **主动轮换**（到期前续期、私钥疑似泄露）：直接执行上述命令。
- **公网 IP 变化**：先更新 `.env` 的 `NEVIX_PUBLIC_IP`，再执行上述命令（证书 SAN
  与新 IP 不匹配会在启动时 fail closed 并指向本命令）。
- **证书损坏 / 过期**：同上。过期前 90 天 cert-watch 每天告警，那是轮换信号。

轮换完成后用第 3 节命令取新指纹并重新分发。V1 不支持自动轮换、域名与企业 CA
（ADR-0013；如需域名证书，后续版本另立决策）。

## 5. 到期告警

证书有效期内最后 90 天，`cert-watch` 服务每天在日志输出 WARNING（含到期日）：

```bash
docker compose logs cert-watch          # 关注 "expires within 90 days"
```

部署方应把该日志纳入例行巡检；看到告警即按第 4 节主动轮换。

## 6. 备份与恢复入口

- **数据库**：`pgdata` 卷。备份入口是 `pg_dump`（本机执行）：
  ```bash
  docker compose exec postgres pg_dump -U postgres -d postgres -Fc \
    > nevix-$(date +%F).dump
  ```
  恢复流程（custom 格式 dump → 空卷重建）：
  ```bash
  docker compose down                # 停栈（保留卷）
  docker volume rm nevix_pgdata     # 丢弃目标卷（确认已无更新数据）
  docker compose up -d postgres     # 空卷重新初始化（含 identity_app 预置）
  # 等 postgres healthy 后，停迁移竞争、导入、再拉起全套：
  docker compose stop server
  cat nevix-<日期>.dump | docker compose exec -T postgres \
    pg_restore -U postgres -d postgres --clean --if-exists
  docker compose up -d
  docker compose logs server | tail  # 应看到迁移检查后正常监听
  ```
  恢复后用 Desktop 登录或 `curl -k https://<IP>/identity/setup/status` 验证
  `"initialized":true`。
- **TLS 材料**：`tls` 卷（`server.pem` + `server.key`）。随数据库同窗口备份：
  ```bash
  docker compose cp nginx:/etc/nginx/tls/server.pem ./tls-backup/
  docker compose cp nginx:/etc/nginx/tls/server.key ./tls-backup/
  ```
  私钥文件按 0600 保管。恢复时直接放回 `tls` 卷即可，指纹不变：
  ```bash
  docker compose cp ./tls-backup/server.pem cert-watch:/etc/nginx/tls/   # 示例；
  # 实际用临时容器或 volume 操作写回，并保持 key 0600
  ```
- 未来 Provider 主密钥 secrets 卷、参考素材 blob 卷纳入同一备份窗口；组合备份
  与恢复的正式脚本及手册归仓库 `scripts/`，随对应切片交付（ADR-0013）。

## 7. 失败排查

| 症状 | 排查 |
| --- | --- |
| `cert-init` exited (1)，栈不起 | `.env` 缺 `NEVIX_PUBLIC_IP`；或已持久化证书损坏/过期/IP 变化被 fail closed 拒绝——日志给出原因与第 4 节轮换命令 |
| 密码含 `/ @ : # %` 等字符后启动失败 | 两条数据库密码进入 URL，字符集只允许字母/数字/`-`/`_`（见 `.env.example` CHARSET CONTRACT）；改 .env 后空卷重建或 ALTER ROLE 对齐 |
| 443 被占用 | 前置 nginx/云 LB 占用；释放后 `docker compose up -d`。改宿主端口需同步改 compose 的 ports 与 `X-Forwarded-Port` |
| server 反复重启、数据库认证失败 | `NEVIX_IDENTITY_APP_PASSWORD` 与 pgdata 卷内实际角色密码不一致（首启后改过 .env）。进 postgres 容器 `ALTER ROLE identity_app PASSWORD '...'` 对齐；**不会**自动重置 |
| 认领时提示 invalid_setup_code | 设置码只在空实例启动时打印一次；重启空实例会轮换新码，重新 `docker compose logs server` 取新值 |
| 认领错误的人成了 Admin | 拥有任何用户后不能重新认领、V1 无离线恢复（ADR-0015）。尚无业务数据时整栈重建：`docker compose down -v` 后重做首次部署 |
| Desktop 报证书指纹变化 | 预期行为：发生了轮换/IP 变化。核对第 3 节新指纹后确认；无法解释的变化按私钥泄露处理（第 4 节轮换） |
| 重建 server 容器后 nginx 502 | nginx 启动时解析 server 容器地址；`docker compose restart nginx` 重新解析 |
| 大量 429 | 触发 nginx 背压限速（登录面 2r/s/IP、一般面 200r/s/IP）；确认是否 NAT 出口聚合流量异常，必要时调整 `nginx/nginx.conf` 的 zone 参数后 `docker compose restart nginx` |

## 8. 交付不变量（改动本目录前必读）

- 宿主机唯一发布端口是 nginx 443；不得给 postgres/server 添加 `ports`。
- 上游镜像引用必须带 digest；本地构建镜像的 FROM 必须带 digest。
- nginx 必须删除外部 Forwarded/X-Forwarded-* 后只写可信 HTTPS 标记
  （后续切片的 `secure_transport_required` 依赖它）。
- 证书身份只允许两种变化：空卷首次生成，或 `CERT_FORCE_NEW=true` 显式轮换；
  其他一切持久化状态（损坏/过期/IP 变化）fail closed，绝不允许自动重建。
- `proxy_buffering`/`proxy_request_buffering` 保持 off：SSE、上传、下载、Range
  与大文件响应端到端流式。
- 自动化合同测试：`scripts/tests/deploy-stack.test.mjs`（`make harness-test`
  运行）。改动 compose/nginx/cert-init 后先跑测试再交付。
