# ADR-0007: Creation Session Navigation 常驻 App Shell，Workbench 生命周期保持页面局部

## 状态

已接受 — 2026-09-19。产品行为经 `grill-with-docs` 设计树逐项确认；本 ADR 记录责任边界，不表示源码已经实现。

## 背景

Creation Session 列表目前内嵌于 Creation Workbench，与 Draft、任务刷新和媒体显示共用一份页面级状态。产品需要把会话导航合入主侧边栏，并在灵感页、资产页和创作页持续可见；若直接在 App Shell 再挂一份 Workbench，会产生两个上下文 controller，并使本应随创作页停止的任务读取常驻。

## 决策

- AI Creation Domain 新增窄的 **Creation Session Navigation** 责任：拥有最新 50 个 Creation Session、临时提交项、新建入口、重命名、删除和目标 Workbench Context handoff。它位于路由之上，在所有 App Shell 页面通过 Creation Feature public interface 贡献 UI；app 只负责组合，不接管业务实现。
- Creation Workbench 只消费该导航给出的目标上下文。Draft、Reference Material、Generation Task 刷新、结果媒体与显示资源仍由 Workbench 拥有，并只在 `/creation` 生命周期内挂载；[ADR-0005](0005-creation-operation-and-task-refresh-lifetimes.md) 的离开创作台停止展示读取约束不变。
- 从任一 App Shell 页面点击会话会进入 `/creation` 并打开目标会话；点击新建入口进入设备本地新 Draft。当前应用运行期间记住最近的 Workbench Context，普通页面往返后恢复；应用重启后保持未激活，由 User 明确选择或新建。
- App Shell 移除内容区 header 与 breadcrumb，伸缩按钮进入侧边栏品牌区。品牌、主导航和用户菜单固定，仅会话区域滚动；侧边栏展开状态按设备记忆，跨页面导航和应用重启保持。
- 折叠态保留新建入口、会话标识和临时提交项。持久会话以名称首个可见字符和由 Session identity 派生的稳定背景色标识，空名称使用图标；tooltip 展示完整名称。临时提交项使用铅笔标识、状态色点与“名称 · 状态” tooltip。重命名和删除只在展开态显示。
- 本次不增加真实媒体封面、置顶、画布、额外导航项或会话分页。现有装饰 tile 改为稳定名称标识；真实结果缩略图需要新的可信投影/API，另行决策。

## 取舍

把完整 Workbench 提升为全局状态可以直接复用现有 hook，但会让任务刷新与媒体资源跨页面常驻，并破坏既定生命周期。只在 `/creation` 显示会话列表改动更小，却不满足全局导航。采用窄导航责任需要一次状态拆分和目标 handoff，但保持单一 creation owner、单一会话列表 owner，并避免新增服务端契约。
