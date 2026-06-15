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
| 后端 | Go — API 服务 / Agent 编排 |
| Monorepo | Turborepo + pnpm Workspaces |
| 打包 | electron-builder |
| 自动更新 | electron-updater (generic provider → 阿里云 OSS) |

## 目录结构

```
nevix-ai/
├── apps/desktop/          # Electron + React 桌面客户端
├── server/                # Go 后端（独立于 Node workspace）
├── contracts/             # 前后端共享的 API 契约（OpenAPI）
├── scripts/               # 构建和部署脚本
├── .github/workflows/     # CI/CD
├── turbo.json
├── pnpm-workspace.yaml
├── package.json
├── go.work
└── Makefile
```

## 架构设计

### 总体原则：Feature-Sliced + Vertical Slice + DDD

3 人协作，按功能垂直切分。每人负责完整的功能模块（UI → IPC → API → 后端存储），代码物理隔离在独立目录中，功能模块之间禁止直接 import。

**为什么选这个方案：**

| 痛点 | 解法 |
|------|------|
| 多人代码耦合 | feature 目录物理隔离，PR 只改自己目录下的文件 |
| AI 上下文过大 | 每个文件 50-150 行，AI 精准定位，不读无关代码 |
| 合并冲突 | 不同 feature 改不同文件，冲突概率极低 |
| 代码审查 | PR 范围清晰，一个 feature 的 PR 只涉及该 feature 的目录 |
| 后期重构成本 | 完整 DDD 分层从一开始建立，避免后期拆分大文件 |

**开发流程：**

1. 把产品需求按用户行为拆成垂直 slice（"用户能生成视频" 而非 "写视频 API"）
2. 每个 slice 分给一人，负责前端 feature 目录 + main 进程 IPC + 后端 module + API 契约
3. 一个 PR 只改 `features/<name>/` + `ipc/<name>/` + `internal/<name>/` + `contracts/<name>.yaml`
4. `components/ui/`、`lib/`、`pkg/` 是公共区域，改动需要额外 review

---

### Electron 主进程 (`apps/desktop/src/main/`)

