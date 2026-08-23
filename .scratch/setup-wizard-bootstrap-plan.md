# 首启设置码向导 — 实施计划（切片 2/2）

背景：消除交付时烧死的管理员初始凭据（admin@admin.com 类默认值成为永久暴力破解靶子，且依赖「改 env 重启」的运维仪式）。决策出自 2026-08-23 grilling 会话；[ADR-0015](../docs/adr/0015-single-tenant-user-system-and-go-authorization.md) 已修订（账号生命周期·Bootstrap）。与切片 1/2（加入码）相互独立，按交付顺序在其后。

## 范围

- Primary Domain：Server identity；次要：Desktop authentication

## Server

- Module 构造时（现有 env bootstrap 之后）若 users 空：生成设置码（Crockford base32 8 位，日志以 `XXXX-XXXX` 分组打印一次），仅存进程内存；库非空不生成、不打印
- 进程重启且仍空库 → 换新码、旧码作废（日志语义：最新一条有效）
- `GET /identity/setup/status`（公开）：`{initialized: bool}`，不含其他信息（已确认：信息暴露面极低，属 setup screen 惯例）
- `POST /identity/setup/initialize`（公开）：`{email, password, display_name?, setup_code}` → 201，LoginResponse 形态；创建首个 admin，`must_change_password=false`（密码自设）
  - 错误：`invalid_setup_code`、`instance_already_initialized` 409、`invalid_email` 400、`password_too_short` 400；per-email 进程内限速（复用登录 limiter 模式）
  - 写事务内 `pg_advisory_xact_lock`（固定 key）+ 复检空库：并发 initialize 与 env 通道先到先得，输家 409
- 审计：新增 `setup_admin_created`（区别于 env 通道的 `bootstrap_admin_created`）
- env 通道（bootstrap.go）原样保留，供 headless 交付与 E2E

## 桌面端

- 登录屏挂载时及 server URL 变更后请求 `setup/status`；`!initialized` → 切换首启向导表单（email、密码、确认密码、设置码、显示名可选）
- 成功即以 admin 进 app；实例初始化后其他设备只见常规登录

## 测试

- Seam A：status 端点；空库 initialize 成功（admin/session/审计/无 must_change_password）；码错；已初始化后再 initialize 409；env bootstrap 先行后 initialize 409；重启换码（旧码拒）；限速；并发 initialize 先到先得
- Seam B：空 server 起向导 → 建 admin → 进 app；第二设备只见登录

## 非目标

- 加入码自注册（切片 1/2）；多管理员引导；设置码持久化（已否决）；`admin@admin.com` 类内置账号（已否决）
