# Design the Identity Schema and Invariants

Type: grilling
Status: claimed
Blocked by: 01, 02, 03

## Question

怎样用最小的 PostgreSQL schema 表达 User、Profile、Organization、Membership、Invitation、Ownership Transfer、删除状态、Audit Log、Outbox 与验证码，并由约束保证单一 Owner、唯一有效关系、状态转换、期限和幂等性？
