# Server

Go 后端服务，按业务复杂度决定分层深度。

## Language

**Module**:
`internal/` 下的独立业务单元，导出 `Register(r chi.Router, bus event.Bus)` 完成路由和事件订阅注册。
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
