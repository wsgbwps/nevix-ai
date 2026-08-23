# #121 自注册 — 实施决策补记

依据：`.scratch/join-code-self-registration-plan.md`（#123 冻结的实施计划，切片 1/2）。
本文件只记录计划未明说、实施中需要落定的决策，供评审对照。

## 决策

1. **`invalid_join_code` 状态码 = 403**。加入码是提交给公开端点的凭据：码错/无活跃码
   是「凭据不被接受」而非「请求形状错误」（400）也非「认证失败」（401——注册并未认证
   任何人）。与 login 的 wrong-credential 语义平行但非同一形态。
2. **限速复用同一 limiter 实例**（`auth.Service.limiter`）。「复用登录 limiter 模式」按
   字面执行：email 是两个表面共同的攻击键，登录表面本就允许 5 次失败锁定（未知 email
   也计数），注册失败（码错/邮箱占用）计入同一计数不引入新暴露；成功注册与成功登录一
   样 `RecordSuccess` 清零。429 机器码用 `register_rate_limited`（区别于登录的
   `login_rate_limited`），Retry-After 头同构。
3. **失败计数口径**：`invalid_join_code` 与 `email_taken` 都 `RecordFailure`（与登录对
   未知 email / 错密码计数平行）；请求形状 400（过短密码等）不计数（从未到达命令）。
4. **显示名缺省 = email local part**（与 bootstrap / 管理员建号同规则），trim 后按字符
   数 ≤128 校验（`invalid_display_name` 400）。
5. **加入码规范化**：trim + 大写后比对（Crockford base32 本就大小写不敏感；生成侧恒为
   大写）。读码输错大小写不应失败。
6. **审计行形态**：`user_self_registered`，actor = 新用户本人快照（事务内 SnapshotSubject），
   target = nil（自己对自己冗余；与 `session_created` 同形态），metadata = `{email,
   join_code_id}`（哪个码被兑现，可追溯）。**不**额外写 `session_created`：注册事务发的
   session 由 `user_self_registered` 一行完整记录（计划冻结的审计面）。
7. **`last_login_at` 于注册事务内打点**。注册即携 session 进入应用；「从未登录」删除
   保护语义按「从未进入应用」理解，防止带活跃 session 的自注册号被当作建错号删除。
8. **响应 = 201 + `LoginResponse` 形态**（token/expires_at/user），user.role=member、
   must_change_password=false。契约 0.7.0。
9. **bcrypt 在事务外**（与 users.Create / login 同构）：限速器先把失败尝试压到 5 次/窗口，
   坏码请求的 bcrypt 成本有界。
10. **包落位：`auth`**。register 是 login 形态的公开账号进入命令（发 session、限速、
    bootstrap 同款建号 INSERT 都在 auth）；join_code 校验是注册事务内一行 SELECT。
    joincodes 包保持 #120 的治理面（issue/list/revoke）不变。

## 测试面（对验收条款）

- Seam A：成功 / 无活跃码≡码错（同体 403）/ email_taken / 密码过短 / 吊销后拒 /
  限速 429+Retry-After / 审计行 / 契约对照（assertContractResponse）。
- E2E：凭码注册进 app；码吊销后注册失败文案（invalid_join_code 词条）。
