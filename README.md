# Nevix AI

AI媒体创作 SaaS 桌面应用。

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面客户端 | Electron + Vite (electron-vite) |
| 前端框架 | React 19 + TypeScript |
| 路由 | TanStack Router (文件路由) |
| 数据获取 | TanStack Query |
| UI 状态 | Zustand |
| 样式 & 组件 | Tailwind CSS v4 + shadcn/ui |
| 后端 | Go — API 服务 / Agent 编排 |
| Monorepo | Turborepo + pnpm Workspaces |
| 打包 | electron-builder |
| 自动更新 | electron-updater (generic provider → 阿里云 OSS) |

## 目录结构

- `apps/desktop/` — Electron + React 桌面客户端
- `server/` — Go 后端（独立于 Node workspace）
- `contracts/` — 前后端共享的 API 契约（OpenAPI）
- `scripts/` — 构建和部署脚本
- `.github/workflows/` — CI/CD

## 常用命令

```bash
pnpm dev          # 启动 Electron 开发模式
pnpm build        # 构建前端
pnpm lint         # 运行 lint
cd server && go run .  # 启动后端

make dev          # 同 pnpm dev
make server       # 启动 Go 后端
make build        # 构建所有
make lint         # lint 所有
```

## 分支与 PR 规范

- `main` 分支受保护，所有改动通过 PR 合并
- 短命功能分支，命名：`feat/xxx`、`fix/xxx`
- PR 合并前必须通过 CI（lint + build + test）
- 合并方式：squash merge
