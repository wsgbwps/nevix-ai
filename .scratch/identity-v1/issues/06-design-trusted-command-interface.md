# Design the Identity Trusted Command Interface

Type: grilling
Status: wontfix — superseded：开发入口已迁移，不再领取或推进（见 ../map.md）
Blocked by: 01, 03, 04

## Question

`server/internal/identity` 应通过哪些最小 HTTP/命令 interface 承担创建组织、邀请、成员治理、Ownership Transfer、删除、安全恢复、审计与 Outbox；各命令的认证、幂等、并发、错误和事务契约是什么？
