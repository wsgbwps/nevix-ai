# Design the RLS and GRANT Matrix

Type: grilling
Status: open
Blocked by: 04

## Question

每张 exposed table 对 `anon`、`authenticated` 和 Go 最小权限数据库角色应具有什么 GRANT 与 RLS policy，怎样保证 Membership 是实时授权事实源、Active Organization 不是权限依据，并验证跨 Organization 隔离和移除后立即失权？
