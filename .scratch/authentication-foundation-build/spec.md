# Authentication Foundation Build Spec

Status: ready-for-agent

## Problem Statement

Nevix AI Desktop 当前会直接渲染应用内容，尚无 Authentication Feature、Supabase SDK、认证边界或安全的 Session 持久化。用户无法在 Desktop 内完成邮箱密码注册、邮箱验证、登录、密码恢复和当前设备退出，应用也无法在启动时可靠地区分“仍在恢复 Session”“已认证”“未认证”和“服务暂时不可用”。

团队需要一个可以独立构建、测试、合并和回滚的 Authentication Foundation vertical slice。它必须让真实 Supabase Auth 闭环先运行起来，并把 Electron 的凭据存储和 renderer 安全边界做到可信；同时必须在这里停止，不把尚无真实用例反馈的 Profile、Organization、业务数据库、RLS 或 Go Identity module 提前带入实现。

## Solution

在 Desktop 的 `identity` Domain 内建立单一 Authentication Feature，由顶层应用组合根据 Session 状态显示阻塞式恢复界面、可重试的恢复失败界面、未认证认证流程或已认证 app shell。Renderer 使用 publishable key 直接调用 Supabase Auth，不经 Go 代理；main process 只通过 domain-local IPC 为 Supabase Session 提供 `safeStorage` 加密的持久化能力。

Authentication Foundation 支持邮箱密码注册、六位注册 code、登录、六位密码恢复 code、设置新密码、安全启动恢复和退出当前设备。所有错误映射、存在性中立提示、Session 状态和恢复资格都留在 Authentication Feature 内，不建立仓库级通用 Auth 抽象。

验收以一个最高层 seam 为主：构建后的真实 Electron 应用连接固定版本的一次性 Supabase Auth 与 Mailpit，通过现有 Playwright runner 穿过 UI、Supabase、IPC、`safeStorage` 和磁盘状态验证完整外部行为。平台原生凭据服务无法在 Ubuntu CI 可靠证明的部分，通过 macOS Keychain、Windows DPAPI 和受控 Linux Secret Service smoke evidence 补充。

## User Stories

