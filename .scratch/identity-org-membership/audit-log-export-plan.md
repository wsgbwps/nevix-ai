# Organization Audit Log 本地导出计划

## 边界

- Primary Domain：Organization。
- Renderer 仅通过用户 JWT 对 `public.audit_logs` 作 RLS 保护的分页读取，并在本地生成 CSV；不新增 Go 导出端点、迁移或 Data API 权限。
- Main 的 Organization IPC 只拥有原生保存对话框与所选路径的写入；preload 保持 generic。

## 安全约束

- IPC handler 验证调用来自 Nevix AI 的顶层 renderer document。
- Renderer 只能提交 CSV 内容和无目录的建议文件名；最终目标路径始终由 Main 的原生保存对话框选择。
- E2E 的确定性输出路径仅在 `NEVIX_E2E=1` 时启用，生产环境始终显示原生对话框。
- RLS 是 Owner/Admin 查看的权威；Member 不显示入口，但其直接 Data API 读取仍由 RLS 拒绝为零行。

## 验收与回滚

- Smoke E2E 验证时间线、动作筛选、跨页 CSV、本地写入反馈与 Member 拒绝；静态检查验证 IPC allowlist、类型和目录架构。
- 回滚仅移除 Desktop Organization UI、同域 IPC 和测试；已存在的 audit_logs schema 与 RLS 不变。

## 2026-08-12 最新审查修复计划

- Primary Domain 继续为 Organization；不新增或移动源文件。
- `renderer/src/features/organization/ui/` 拥有 Audit Log 设置交互：用不会改变顶层 renderer URL 的滚动按钮替代原生 fragment 链接，避免跨入 Authentication 或 platform owner 修改 trusted-sender 规则。
- `renderer/src/features/organization/api/` 与 `model/` 拥有 Membership 直读和 Active Organization 缓存：进入 Audit Log 设置 surface 时在既有用户 JWT + RLS seam 下重新读取当前 Membership，并把最新 role 更新到现有缓存；Member 随即失去导航与区块。Membership 查询错误保持错误，Audit Log 空数组保持合法空日志，两者不互相推断。
- `tests/organization/` 拥有外部行为回归：一条覆盖点击 Audit Log 后退出并以同一 userData 重启仍保持退出；一条覆盖运行中 Admin→Member 后导航与区块消失。RLS 继续保护直接读取，不新增 Go 代理、迁移或策略变更。
- Authentication Domain 无代码改动；其 Session 清除安全边界通过上述跨 Domain Smoke 行为验证。回滚仅撤销 Organization UI、Membership 刷新与对应测试。
