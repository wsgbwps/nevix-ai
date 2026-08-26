# ADR-0013: 私有化交付总纲——从云端 SaaS 转向 B 端单租户 Docker 交付

## 状态

已接受 — 2026-08-22

2026-08-24 修订：首次管理员改由默认无凭据的实例认领产生，设置码降为可选部署保护；移除环境变量管理员 Bootstrap 与离线管理员恢复通道。

2026-08-26 修订（AI Creation V1 实施规格 [#150](https://github.com/wsgbwps/nevix-ai/issues/150)）：官方公网 Compose 形状定为「固定版本/摘要的 Nginx 只暴露 HTTPS 443」，客户部署只接受 https Server URL；主密钥与 TLS 材料纳入备份范围；交付资产 canonical owner 命名见「部署形状」与「备份」。

## 背景

Nevix AI 从云端多租户 SaaS 转型为 B 端私有化部署：Docker 交付到客户内网，一套部署对应一个客户。无生产数据，旧表直接删掉重建（旧世界经 `saas-final` tag 存档），不开新仓库。Supabase 整体退场，只留 Postgres，auth 收进 Go server。

本 ADR 是私有化交付的总纲，收纳不落在其他 ADR 的交付形态决策；数据面 seam 见 [ADR-0014](0014-go-sole-trusted-data-plane.md)，用户系统与授权见 [ADR-0015](0015-single-tenant-user-system-and-go-authorization.md)。

## 决策

### 单租户与账号模型

- 单租户：无多组织概念，一套部署内的全体用户构成一个团队。
- 空实例由首个认领者自选凭据成为首个 Admin；初始化后通过 Admin 建号或加入码自注册增加 User。无邮件通道：验证码、邀请函、邮件找回密码全部移除；密码重置仅由仍可登录的 Admin 执行。账号系统细节见 ADR-0015。

### 部署形状

- 单一 docker compose：Go server + 捆绑 postgres 官方镜像（钉 major.minor）+ named volume（`pgdata`、`blobs`）。
- 官方公网 Compose（2026-08-26 修订）：面向客户固定公网 IP 的官方交付栈在同一 compose 内加入固定版本/摘要的 Nginx，只暴露 HTTPS 443；Go、PostgreSQL、Storage 与管理端口只在 internal network，不直接暴露。客户部署只接受 https Server URL，显式 development mode 才允许 loopback http（桌面侧连接规则见 [ADR-0014](0014-go-sole-trusted-data-plane.md)）；官方公网 Compose 强制 Setup Code，受隔离内网可显式关闭。
- 自签证书生命周期：初次启动为固定公网 IP 生成含 IP SAN 的五年自签证书，持久化于独立 tls volume（私钥 0600）；重启/升级复用、不自动轮换，输出 SHA-256 指纹与可重复查询命令，到期前 90 天持续告警。Nginx 删除外部 Forwarded headers 后向 private-network Go 写可信 HTTPS 标记；Provider Key 与 Reauthentication endpoint 无法证明 HTTPS 时返回 `secure_transport_required`。
- V1 只支持捆绑 Postgres；客户强制使用自有数据库平台时再加外部 DSN 支持（届期为兼容矩阵问题）。
- PG 大版本升级是文档化的人工 dump/restore 维护操作，不做自动升级。
- 服务启动配置 env-only：`PORT`、`DATABASE_URL`（compose 内部生成，不外暴露）、`NEVIX_SETUP_CODE_REQUIRED=true|false`（默认 `false`，见 ADR-0015）、Storage 选择（见下）。无 CLI flag、无 config 文件解析。
- `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD` 管理员 Bootstrap 通道删除；检测到任一旧变量即以明确配置错误拒绝启动，防止旧配置被静默忽略后意外开放实例认领。
- 交付资产 canonical owner（2026-08-26 修订，仓库目录契约同步）：官方公网 Compose、Nginx 配置、证书初始化与部署手册归 `deploy/`；备份与恢复脚本及手册归 `scripts/`；后续交付切片不得临时新建顶层 source owner。

### 首次部署与管理员连续性

- 默认实例认领不要求授权凭据；部署方必须在向无关人员广泛暴露 Server URL 前完成认领。产品不以端口未知作为安全边界，也不增加 IP 白名单、网段判断或监听地址推断。
- 上线前认领错误时直接重建尚无业务数据的空实例；实例拥有任何 User 后不允许重新认领。
- V1 不提供离线 Admin 恢复命令、恢复码或其他旁路。部署验收清单与运维手册建议客户保留至少两名 Admin，但产品不强制、不弹窗提醒；所有 Admin 均失联是明确接受的低概率运维风险。

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
- 2026-08-26 修订：Provider Credential 主密钥所在的 secrets volume 与 Nginx tls volume 一并纳入备份范围；PostgreSQL、blob、主密钥与 TLS 材料能按手册组合备份与恢复（主密钥语义见 [ADR-0016](0016-ai-creation-v1-trusted-seams.md)，丢失后凭 Admin 重新认证恢复，不自动重建）。

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
- AI 创作域（Kapon 接入、凭据保护、生成编排）的产品合同归实施规格 [#150](https://github.com/wsgbwps/nevix-ai/issues/150)，跨 Module 可信 seam 基线见 [ADR-0016](0016-ai-creation-v1-trusted-seams.md)；本 ADR 组不展开创作域内部设计。

## Considered Options

- **捆绑 Postgres vs 支持外部 DSN**：V1 捆绑覆盖绝大多数客户且测试路径唯一；两者都支持是把兼容矩阵提前搬进 v1。否决。
- **electron-updater vs 版本配对协议**：见「升级」。air-gap 分发下 updater 的基础设施成本高于其价值。
- **License V1 实现**：当前无正式产品与用户，提前写校验代码无合同可执行；但年订阅已定，故将执行语义冻结于此 + 硬截止点，防止补做时重新设计。
- **环境变量直接创建首个 Admin**（2026-08-24）：需要部署方预填、传递并轮换初始凭据，与“安装后由客户自选管理员凭据”的交付体验相悖；可选设置码已经覆盖需要额外保护的部署，故删除。
- **离线 Admin 恢复或强制双 Admin**（2026-08-24）：前者新增第二条高权限写通道，后者把低概率运维风险变成所有客户的硬门槛；V1 均不采用，以验收建议和客户运维责任承接剩余风险。

## 后果

- `supabase/` 目录、Supabase 相关 E2E/CI harness 随用户系统迁移拆除。
- 部署手册（compose 样例、.env 模板、实例认领顺序、双 Admin 建议、备份/恢复、nginx TLS 配置、PG 大版本升级步骤）随交付工作落地，归 `deploy/` 与 `scripts/` 的 canonical owner。
- README 中 electron-updater 的不实表述已修正（仓库从未实现 auto-updater）。
