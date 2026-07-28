# Finalize the Authentication Policy

Type: grilling
Status: resolved
Blocked by: 01, 02

## Question

在已确认邮箱密码、验证码、Session 生命周期、Email Change 和 Security Lock 的基础上，V1 还需要哪些密码规则、限流、枚举防护、失败锁定和异常恢复语义，才能形成完整而不过度设计的认证政策？

## Answer

Identity V1 采用以下最小认证政策。

### 密码凭据

- 密码允许 Unicode，权威长度为原始输入的 12–72 个 UTF-8 字节；72 字节是当前固定 Supabase Auth 上限。Desktop 显示动态字节计数并提前反馈同一规则。
- 密码是精确、不透明的字节串。Desktop 和服务端都不得 trim、改变大小写或执行 Unicode NFC/NFKC 规范化。
- 不强制大小写、数字或符号组合，不接入 HIBP，不维护常见密码库，也不建立可被绕过的纯客户端字符数规则或 Auth 代理。
- 新密码必须与当前密码不同，沿用 Supabase 的 `same_password` 校验；V1 不保存密码历史、不阻止隔代复用，也不设置定期过期或强制轮换。
- 成功的密码修改或恢复发送不可关闭的安全通知；失败尝试不逐次发邮件。

### 限流、锁定与 CAPTCHA

- 登录与注册共用 Supabase 原生的每 IP 30 次/5 分钟限制。
- 所有验证码签发与重发对同一规范化邮箱跨用途合计最多 5 次/小时，相邻发送至少间隔 60 秒。
- 未认证验证码请求对每 IP 合计最多 60 次/小时。
- 每个 code 最多提交 5 次，同时验证码提交对每 IP 最多 30 次/5 分钟。
- 超限不签发新 code、不使旧 code 失效或延长其有效期；返回不暴露邮箱存在性的 429，并只在服务端提供时显示 `Retry-After`。
- V1 不设置按 User/email 的永久或定时失败锁定。攻击者触发某个 IP 的限制后，合法 User 仍可从其他网络登录。
- V1 不接入 CAPTCHA、指数退避、设备指纹、分布式信誉评分或假想 provider adapter；只有出现可验证的分布式撞库、批量注册或邮件滥用后才另行设计。

### 枚举防护

- 登录失败统一为“邮箱或密码错误”。
- 密码恢复始终为“如果该邮箱已注册，我们会发送恢复邮件”。
- 注册始终给出存在性中立的检查邮件提示，并同时提供登录和忘记密码入口。
- 同一规范化邮箱只对应一个 Auth identity。重复注册未验证邮箱时不创建第二个 User；限流允许时签发新注册 code 并使旧 code 失效。重复注册已验证邮箱时不创建 User，也不发送注册 code。
- 客户端不得根据 Auth 响应中的 User 形状或邮件是否发送改变注册界面分支。
- 已认证 Email Change 的冲突统一为“该邮箱无法使用”，不说明它属于现有 User、待处理变更还是安全保留。
- 不要求人为恒定响应时间；Desktop 不增加查询邮箱是否存在的请求或分支。

### Code 与普通密码恢复

- 注册邮箱验证和忘记密码 code 均有效 1 小时。重发使旧 code 立即失效，并从新 code 发出时重新计算 1 小时。
- code 过期、已使用或不匹配统一为“验证码无效或已过期”。验证失败不创建 Session，也不改变密码或安全状态。
- 普通密码恢复只适用于未进入 Pending User Deletion、Security Lock 或其他专用恢复状态的 User；它不会验证注册邮箱、取消 Pending User Deletion、解除 Security Lock，或完成、撤销、回滚 Email Change。
- Pending User Deletion 必须走已验证邮箱的删除撤销流程；Security Lock 必须走旧邮箱恢复流程。专用流程失败时保持原状态，不回退成普通密码恢复。

### 恢复信任根与 Security Lock

- 已验证邮箱控制权是 V1 唯一的凭据恢复信任根。V1 不提供安全问题、备用码、客服人工改邮箱、Organization 管理员代重置或其他人工身份核验旁路。
- 无法访问登录邮箱且忘记密码的 User 在 V1 不可恢复；可创建新 User，再由有权限的 Owner/Admin 重新邀请。若不可恢复者是唯一 Owner，V1 不提供人工 Organization 接管。
- Email Change 期间，当前邮箱和待验证新邮箱都保留给同一 User。变更完成后，旧邮箱继续保留到 “not me” 凭证的 24 小时窗口结束；若触发 Security Lock，则保留到恢复完成。只有无争议窗口结束后旧邮箱才可重新注册。
- Security Lock 的旧邮箱恢复 code 有效 1 小时，并使用相同验证码限流。验证旧邮箱只证明恢复资格，不单独解除锁定。
- 恢复必须完成旧邮箱验证、符合政策的新密码、旧登录邮箱恢复、Email Change 撤销、全部旧 Session 撤销和相关凭证消费；最后才清除 Security Lock。
- 任一中间步骤失败都保持锁定，重试必须幂等。成功后不自动创建 Session，也不授予五分钟重新认证窗口；User 必须使用恢复后的邮箱和新密码重新登录。

### Session 撤销边界

- Session 和 refresh token 的撤销立即生效，旧设备不能再刷新。
- 已签发 access token 对普通 Supabase/RLS 数据访问最多仍可使用到一小时到期；V1 不让每条普通 RLS 查询 `auth.sessions`。
- 所有 `internal/identity` 可信命令额外验证 JWT 的 `session_id` 仍然有效，因此密码重设、密码变更或退出后立即拒绝旧 Session 的治理与危险操作。
- Security Lock 和 Pending User Deletion 是强 User 状态；Go 与 RLS 都检查该状态，使账号使用立即停止，不等待 access token 到期。
- UI 不声称普通数据访问瞬时失效，而说明其他设备退出最长可能需要一小时完全生效。

### 错误边界

- 只向用户具体展示不会泄露身份存在性的可操作错误：密码字节长度、`same_password`、通用 invalid credentials、通用 invalid/expired code，以及 429。
- 网络、SMTP 或服务异常使用可重试的通用错误，不暴露 Supabase 原始错误、内部状态、堆栈或标识符。
- V1 不创建 Auth 错误码的公共共享抽象；Identity Domain 内执行穷尽映射，未知错误安全回退并进入内部遥测。
