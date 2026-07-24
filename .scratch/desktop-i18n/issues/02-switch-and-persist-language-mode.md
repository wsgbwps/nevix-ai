# 02 — 切换并持久化 Language Mode

**What to build:** 让用户在无需登录、无需联网的设置界面中选择“跟随系统”“简体中文”或“English”，并让选择通过 `settings` IPC 由主进程立即应用和持久化。当前应用应无重启更新全部运行时文案，之后重新启动仍保持用户选择。

**Blocked by:** 01 — 启动时解析 Interface Language，并建立 Supported Language 契约

**Status:** ready-for-agent

- [ ] `settings` Feature 提供三个且仅三个 Language Mode 选项：跟随系统、简体中文和 English，并清楚显示当前选择。
- [ ] 设置入口在未登录和离线状态下可访问；首版不在顶部栏、托盘或原生菜单增加重复入口。
- [ ] 主进程是 Language Mode 的唯一权威来源，并将其保存在 Electron 应用用户数据目录中。
- [ ] 渲染进程通过 `settings` IPC 读取和更新 Language Mode，不使用 `localStorage` 作为第二权威来源。
- [ ] `settings` IPC 遵守按 Domain 分散类型和 handler 的现有约定，并复用通用 preload 桥，不增加 per-domain preload 代码。
- [ ] 用户固定选择简体中文或英文后，当前渲染界面和主进程拥有的运行时 Localized Surface 立即切换，无需页面重载或应用重启。
- [ ] 固定 Language Mode 在关闭并重新启动应用后仍然生效，并覆盖启动时系统语言。
- [ ] 用户切回“跟随系统”时，当前会话立即采用本次启动时解析出的系统语言；下次启动重新解析系统语言。
- [ ] 缺失、损坏或无法识别的持久化值按“跟随系统”处理，不向渲染进程传播无效 Language Mode。
- [ ] 切换 Interface Language 只改变 Desktop 自有文案，不改变品牌名、用户内容、业务数据、时区、日期数字格式、货币或计量单位。
- [ ] Electron 应用测试通过设置 UI 验证即时切换，不直接调用内部 store、i18n 实例或 IPC handler。
- [ ] Electron 应用测试使用同一个隔离用户数据目录关闭并重启应用，验证固定选择持久化以及切回跟随系统后的重新解析。
- [ ] 测试覆盖无需账号和网络即可读取、修改并恢复 Language Mode。
- [ ] Desktop lint、node/web TypeScript 检查、生产构建和全部测试继续通过。
