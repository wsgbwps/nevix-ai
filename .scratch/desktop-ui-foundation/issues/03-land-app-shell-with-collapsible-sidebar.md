# 03 — App Shell 落地（sidebar-07 精简版）

**What to build:** 登录成功的用户进入 App Shell：左侧为可折叠为图标的侧边栏（带 rail），Header 是组织切换器槽位——图标 + 产品标识"Nevix AI" + chevron，形态保留但行为置空，不展示任何虚构组织名；NavMain 当前只有"首页"一个真实入口；Footer 是 NavUser 用户菜单，显示登录邮箱与首字母头像，菜单内含退出登录（沿用现有行为与远端撤销延迟提示）。内容区头部含 SidebarTrigger 与 Breadcrumb（反映当前路由位置），首页为占位内容，Language Mode 控件暂留在首页（与现状一致）。组合代码归属 app 组合层，不新建任何 Domain 或 Feature。

**Blocked by:** 01 — 引入 TanStack Router 顶层路由骨架（侧边导航与 Breadcrumb 是路由感知的，需要路由骨架就位）

**Status:** resolved — [PR #19](https://github.com/wsgbwps/nevix-ai/pull/19) 经 CI 把关合并入 main（a7544e9）

- [x] 已认证视图渲染 App Shell：侧边栏 + 内容区头部（SidebarTrigger + Breadcrumb）+ 占位首页
- [x] 侧边栏可折叠为图标并可展开，带 rail；折叠状态交互符合 sidebar-07 行为
- [x] Header 组织切换器槽位显示产品标识占位、不可切换、无下拉死入口；不出现虚构组织名或 "Default Organization" 措辞
- [x] NavMain 仅"首页"一项且为真实可点；不为不存在的业务发明导航项
- [x] NavUser 显示当前 Session 的登录邮箱与首字母头像；菜单含退出登录；退出行为与提示文案与现状一致
- [x] 首页占位内容保留现有 Language Mode 控件（设置页就位前不移除）
- [x] 组合代码在 app 组合层；共享 UI 层新增 sidebar/breadcrumb/dropdown-menu/avatar/separator/collapsible 等 primitive（PR 描述说明影响与测试）
- [x] 外壳文案在 app namespace 下双语齐全，术语符合词汇表（组织/Organization）
- [x] 新增 e2e：登录后 Shell 各元素呈现、折叠/展开、用户菜单退出登录回到登录界面；既有 e2e 保持绿色
- [x] 架构校验通过：无新 Domain/Feature，Feature 边界与依赖方向无违规
- [x] 未新增/修改任何 IPC Channel、main process 代码或 Session 持久化行为
