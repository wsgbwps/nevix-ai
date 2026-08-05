# renderer-app-structure：app/ 收敛为纯 composition root

## 背景

renderer 的 `app/` 根混入了页面实现（SettingsPage、内联在路由文件里的 HomeView），随业务增长会持续膨胀。ADR-0004 已把 routes 固定为声明层，但"页面实现放哪"没有明文归属，新增页面只能堆在 `app/` 根。

## 决策（方案 A，对话评审结论）

- 新增 `app/pages/`：跨 Feature 聚合页与无 Domain owner 的页面（Settings、Home 占位页）。
- 新增 `app/shell/`：App Shell（已认证布局外壳）的家，对外 interface 不变，内部拆分留待需要时。
- `routes/` 全部保持 thin：仅 `createFileRoute` + 组装，不含页面实现。
- 业务 Domain 页面继续实现在 `features/<domain>/`，经 public `index.ts` 导出，route 薄组装。
- 禁止建立 `features/settings/`（settings 不是 Domain 名）；`app/` 根禁止新增页面文件。

## 页面归属决策树（随票 02 写入 AGENTS.md）

1. 页面属于某个业务 Domain → `features/<domain>/`，route 薄组装（已登录界面按 ADR-0004 在 App Shell 内容区获得路由）。
2. 跨 Feature 聚合页 / 无 Domain owner → `app/pages/`。
3. `app/` 根永不新增页面文件。

## 范围外

- `features/` 内部 segment 结构维持"固定词汇 + 受控子集"，不追求目录对称。
- verifier 自定义 segment 白名单加固（另开 feature）。
- 完整 FSD 分层（pages/widgets/entities 顶层化）：widget 跨页复用成规模、entity 共享反复出现前不引入；届时 `app/pages/`、`app/shell/` 即平移对象。

## 依据

- `apps/desktop/docs/adr/0004-renderer-routing-topology.md`（routes 仅覆盖顶层视图、声明集中于 app/）
- `docs/adr/0002-feature-sliced-vertical-slice.md`（Domain 垂直切片、物理隔离）
- `apps/desktop/AGENTS.md`（app/ 只含 composition，无 Feature 业务逻辑）
