# Desktop UI Foundation Spec

Status: ready-for-agent

## Problem Statement

Nevix AI Desktop 的认证界面是手写原生 input 与一次性卡片布局，登录后只有一个居中的占位页——没有 App Shell、没有导航结构，Language Mode 切换控件直接裸露在占位页上。用户看到的是一套临时界面，而不是一个可以长期承载业务的产品底座。

团队需要把 Desktop 的基础界面一次性立起来：认证界面采用成熟的 shadcn block 布局，登录后进入带侧边导航的 App Shell，Language Mode 设置收进独立的 Settings Page，并在此过程中引入技术栈既定但尚未落地的 TanStack Router，为后续所有业务界面铺路。

## Solution

以四个 shadcn block 为布局参考重做 Desktop 基础界面，行为全部保持现有能力：

- **认证界面**：login 按 login-02、signup 按 signup-02 的两栏布局（左表单栏含品牌行，右栏品牌渐变封面面板，不使用图片资产）；signup 增加 Confirm Password 字段（纯客户端校验，两次输入不一致时提示并禁止提交）；全部六个认证 flow 界面与三个状态界面统一迁入同一外壳与 shadcn 控件体系（Input/Label/Field），移除 block 中的社交登录按钮（Authentication Domain 无此能力）。
- **App Shell**：以 sidebar-07 为底座——可折叠为图标的侧边栏（Header 为组织切换器槽位、NavMain 含"首页"、Footer 为 NavUser 用户菜单），内容区头部含 SidebarTrigger 与 Breadcrumb。组织切换器槽位保留形态、行为置空，显示产品标识占位，不编造任何 Organization 数据；NavUser 显示登录邮箱与首字母头像，菜单内含 Settings Page 入口与退出登录。
- **Settings Page**：独立全屏界面（在 App Shell 之外呈现），按 sidebar-13 的页面布局做"左侧设置导航 + 右侧内容"，导航顶部有返回按钮回到 App Shell；当前仅"语言"一个设置项，Language Mode 控件改为 shadcn Select 下拉。
- **路由**：引入 TanStack Router（文件路由、memory history），routes 集中在 app 组合层；路由只覆盖顶层视图（认证区 / App Shell / Settings Page），认证 flow 继续由 Authentication Feature 的状态机驱动（desktop ADR-0004）。

## User Stories

1. 作为打开 Desktop 的未认证用户，我想看到左右分栏的登录界面，以便获得成熟产品的第一印象而非临时表单。
2. 作为小窗口用户，我想在窗口宽度不足时封面面板自动隐藏、表单保持可用，以便任何窗口尺寸下都能完成认证。
3. 作为登录用户，我想使用邮箱和密码登录，并保留"忘记密码"与"创建账号"入口，以便完成现有全部登录路径。
4. 作为登录失败的用户，我想继续看到现有的统一错误文案与提示（session 过期、密码已更新等 notice），以便界面重做不丢失任何已有反馈能力。
5. 作为注册用户，我想看到 Email / Password / Confirm Password 三个字段，以便按惯例确认我输入的密码。
6. 作为两次密码输入不一致的注册用户，我想立即看到不一致提示且无法提交，以便在发送请求前修正输入。
7. 作为注册用户，我想继续看到 12–72 UTF-8 字节规则的实时提示，以便遵守现有密码策略。
8. 作为注册用户，我想确认密码只在我本机用于核对、不随注册请求发送，以便凭据契约保持不变。
9. 作为完成注册提交的用户，我想继续进入六位验证码流程，以便现有邮箱验证行为完全保留。
10. 作为在认证流程中穿梭的用户，我想在登录、注册、注册验证、忘记密码、恢复验证、设置新密码六个界面看到同一套外壳与控件风格，以便流程切换不出现视觉割裂。
11. 作为遇到恢复中、恢复失败、配置错误状态的用户，我想看到与认证流程一致风格的状态界面，以便异常状态也不像另一款产品。
12. 作为登录成功的用户，我想进入带侧边导航的 App Shell，以便理解产品的长期界面结构。
13. 作为已认证用户，我想折叠侧边栏为图标形态并随时展开，以便在内容区获得更多空间。
14. 作为已认证用户，我想在侧边栏 Header 看到产品标识槽位（将来承载组织切换），以便未来接入 Organization 时界面结构无需变化。
15. 作为已认证用户，我想明确当前组织切换器不可交互、不展示任何虚构组织，以便界面的每个元素都对应真实能力。
16. 作为已认证用户，我想通过侧边栏 Footer 的用户菜单看到自己的登录邮箱，以便确认当前登录身份。
17. 作为已认证用户，我想从用户菜单退出当前设备，以便沿用现有退出能力（含远端撤销延迟提示）。
18. 作为已认证用户，我想从用户菜单进入 Settings Page，以便找到设备级设置。
19. 作为已进入 Settings Page 的用户，我想看到独立全屏的设置界面，左侧为设置导航、右侧为内容，以便获得清晰的设置信息架构。
20. 作为 Settings Page 用户，我想点击设置导航顶部的返回按钮回到 App Shell，以便设置页不会成为导航死胡同。
21. 作为 Settings Page 用户，我想当前只看到"语言"一个设置项且处于选中态，以便界面不暗示尚不存在的设置能力。
22. 作为切换语言的用户，我想用下拉选择跟随系统、简体中文或 English，以便以紧凑控件完成 Language Mode 切换。
23. 作为切换语言的用户，我想界面文案立即采用新的 Interface Language 且无需重启，以便遵守现有热切换契约。
24. 作为简体中文或英文用户，我想登录界面、App Shell、Settings Page 的全部 Localized Surface 都有对应语言资源，以便新界面不破坏发布完整性检查。
25. 作为重新打开 Desktop 的用户，我想 Session 恢复、恢复失败重试、配置错误等启动行为与界面重做前完全一致，以便视觉升级不引入认证回归。
26. 作为未来接入 Organization 功能的实现者，我想组织切换器槽位的形态已经就位，以便接入时只替换数据源、不改 App Shell 结构。
27. 作为维护者，我想路由声明集中在 app 组合层、认证 flow 不拥有路由，以便未来新增界面的归属规则清晰。
28. 作为安全审查者，我想确认本次改动不引入任何新 IPC Channel、不触碰 Session 持久化与 Supabase 交互，以便界面重做不扩大受信攻击面。