```
src/main/
├── index.ts                      # 入口：app 生命周期，组装各模块
├── window/
│   └── main-window.ts            # 窗口创建与管理
├── ipc/
│   ├── types.ts                  # 类型安全 IPC 基础设施（typed wrapper）
│   ├── register.ts               # 统一注册所有 domain 的 handlers/listeners
│   ├── system/                   # 系统级 IPC（窗口操作、文件对话框等）
│   │   ├── index.ts              # 导出类型 + 注册函数 + API 对象
│   │   ├── open-file-dialog.ts   # 单个 handler
│   │   └── get-app-version.ts
│   ├── video-generation/         # 视频生成（开发者 A）
│   │   ├── index.ts
│   │   ├── generate-video.ts
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
| `ipc/` | 类型安全的 IPC 层，按 domain 拆目录，每个 handler 独立文件 | 初始化即有 |
| `updater/` | 自动更新检查、下载、安装提示 | 接入阿里云 OSS 时 |
| `tray/` | 系统托盘图标和菜单 | 产品需要后台常驻时 |

**IPC 架构说明：**

采用业界推荐的 **Domain-based + Type-safe IPC** 模式（参考 [Orbit](https://heckmann.app/en/blog/electron-ipc-architecture)、[Ray 3.0](https://myray.app/blog/ray-architecture) 等成熟 Electron 应用），核心要点：

1. **按 domain 拆目录**：`ipc/video-generation/`、`ipc/image-editing/`，和 renderer `features/` 一一对应
2. **每个 handler 一个文件**：`generate-video.ts`、`get-progress.ts`，避免单文件无限膨胀
3. **类型安全**：使用 `@electron-toolkit/typed-ipc` 或等效 typed wrapper，channel 名称和参数全程类型检查
4. **每个 domain 的 `index.ts` 导出三样东西**：
   - **类型映射**（handler types、listener types、main-to-renderer event types）
   - **API 对象**（供 preload 暴露给 renderer）
   - **注册函数**（`registerXxxHandlers()`，在 `register.ts` 中统一调用）
5. **`register.ts`** 在 `app.whenReady()` 时统一注册所有 domain

这样每个 feature 开发者只在自己的 `ipc/<domain>/` 下增删 handler 文件，不会和其他人冲突。

---

### Electron 预加载 (`apps/desktop/src/preload/`)

保持 electron-vite 模板默认结构，不做额外规划。preload 是固定的桥接层，通过 `contextBridge` 暴露 API 给 renderer。

---

### 渲染进程 (`apps/desktop/src/renderer/src/`)

采用 Feature-Sliced Design，shadcn/ui 组件保持默认路径。

```
src/renderer/src/
├── app/                          # 应用层
│   ├── routes/                   # TanStack Router 文件路由
│   └── providers.tsx             # 全局 providers
├── features/                     # ★ 功能模块（每人一个目录，互不侵入）
│   ├── video-generation/         # 开发者 A
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── api/                  # TanStack Query hooks
│   │   ├── store/                # Zustand slice
│   │   └── index.ts              # 公共导出（唯一对外接口）
│   ├── image-editing/            # 开发者 B
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── api/
│   │   └── index.ts
│   └── project-management/       # 开发者 C
│       ├── components/
│       ├── hooks/
│       ├── api/
│       └── index.ts
├── components/                   # 共享 UI 层
│   └── ui/                       # shadcn/ui 组件（button, dialog, input...）
├── lib/                          # 共享工具函数（含 shadcn 的 utils）
├── hooks/                        # 共享 hooks
└── main.tsx
```

**关键规则：**

- `features/A/` **禁止**直接 import `features/B/` 的内部文件
- feature 之间需要通信时，走 `lib/` 或事件机制
- 每个 feature 的 `index.ts` 是唯一的公共导出
- `components/ui/` 是 shadcn 默认生成路径，保持不变，视为 shared 层

---

### Go 后端 (`server/`) — 完整 DDD

```
server/
├── cmd/server/
│   └── main.go                   # 入口：组装所有模块，注册路由
├── internal/                     # ★ 业务模块（每人一个目录）
│   └── <module>/
│       ├── domain/
│       │   ├── entity.go         # 实体、聚合根
│       │   ├── value.go          # 值对象
│       │   ├── event.go          # 领域事件定义
│       │   └── repository.go     # Repository 接口（不是实现）
│       ├── application/
│       │   ├── service.go        # 应用服务 / 用例编排
│       │   ├── command.go        # 命令（写操作）
│       │   └── query.go          # 查询（读操作）
│       ├── infrastructure/
│       │   ├── postgres_repo.go  # Repository 实现
│       │   └── adapter.go        # 外部服务适配器
│       └── interface/
│           └── http.go           # HTTP handler，暴露 RegisterRoutes()
├── pkg/                          # 跨模块共享
│   ├── middleware/                # HTTP 中间件
│   ├── auth/                     # 认证
│   ├── database/                 # 数据库连接
│   └── event/                    # 事件总线
└── go.mod
```

**DDD 分层职责：**

| 层 | 职责 | 依赖方向 |
|---|---|---|
| `domain/` | 实体、值对象、领域事件、Repository 接口 | 不依赖任何其他层 |
| `application/` | 用例编排，调用 domain 接口 | 依赖 domain |
| `infrastructure/` | Repository 实现、外部服务适配 | 依赖 domain（实现接口） |
| `interface/` | HTTP handler，调用 application | 依赖 application |

**关键规则：**

- `internal/videogen/` **禁止** import `internal/imageedit/`
- 模块间通信通过 `pkg/event/` 事件总线
- 每个模块通过 `interface/http.go` 暴露 `RegisterRoutes(r chi.Router)`，在 `cmd/server/main.go` 中统一注册

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
