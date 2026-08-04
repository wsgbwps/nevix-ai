# 01 — 引入 TanStack Router 顶层路由骨架

**What to build:** 用户看到的界面与行为完全不变，但 renderer 的顶层视图切换由 TanStack Router 接管：文件路由、memory history，routes 声明集中在 app 组合层。未认证时呈现现有认证区，已认证时呈现现有占位页（含语言控件与退出登录）。本票是后续 App Shell 与 Settings Page 的地基，落地 desktop ADR-0004 的路由拓扑：路由只覆盖顶层视图，认证 flow 继续由 Authentication Feature 状态机驱动、不拥有路由。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] TanStack Router 以文件路由方式接入 renderer 构建链（路由树生成纳入开发/构建流程，生成物不入手维护）
- [x] history 为 memory history；不出现 URL 同步依赖
- [x] routes 声明集中在 app 组合层；顶层视图为认证区与已认证区两个，认证 flow 无路由
- [x] 现有认证区与已认证占位页的视觉与行为逐像素/逐行为保持；占位页仍含 Language Mode 控件与退出登录
- [x] 既有全部 e2e（认证、i18n）保持绿色，不新增测试框架
- [x] 架构校验通过：routes 归属 app 组合层，Feature 边界无违规
- [x] 未引入 TanStack Query、Zustand 或任何本 slice 不需要的依赖