## Implementation Decisions

### Delivery and ownership

- 本规格交付一个 Desktop 界面底座 vertical slice，主要落在 app 组合层，并触及 Authentication Feature 与 Language Feature 的界面部分；经一个 feature branch 与一个 PR 交付（`apps/` 属 CI-gated 路径）。
- 新增共享 UI primitive（shadcn 的 sidebar、input、label、field、breadcrumb、dropdown-menu、avatar、separator、collapsible、select 等）进入共享 UI 层；这是共享区域变更，PR 描述必须说明影响与测试。
- App Shell 与 Settings Page 的组合代码放在 app 组合层；不新建 settings Domain 或 settings Feature（词汇表与 desktop ADR-0003 均禁止），Settings Page 只是各 Feature 设置项的组合面。
- 语言设置 section 的组件仍由 Language Feature 拥有并经其公开入口导出；Authentication Feature 内部完成认证屏重做；peer Feature 不互相导入。
- 路由采用 TanStack Router 文件路由与 memory history，routes 集中在 app 组合层；顶层视图为认证区、App Shell、Settings Page；认证 flow 界面不拥有路由（desktop ADR-0004）。memory history 的理由：`file://` 协议下地址栏不可见，URL 同步没有价值。
- 本次不新增、不修改任何 IPC Channel、shared IPC 类型、main process 代码、Supabase 配置或 schema；注册、登录、验证、恢复、Session 持久化的行为契约全部不变。

### Authentication screens

- 认证区外壳为两栏布局：左栏顶部品牌行 + 垂直居中表单（窄栏宽），右栏品牌渐变封面面板；封面面板在小宽度下隐藏（沿用 block 的响应式行为），不使用任何图片资产。
- 登录表单字段保持 Email / Password；保留"忘记密码"与"创建账号"入口；移除 block 中的社交登录按钮与对应分隔符。
- 注册表单字段为 Email / Password / Confirm Password；Confirm Password 纯客户端校验——两次输入不一致时显示错误并禁止提交，其值不随注册请求发送，不改变现有 signUp 契约。
- 不加 Full Name 或任何 Profile 字段：全仓尚无 Profile 实现，Authentication Domain 明确不含 Profile 管理，该能力留给独立的 Identity 任务。
- 现有密码字节规则提示、存在性中立提示、错误映射、重发冷却、提交中去重等行为全部保留；六个认证 flow 界面与三个状态界面统一使用同一外壳与 shadcn Input/Label/Field 控件。
- 验证码输入框等现有专用交互（六位数字、自动过滤非数字）保留，仅迁移视觉风格。

### App Shell

- 侧边栏可折叠为图标并带 rail；Header 为组织切换器槽位——形态保留（图标 + 名称 + chevron）、行为置空、显示产品标识占位，不出现虚构组织名，也不使用词汇表禁用的 "Default Organization" 措辞。
- NavMain 当前仅"首页"一个真实入口，内容区为占位首页；不为尚不存在的业务发明导航项。
- NavUser 显示登录邮箱与首字母头像（无显示名与头像概念，不虚构）；菜单含 Settings Page 入口与退出登录，退出行为沿用现有实现。
- 内容区头部含 SidebarTrigger 与 Breadcrumb，Breadcrumb 反映当前路由位置。

