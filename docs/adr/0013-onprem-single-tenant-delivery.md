# ADR-0013: 私有化交付总纲——从云端 SaaS 转向 B 端单租户 Docker 交付

## 状态

已接受 — 2026-08-22

## 背景

Nevix AI 从云端多租户 SaaS 转型为 B 端私有化部署：Docker 交付到客户内网，一套部署对应一个客户。无生产数据，旧表直接删掉重建（旧世界经 `saas-final` tag 存档），不开新仓库。Supabase 整体退场，只留 Postgres，auth 收进 Go server。

本 ADR 是私有化交付的总纲，收纳不落在其他 ADR 的交付形态决策；数据面 seam 见 [ADR-0014](0014-go-sole-trusted-data-plane.md)，用户系统与授权见 [ADR-0015](0015-single-tenant-user-system-and-go-authorization.md)。

## 决策

### 单租户与账号模型

- 单租户：无多组织概念，一套部署内的全体用户构成一个团队。
- 管理员建号 + 密码，无邮件通道：验证码、邀请函、邮件找回密码全部移除；密码重置由管理员执行。账号系统细节见 ADR-0015。

### 部署形状

- 单一 docker compose：Go server + 捆绑 postgres 官方镜像（钉 major.minor）+ named volume（`pgdata`、`blobs`）。
- V1 只支持捆绑 Postgres；客户强制使用自有数据库平台时再加外部 DSN 支持（届期为兼容矩阵问题）。
- PG 大版本升级是文档化的人工 dump/restore 维护操作，不做自动升级。
- 配置 env-only，延续现状：`PORT`、`DATABASE_URL`（compose 内部生成，不外暴露）、`ADMIN_EMAIL`/`ADMIN_INITIAL_PASSWORD`（仅空库 bootstrap 时生效，见 ADR-0015）、Storage 选择（见下）。无 CLI flag、无 config 文件解析。

### Storage 双后端

- 部署时经环境变量选择后端，不做应用内管理 UI：`STORAGE_BACKEND=filesystem|s3`、`STORAGE_FS_ROOT`（本地卷，NAS 以挂载路径方式覆盖）、`S3_ENDPOINT`/`S3_BUCKET`/`S3_REGION`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`（OSS/COS/MinIO 共用一个 S3 兼容 adapter）。
- 文件一律经 Go server 出口，不做预签名直连，避免绕过 Go 层授权（seam 论证见 ADR-0014）。
- 元数据只在 Postgres，后端是纯 blob 仓。

### 推送通道

- SSE，v1 即实现：Go 单实例内按 user_id 的 hub；事件源为生成任务状态迁移。
- 真相在 Postgres，SSE 仅加速展示；断线重连先全量后续流。
- WebSocket 仅当出现真实双向/高频需求时另立 ADR。

### 升级

- 从 v1 起上 up-only 版本化 migration（无 down），升级 = 拉新镜像重启、启动时自动执行。
- 升级顺序固定为先 server 后 desktop；server 暴露 `min_desktop_version`，desktop 启动与连接时比对，旧于阈值强提示并指向下载页。
- 不引入 electron-updater：air-gap 下 feed 托管、差量与签名验证全是新增负担，版本配对协议承担版本漂移这一分发模型下的真实风险。

### 备份

- `scripts/` 提供 pg_dump 到挂载卷与恢复验证的脚本及手册，备份策略归客户 IT；不做自动备份 sidecar。
- filesystem 后端的 blob 卷必须与 pg_dump 同窗口备份；元数据与 blob 的一致性 V1 不做工具保证，手册写明风险。

### 规模画像

- 按 200–300 用户、峰值 ≤10 并发生成任务、单 Go 实例设计；超出画像时重开对应决策。

### License

- 商务形态为按年订阅。V1 不写 license 代码，纯合同约束起步；既定设计如下，补做时照做不重开：
  - 离线签名 license 文件：客户名、到期日、席位上限，ed25519 签名，公钥编进 server 二进制，`LICENSE_FILE` env 挂载；换发 = 重签 + 换文件 + 重启，无需重装。
  - 仅 server 校验（desktop 永不校验，内网零外联承诺不变）；启动时 + 周期性重查（到期可能跨运行期）。
  - 到期前 14 天登录时警告；到期后阻止新登录并断全部存量 session 与 SSE。
  - 席位上限只阻止新建号，不踢存量用户。
  - 客户控制服务器时钟的作弊接受为剩余风险，不做 phone-home 反制。
- 硬截止点：第一个带到期日的付费客户合同签出前必须落地。

### 推迟与范围边界

- 分发渠道（桌面安装包来源、server 镜像如何到客户）推迟到打包分发阶段另议，本 ADR 不预设。
- AI 创作模块（Kapon 首发接入、BYO-key 可选性、egress 代理策略）全部归 [issue #77](https://github.com/wsgbwps/nevix-ai/issues/77) 轨道，本 ADR 组不设计创作域。

## Considered Options

- **捆绑 Postgres vs 支持外部 DSN**：V1 捆绑覆盖绝大多数客户且测试路径唯一；两者都支持是把兼容矩阵提前搬进 v1。否决。
- **electron-updater vs 版本配对协议**：见「升级」。air-gap 分发下 updater 的基础设施成本高于其价值。
- **License V1 实现**：当前无正式产品与用户，提前写校验代码无合同可执行；但年订阅已定，故将执行语义冻结于此 + 硬截止点，防止补做时重新设计。

## 后果

- `supabase/` 目录、Supabase 相关 E2E/CI harness 随用户系统迁移拆除。
- 部署手册（compose 样例、.env 模板、备份/恢复、nginx TLS 样例、PG 大版本升级步骤）随交付工作落地。
- README 中 electron-updater 的不实表述已修正（仓库从未实现 auto-updater）。
