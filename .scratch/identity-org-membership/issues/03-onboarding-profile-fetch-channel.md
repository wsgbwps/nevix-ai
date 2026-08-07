# 03 — Onboarding 向导 + Profile 读写 + Desktop 直连通道

**What to build:** 前置切片的 Desktop 主体。落地 renderer 直连 fetch 通道：新增 VITE_SERVER_URL 构建期配置（启动校验、缺失即显式失败），CSP connect-src 按环境加精确 origin。新建窄 Profile Domain（features/profile）：全局 Profile 读写与显示名编辑，经 RLS 直写本人行。onboarding 作为第四个顶层视图（路由化，符合 desktop ADR-0004 路由拓扑），采用定稿的 B 两步向导：第 1 步显示名（trim 后 1–50 字符、拒纯空白），第 2 步组织名（trim 非空），进度点 + "第 x/2 步"标签，第 2 步可返回上一步；完成即调 CreateOrganization 建组织并落点首页。设置页账户组新增「个人资料」区块（定稿变体 A）：默认头像占位（renderer 资源，不加 avatar_path、不建 bucket）+ 显示名字段 + 保存/取消（脏检查）+ 已保存反馈。文案与字段规则以 `.scratch/identity-org-membership/copy-and-validation-baseline.md` 为基线，全部新 Localized Surface 中英双语。

**Blocked by:** 02 — Go 传输基座 + CreateOrganization

**Status:** in-review

- [x] VITE_SERVER_URL 缺失时启动显式失败；CSP connect-src 按环境精确 origin
- [x] e2e：注册 → 显示名 → 建组织 → 进入 App Shell（含字段校验与两步导航、上一步返回）
- [x] 设置页个人资料区块可编辑显示名，脏检查与已保存反馈符合定稿行为
- [x] 创建组织失败重试不产生重复组织（幂等键经命令保证）
- [x] 全部新 Localized Surface 过既有 localization 发布检查；e2e 新用例归入既有 tier
- [x] apps/ 属 CI 门禁路径，走 feature branch + PR

## Comments

- 2026-08-07：实现已提交为 `f8350e5`，PR [#26](https://github.com/wsgbwps/nevix-ai/pull/26) 已创建并等待审查。已通过 Desktop 全量 E2E（49 passed、4 skipped）、unit、typecheck、lint、architecture/localization checks 与 `go test -C server ./...`；最终双轴代码审查无遗留问题。