1. 作为首次使用 Desktop 的用户，我想在未认证边界看到登录、创建账号和忘记密码入口，以便选择符合当前目的的认证流程。
2. 作为未认证用户，我想只用邮箱和密码创建账号，以便不在 Authentication Foundation 阶段被要求填写 Profile 或 Organization 信息。
3. 作为创建密码的用户，我想看到按原始输入计算的 UTF-8 字节数和 12–72 字节规则，以便在提交前修正无效密码。
4. 作为使用 Unicode 密码的用户，我想让空格、大小写和 Unicode code points 保持原样，以便 Desktop 不在我不知情时改变凭据。
5. 作为注册用户，我想在提交后看到不泄露邮箱存在性的统一提示，以便产品不会帮助第三方枚举已注册邮箱。
6. 作为注册用户，我想收到包含六位 code 和一小时有效期说明的邮件，以便不依赖 Desktop 自定义协议或外部浏览器完成验证。
7. 作为输入注册 code 的用户，我想在不足六位时不能提交，以便立即发现不完整输入。
8. 作为输入错误、过期或已使用 code 的用户，我想停留在同一输入状态并看到统一错误，以便可以修正或重新发送而不泄露内部原因。
9. 作为等待邮件的用户，我想重新发送 code，并看到 60 秒冷却状态，以便避免重复提交且知道何时可以重试。
10. 作为收到新 code 的用户，我想明确知道旧 code 已失效，以便不会继续尝试已经不能使用的凭据。
11. 作为完成注册验证的用户，我想建立正常 Session 并进入 app shell，以便验证后无需再次登录。
12. 作为已注册用户，我想用邮箱和密码登录，以便恢复对当前设备上的 Desktop 使用权。
13. 作为登录失败的用户，我想只看到“邮箱或密码错误”，以便未知邮箱、未验证邮箱和错误密码不会形成账号枚举分支。
14. 作为提交认证表单的用户，我想在请求进行中不能重复提交，以便不会产生重复请求或互相覆盖的状态。
15. 作为忘记密码的用户，我想提交邮箱后看到存在性中立提示，以便恢复流程不泄露该邮箱是否注册。
16. 作为忘记密码的用户，我想通过六位恢复 code 证明邮箱控制权，以便不需要 Magic Link 或 Desktop 深链。
17. 作为已验证恢复 code 的用户，我想只获得设置新密码所需的临时恢复资格，以便中间状态不会被误当作正常 app Session。
18. 作为设置新密码的用户，我想沿用相同的 12–72 UTF-8 字节规则，并在密码相同时看到可操作提示，以便正确完成恢复。
19. 作为完成密码恢复的用户，我想返回登录并使用新密码重新登录，以便恢复资格不会隐式进入 app shell。
20. 作为完成密码恢复的用户，我想让旧 refresh Sessions 被撤销并收到密码已修改通知，以便遗失设备不能继续刷新认证状态。
21. 作为重新打开 Desktop 的已认证用户，我想在安全恢复成功后直接进入 app shell，以便不必每次启动都重新登录。
22. 作为正在启动 Desktop 的用户，我想在 Session 是否有效尚未确认时只看到阻塞式恢复状态，以便不会短暂看到登录页或受保护内容。
23. 作为 refresh token 已失效、损坏或被撤销的用户，我想让本地认证材料被清除并回到登录，以便 Desktop 不会反复尝试不可恢复的 Session。
24. 作为在断网或 Supabase 暂时不可用时启动的用户，我想让本地 Session 保留并看到可重试恢复失败状态，以便暂时故障不会被误报为退出登录。
25. 作为处于暂时恢复失败状态的用户，我想主动重试，以便服务恢复后可以继续当前 Session。
26. 作为凭据服务不可安全使用的用户，我想让当前运行期可以继续使用内存 Session、但重启后要求重新登录，以便 token 不会降级为明文持久化。
27. 作为 Linux 用户，我想让 `basic_text` 后端被视为不可安全持久化，以便 Electron 的弱回退不会被当作加密。
28. 作为已认证用户，我想从 app shell 退出当前设备且无需确认弹窗，以便可以快速结束本机 Session。
29. 作为在退出时遇到网络错误的用户，我想让本机认证材料仍立即清除并返回登录，以便远端撤销失败不会让当前 Desktop 继续进入 app shell。
30. 作为退出时遇到远端撤销失败的用户，我想看到不夸大安全边界的提示，以便理解本机已退出但服务端撤销可能延迟。
31. 作为简体中文或英文用户，我想在完整认证流程中看到对应 Interface Language 的 Desktop 文案，以便认证边界与现有本地化体验一致。
32. 作为安全审查者，我想确认 Desktop 包中没有 Supabase secret key、service-role key、PostgreSQL 凭据或签名私钥，以便公开客户端不能跨越可信执行 seam。
33. 作为安全审查者，我想确认 renderer 的 Session 不写入 `localStorage`、IndexedDB 或明文 JSON，以便磁盘泄漏不直接暴露 token。
34. 作为安全审查者，我想确认 BrowserWindow sandbox、context isolation、node integration、web security、CSP 和导航策略被明确验证，以便认证功能不会依赖 Electron 默认值或开放任意外部 URL。
35. 作为实现者，我想只处理一个 Desktop 主导的 cohesive vertical slice，以便可以独立验证和回滚而不需要 Profile、Organization、schema、RLS 或 Go Identity module。
36. 作为维护者，我想通过现有 Electron Playwright seam 验证用户可见行为而不是私有 reducer 或组件实现，以便测试在 UI 重写后仍然表达产品契约。

## Implementation Decisions

### Delivery and ownership

