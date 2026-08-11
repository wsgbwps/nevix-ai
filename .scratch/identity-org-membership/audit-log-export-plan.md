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
