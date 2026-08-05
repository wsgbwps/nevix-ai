# 02 E2E 并行化

Status: ready-for-agent

Blocked by: 01

`playwright test` 从串行改为文件级并行：`workers=2`（本地与 CI 全量 job 一致），
`fullyParallel` 维持 `false`。`configuration.spec.ts` 因绑定专用构建保持独立串行。

落地前逐 spec 审查并行安全性：userDataDir 已按测试隔离（mkdtemp）、Auth 身份已唯一
（uniqueAuthIdentity），重点确认 Mailpit 收件匹配按收件人/消息 ID 区分、无共享端口或全局
状态。完成后对比并行前后墙钟并记录到本文件 Comments。

登录态复用**不在本切片默认范围**：仅当实测显示 UI 登录仍占显著比例时才做，且机制为
`NEVIX_TEST_*` 环境变量注入、每测试独立身份；明确不做 userDataDir 快照（refresh token 轮
换竞态，见 ADR-0007）。
