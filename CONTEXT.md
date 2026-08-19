# Nevix AI

跨 Desktop 与 Server 两个 context 的仓库级术语。各 context 自己的语言见
[CONTEXT-MAP.md](./CONTEXT-MAP.md)。

## Language

**Gate 强制**:
合并前 PR 必须通过的检查集合及其实际执行方式——由 CI gate 认定范围，经本地
watch 兑现。GitHub 免费私库没有服务端 required checks，这套本地纪律就是仓库
唯一的门禁。
_Avoid_: required checks、required status checks、分支保护
