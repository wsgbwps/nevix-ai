# 采用 Feature-Sliced + Vertical Slice 架构

3 人团队并行开发，核心需求是代码物理隔离——每人改自己的目录，PR 不交叉，合并冲突概率趋近于零。采用 Feature-Sliced Design 组织前端渲染进程，每个功能模块（video-generation、image-editing、project-management）独占一个 feature 目录；后端同样按 domain 拆分 `internal/` 子目录。功能模块之间禁止直接 import，跨模块通信走共享层（前端 `lib/`、后端 `pkg/event/`）。

## Considered Options

- **按技术层横切（components / hooks / api / store 各一个目录）**：多人改同一层时冲突频繁，PR 范围模糊。
- **Micro-frontend / 多仓库**：3 人规模下基础设施开销不划算，共享类型困难。
- **Feature-Sliced + Vertical Slice**：物理隔离、PR 范围清晰、AI 上下文小（每文件 50-150 行）。代价是 feature 间复用需要提升到 shared 层，但对 3 个 feature 的规模来说这个成本可接受。
