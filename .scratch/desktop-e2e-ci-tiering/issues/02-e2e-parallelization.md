# 02 E2E 并行化

Status: ready-for-agent

Blocked by: 01

`playwright test` 从串行改为文件级并行：`workers=2`（本地与 CI 全量 job 一致），
`fullyParallel` 维持 `false`。`configuration.spec.ts` 因绑定专用构建保持独立串行。

落地前逐 spec 审查并行安全性：userDataDir 已按测试隔离（mkdtemp）、Auth 身份已唯一
（uniqueAuthIdentity），重点确认 Mailpit 收件匹配按收件人/消息 ID 区分、无共享端口或全局
状态。完成后对比并行前后墙钟并记录到本文件 Comments。

## Comments

### 并行化实施结果（2026-08-05）

**变更内容：**
- `playwright.config.ts` 添加 `workers: 2`
- `run-e2e.sh` 主运行 `--workers=1` → `--workers=2`
- `configuration.spec.ts` 保持独立串行（专用 CI job 已显式 `--workers=1`）

**并行安全审查：**
| 检查项 | 结论 |
|--------|------|
| userDataDir 隔离 (mkdtemp) | 全部 14 个 spec 文件使用独立临时目录 |
| Auth 身份唯一 (uniqueAuthIdentity) | `Date.now()` + `crypto.randomUUID()` 无冲突 |
| Mailpit 收件匹配 | 无状态 fetch，按消息 ID 和收件人区分 |
| 共享端口/全局状态 | 无。每次启动新 Electron 进程，helper 均为无状态 |
| configuration.spec.ts 串行保障 | 通过 `test.skip` 条件隔离，专用 CI job 显式 `--workers=1` |

**墙钟对比（本地 macOS）：**
- 并行前：约 2m（串行 `--workers=1` 历史数据）
- 并行后：Full Suite `1.1m`（47 passed, 3 skipped, 2 workers）
- 加速比：约 1.8x
- Smoke Suite：`5.0s`（4 tests, 2 workers）

**结论：** workers=2 在本地 macOS 上安全有效，无竞态问题。CI 为 4-CPU runner，workers=2 合理。

**登录态复用：** 实测 UI 登录在 2 workers 下未构成瓶颈（最长单测 31.4s 为 runtime-revocation），暂不纳入本切片范围。

登录态复用**不在本切片默认范围**：仅当实测显示 UI 登录仍占显著比例时才做，且机制为
`NEVIX_TEST_*` 环境变量注入、每测试独立身份；明确不做 userDataDir 快照（refresh token 轮
换竞态，见 ADR-0007）。
