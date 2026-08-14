# ADR-0003: Main 采用 Domain-first IPC adapter

## 状态

已接受 — 2026-07-30；2026-08-13 修订：允许 Window lifecycle 使用唯一的 platform-owned typed IPC adapter

## 决策

Electron Main 以 Domain locality 为第一组织轴：Domain-owned IPC adapter 位于 `main/<domain>/ipc/`，共享 Channel interface 继续位于 `shared/ipc/<domain>/`，generic preload 保持不含 per-Domain 代码。Window lifecycle 是唯一 platform-owned typed IPC 例外，位于 `main/window/ipc/` 与 `shared/ipc/window/`，使用 `window:<action>` Channel；它不把 Window 伪装成 Domain。`updater` 与 `tray` 仍不拥有 IPC adapter。`main/index.ts` 通过 `./*/ipc/index.ts` 自动发现 Domain 与获准的 Window registration module；每个 registration module 无 import side effect、只导出同步且顺序无关的 `register(): void`，每个 Channel 的 Handler 直接位于 `ipc/`。

Canonical Domain 名贯穿实际存在的 Main、shared IPC、renderer Feature 与 Channel prefix，但不为缺失 seam 创建空目录。Authentication Domain 使用 `authentication`；Language Mode 与 Interface Language 合并归入 `language`，不把现有 `settings` 与 `i18n` 固化为两个互相依赖的 Domain。`window/`、`updater/`、`tray/` 等平台职责继续作为非-Domain owner；Window 的同名 cross-process seam 只表达 BrowserWindow lifecycle，不取得业务行为。

Renderer document 的身份与 top-level frame 判断是 `main/window/` 拥有的单一平台安全约束，而不是各业务 Domain 的 IPC 规则。敏感 Domain Handler 必须在产生副作用前显式调用该 canonical predicate，不得复制 domain-local sender 判断。按照 [ADR-0004](0004-renderer-routing-topology.md) 的 memory-history 决策，可信 URL 仅为 renderer entry 的 exact URL；fragment、query、其他路径或 origin 均不受信任。

Window ordinary-close 协议需要 Main 向 renderer 请求决定、renderer 异步回应，以便 app-owned Settings coordinator 等调用方等待保存或取得明确丢弃决定。该协议必须关联 pending request、验证 exact top-level renderer sender、拒绝陈旧或重复决定；Main Window 只运输 close intent 和最终决定，不解释 Feature 的 dirty、saving 或 command 状态。generic preload 继续只暴露 typed `invoke`/`on`，不增加 Window 专用方法。

IPC adapter 可以依赖同 owner implementation，implementation 不得反向依赖 IPC。Domain 只有在存在外部 Main caller 时才创建根 `index.ts` public interface；跨 Domain 依赖只能经过 public interface 且必须无环。Architecture verifier 对 Window adapter 应用与 Domain adapter 相同的 registration shape、Handler nesting、Channel prefix、shared declaration 与 implementation independence 规则，同时继续拒绝其他 platform-owner adapter。

## 取舍

Adapter-first 的 `main/ipc/<domain>/` 让所有 IPC adapter 集中，但理解一个 owner 时需要跨 adapter 树与 implementation 树跳转，且同一 Domain 日后增加 protocol 或 background adapter 时 locality 会继续下降。Domain-first 增加了 Main 根目录中 Domain 与平台 owner 并存的分类责任，但把一个 owner 的 adapter 与 implementation 集中到同一 ownership 范围，并保持 cross-process interface 和 generic preload 独立。Window 例外避免创造只为传递 BrowserWindow lifecycle 的伪 Domain，也不授权新的通用 platform transport 层。

## 后果

该决定部分取代系统 ADR-0001 中 TypeScript runtime registration 的物理路径与 glob；分散类型声明、declaration merging、generic preload、自注册原则和 Go 显式注册决定继续有效。Main Domain-first、Language Domain 合并、Channel 重命名与单一 glob 保持原子形状，不长期保留两套目录、双 glob 或旧 Channel alias。新增 platform-owned IPC 仍需重新修订本 ADR；Window 例外不能作为 Updater、Tray 或业务逻辑进入 platform owner 的先例。
