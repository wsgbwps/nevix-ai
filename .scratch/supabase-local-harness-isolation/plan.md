# Supabase 本地集成 Harness 隔离计划

## 范围与 owner

- Primary Domain：开发与 CI 的 Supabase 集成 harness；不改变 Desktop 或 Server 业务 Domain。
- 最窄 owner：`apps/desktop/scripts/run-e2e.sh`、`scripts/test-mail-smoke.sh`，以及二者共享的根 `scripts/` harness guard。
- 不改变 Supabase schema、migrations、公开契约或 ADR-0004 的 Desktop/Go 可信执行 seam。

## 安全不变量

1. 本地默认项目 `nevix-ai` 已存在任何带 CLI project label 的容器、卷或网络时，两个入口必须在 `start`、`stop` 或 `db reset` 前失败。
2. E2E 还必须拒绝旧 `nevix-authentication-e2e` 栈，不再为释放端口而删除它。
3. E2E 与 Mail Smoke 共用一个原子目录锁；第二个并发入口不得操作 Docker。
4. 默认 Supabase 端口或 E2E identity server 的 8080 端口已被占用时，入口必须在启动栈前失败。
5. 只有在持锁且状态、端口检查均通过后，入口才可声明拥有 `nevix-ai` 栈并启动它。
6. 正常退出、测试失败、SIGINT 或 SIGTERM 只清理本次声明拥有的明确 project ID；清理失败必须产生非零退出。
7. SIGKILL 或宿主崩溃无法执行 trap 时，残留锁或 Docker 状态使下一次运行 fail-closed。恢复者须先核对 owner、容器、卷与哨兵数据，再显式清理；harness 不自动接管不明状态。
8. GitHub hosted runner 的空白一次性环境继续执行 start → reset → tests → stop，并能连续重复运行。

## 验证

- 在系统临时目录复制 `supabase/`，用默认 `project_id = "nevix-ai"` 启动栈并写入哨兵数据。
- 对同一哨兵栈运行 E2E 与 Mail Smoke 入口，要求二者在破坏性命令前拒绝。
- 核对拒绝后容器、监听端口和哨兵行不变，再显式清理临时栈。
- 在空状态下运行 guard 回归测试，并重复执行 CI 等价的一次性 Supabase 生命周期，核对退出后无容器、卷、网络或监听端口残留。
