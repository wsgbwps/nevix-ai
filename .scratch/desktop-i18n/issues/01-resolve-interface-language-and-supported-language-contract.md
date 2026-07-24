# 01 — 启动时解析 Interface Language，并建立 Supported Language 契约

**What to build:** 让 Nevix 在没有已保存语言选择时，根据启动时的系统语言完整地呈现简体中文或英文，并同时建立可持续扩展的 Supported Language 资源契约。这个切片应从主进程语言解析贯穿到窗口和渲染界面，且通过自动化测试与 CI 保证正式支持语言不会缺词。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 默认 Language Mode 为“跟随系统”；启动时最高优先级系统语言属于中文语言族时，Interface Language 为 `zh-CN`。
- [ ] 启动时最高优先级系统语言属于英文语言族时，Interface Language 为 `en`。
- [ ] 启动时最高优先级系统语言既非中文也非英文时，Interface Language 回退为 `zh-CN`。
- [ ] 本次启动解析出的系统语言保持稳定，不监听运行期间的操作系统语言变化。
- [ ] 主进程拥有解析后的 Interface Language，渲染界面与至少一个主进程拥有的 Localized Surface 显示一致语言。
- [ ] 使用 `i18next` 初始化主进程本地化实例，使用 `i18next` 与 `react-i18next` 初始化独立的渲染进程实例；两个进程不共享内存实例。
- [ ] 应用 Provider 层向 React 界面提供翻译能力，用户不会看到空白或内部翻译 key。
- [ ] 唯一 Supported Language 注册表只声明 `zh-CN` 和 `en`，正式可用语言来源于该注册表，而不是自动扫描全部语言资源。
- [ ] 各资源所有者使用独立 namespace；Feature 资源通过其公共边界提供，不直接导入其他 Feature 的内部资源。
- [ ] CI 逐 namespace 验证所有 Supported Language 的必需资源存在、必需 key 完整且值非空。
- [ ] 未注册候选语言允许资源不完整，且不会自动成为 Supported Language。
- [ ] 正式资源意外缺词时，生产配置回退到简体中文；开发和测试配置报告可定位的缺失翻译错误。
- [ ] TypeScript 能检查静态字面量翻译 key，常规实现不依赖动态 key 绕过资源契约。
- [ ] 新增单一 `@playwright/test` 测试框架；Electron 应用测试以隔离用户数据和受控系统语言覆盖中文、英文与不支持语言三条启动路径。
- [ ] 同一测试 runner 执行 Supported Language 资源契约测试，不额外引入第二套单元测试框架。
- [ ] Desktop lint、node/web TypeScript 检查、生产构建和新增测试全部通过。