- 本规格只交付 Authentication Foundation，是 `identity` Primary Domain 内的一个 Desktop 主导 vertical slice。
- Authentication Feature 拥有 Supabase client、认证状态、认证子流程、错误映射和用户可见认证文案，并只通过自己的公开入口被应用组合使用。
- 顶层 `App` 负责在 `restoring`、`restore-retryable-failure`、`unauthenticated` 和 `authenticated-shell` 四个边界之间选择。暂时性恢复失败必须是可见 React 状态，不能被藏在渲染前永不结束的 bootstrap promise 中。
- 当前应用内容成为最小 authenticated app shell。进入该 shell 只证明存在有效 Session，不创建或暗示 Profile、Organization、Membership 或业务资源访问。
- 不增加 React Router。登录、注册、注册验证、忘记密码、恢复验证和设置新密码使用 Authentication Feature 内显式状态。
- 不增加共享 Auth library、公共错误码 package 或通用 provider adapter。Feature 之间不得导入 Authentication Feature 的内部文件。
- 预计不修改共享 UI 层；若实现确实需要新增共享 primitive，必须按共享区域规则单独说明影响、测试和维护者复审，本规格不自动授权该扩展。

### Supabase boundary and configuration

- Renderer 直接调用 Supabase Auth。这是 ADR-0004 允许的公开数据面路径；Go、Edge Function 和 main process 都不成为 Auth 请求代理。
- Desktop 构建只接收 Supabase API URL 与 publishable key。secret/service-role key、PostgreSQL 凭据、JWT 私钥和 SMTP 凭据不得进入 renderer、preload、安装包、日志、trace 或截图。
- Supabase client dependency 使用实施时核对过官方文档的固定版本，并提交 lockfile；不得依赖浮动版本来决定 Auth 行为。
- 缺少或格式无效的公开配置必须在启动时明确失败。开发、CI、预发布和生产使用各自构建配置，生产不提供用户可编辑的 Supabase URL。
- Authentication Foundation 只配置 Supabase Auth，不创建业务 schema、migration、RLS、GRANT、Storage bucket、Realtime subscription 或 Go database role。
- access token lifetime 为一小时；Session 允许多设备并发，14 天无活动后要求重新登录，绝对最长 90 天。超时在 refresh 边界生效，界面不得声称已签发 JWT 在所有数据路径瞬时失效。
- 本地与 CI 邮件进入隔离的 Mailpit。任何预发布或生产样环境必须使用 custom SMTP；Supabase 默认 SMTP 不作为验收环境。
- 注册确认和密码恢复邮件使用六位数字 code，并明确一小时有效期；模板输出 code 而不是 action link。当前阶段不注册 Electron custom protocol，也不接受通用深链。
- 在尚无账号语言偏好的阶段，Auth code 邮件采用包含简体中文与英文的固定双语模板，不为此创建 Profile 或把语言当作授权 claim。
- 开启不可关闭的密码修改安全通知。

### Password and abuse policy within this slice

- Desktop 对注册和新密码执行同一输入契约：原始输入必须是 12–72 UTF-8 字节；不 trim、不改变大小写、不做 Unicode normalization，也不增加字符组合规则。
- 字节计数与提交校验属于 Authentication Feature 的产品边界。Authentication Foundation 不为字节精确的服务端最小长度新增 Go 代理、数据库 hook 或自定义 Auth fork，也不声称客户端校验是不可绕过的授权控制。
- `same_password` 是可以具体显示的恢复错误；其他未知 provider 错误安全回退为通用服务错误。
- 使用 Supabase Auth 在本阶段原生提供的登录/注册、邮件发送、重发冷却、code 尝试和 token 验证限流。不得用 renderer 计数器冒充可信限流。
- 旧 Identity policy 中需要跨用途、按规范化邮箱持久聚合，但当前 Supabase Auth 配置不能直接表达的自定义滥用计数器，不在本 slice 通过新 schema 或 Go module 补建。若真实流量证明原生限流不足，它将成为单独的可信执行与 abuse-control 设计任务。
- 429 只展示通用限流消息；只有 Supabase 实际提供可信的 retry 时长时才显示等待时间。网络、SMTP 与服务异常不暴露 provider 原文、内部标识符或堆栈。

### Registration and verification

