# identity CORS preflight 修复计划

## 根因

`cmd/server/main.go` 通过 `router.Group(...)` 挂载 identity Module。chi v5 中，
Group（inline mux）里 `Use` 注册的中间件只在**路由命中**时执行（在路由注册时
被烘进每条路由的 handler 链）；未命中的方法（如对 POST-only 路由发 OPTIONS
preflight）直接走 chi 的 405，不经过任何 Group 中间件。因此浏览器预检得到无
CORS 头的 405 → 拦截真正的 POST → 创建组织按钮"没反应"。

测试未暴露的原因：

- 单元测试 `transport_test.go` 用裸 handler 包中间件，不经 chi 路由。
- 集成测试 `newTransportHandler` 把 Module 挂到根 mux（`Use` 包裹整个 mux，
  405 也过中间件），与生产挂载方式不一致。

## 修复（安全边界行为不弱化）

1. `internal/identity/cors.go`：新增 `preflightEndpoint` no-op（中间件放行的
   未知来源预检落到此端点，响应无 CORS 头，浏览器仍然拒绝）。
2. `internal/identity/module.go` `Register`：为 `/identity/verification-codes`
   与 `/identity/organizations` 显式注册 `OPTIONS` 路由，使预检在任何挂载
   方式下都能命中路由并经过 CORS 中间件。
3. 集成测试 `newTransportHandler` 改为经 `router.Group` 挂载（对齐组合根），
   `TestCreateOrganizationCORSWhitelist` 增补未知来源预检与
   verification-codes 预检断言。

## 验证

- `go build ./...` + 单元测试（无栈）。
- 对运行中的本地栈跑 `TestCreateOrganizationCORSWhitelist`（不 reset 数据库）。
- 用户重启 `make server` 后 curl 预检确认 204 + ACAO。
