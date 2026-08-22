# Server

Go 后端服务，按业务复杂度决定分层深度。

## Language

**Module**:
`internal/` 下的独立业务单元，组合根与测试只见 Module 包本身。统一 contract：`LoadConfig(getenv)` 加载部署配置、`NewModule` 构造依赖、`Register(r chi.Router, bus event.Bus)` 完成路由和事件订阅注册、`RunWorkers(ctx) error` 运行后台 Worker 直到 ctx 取消（无 Worker 的 Module 空转）。
_Avoid_: service, package, domain

**AI Creation Module**:
Server 中 canonical owner 名为 `creation`、与 Desktop AI Creation Domain 共享同一 AI 创作业务 owner 的 Module，边界覆盖图片与视频生成的可信命令、供应商连接和异步编排；媒体类型和供应商 adapter 不单独构成 Module。
_Avoid_: Video Generation Module, Image Generation Module, Provider Module, videogen

**Aggregate Root**:
拥有一致性边界的领域实体，仅在复杂 module 中使用（如 AI Creation Module）。
_Avoid_: model, record

**Domain Event**:
module 间异步通信的载体，类型集中定义在 `internal/event/types.go`，通过事件总线分发。
_Avoid_: message, notification, signal

**Repository**:
聚合根的持久化接口，定义在 `domain/repository.go`，实现在 `infrastructure/`。简单 module 不需要拆出。
_Avoid_: store, DAO, data layer

## 用户系统

**User**:
由管理员创建的登录主体，email 是唯一登录标识；含显示名、角色与状态，密码重置由管理员执行，无自助邮件通道。
_Avoid_: Account, Member（指角色时）, Profile

**Admin**:
两级角色中的管理者：建号、停用、重置密码、改登录 email、读 Audit Log；最后一个活跃 Admin 不可自降级或自停用。
_Avoid_: Owner, Administrator, Manager

**Member**:
两级角色中的基础使用者；对业务数据与全体活跃用户目录团队共享可读。
_Avoid_: User, Regular User

**Session**:
服务端可吊销的已认证状态：opaque token 仅以 hash 存于 Postgres，多设备并存、滑动过期；改密、停用或吊销即刻生效并断开该用户的 SSE 连接。
_Avoid_: JWT, 登录态

**Authentication Identity (认证身份)**:
运行时数据库连接经 `session_user` 观察到的登录主体。Identity 运行时必须**直接以 `identity_app` 登录**；owner 等高权限凭据即使能 `SET ROLE identity_app` 也不是合法运行配置，认证身份不能用事务内角色切换替代。
_Avoid_: login role（泛指任意登录角色）, service role, 数据库用户（不区分认证/执行时）

**Execution Identity (执行身份)**:
同一连接经 `current_user` 观察到的、实际参与权限检查的角色，与认证身份一起在 Identity Module 构造时以真实数据库往返验证为恰 `identity_app`（验证失败即构造失败，进程不得启动 HTTP listener 或 Worker），并在每个写事务开始后由 Write Transaction Module 重新验证——事务期验证失败则该事务回滚、业务代码不执行，Lean V1 仅失败受影响操作。
_Avoid_: 权限角色（不指明观察方式）, effective role

**Write Transaction Module (写事务模块)**:
Identity Domain 内全部 Identity-owned 写事务的唯一生产入口（`internal/identity/writetx`）。它独占事务开始、执行身份验证、commit 与 rollback：回调 nil 提交、错误回滚、回调完成前观察到的取消阻止提交、panic 尽力回滚并保留、从不自动重放回调。用户、会话与审计写路径一律经由它；命令层组件持有 runner 而非数据库连接池，新增 Identity 写路径不得自建事务约定。它是 Domain 内的责任命名子包，不是 Server 共享数据库层。
_Avoid_: transaction framework, Unit of Work, 共享数据库执行层。

**测试边界（Test Boundary）**: 测试所观察的责任边界；按被测代码是通过 owning package 的内部 seam，还是通过 Module 的公开 contract 来划分，不按是否使用真实数据库划分。

**Module 契约测试（Module Contract Test）**: 只通过 Module 的公开 contract（`LoadConfig`、`NewModule`、`Register`、`RunWorkers`）观察真实协作行为的测试；不依赖业务子包的未导出实现。

**包内真库测试（Package-Local Real-Database Test）**: 在 owning package 内直接验证 SQL、query plan、事务或其他内部 seam 的测试；使用真实数据库不会改变其 package-local 归属。

**测试资源（Test Resource）**: 测试所依赖的 fake、真实 PostgreSQL、认证服务、Mailpit 等外部协作者；资源类型决定运行环境和测试命令，不决定测试的 canonical owner。

**测试支持代码（Test Support Code）**: 仅为测试组装环境或访问测试替身服务的代码，不属于生产业务 contract；只有在存在第二个真实 Module consumer 时，才考虑提升为跨 Module 的共享测试包。
