# Design the Email and Outbox Contract

Type: grilling
Status: open
Blocked by: 01, 02, 04

## Question

GoTrue SMTP 邮件与 `internal/identity` Outbox 邮件各自拥有哪些模板和状态；发送、重试、去重、失败可见性、验证码安全、通知矩阵和本地邮件捕获的最小可靠契约是什么？

## Comments

2026-07-31：本票的发送、重试、失败可见性、验证码限流位置与本地邮件捕获已由 [Resend Email Delivery spec](../../resend-email-delivery/spec.md)（ready-for-agent）定案，并已写回 identity-v1 spec 的 Email and Outbox 章节（第 368/455 行留白同步收窄）。本票剩余未决：模板清单、通知矩阵、去重语义。
