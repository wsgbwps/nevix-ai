# ADR-0016: AI Creation V1 可信 seam 基线与旧假设退场

## 状态

已接受 — 2026-08-26。权威来源为 [#93](https://github.com/wsgbwps/nevix-ai/issues/93) 收敛出的实施规格 [#150](https://github.com/wsgbwps/nevix-ai/issues/150)；本 ADR 把规格中跨 Module、跨 context 的责任 seam 固化为仓库权威架构决定，供实施切片直接遵循，不重开已关闭决策。

2026-09-01 修订：Capability Manifest 改为随代码发布的版本化合同；真实 Provider smoke 仅是人工发布检查，不再生成或部署运行时 evidence，也不参与 Server 启动或实例能力激活。本修订取代 #150、#158 与 #166 中关于 Production Readiness evidence 运行时门控的设计。

## 背景

AI Creation V1 的产品决策分散在 Wayfinder map #77 的 19 张已关闭 decision tickets 与多份 ADR 中；旧票建立于 Organization、Supabase/RLS、Desktop 直连数据面等前提之上。#93 清空全部决策前沿并取代早期假设，#150 把最终边界收敛为单一规格。若不在架构文档中固化，实施 agent 容易复活已被取代的设计。本 ADR 与 [ADR-0012](0012-unified-ai-creation-owner.md)（owner 统一）、[ADR-0014](0014-go-sole-trusted-data-plane.md)（数据面）、[ADR-0015](0015-single-tenant-user-system-and-go-authorization.md)（用户系统与授权）互补，各自保持单一权威说明。

## 决策

### 旧假设退场

以下前置假设全部退场，实施不得从旧票或旧文档恢复；作废 ADR 原文仅为历史存档：

- **Organization、Membership、Owner**：多组织概念已随单租户私有化移除（[ADR-0015](0015-single-tenant-user-system-and-go-authorization.md)）；发布词汇使用 Team Publication，角色只有 Admin/Member。
- **Supabase（Auth/RLS/Data client/Storage Policy）、Supabase Broadcast**：Supabase 整体退场（[ADR-0013](0013-onprem-single-tenant-delivery.md)、[ADR-0014](0014-go-sole-trusted-data-plane.md)），授权在 Go 层，推送是 SSE。
- **直传 Storage Grant / 预签名直连**：文件一律经 Go 有界流式出口，Desktop 不获得 Storage 凭据（[ADR-0014](0014-go-sole-trusted-data-plane.md)）。
- **独立 creation 数据库角色**：不存在按域拆分的第二执行角色；Creation 写事务直接以最小权限 `identity_app` LOGIN 角色运行（见下）。
- **Deployment Administrator**：不存在产品内的部署管理员主体；部署侧责任（认领、证书、备份）由部署方经 Instance Claim 与交付资产承担，治理主体只有 Admin/Member。
- **外部 Secret Store 前置要求**：Provider 凭据保护使用本地 AEAD（见下），不依赖 Vault 等外部服务。

**2026-08-26 后续决定（覆盖 #93）**：V1 不包含 User 举报入口、Reports 聚合或 report 状态机，不交付 report schema/API/UI/测试；内容安全只保留 Admin 直接限制与解除（active/released 实例级限制 + 脱敏 Audit Log）。

### 可见性模型（权威）

- **creator-private**：Creation Session、Reference Material、Generation Task、Generation Specification、Generation Result 与 Result Slot 只允许创建者读取；查询层和命令层都执行该规则，Admin 治理命令不返回私有内容——Admin 只能查看治理所需的 ID、创建者、状态、时间、支持编号和限制事实，不能读取 prompt、参考素材、未发布媒体或供应商原始 payload。
- **team-readable**：成功 Media Asset 与有效 Team Publication 对全体 active User 可见；Asset 创建者或 Admin 可删除 Asset，只有 Asset 创建者可首次发布，Publication 发布者或 Admin 可撤回。
- 所有 Creation route 在 Server 显式挂 `RequireActiveUser` 或 `RequireAdmin`；Desktop 可见性门控不是授权真相。

### 认证与授权注入

Session 认证与 Reauthentication Proof 归 Identity（[ADR-0015](0015-single-tenant-user-system-and-go-authorization.md)）。Creation 通过 composition root 注入的窄 public interface 消费 authenticated principal 与 exact-action proof：不 deep-import Identity implementation，不复制凭据验证。Provider Key 首次配置、替换与连接删除分别使用 exact action；proof 由当前密码签发、五分钟有效、opaque hash 持久化、单次消费，消费成功后即使后续业务命令失败也不恢复。

### Creation domain-local 写事务

Creation 拥有自己的 domain-local write transaction implementation，与 Identity 的 Write Transaction Module 同纪律但不 deep-import 它，也不提前建立通用数据库框架：

- 直接以最小权限 `identity_app` LOGIN 角色运行；Module 构造时与每个写事务开始后验证 Authentication/Execution Identity（`session_user = current_user`），失败即回滚且不执行业务代码。
- 独占 begin/commit/rollback/cancel/panic 与 AfterCommit effect；外部 Provider/Storage 调用永不发生在持锁事务内。

### 共享 Audit Append

通用审计写入是共享深 Module（Audit Append，语义见 [ADR-0009](0009-audit-log-snapshot-and-immutability.md)）：Creation 在自己的业务事务内 append actor/target 快照、合法 action 与脱敏 metadata，append 失败回滚业务写；Identity 保留 Admin Audit Log 查询 surface。审计行不可 UPDATE，保留 365 天。

### Session 吊销后断流

Identity 在 Session 吊销事务成功提交后，通过共享 Domain Event（`internal/event`）发布受影响的非敏感 Session identity；Creation 的 SSE hub 订阅并断开精确流。回滚不发布；已授权的在途 HTTP 请求不追溯取消；事件只表达事实，不携带 token、prompt 或私有内容。

### 本地 AEAD（Provider 凭据保护）

- Provider Key 以应用层 AEAD envelope 存入 PostgreSQL：数据库外 secrets volume（目录 0700、文件 0600、原子创建）保存 32-byte CSPRNG master key；AES-256-GCM + 每次随机 nonce；版本化 envelope 保存 key ID、nonce、ciphertext，AAD 绑定 Connection ID、Kapon 与凭据用途。
- master key 权限过宽、损坏、不可读或解密失败时 Connection 进入 `credential_unavailable` 并 fail closed，Server 其他业务继续运行；已有密文时绝不静默生成替代 key。恢复只能由 Admin 经 exact-action Reauthentication 重新输入 Key：先安全建立新 master key 文件，再完成 Connection Check 与新密文写入，任一步失败保持 `credential_unavailable` 且可重试。
- Provider Key 明文只在 Go 检查或调用期间短暂存在于内存；Key、prompt、私有媒体、Authorization header、可访问 URL 与任意原始 response body 不进入 Desktop、普通日志、Audit Log 或错误响应。Generation Task/Result Slot 已是 creator-private，因此失败结果位可持久化并向该任务创建者返回 Kapon 标准错误 envelope 中有界的 `code`、`type`、`message`、`request_id`，以及 Server 后处理阶段生成的明确安全诊断；可信适配器先对本次凭据、Authorization 形态、提交 body 中的 prompt/reference 与 URL/data URL 模式做脱敏，再丢弃控制字符、超长值和 envelope 外字段。稳定 Failure Reason 继续承担状态机、重试与治理判断，诊断对象只解释该 verdict，不参与控制流。首个稳定映射仍为 Kapon `MODEL_GROUP_ALL_UNAVAILABLE` → `provider_route_unavailable`，用于区分模型渠道不可用与一般临时故障；若同一响应携带标准错误 envelope，Desktop 同时显示其具体字段。Provider Connection 管理面、普通日志和 Audit Log 仍不返回这些 creator-private 诊断。

### Capability Manifest 与 Provider 验证

- AI Provider Capability Manifest 是随 Nevix 代码发布的版本化合同：模型、模式、参数与参考素材限制只有在开发者确认供应商合同并更新实现、契约和测试后才进入版本。Desktop 镜像允许值，Server 仍执行权威准入校验。
- 实例运行时只把 AI Provider Connection Check 作为媒体可用性输入：Token、固定模型可见性或管理状态不满足时，仅对应 Creation 媒体 fail closed；这些事实不影响 Server 启动和其他业务。
- fake adapter 与契约测试进入普通 CI。首次正式发布、固定模型变化或供应商合同变化时，开发者按发布 checklist 人工执行真实 Kapon generation smoke，并把结果记入 release checklist 或 issue；该记录不是部署资产，不进入 Server 配置，不控制 Capability Manifest，也不要求重启 Server 激活。
- 用户真实生成失败只使对应 Generation Task/Result Slot 进入明确失败或重试语义；不得因为外部 Provider 一次失败而终止 Server 进程。

### 官方公网交付责任

Go 唯一可信数据面与桌面端连接规则归 [ADR-0014](0014-go-sole-trusted-data-plane.md)；官方公网 Compose、证书生命周期与备份范围的权威说明归 [ADR-0013](0013-onprem-single-tenant-delivery.md)。交付资产 canonical owner：官方公网 Compose、Nginx 配置、证书初始化与部署手册归 `deploy/`，备份与恢复脚本及手册归 `scripts/`（目录契约见根 `README.md`）。

## Considered Options

- **按规格逐票实施、不改架构文档**：旧 ADR 与最终基线冲突（团队共享可读、RFC1918 http、Organization Publication），实施 agent 会沿冲突文档复活旧设计；否决，先做本文档 prefactor。
- **把全部 seam 并入 ADR-0014/0015**：两份 ADR 的主题分别是数据面与用户系统；可见性、写事务、AEAD、断流是 Creation 侧职责，混入会破坏各自单一主题；否决。
- **Identity 写事务 Module 直接复用为共享框架**：deep-import 破坏 Module 边界，且无第二个 consumer 之前建通用数据库框架属过早抽象；否决，Creation 建同纪律的 domain-local 实现。
- **外部 Secret Store（Vault 等）**：私有化交付新增外部依赖与运维面；本地 AEAD + 数据库外主密钥已覆盖威胁模型（数据库/备份泄露不直接暴露可用 Key）；否决。
- **Production Readiness evidence 作为运行时能力门禁**：把发布检查结果复制到每个 Deployment Instance，再由 Server 在启动时解析其 schema，会把发布审计、部署配置和运行时可用性耦合；文件漂移还能阻止整个数据面启动，而普通测试、Connection Check 和发布前 smoke 已分别覆盖开发、实例配置与发布风险。否决。

## 后果

- 实施切片以本 ADR 为架构入口：与最终基线冲突的旧表述以本 ADR 与所引修订为准。
- 后续切片如需改变本 ADR 记录的 seam，先修订本 ADR 或其指向的权威 ADR，再实施。
- 仓库目录契约在根 `README.md` 命名 `deploy/` 与 `scripts/` 的交付资产归属；公网交付切片不得临时新建顶层 source owner。
- 部署不再包含 Production Readiness evidence 文件、环境变量、secrets volume 路径或复制后重启步骤；旧文件即使仍留在主机也不被 Server 读取。

## 非目标

- 本 ADR 不定义 creation OpenAPI 形状、生成状态机、治理计数与 UI 合同；这些归 [#150](https://github.com/wsgbwps/nevix-ai/issues/150) 的对应实施切片。
