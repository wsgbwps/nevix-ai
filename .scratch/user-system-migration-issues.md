# 用户系统迁移——issue 拆分清单

出处：2026-08-22 grill-with-docs session。决策全文见 ADR-0013（交付总纲）、ADR-0014（数据面 seam）、ADR-0015（用户系统与授权）；本文件是实施拆分与边界记录，落地后可归档。

当前实施焦点 = 用户系统迁移；AI 创作全部归 [#77](https://github.com/wsgbwps/nevix-ai/issues/77)。

## 实施序列（建议顺序）

1. **Schema 重建基线** — drop-rebuild：`public.users`（email/password_hash/display_name/role/status/must_change_password）+ `public.sessions` + `audit_logs` 去 org 维度；删 organizations/memberships/invitations/verification_codes/outbox_messages 与 Outbox Worker；`identity` schema 取消；RLS 全移除、GRANT 重写（`identity_app` 沿袭）；up-only migration 从新基线起版。验收：identity 集成测试按新 schema 通过。
2. **Go auth module** — 登录（argon2/bcrypt、进程内失败限速）、bootstrap（`ADMIN_EMAIL`/`ADMIN_INITIAL_PASSWORD` 仅空库）、session CRUD（opaque token、30 天滑动）、改密/停用/角色管理卫生规则（改密吊销其他 session、停用断流、末位 admin 保护、email admin-only）+ 集成测试。验收：ADR-0015「后果」清单逐条有测试。
3. **authz 包** — `RequireActiveUser`/`RequireAdmin` guard + handler 行级检查 + 可见性查询单一落点；每路由挂 guard 的门禁测试。
4. **审计读取路径** — admin-only 分页 API + Desktop 本地导出（ADR-0009 修订）。
5. **桌面端改造** — Supabase 全摘除（`.from()`/supabase-js/`VITE_SUPABASE_*`）：authentication feature 改走 Go API（登录/登出/改密/首登改密流），organization feature 整体删除，profile 并入用户管理；运行时 server URL 配置（首启连接屏 + IPC 存 userData + 测试连接）+ TOFU 指纹钉扎 + RFC1918 http 放行；设置页用户管理界面（建号/停用/重置/角色，admin-only，分页+搜索）。
6. **SSE 通道** — 单实例按 user_id hub、fetch-stream header 认证、心跳 ~20s、断线先全量后续流、session 吊销断流。边界：事件源（生成任务状态迁移）归 #77；本项交付通道与断流语义。
7. **CI/E2E harness 重造** — Supabase 栈（auth-policy harness、supabase-auth helpers、mail-smoke CI）拆除，替换为 Go server + Postgres 测试栈。
8. **Docker 交付** — compose（捆绑钉版本 PG、pgdata/blobs 卷、env 面）+ 启动自动 migration + `PORT` 可配。依赖 1。

## 边界（不在本迁移内）

- **Storage 双后端 adapter**：服务创作资产，归 #77 轨道（env 命名已冻结于 ADR-0013）。
- **分发渠道/镜像渠道/桌面更新渠道**：推迟至打包分发阶段另议（ADR-0013「推迟与范围边界」）。
- **`min_desktop_version` 配对协议**：决策已冻结（ADR-0013），实现随交付工作。
- **部署手册 `docs/deploy.md`**：随交付工作。

## 专项 issue（deferred）

- **部门隔离**：v1 不做（无实锤需求）；可见性单一落点保证将来是词汇迁移。触发条件：出现 day-one 书面要求隔离的客户。
- **License**：年订阅，执行语义冻结于 ADR-0013（ed25519 离线文件、仅 server 校验、14 天警告、到期断 session/SSE、席位只阻止新建号不踢存量、时钟作弊接受）。**硬截止点：第一个带到期日的付费客户合同签出前必须落地。**
- **外部 Postgres DSN 支持**：出现强制使用自有 DB 平台的客户时再议。
