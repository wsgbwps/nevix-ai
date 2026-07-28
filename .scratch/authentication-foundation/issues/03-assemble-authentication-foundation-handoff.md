# Assemble the Authentication Foundation Handoff

Type: task
Status: resolved
Blocked by: 02

## Question

结合已确认的 Auth policy、Supabase baseline、Electron 安全边界与 Desktop prototype，汇编一份只覆盖 Authentication Foundation 的实施 handoff；它是否已明确 feature 边界、Session persistence contract、Supabase 配置、错误状态、测试与验收标准，并排除所有后续阶段能力？

## Answer

已发布 [Authentication Foundation Build Spec](../../authentication-foundation-build/spec.md)，状态为 `ready-for-agent`。handoff 已明确：

- 以 `identity` Domain 内单一 Desktop Authentication Feature 和顶层认证 gate 为边界，当前 app 内容只作为最小 authenticated app shell。
- Renderer 以 publishable key 直连 Supabase Auth；Go、业务 schema、RLS、共享 Auth package 与 provider adapter 均不进入本 slice。
- Main process 仅通过 domain-local IPC 和 Electron `safeStorage` 持久化正常 Session；恢复资格保持临时、隔离且不进入 app shell。
- 启动恢复区分成功、终止性失败与暂时性失败；当前设备 logout 无论远端结果如何都先结束本机访问。
- 注册、六位 code、登录和密码恢复沿用 prototype 的存在性中立提示、明确错误状态、60 秒重发冷却与密码字节规则。
- Electron sandbox、CSP、navigation、permission 和 IPC sender 校验作为 Authentication Foundation 的窄安全改动纳入验收。
- 最高测试 seam 固定为构建后的真实 Electron + disposable Supabase Auth + Mailpit + 现有 Playwright runner；原生 Keychain/DPAPI/Secret Service 另以平台 smoke evidence 补足。
- Profile、Organization、Membership、业务 schema、RLS、Go Identity module、治理与生产基础设施均明确排除。

为保持 cohesive vertical slice，旧 Identity policy 中需要新增可信持久状态才能实现的自定义跨用途 abuse counter 没有被伪装成 renderer 限流，也没有借此扩张到 Go/schema；它只在真实流量证明 Supabase Auth 原生控制不足后进入独立设计。
