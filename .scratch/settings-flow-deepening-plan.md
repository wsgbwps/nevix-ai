# Settings Flow 深化 — 实施计划

来源：架构评审候选 1（improve-codebase-architecture 报告）+ grilling 共识（10 项决策全部按推荐锁定）。

## 目标

`app/pages/` 的 Settings 导航机（5 文件 ~760 行）是 shallow module：interface（10 个
coordinator 方法 + 6 种 contribution 状态 + 2 个 context + monkey-patched
`history.back`）几乎与 implementation 一样复杂；286 行 coordinator 无 unit test。
深化为 `app/settings/` 深模块，Feature 以**导航语义**（而非内部状态）参与。

## 定案（grilling 共识）

1. **边界**：导航机 + 页面外壳 + picker 页全部收进 `app/settings/`；`app/pages/` 只剩
   home-page；`App.tsx` 只创建 history。
2. **词汇**：seam 上只说导航语义，Feature 直接产出：
   `SettingsLeaveSemantics = { navigate: 'navigable'|'confirm-discard'|'blocked';
   close: 'allow'|'confirm'|'defer'|'deny'; discard?: () => void }`。
   映射：clean→(navigable,allow)；dirty→(confirm-discard,confirm)；saving→(blocked,defer)；
   command-pending/unknown-command-result/audit-export-active→(blocked,deny)。
3. **策略内化**：`FORCED_SECURITY_PATHS`、`canEnterBusinessSource` 收进模块内部具名；
   删除 `canEnterSource` 注入面。audit `onPermissionLost` 保持命令式 prop，落点
   'members' 由模块接线。
4. **monkey-patch 生命周期**：mount 安装 / unmount 还原，位于模块内；
   `SettingsBackNavigationContext` 删除。
5. **注册表**：模块内每个 section 一行（渲染闭包 + organization-scoped + 默认
   contribution）；4 个 useState relay 合并为按 section 的槽。新增 Section = 注册表
   1 行 + Feature 自己的文件。
6. **验收单测**（`apps/desktop/tests/unit/`，纯决策函数走 node --test）：
   ① close confirm + 已开 prompt → queue；② defer 分叉（allow→allow，else→cancel）；
   ③ FORCED_SECURITY_PATHS 不拦；④ source 不可回落 home（现有测试保留）。
   现有 settings-navigation 单测随搬家保留；E2E（settings 套件）全绿不动。
7. **切法**：一个任务一次到位，无中间垫片。
8. **名字**：Settings Flow，写入 `apps/desktop/CONTEXT.md`。
9. **类型归属**：`app/settings/` 拥有 canonical 类型；4 个 Feature 结构化镜像
   （延续现状模式），漂移在组装点变编译错误。
10. **流程**：不写新 ADR（ADR-0004 各条决定继续成立）；更新 README 目录树 +
    CONTEXT.md + apps/desktop/AGENTS.md 中「Settings page is owned by app/pages/」一句。

## 委托给实现的自由

coordinator 交错逻辑做成纯状态机还是 reducer 按可测性自然成形——本计划采纯决策
函数（`settings-leave-semantics.ts`），hook 只剩薄接线。

## 任务自有路径

- `apps/desktop/src/renderer/src/app/pages/settings-*`（移出）
- `apps/desktop/src/renderer/src/app/settings/**`（新建）
- `apps/desktop/src/renderer/src/app/{App.tsx,routes/settings.tsx,shell/app-shell.tsx}`
- `apps/desktop/src/renderer/src/features/{organization,profile}/ui/*settings*.tsx`
- `apps/desktop/tests/unit/settings-*.test.mts`
- `apps/desktop/CONTEXT.md`、`README.md`、`apps/desktop/AGENTS.md`（一句）

## 非目标

- 不动 candidate 3 的另外两条 App.tsx 行为泄漏（onboarding effect、close 兜底）。
- 不动 shell/ 其余结构、不动 E2E spec、不新增共享层文件。