- 注册只收集邮箱和密码，并调用 Supabase email/password signup。UI 不根据返回的 User 形状、邮箱是否已存在或邮件是否实际发送建立不同分支。
- 注册提交成功和安全可归一化的冲突都进入同一存在性中立状态：“如果该邮箱可以用于注册，我们已发送验证码”，并继续提供登录与忘记密码入口。
- 注册验证只接受六位 code；不足六位不能提交。错误、过期与已使用统一为“验证码无效或已过期”，并保留当前邮箱和输入状态。
- resend 使用同一注册用途；提交后 60 秒内禁用再次发送。新 code 成功签发后明确说明旧 code 已失效。
- 注册 code 验证成功返回的正常 Session 进入唯一 authenticated Session owner，随后才能进入 app shell 并按安全持久化契约保存。

### Login and authenticated boundary

- 登录只接受邮箱和密码。未知邮箱、未验证邮箱和错误密码均映射为“邮箱或密码错误”。
- 认证请求进行中禁止重复提交；失败保留用户可安全保留的表单上下文，但密码不得写入持久化状态或日志。
- Authentication Feature 是 app shell 的唯一认证 gate。其他 Feature 不自行读取 token 判断登录状态，也不根据 UI 状态授予权限。

### Password recovery

- 忘记密码提交始终进入存在性中立的恢复 code 状态，不根据邮箱是否注册改变界面。
- 恢复 code 通过一个与正常 authenticated Session owner 隔离的临时 Supabase Auth client 验证。该 client 禁用持久化和自动刷新；Supabase 返回的 recovery Session 只保留在该子流程内存中。
- recovery Session 只能调用设置新密码所需的 Auth 操作。它不得发布为顶层 authenticated Session、不得进入 app shell、不得写入 main process Session store。
- 密码更新成功后，使用 recovery Session 请求全局撤销 refresh Sessions，再清除临时恢复材料并返回登录。即使全局撤销响应失败，也不得把 recovery Session 提升为正常 Session；提示必须准确说明需要使用新密码重新登录。
- 已签发 access JWT 可能在最长一小时内仍保持密码学有效；本阶段没有业务 schema 或 Go 敏感命令，因此不增加逐请求 `auth.sessions` 检查。

### Session state and startup recovery

- 正常 authenticated Session 只有一个 owner。Supabase Auth state events必须映射到显式应用状态，未知事件不得绕过 `restoring` 或进入 app shell。
- Desktop 启动先读取加密 Session；没有持久化材料时进入未认证状态。
- 存在持久化 Session 时，启动必须跨一次真实 refresh/validation 边界后才进入 app shell，不能只因缓存 access token 尚未过期就判定恢复成功。
- refresh 成功时原子持久化轮换后的 Session，再进入 app shell。
- refresh token 明确无效、已撤销、不可解密或持久化 payload 不合法属于终止性失败：清除本地材料，进入登录，并显示“登录状态已失效，请重新登录”。
- 网络不可达、超时、5xx 或 Supabase 暂时不可用属于可重试失败：保留加密材料，停留在独立恢复失败状态，不显示 app shell，也不误报为退出。
- Retry 重新执行相同恢复操作。不得通过忽略验证、使用陈旧 UI cache 或降级为匿名 shell 来“恢复”。

### Encrypted Session persistence

- Supabase 的正常 authenticated client 使用 async custom storage adapter；adapter 通过 domain-local typed IPC 调用 main process 的 Session store。
- IPC 只允许固定的读取、替换和清除 Session 操作，不提供任意文件路径、任意 key/value store 或 Supabase 请求代理。
- Main process 使用 Electron `safeStorage` 的异步加解密能力，在应用 `userData` 下只保存 ciphertext。磁盘文件不得包含 access token、refresh token、邮箱或序列化 Session 的明文片段。
- Session 写入采用原子替换，避免崩溃留下部分 ciphertext。读取时验证持久化 envelope/version 与解密后的最小 Session 形状；损坏、截断或未知版本按终止性失败处理，不回退读取明文。
- IPC Handler 对 payload 做运行时校验，并验证调用 sender 属于当前受信任 renderer。TypeScript 类型本身不作为安全边界。
- Preload 保持现有通用 typed `invoke/on` bridge；不增加 Authentication 专用 preload API，也不修改中央 IPC registry 来登记 domain 行为。
- Renderer 只在内存中使用当前 Session，不写 `localStorage`、IndexedDB、web cache 或明文文件。Main process 不把 token 记录到日志。
- `safeStorage` 不可用、暂时不可用或 Linux 选择 `basic_text` 时，store 明确返回“不允许持久化”。当前运行期 Session 可继续留在内存，但不能写盘，下一次启动必须重新登录。
- macOS Keychain、Windows DPAPI 和 Linux Secret Service 的安全保证按 Electron 平台语义描述；UI 只承诺“此设备上的 Session 安全保存”这一经过实际平台验证的能力。

