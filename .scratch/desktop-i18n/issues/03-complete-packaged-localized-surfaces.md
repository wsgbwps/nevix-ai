# 03 — 完成打包阶段的 Localized Surface 与发布验证

**What to build:** 完成运行时之外的 Desktop 文案本地化，让安装流程和操作系统权限说明具备简体中文与英文资源，并对当前所有 Localized Surface 做发布前闭环验证。完成后，桌面应用在运行时和打包生命周期中都满足 PRD 的中英文支持承诺。

**Blocked by:** 02 — 切换并持久化 Language Mode

**Status:** done

- [x] 安装流程中由 Desktop 拥有的用户可见文案提供简体中文和英文版本。
- [x] 所有已配置的操作系统权限说明提供简体中文和英文版本。
- [x] 安装器和系统权限说明由操作系统生命周期选择语言，不承诺响应应用运行期间的 Language Mode 切换。
- [x] 审计当前渲染界面、窗口、原生桌面交互、安装流程和系统权限说明，确保 Desktop 自有文案全部由对应资源所有者本地化。
- [x] 品牌名 `Nevix AI`、用户内容、业务数据、服务端日志和第三方原文保持原样，不被误纳入翻译资源。
- [x] 应用壳、`settings` Feature、主进程和打包生命周期分别拥有自身资源，不回退为集中式巨型语言文件。
- [x] Supported Language 资源契约覆盖本 ticket 新增的打包阶段必需文案；简体中文和英文任一缺失时发布验证失败。
- [x] 在当前受支持的构建主机上成功生成生产包，并验证包内包含对应平台所需的简体中文与英文本地化元数据。
- [x] 完整 Electron 应用流程覆盖系统语言解析、即时切换、重启持久化、切回跟随系统和中文 fallback。
- [x] 完整资源契约检查证明正式语言资源完整、候选语言未被公开且缺词诊断符合环境策略。
- [x] Desktop lint、node/web TypeScript 检查、生产 build、package 和全部测试通过。
- [x] 最终差异不包含 Supabase、Server、数据库、账号同步、网络 API、RTL 或日期数字等区域化实现。

## Comments

- 2026-07-24：新增 macOS 中英文权限说明和 NSIS 中英文安装器语言；构建后的 macOS app bundle 会验证 `InfoPlist.strings` 已被打包。完整 Playwright 流程、资源契约、Desktop lint、类型检查和 arm64 macOS ZIP/DMG 打包均已通过。
