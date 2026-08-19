# CI gate 观察判据（预登记）

背景：#71（2026-08-19 合并，Tier 1：job 超时、Playwright 浏览器缓存、E2E
单次重试）之后约定「先观察再决定要不要砍 CI」。为防止事后凭印象选激进
程度，判定标准在此预登记；观察期内不修改本文件。

## 基线

#71 后首个 PR gate 数据点（run 32236228319，PR #71 自身）：
changes 8s · server 22s · auth-policy 1m58s · quality 3m46s（浏览器缓存
未命中；历史中位 92s）· e2e smoke 4m30s · build 31s · identity 4m54s ·
gate 3s → **关键路径 ≈ 5 分钟**（quality / e2e smoke / identity 并行）。

## 观察窗口

#71 之后的 10 个 PR gate 运行。

## 指标与读法

1. **gate 关键路径耗时 p50/p90**：`gh run view <id> --json jobs` 取各 job
   duration 的最长依赖链，而非各 job 墙钟相加。
2. **flake 重跑次数**：窗口内因 infra/flake 触发 rerun 的 job 总数。
3. **人肉等待分钟**：agent watch 模式下预期 ≈ 0；仅统计人亲自盯着的时长。

## 判定（预注册）

- **p90 < 8 分钟 且 重跑 ≤ 2 次 且 人肉等待 ≈ 0 → 维持现状，不缩 gate
  范围，不移任何检查出阻塞。** 基线显示这就是预期结局：结构已是最简形态
  （路径感知 + ADR-0007 分层 + ADR-0010 验证一次 + ADR-0011 PR 交付）。
- 任一超标 → 携数据重议「缩 gate / 移异步」，届时对照 ADR-0007/0010/0011
  评估是否需要新 ADR。

## 干扰项声明

Docker Hub 限流 flake（toomanyrequests）由 Tier 2 镜像缓存 PR 修复，可能
落在观察窗口内。重跑指标只统计 Tier 2 合并之后的运行；耗时指标不受影响
（限流失败的是拉取，不是耗时）。