### Settings Page

- Settings Page 是独立全屏界面，在 App Shell 之外呈现，拥有自己的路由。
- 页内为"左侧设置导航 + 右侧内容"两栏结构；设置导航顶部为返回 App Shell 的按钮；当前仅"语言"一项且为选中态。
- Language Mode 控件从 radiogroup 改为 shadcn Select 下拉，三个取值不变（跟随系统 / 简体中文 / English）；读取、写入、变更订阅沿用 Language Domain 现有 IPC，行为契约不变。

### Localization

- 新增 Localized Surface（认证新文案、App Shell 导航与用户菜单、Settings Page 文案）同时提供简体中文与英文资源，分别归属 app / authentication / language 既有 namespace，沿用现有资源合并机制与发布完整性检查。
- 全部用户可见文案遵守词汇表：组织（Organization）、语言模式（Language Mode）等术语与 CONTEXT.md 一致。

## Testing Decisions

### Test quality and seam

- 好测试只验证外部可观察行为：界面呈现什么、能否提交、导航到哪里、语言是否即时切换；不锁定组件树、CSS 类名细节或内部状态机实现。
- 主要且最高的 seam 只有一个：现有 Electron Playwright runner，对真实构建的应用穿过 UI 验证认证流程、App Shell 与 Settings Page；DOM 结构变化导致的既有断言同步更新。
- 既有检查全部沿用，不新增测试框架或 seam：i18n 资源契约（新增 key 的双语完整性）、打包本地化契约检查、Desktop 架构校验脚本（新目录与依赖方向）。
- 不为 confirm-password 校验或 Select 交互新增组件级单测；这些纯 UI 行为由最高 seam 覆盖。

### Required behavior coverage

- 六个认证 flow 界面与三个状态界面在新外壳下渲染正确；登录、注册、验证码、密码恢复的既有 e2e 路径全部保持绿色。
- 注册界面 Confirm Password 不一致时显示错误且无法提交；一致时可正常提交并进入验证码流程。
- 登录成功进入 App Shell：侧边栏、组织切换器槽位（产品标识占位、不可切换）、首页导航项、用户菜单（邮箱可见）均呈现。
- 侧边栏可折叠为图标并展开。
- 从用户菜单进入 Settings Page：独立全屏、左侧设置导航仅"语言"选中、返回按钮可回到 App Shell。
- Settings Page 中通过 Select 切换 Language Mode，Localized Surface 立即以新 Interface Language 呈现，重启后选择保持（沿用现有持久化）。
- 退出登录从用户菜单完成，回到登录界面；现有远端撤销延迟提示不变。
- 全部新界面文案在简体中文与英文资源中完整，通过资源契约与打包本地化检查。
- 架构校验通过：app 组合层、Feature 边界、共享 UI 层的依赖方向无违规。

### Acceptance gate

- `lint`、typecheck、build、Desktop Playwright 套件、i18n 与架构校验全部通过。
- PR 只包含本 slice 与其窄支撑改动；没有 IPC/schema/后端变更、没有 Profile 或 Organization 数据层、没有无关重构。
- 共享 UI 层的新增在 PR 描述中说明影响与测试。

## Out of Scope

- Full Name / 显示名收集、profiles 表、handle_new_user trigger 与任何 Profile 持久化。
- 真实 Organization 数据、组织切换、创建组织；切换器槽位仅为形态占位。
- 社交登录、OAuth、Magic Link 与任何新认证方式。
- 认证 flow 界面路由化。
- 任何 IPC Channel、shared IPC 类型、main process、Supabase 配置、schema 或 server 变更。
- App Shell 内的真实业务页面（首页保持占位）。
- Settings Page 的第二个设置项、账号级设置（Language Mode 是设备级）。
- 深色模式切换 UI、主题自定义。
- 窗口默认/最小尺寸调整（仅沿用 block 的响应式隐藏行为）。

## Further Notes

- 布局参考：login-02、signup-02（[login](https://ui.shadcn.com/blocks/login) / [signup](https://ui.shadcn.com/blocks/signup)）、sidebar-07、sidebar-13（[sidebar](https://ui.shadcn.com/blocks/sidebar)）；sidebar-13 仅借页面布局，不采用其 dialog 形式。
- 本次访谈沉淀的文档：词汇表新增 **App Shell** 与 **Settings Page**（见 apps/desktop/CONTEXT.md）；路由拓扑决策见 [desktop ADR-0004](../../apps/desktop/docs/adr/0004-renderer-routing-topology.md)。
- 组织切换器"形态保留、行为置空"是经确认的产品决策：Organization UI 后续接入，届时只替换数据源。
- 技术栈既定的 TanStack Query、Zustand 本 slice 尚不需要，不为未来用途预引入。
