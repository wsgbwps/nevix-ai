# 采用 Feature-Sliced + Vertical Slice 架构

个人开发，核心需求是代码物理隔离——每个 Domain/Module 独占目录，改动范围与 owner 边界清晰。采用 Feature-Sliced Design 组织前端渲染进程，每个业务 Domain 独占一个 feature 目录；后端同样按业务 Module 拆分 `internal/` 子目录。AI 创作按 [ADR-0012](0012-unified-ai-creation-owner.md) 使用单一 `creation` owner，不再按图片、视频或页面拆 Feature/Module。功能模块之间禁止直接 import，跨模块通信走已批准的共享 owner。

## Considered Options

- **按技术层横切（components / hooks / api / store 各一个目录）**：单个功能的改动散布多层，修改与回滚范围模糊。
- **Micro-frontend / 多仓库**：单人规模下基础设施开销不划算，共享类型困难。
- **Feature-Sliced + Vertical Slice**：物理隔离、改动范围清晰、AI 上下文小（每文件 50-150 行）。代价是 feature 间复用需要提升到 shared 层，但对当前 feature 规模这个成本可接受。
