# make postgres 幂等预置 identity_app 角色 — 任务计划（AGENTS.md 高风险条目）

Issue 来源：用户会话请求（用户系统迁移 #106 后续本地开发 DX）。
变更：`make postgres` 在就绪等待后幂等预置 `identity_app` LOGIN 角色（密码 `dev`）。

## 为什么属于「高风险条目」

该变更预置**持久 LOGIN 凭据**（数据库角色 + 固定开发密码），触及 AGENTS.md
「authentication … persistent data … require a brief written plan」条款，故记录本计划。

## 边界

1. **仅本地开发**：目标只操作 `nevix-dev-postgres` 本地容器（端口仅绑
   `127.0.0.1:5432`）；不触碰生产/私有化交付路径（那属于 Docker 交付独立 issue）。
2. **采用语义与 migration 一致**（0001_baseline_user_system.sql / ADR-0015）：
   角色已存在 → 原样采用、绝不重置密码；角色缺失 → 以 `dev` 创建。本目标与
   migration 都不覆盖既有凭据——「配置密码 ≠ 库内密码」错误（28P01）只能源于
   人为单边修改，目标不引入新的此类路径。
3. **固定密码 `dev` 的风险接受**：dev 专用、loopback 绑定、与卷初始
   `POSTGRES_PASSWORD=dev` 同源；真实凭据轮换不属本地开发场景。
4. **不越权**：不 ALTER、不 DROP、不触碰 goose 账本与业务表；仅 `pg_roles`
   存在性检查 + 缺失时 CREATE。

## 验证（实施时实际执行）

- 场景①（删卷重置）：`make postgres` → `CREATE ROLE`，`pg_roles` 出现
  `identity_app|t`
- 场景②（角色已存在）：再次 `make postgres` → 提示「保持不动」，零改动
- 场景③（全新库端到端，dev 凭据，环境按 make server 方式 source）：
  server listening、health ok、public 表 = goose_db_version/users/sessions/audit_logs
- 过程纪律：曾因孤儿 server 进程拿到假绿 health，经 lsof 启动时间核查发现，
  清理后以空闲端口 + 日志断言重跑，最终证据来自真实运行。
