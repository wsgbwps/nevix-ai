# Nevix AI

AI 媒体创作 SaaS 桌面应用。

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面客户端 | Electron + Vite (electron-vite) |
| 前端框架 | React 19 + TypeScript |
| 路由 | TanStack Router (文件路由) |
| 数据获取 | TanStack Query |
| UI 状态 | Zustand |
| 样式 & 组件 | Tailwind CSS v4 + shadcn/ui |
| 身份、数据与对象存储 | Supabase (Auth / PostgreSQL / Storage / Realtime) |
| 后端 | Go — API 服务 / Agent 编排 |
| Monorepo | Turborepo + pnpm Workspaces |
| 打包 | electron-builder |
| 自动更新 | electron-updater (generic provider → 阿里云 OSS) |

## 目录结构

```
nevix-ai/
├── apps/desktop/          # Electron + React 桌面客户端
│   └── src/
│       ├── shared/ipc/    # ★ IPC 类型声明（declaration merging，各 domain 独立扩展）
│       ├── main/          # 主进程（handler 注册 + import.meta.glob 自动发现）
│       ├── preload/       # 预加载（通用 typedInvoke / typedOn）
│       └── renderer/      # 渲染进程（React + Feature-Sliced）
├── server/                # Go 后端（独立于 Node workspace）
├── contracts/             # 前后端共享的 API 契约（OpenAPI）
├── docs/adr/              # 架构决策记录
├── scripts/               # 构建和部署脚本
├── .github/workflows/     # CI/CD
├── turbo.json
├── pnpm-workspace.yaml
├── package.json
├── go.work
└── Makefile
```

## 架构设计

采用 Feature-Sliced + Vertical Slice + DDD，3 人按功能垂直切分，代码物理隔离。详见 [ADR-0002](docs/adr/0002-feature-sliced-vertical-slice.md)。

数据平面默认由 Desktop 使用用户 JWT 直连受策略保护的 Supabase；只有密钥、额度/支付、Webhook、管理员权限、事务或异步编排需要跨入 Go 的可信执行 seam。Go 不是 Supabase 的通用代理层；完整决策见 [ADR-0004](docs/adr/0004-supabase-go-trusted-execution-seam.md)。

领域术语详见 `CONTEXT-MAP.md` → 各子 context 的 `CONTEXT.md`；Codex 的持久开发与评审规则详见 [`AGENTS.md`](AGENTS.md)。

---

### IPC 共享类型 (`apps/desktop/src/shared/ipc/`)

```
src/shared/ipc/
├── channels.ts                   # IPC 类型基座（空 interface，各 domain 通过 declaration merging 扩展）
├── video-generation/
│   └── types.ts                  # declare module '@ipc/channels' 扩展 + 具名 req/res 类型
├── image-editing/
│   └── types.ts
└── project-management/
    └── types.ts
```

各 domain 通过 TypeScript **declaration merging** 在自己的 `types.ts` 里扩展 `IpcChannelMap` / `IpcEventMap`，用 path alias `@ipc/channels` 而非相对路径。`tsconfig` 的 `include` glob 覆盖 `shared/**/*.ts`，tsc 自动合并所有 augmentation——无需 barrel 文件。决策背景详见 [ADR-0001](docs/adr/0001-ipc-self-registration.md)。

---

### Electron 主进程 (`apps/desktop/src/main/`)

```
src/main/
├── index.ts                      # 入口：app 生命周期 + import.meta.glob 自动注册 IPC handlers
├── window/
│   └── main-window.ts            # 窗口创建与管理
├── ipc/
│   ├── video-generation/         # 视频生成（开发者 A）
│   │   ├── index.ts              # export function register() — handler 注册
│   │   ├── generate-video.ts     # 单个 handler
│   │   └── get-progress.ts
│   ├── image-editing/            # 图片编辑（开发者 B）
│   │   ├── index.ts
│   │   ├── apply-filter.ts
│   │   └── export-image.ts
│   └── project-management/       # 项目管理（开发者 C）
│       ├── index.ts
│       ├── create-project.ts
│       └── list-projects.ts
├── updater/
│   └── auto-updater.ts           # electron-updater 自动更新逻辑
└── tray/
    └── tray.ts                   # 系统托盘（需要时添加）
```

| 目录 | 职责 | 时机 |
|------|------|------|
| `window/` | BrowserWindow 创建、多窗口管理、窗口状态持久化 | 初始化即有 |
| `ipc/` | handler 运行时逻辑，按 domain 拆目录，每个 handler 独立文件 | 初始化即有 |
| `updater/` | 自动更新检查、下载、安装提示 | 接入阿里云 OSS 时 |
| `tray/` | 系统托盘图标和菜单 | 产品需要后台常驻时 |

**IPC 架构说明：**

采用 **Domain-based + Type-safe IPC + 自注册** 模式，核心要点：

