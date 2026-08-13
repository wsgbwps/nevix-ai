# 04 — 最终密码与 Session 安全策略

**What to build:** 在首个真实 User 之前，让部署等价的 Supabase Auth 栈真正强制已定稿的密码与 Session 安全底线，并让 Desktop 以稳定、可操作的双语提示表达同一规则，不暴露字节计数、不为成功登录发明 weak-password gate。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

**Consumes**

- 版本钉定的 Supabase Auth 本地/CI 栈与现有 policy harness。
- Authentication Feature 现有 password policy helper、provider error mapping、Session restore 与 revocation 边界。
- 现有一小时 JWT、refresh rotation 和 Session 加密持久化行为。

**Produces**

- 12–72 UTF-8 bytes、无字符类强制、HIBP 泄露密码拒绝且查询失败 fail-open 的 Auth 策略。
- 一小时 access token、14 天 inactivity timeout、90 天 absolute time-box 与既有 refresh rotation 的部署等价配置。
- 注册/恢复密码提示、太短/太长/已泄露错误映射与对应的 Supabase Auth Policy Harness。

**Owns**

- 密码是不 trim、不转换大小写、不执行 Unicode normalization 的不透明 UTF-8 字节串不变式。
- `weak_password`、`same_password` 和未知 Auth error 的局部映射；不创建公共共享错误抽象。
- 瞬时网络/服务失败保留 Session，明确 refresh-token 撤销、密码安全事件、logout 或强安全状态清除 Session 的边界。

**Acceptance**

- [ ] 注册与恢复新密码常驻显示“建议使用 12 个以上字符”；登录不显示创建密码提示。
- [ ] UI 不显示实时字节计数；对超出 12–72 UTF-8 byte 边界的原始输入显示稳定的太短或太长错误。
- [ ] 注册和密码更新拒绝已泄露密码；HIBP 不可用时请求继续并产生内部告警。
- [ ] 已有 `same_password` 表现保持；未知 provider error 是安全、可重试的通用服务错误。
- [ ] 成功 `signInWithPassword` 响应即使包含 weak-password signal 也正常进入已认证应用，不增加 state、route、modal 或 gate。
- [ ] 真实 Auth harness 证明 12/72 UTF-8 byte 边界、无字符类强制、HIBP 拒绝与 fail-open、1h JWT、refresh rotation、14d inactivity 和 90d time-box。
- [ ] 既有 Session 离线保留、明确撤销、密码恢复和 runtime security-state 验收仍通过。
- [ ] `Authentication Usability Desktop E2E`、`Supabase Auth Policy Harness`、Desktop lint/typecheck/build 与 packaged localization 通过。
- [ ] 产品代码前记录短实施计划；最后代码修改后绑定 final-state evidence 并关闭 finding ledger。

**Parallel classification:** full parallel; `parallel-ready` from the current fixed point.

**Absence test:** 其他 Authentication UX 票全部缺席时，本票仍能通过 Auth harness 与既有 Desktop flow 完整验收。

**Commutativity test:** 与 01/03 可任意顺序合并；04 只负责 Authentication UI/i18n 的机械性冲突收口，不接管它们的业务状态。

**Rollback constraint:** 首个真实 User 之前可在显式安全决定下独立回滚；出现真实 User 后不得通过回滚静默降低密码或 Session 安全 floor。
