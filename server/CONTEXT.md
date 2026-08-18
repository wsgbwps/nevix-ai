# Server

Go 后端服务，按业务复杂度决定分层深度。

## Language

**Module**:
`internal/` 下的独立业务单元，组合根与测试只见 Module 包本身。统一 contract：`LoadConfig(getenv)` 加载部署配置、`NewModule` 构造依赖、`Register(r chi.Router, bus event.Bus)` 完成路由和事件订阅注册、`RunWorkers(ctx) error` 运行后台 Worker 直到 ctx 取消（无 Worker 的 Module 空转）。
_Avoid_: service, package, domain

**Aggregate Root**:
拥有一致性边界的领域实体，仅在复杂 module 中使用（如 videogen）。
_Avoid_: model, record

**Domain Event**:
module 间异步通信的载体，类型集中定义在 `internal/event/types.go`，通过事件总线分发。
_Avoid_: message, notification, signal

**Repository**:
聚合根的持久化接口，定义在 `domain/repository.go`，实现在 `infrastructure/`。简单 module 不需要拆出。
_Avoid_: store, DAO, data layer

**Outbox**:
与领域状态、Audit Log 同一数据库事务提交的待发消息记录，是 module 对外发送邮件等副作用的唯一出口。
_Avoid_: message queue, mail queue, 待发送表

**Outbox Worker**:
轮询 Outbox 并执行投递与重试的纯投递器，不包含限流、冷却等任何业务规则。携码邮件的重试地平线属投递语义：码被作废或过期时停止投递并将行置为终态（cancelled），由 Worker 在认领与重试调度时执行。
_Avoid_: mailer service, sender, dispatcher

**Resend（服务商）**:
生产环境的邮件投递服务商，仅通过标准 SMTP 端点接入。与「重发码」（重新签发一次性验证码的动作，见 identity 规格）严格区分，讨论中须标注是服务商还是动作。
_Avoid_: resend（指动作时不带限定语）

**Authentication Identity (认证身份)**:
运行时数据库连接经 `session_user` 观察到的登录主体。Identity 运行时必须**直接以 `identity_app` 登录**；owner 等高权限凭据即使能 `SET ROLE identity_app` 也不是合法运行配置，认证身份不能用事务内角色切换替代。
_Avoid_: login role（泛指任意登录角色）, service role, 数据库用户（不区分认证/执行时）

**Execution Identity (执行身份)**:
同一连接经 `current_user` 观察到的、实际参与权限检查的角色，与认证身份一起在 Identity Module 构造时以真实数据库往返验证为恰 `identity_app`（验证失败即构造失败，进程不得启动 HTTP listener 或 Worker），并在每个写事务开始后由 Write Transaction Module 重新验证——事务期验证失败则该事务回滚、业务代码不执行，Lean V1 仅失败受影响操作。
_Avoid_: 权限角色（不指明观察方式）, effective role

**Write Transaction Module (写事务模块)**:
Identity Domain 内全部 Identity-owned 写事务的唯一生产入口（`internal/identity/writetx`）。它独占事务开始、执行身份验证、commit 与 rollback：回调 nil 提交、错误回滚、回调完成前观察到的取消阻止提交、panic 尽力回滚并保留、从不自动重放回调。Organization、Membership、Invitation、Verification 签发与 Outbox Worker 写路径一律经由它；命令层与 Worker 组件持有 runner 而非数据库连接池，新增 Identity 写路径不得自建事务约定。它是 Domain 内的责任命名子包，不是 Server 共享数据库层。
_Avoid_: transaction framework, Unit of Work, 共享数据库执行层