1. **类型与运行时分离**：类型声明在 `shared/ipc/`（tsc 负责聚合），handler 注册在 `main/ipc/`（Vite 负责发现）——两条独立管线
2. **按 domain 拆目录**：`ipc/video-generation/`、`ipc/image-editing/`，和 renderer `features/` 一一对应
3. **每个 handler 一个文件**：`generate-video.ts`、`get-progress.ts`，避免单文件无限膨胀
4. **类型安全**：各 domain 在自己的 `shared/ipc/<domain>/types.ts` 里通过 `declare module '@ipc/channels'` 扩展 `IpcChannelMap` / `IpcEventMap`。channel 名拼错或参数类型不匹配在 `tsc` 阶段即被捕获。每个 domain 独立导出具名的 request/response 类型（如 `GenerateVideoReq`），renderer 可直接 import
5. **自动注册**：`main/index.ts` 通过 `import.meta.glob('./ipc/*/index.ts', { eager: true })` 在构建时自动发现并注册所有 domain 的 handler。加新 domain 只需创建目录，不需要编辑任何共享文件
6. **Preload 通用化**：preload 只暴露 `typedInvoke`（request/response）和 `typedOn`（push events）两个泛型函数，类型从 `IpcChannelMap` / `IpcEventMap` 推导。加新 domain 不需要编辑 preload
7. **`index.ts` 是纯组装器**：只负责 app 生命周期和自动注册，不包含任何业务逻辑

加一个 handler 只改自己 domain 下的两个文件（`shared/ipc/<domain>/types.ts` + `main/ipc/<domain>/index.ts`），不碰任何共享文件。

---

### Electron 预加载 (`apps/desktop/src/preload/`)

preload 是固定的桥接层，通过 `contextBridge` 暴露通用的 `typedInvoke` / `typedOn` 给 renderer。不含 per-domain 代码，加新 domain 不需要编辑。

---

### 渲染进程 (`apps/desktop/src/renderer/src/`)

```
src/renderer/src/
├── main.tsx                      # 入口
├── app/                          # 应用层（全局 shell）
│   ├── globals.css               # 全局样式（Tailwind + shadcn 主题 + 设计 tokens + base）
│   ├── App.tsx                   # 根组件
│   ├── routes/                   # TanStack Router 文件路由
│   └── providers.tsx             # 全局 providers（QueryClient, ThemeProvider 等）
├── features/                     # ★ 功能模块（每人一个目录，互不侵入）
│   ├── video-generation/         # 开发者 A
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── api/                  # TanStack Query hooks
│   │   ├── store/                # Zustand slice
│   │   └── index.ts              # 公共导出（唯一对外接口）
│   ├── image-editing/            # 开发者 B
│   └── project-management/       # 开发者 C
├── components/
│   └── ui/                       # shadcn/ui 组件（button, dialog, input...）
├── assets/                       # 静态资源（图片、SVG、字体文件）
├── lib/                          # 共享工具函数（含 shadcn 的 utils）
├── hooks/                        # 共享 hooks
└── env.d.ts                      # Vite 类型声明
```

---

### Go 后端 (`server/`)

按复杂度分层，详见 [ADR-0003](docs/adr/0003-complexity-driven-ddd-layering.md)。

```
server/
├── cmd/server/
│   └── main.go                   # 入口：显式调用各 module 的 Register()
├── internal/                     # ★ 业务模块（每人一个目录）
│   ├── videogen/                 # 复杂模块 — 完整 DDD 分层
│   │   ├── domain/
│   │   │   ├── entity.go         # 实体、聚合根
│   │   │   ├── value.go          # 值对象
│   │   │   ├── event.go          # 领域事件定义
│   │   │   └── repository.go     # Repository 接口（不是实现）
│   │   ├── application/
│   │   │   ├── service.go        # 应用服务 / 用例编排
│   │   │   ├── command.go        # 命令（写操作）
│   │   │   └── query.go          # 查询（读操作）
│   │   ├── infrastructure/
│   │   │   ├── postgres_repo.go  # Repository 实现
│   │   │   └── adapter.go        # 外部服务适配器
│   │   └── interface/
│   │       └── http.go           # Register(r chi.Router, bus event.Bus)
│   └── projmgmt/                 # 简单模块 — 单文件
│       └── module.go             # handler + storage 内联
├── pkg/                          # 跨模块共享
│   ├── middleware/                # HTTP 中间件
│   ├── auth/                     # 认证
│   ├── database/                 # 数据库连接
│   └── event/                    # 事件总线（types.go 定义事件类型，bus.go 定义接口）
└── go.mod
```

| 层 | 职责 | 依赖方向 |
|---|---|---|
| `domain/` | 实体、值对象、领域事件、Repository 接口 | 不依赖任何其他层 |
| `application/` | 用例编排，调用 domain 接口 | 依赖 domain |
| `infrastructure/` | Repository 实现、外部服务适配 | 依赖 domain（实现接口） |
| `interface/` | HTTP handler，调用 application | 依赖 application |

---

### API 契约 (`contracts/`)

```
contracts/
├── openapi.yaml             # API 总纲
├── video-generation.yaml    # 开发者 A 维护
├── image-editing.yaml       # 开发者 B 维护
└── project-management.yaml  # 开发者 C 维护
```

每个开发者维护自己功能模块的 API 契约，`openapi.yaml` 通过 `$ref` 引用各子契约。

## 常用命令

```bash
pnpm dev          # 启动 Electron 开发模式
pnpm build        # 构建前端
pnpm lint         # 运行 lint
cd server && go run ./cmd/server  # 启动后端

make dev          # 同 pnpm dev
make server       # 启动 Go 后端
make build        # 构建所有
make lint         # lint 所有
```

## 打包与应用身份

- **App ID**：`com.nevix.ai`（electron-builder.yml + main 进程 `setAppUserModelId`）
- **Product Name**：`Nevix AI`
- App ID 一旦发布后变更，已安装用户会丢失数据和配置，必须在首次发布前确定

## 分支与 PR 规范

- `main` 分支受保护，所有改动通过 PR 合并
- 短命功能分支，命名：`feat/xxx`、`fix/xxx`
- PR 合并前必须通过 CI（lint + build + test）
- 合并方式：squash merge
