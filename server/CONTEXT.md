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
module 间异步通信的载体，类型集中定义在 `pkg/event/types.go`，通过事件总线分发。
_Avoid_: message, notification, signal

**Repository**:
聚合根的持久化接口，定义在 `domain/repository.go`，实现在 `infrastructure/`。简单 module 不需要拆出。
_Avoid_: store, DAO, data layer
