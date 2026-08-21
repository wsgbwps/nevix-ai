# 采用 Feature-Sliced + Vertical Slice 架构

3 人团队并行开发，核心需求是代码物理隔离——每人改自己的目录，PR 不交叉，合并冲突概率趋近于零。采用 Feature-Sliced Design 组织前端渲染进程，每个业务 Domain 独占一个 feature 目录；后端同样按业务 Module 拆分 `internal/` 子目录。AI 创作按 [ADR-0012](0012-unified-ai-creation-owner.md) 使用单一 `creation` owner，不再按图片、视频或页面拆 Feature/Module。功能模块之间禁止直接 import，跨模块通信走已批准的共享 owner。

## Considered Options

- **按技术层横切（components / hooks / api / store 各一个目录）**：多人改同一层时冲突频繁，PR 范围模糊。
- **Micro-frontend / 多仓库**：3 人规模下基础设施开销不划算，共享类型困难。
- **Feature-Sliced + Vertical Slice**：物理隔离、PR 范围清晰、AI 上下文小（每文件 50-150 行）。代价是 feature 间复用需要提升到 shared 层，但对 3 个 feature 的规模来说这个成本可接受。