### Current-device logout

- app shell 提供“退出当前设备”；无需确认弹窗，提交期间禁止重复操作。
- 正常路径显式请求 Supabase current-session/local scope sign-out，而不是默认的 global scope。
- 无论远端响应成功、token 已不存在还是网络失败，Desktop 都清除内存 Session 与 main process ciphertext，并立即回到登录；远端失败不能保留本机 app shell 访问。
- 本阶段不为失败的远端撤销持久化 token 或建立后台队列。网络失败时只说明当前 Desktop 已退出、远端撤销可能延迟，不声称其他设备或被复制的 token 已被撤销。

### Electron security boundary

- BrowserWindow 显式固定 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false` 和 `webSecurity: true`，不依赖 Electron 默认值。
- Renderer CSP 默认拒绝远程连接；`connect-src` 只加入当前构建的精确 Supabase Auth HTTP/HTTPS origin。Authentication Foundation 不使用 Realtime，因此不为未来用途预加 WS/WSS 或 wildcard。
- 生产只允许 HTTPS；loopback HTTP 只存在于 disposable local/CI 环境。CSP 不允许通用 `http:`、`https:`、`ws:`、`wss:` 或 `*` source。
- 顶层 navigation 与新窗口默认拒绝。Authentication Foundation 没有外部链接需求，因此不把任何 Auth URL 传给 `shell.openExternal`；未来真实链接需求必须另建完整 protocol/origin/path allowlist。
- 默认拒绝 renderer permission request；只有未来具体能力经单独设计后才增加最小授权。
- 安全改动只覆盖认证闭环实际依赖的 BrowserWindow、CSP、navigation、permission 和 IPC sender 边界，不扩展成一般 Electron 重构。

### Localization and observability

- 全部 Desktop Authentication Localized Surface 同时提供简体中文和英文资源，并遵循现有 Interface Language 热切换与简体中文 fallback 契约。
- 用户可见错误由 Authentication Feature 穷尽映射。未知错误进入安全通用文案，并允许写入不含邮箱、密码、code、token、Supabase key 或原始响应 body 的内部诊断事件。
- 认证字段、邮件 code、Session payload 和 provider error 不进入 analytics、console、Playwright trace attachment 或 crash breadcrumb。

## Testing Decisions

### Test quality and seam

- 好测试只验证外部可观察行为：用户看到哪个边界、能否提交、是否进入 app shell、Supabase 是否真实签发/撤销 Session、磁盘是否只有 ciphertext、重启后是否恢复。测试不锁定 reducer action、React component tree、私有 helper 或具体 Supabase SDK 调用顺序。
- 主要且最高的 seam 只有一个：构建后的 Electron 应用通过 Playwright 连接一次性真实 Supabase Auth 与 Mailpit。该 seam 同时覆盖 renderer、真实网络、Auth 配置、邮件、domain IPC、main Session store 和磁盘状态。
- 复用现有 Electron Playwright launcher：隔离 `userData`、关闭并使用同一目录重启、main-process evaluate、离线网络模拟、accessible role/name UI 断言和失败时清理。
- 不为 Authentication Foundation 新增 Vitest 或第二套 frontend unit-test framework。只有无法通过最高 seam 稳定触发的 `safeStorage` 暂时不可用状态，才允许通过现有 Playwright runner 注入窄的 E2E test control；test control 必须只在非打包 E2E 环境启用。

### Disposable integration environment

- CI 使用固定版本、一次性销毁的本地 Supabase stack 和 Mailpit，只绑定 loopback，不使用 linked cloud project、生产 secret 或共享开发数据库。
- 测试从干净 Auth 状态开始；每个 case 使用唯一邮箱并通过 Mailpit API 有界轮询 code，不使用固定 sleep。
- Desktop 只接收测试 Supabase URL 与 publishable key。只有测试 fixture/setup 可以持有本地 admin credential，用于构造过期、撤销或损坏等前置状态；credential 不进入应用进程、日志或 trace。
- CI 明确先 build 再运行 Playwright，并以单 worker 执行共享 Auth/Mailpit 流。无论成功失败都停止 Supabase、删除 volume、临时 userData 和测试密钥材料。

### Required behavior coverage

- 启动时 `restoring` 阻止 app shell 与登录页闪现；无持久化 Session 进入登录。
- 注册只收邮箱/密码；验证 12–72 UTF-8 字节、不 trim/normalize；提交结果保持邮箱存在性中立。
- Mailpit 捕获六位注册 code；错误、过期、已使用和不足六位分支正确；resend 冷却存在，新 code 成功且旧 code 失效。
- 注册验证成功建立 Session 并进入 app shell。
- 登录成功进入 app shell；未知邮箱、未验证邮箱和错误密码得到同一用户文案；重复提交被阻止。
- 密码恢复始终存在性中立；Mailpit 捕获六位 recovery code；恢复验证不进入 app shell；`same_password` 与通用错误映射正确。
- 新密码设置成功后回到登录，旧 refresh Session 无法再刷新，新密码可以登录，密码修改安全通知已发送。
- 登录后关闭并使用同一 `userData` 重启，真实 refresh 成功后恢复 app shell，并验证轮换后的 Session 已重新加密落盘。
- 撤销/无效 refresh token、截断 ciphertext、随机 ciphertext 和未知 envelope version 均清理持久化材料、回到登录且不崩溃。
- 已持久化 Session 下离线启动停留在可重试恢复失败状态，保留 ciphertext，不显示 app shell；恢复网络后 Retry 成功。
- 当前设备 logout 后内存与 ciphertext 均清除；重启仍为未认证。离线 logout 同样先离开 app shell，并显示准确的远端撤销延迟提示。
- 磁盘扫描证明已知 Session 文件中不存在 access token、refresh token、邮箱或完整 Session JSON 的明文。
- Linux 强制 `basic_text` 时不写持久化 Session，重启要求登录；测试报告不得把这一 case 表述为 Linux Secret Service 加密成功。
- 所有认证状态、表单、错误、按钮、code 说明和恢复失败界面在简体中文与英文资源中完整，并通过现有资源 contract。

### Required Electron security coverage

- 通过真实 BrowserWindow 的最终 web preferences 断言 sandbox、context isolation、node integration 与 web security，而不是只读取源码文本。
- Playwright 以 Chromium sandbox 启动 Electron；测试配置不得使用会让 sandbox 验收失真的默认关闭行为。
- CSP 测试证明精确 Supabase Auth origin 可连接，并通过 `securitypolicyviolation` 证明 sentinel origin 被 `connect-src` 阻止；connection refused 不能冒充 CSP 成功。
- 断言生产 CSP 没有 wildcard、通用 scheme 或 Authentication Foundation 不需要的 WS/WSS origin。
- 断言顶层 navigation、新窗口、任意 external-open 与 permission request 默认被拒绝。
- 断言 renderer global 只暴露既有通用 typed bridge，Authentication 没有额外 Node/Electron 能力。

### Native evidence outside the Ubuntu PR lane

- macOS packaged smoke：Keychain 可用时登录、关闭、重启、解密恢复、logout 清除，并证明磁盘无明文。
- Windows packaged smoke：DPAPI 可用时执行同一闭环，并按 Electron 的同用户会话安全边界描述结果。
- 受控 Linux Secret Service smoke 可作为补充，但 stock Ubuntu/Xvfb 不能被当作真实 Secret Service 证据。
- Keychain 锁定、系统提示和暂时不可用通过 release smoke/manual checklist 验证；在 runner 行为稳定前不作为阻塞普通 PR 的伪确定性自动化。

### Acceptance gate

- 一个干净 checkout 能以已记录命令构建 Desktop、启动 disposable Auth/Mailpit、完成所有 required behavior/security coverage，并保证失败后清理。
- `lint`、node/web typecheck、build 与 Authentication Playwright suite 全部通过。
- 安装包与测试 artifact 扫描未发现 secret/service-role key、数据库凭据、密码、code 或 token。
- Implementation PR 只包含 Authentication Foundation 与其窄支撑改动；没有 Profile、Organization、业务 schema、RLS、Go Identity module、通用 shared Auth API 或无关重构。
- Ubuntu PR lane 通过后，功能可合并；声明某一原生凭据后端“已支持”前，必须同时具备对应平台 smoke evidence。

## Out of Scope

- Profile、显示名称、头像、账号级语言偏好和任何公开用户资料。
- First Organization、Active Organization、Organization 创建与任何业务资源归属。
- Membership、Invitation、多 Organization、Owner/Admin/Member 角色与成员治理。
- 任何业务 schema、Supabase declarative schema、migration、RLS、GRANT、Storage Policy、Realtime 或 Data API CRUD。
- `server/internal/identity`、Go JWT/JWKS verifier、Go Auth Admin client、可信命令和逐请求 `session_id` 验证。
- Ownership Transfer、Organization/User Deletion、Pending Deletion、Email Change、Security Lock、Audit Log 和 Outbox。
- 自定义跨用途 abuse counter、CAPTCHA、设备指纹、信誉评分、永久/定时账号锁定和 provider adapter。
- 登录后的改密码、重新认证窗口、查看其他设备、远程撤销指定设备、退出所有其他设备和 Session inventory。
- Magic Link、社交登录、匿名登录、MFA、SAML SSO、SCIM、Electron custom protocol 与通用 deep link。
- Profile/Organization onboarding；注册验证成功只进入现有最小 app shell。
- 阿里云 RDS compatibility、预发布/生产基础设施、生产 TLS/DNS 演练、真实邮件 deliverability、bounce 处理、运营后台与完整可观测性。
- 对 Supabase Auth 内部 schema 的修改、对 Auth server 的 fork，以及为了字节精确密码规则增加新的可信代理。
- 一般 Electron 安全重构、通用外链系统、未来业务权限请求和 Authentication 不需要的 Realtime CSP 放行。

## Further Notes

- 本规格是 [Authentication Foundation Wayfinding Map](../authentication-foundation/map.md) 的实施 handoff，并以 [Prototype the Desktop Authentication Loop](../authentication-foundation/issues/02-prototype-desktop-authentication-loop.md) 的状态差异为当前产品行为来源。
- 认证规则复用 [Finalize the Authentication Policy](../identity-v1/issues/03-finalize-authentication-policy.md) 中与本 slice 可由 Desktop/Supabase Auth 实现的结论；需要新可信存储或 Go/schema 的 abuse-control 部分按本规格范围边界延期。
- Supabase 配置与 Session 语义以 [Verify the Supabase Platform Baseline](../identity-v1/issues/02-verify-supabase-platform-baseline.md) 为基线；测试环境以 [Verify the Integration Test Harness](../identity-v1/issues/09-verify-integration-test-harness.md) 为 prior art。
- [ADR-0004](../../docs/adr/0004-supabase-go-trusted-execution-seam.md) 仍是职责 seam 的权威来源：Desktop 直连普通 Auth，任何 secret 或可信命令都不得借本 slice 进入公开客户端。
- 当前仓库没有 Supabase SDK 或 Authentication Feature，BrowserWindow 仍显式关闭 sandbox；这些是本 slice 必须真实改变并由集成测试证明的现状，不是已经具备的能力。
- 原型 branch `codex/prototype-authentication-foundation-loop`、commit `5df2a2a` 的低保真 UI 只用于确认状态和交互语义，不是视觉或生产代码模板。
