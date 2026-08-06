# 04 — Settings Page 落地（sidebar-13 页面布局）+ 语言控件改 Select

**What to build:** 已认证用户从 NavUser 菜单进入独立全屏的 Settings Page：左侧设置导航（顶部为返回 App Shell 的按钮，当前仅"语言"一项且选中）+ 右侧内容区。内容区呈现 Language Feature 交出的语言设置 section，Language Mode 控件由 radiogroup 改为 shadcn Select 下拉，取值不变（跟随系统 / 简体中文 / English）；切换后全部 Localized Surface 立即以新 Interface Language 呈现，重启后选择保持。首页不再裸露语言控件。Settings Page 只是组合面，不新建 settings Domain 或 Feature；读取、写入、变更订阅沿用 Language Domain 现有 IPC，行为契约不变。

**Blocked by:** 03 — App Shell 落地（设置入口位于 NavUser 菜单，且首页语言控件的移除依赖设置页就位）

**Status:** resolved — [PR #21](https://github.com/wsgbwps/nevix-ai/pull/21) 经 CI 把关并于 2026-08-05 合并入 main

- [ ] NavUser 菜单新增 Settings Page 入口并可导航到达；Settings Page 拥有自己的顶层路由，在 App Shell 之外全屏呈现
- [ ] 页内为"左侧设置导航 + 右侧内容"两栏结构（sidebar-13 页面布局，非 dialog）；导航顶部返回按钮可回到 App Shell
- [ ] 设置导航当前仅"语言"一项且为选中态；不出现第二个设置项占位
- [ ] 语言设置 section 由 Language Feature 拥有并经其公开入口导出；Settings Page 组合代码在 app 组合层
- [ ] Language Mode 控件为 shadcn Select 下拉，三取值不变；切换即时热切换、重启保持，IPC 与行为契约零变化
- [ ] 首页移除裸露的 Language Mode 控件；旧 radiogroup 组件无残留引用
- [ ] 设置页文案在 language/app namespace 下双语齐全，通过 i18n 资源契约与打包本地化检查
- [ ] 新增 e2e：从用户菜单进入设置页、返回按钮回 Shell、Select 切换语言后界面文案即时变更；既有 e2e 保持绿色
- [ ] 架构校验通过：无 settings Domain/Feature，共享 UI 层新增 select primitive 在 PR 描述中说明影响与测试
- [ ] 未新增/修改任何 IPC Channel 或 Language Domain 主进程行为
