# 用户系统迁移 7/7（#106）：测试栈与 CI 收尾 — 实施计划

Spec: #99（用户系统迁移）。本任务为收官：Supabase 在测试体系与 CI 中的残余全部清除，
README 技术栈表述与现实一致，全链路 smoke（Postgres + Go server + 桌面端）走通。

## Acceptance boundary

- **Fixed point**: `main` @ `610686b`（origin/main）
- **Primary Domain**: 交付机器（CI/test harness）+ 根文档；不触碰 server/ 与
  apps/desktop 产品源码
- **Task-owned paths**:
  - 删除：`scripts/test-auth-policy.sh`、`scripts/auth-policy-harness.mjs`、
    `scripts/lib/supabase-local-harness.sh`、`scripts/tests/auth-policy-harness.test.mjs`、
    `scripts/tests/supabase-local-harness.test.sh`、`.github/actions/supabase-image-cache/`、
    `supabase/`（tracked 全目录）
  - 修改：`.github/workflows/desktop-e2e-ci.yml`（删 auth-policy job）、
    `.github/workflows/desktop-ci.yml`（删 VITE_SUPABASE_* env）、`package.json`
    （删 test:auth-policy 与 supabase devDep）、`pnpm-lock.yaml`、`Makefile`
    （删 supabase target）、`scripts/classify-ci-changes.mjs`（分类词表收敛）、
    `scripts/tests/classify-ci-changes.test.mjs`、`.pi/tests/pi-hooks.test.mjs`
    （删已不存在路径的负例）、`README.md`、`apps/desktop/README.md`（E2E 段落改写）
- mail-smoke CI workflow（`.github/workflows/mail-smoke-ci.yml`）已在先前 issue 删除，本任务核实为零残余。

## 关键设计点

1. **classifier 必须能分类「本 PR 自己删除的路径」**：PR diff 与合并后 main push diff
   都含被删路径（git diff --name-only 含 deletion）。`supabase/` 前缀规则与
   `.github/actions` 前缀规则因此保留（否则 gate 直接 unclassified fail）；
   auth-policy 脚本五条精确路径收敛为 `scripts/` 前缀 → harness（语义：
   scripts/ 全部是交付机器，未来脚本自动分类，无需逐文件登记）。
2. **AC「桌面端依赖树无 supabase-js」**：desktop package.json 已无 supabase-js（#103 完成）；
   根 devDep `supabase` CLI（仅 harness 使用）删除后 lockfile 重生成，`@supabase/*`
   全部消失——QA 用 `pnpm why` + lockfile grep 证明。
3. **README 技术栈行**：SSE 未落地（#100–105 无 text/event-stream），行文案不得声称 SSE；
   写 Go server（唯一可信数据面，ADR-0014/0015）+ PostgreSQL。
4. **AC「全链路 smoke」**：smoke 套件覆盖登录/首登改密；用户管理与审计查看在
   `tests/settings/admin-user-management.spec.ts`（无 @smoke 标签）→ 本地跑
   smoke + full 两轮拿全四项证据。

## 验证

- `make harness-test`（classifier + pi-hooks + lifecycle 内联测试）
- `node scripts/classify-ci-changes.mjs --base main --head HEAD`（零 unclassified）
- `pnpm --filter @nevix/desktop test:e2e:smoke` + `test:e2e`（全链路 QA）
- 全库 grep 证明产品/测试面零 Supabase 残余（docs/adr 历史记录与 agent skills 除外）
