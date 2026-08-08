# Identity command skeleton — 深化计划

来源：架构评审（PR #24–#28 热点）候选 A，经两轮 grilling（11 项决策）收敛。本文件是唯一决策记录；实施票见 `issues/`。

## 问题

Identity 规格还有 ~15 个 trusted command 排队进入（ticket 06 邀请四命令、07 membership 命令等）。当前每个命令复制一份样板：`MaxBytesReader+Decode→400`、`errors.Is` 分支映射、`slog.Error+500`、手写成功 JSON、错误信封双写（`writeCreateError` / `writeIssueError`）、Register 里每路径手写 OPTIONS 孪生、`Allow-Methods` 硬编码 `"POST, OPTIONS"`（PR #28 的病根：路由注册与 CORS 认知分离）。

## 决策（grilling 已锁定，勿重开）

1. **骨架落点**：新子包 `internal/identity/command`（词汇复用 ADR-0008「Go trusted command」，CONTEXT.md 不新增词条）。域子包只留业务函数与请求/响应类型，HTTP 机制全部上移。
2. **错误模型**：`command.Error{Status, Code, Message, Headers}`；业务返回 `error`；每**域子包**一个 `mapError func(error) *command.Error`（防枚举 404/403/401 是域级词汇，邀请四命令共享）；未映射错误由骨架统一 `slog.Error + 500 internal_error`。信封 writer 全 Module 唯一。
3. **业务签名**：`func(ctx, req Req) (Resp, error)`。骨架提供两个泛型入口共享私有管线：`Handle`（常规）与 `HandleWithRequest`（多一个 `*http.Request`，verification 用闭包提取 clientIP）。不暴露管线原语。（这是对「注册点闭包捕获 r」的机械修正——注册在启动期，捕获不到 per-request 值。）
4. **路由表**：entry 四字段 `{Method, Path, Public bool, Handler}`——`Public` 零值即安全（缺省挂 Bearer guard，spec 已定新命令一律 Bearer）；SuccessStatus 不入表（CORS 派生只需 method 集合），只活在 `Handle` 调用点。chi path pattern（`{id}`）与多方法共享 path 现在就支持（ticket 06 的 DELETE 会撞上）。
5. **CORS 同源**：骨架拥有 `Mount(r, routes, bearer)` 与 `MethodsByPath(routes)`；OPTIONS 孪生、preflight `Allow-Methods` 全部由同一张表派生。表是唯一信源。
6. **Validate hook**：请求类型可选实现 `Validate() *command.Error`（指针接收者，先 normalize 再校验）；字段校验直接返回成形 400，不绕 mapError——「请求形状不符」与域错误分层。
7. **契约断言（评审候选 D）不捆绑**：本轮只做骨架；骨架的 decode/encode 单一 choke point 即为 D 预留挂点，D 独立成票、独立 grilling。
8. **迁移策略**：两个现有命令在同一切片内迁完，不保留双结构（repo 原子迁移惯例）。

## 不变量与风险（实施时逐条核对）

- **组合面契约不动**：`LoadConfig / NewModule / Register / RunWorkers` 签名零变化；组合根与集成测试仍只见 package identity。
- **信封字节格式逐字节保留**：`{"error":%q,"message":%q}`——契约一致性测试与潜在消费方依赖现状，不「顺手」改 json.Marshal。
- **PR #28 预检语义严格保持**：白名单 origin 的预检由中间件应答 204+头部（Allow-Methods 改为逐路径派生值）；未知 origin 落穿、无 CORS 头。
- **测试挂载必须复制生产的 chi Group 方式**（main.go 形状）——裸 mux 挂载会掩盖 Group 下中间件不拦截未命中方法的回归（PR #28 教训）。
- **cooldown 的 Retry-After**：`errCooldownActive` sentinel 升级为携带 retryAfter 的 typed error，mapError 用 `errors.As` 取出并填 `Error.Headers`。
- **Desktop 零改动**，`contracts/openapi.yaml` 零改动。

## 交付

- 票 01（骨架 + 表驱动注册，handler 原样入表，行为零变化）→ 票 02（两命令迁上骨架，删双写），顺序执行，各自 feature 分支 + PR。
- 每票门禁：`go test ./...` 全绿 + mail-smoke CI 绿；现有集成测试与契约一致性测试不改断言不红（回归网）。
- 预估总规模约 +260 / −130 行。
