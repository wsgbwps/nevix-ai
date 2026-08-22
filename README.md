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
| 自动更新 | 暂无（分发与更新机制推迟至打包分发阶段，见 [ADR-0013](docs/adr/0013-onprem-single-tenant-delivery.md)） |

## 目录结构

```
nevix-ai/
├── apps/desktop/          # Electron + React 桌面客户端
│   └── src/
│       ├── shared/ipc/    # ★ IPC 类型声明（declaration merging，各 domain 独立扩展）
│       ├── main/          # 主进程（Domain-first implementation + domain-local IPC adapter）
│       ├── preload/       # 预加载（通用 typedInvoke / typedOn）
│       └── renderer/      # 渲染进程（React + Feature-Sliced）
├── server/                # Go 后端（独立于 Node workspace）
├── contracts/             # 前后端共享的 API 契约（OpenAPI）
├── supabase/              # 版本钉定的本地/CI Supabase 栈定义（config、migrations、seed）
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

采用 Feature-Sliced + Vertical Slice + DDD，个人开发，按功能垂直切分，代码物理隔离。详见 [ADR-0002](docs/adr/0002-feature-sliced-vertical-slice.md)。

AI 创作使用跨 Desktop、Server 与 OpenAPI 的唯一 canonical owner `creation`；图片、视频、灵感页、创作工作台与资产库不拆分独立 Domain/Module。详见 [ADR-0012](docs/adr/0012-unified-ai-creation-owner.md)。

数据平面默认由 Desktop 使用用户 JWT 直连受策略保护的 Supabase；只有密钥、额度/支付、Webhook、管理员权限、事务或异步编排需要跨入 Go 的可信执行 seam。Go 不是 Supabase 的通用代理层；完整决策见 [ADR-0004](docs/adr/0004-supabase-go-trusted-execution-seam.md)。

领域术语详见 `CONTEXT-MAP.md` → 各子 context 的 `CONTEXT.md`；Codex 的持久开发与评审规则详见 [`AGENTS.md`](AGENTS.md)。

### 目录边界是架构契约

本 README 的目录树和下方各层说明定义代码的归属边界；Domain、Feature、共享层和 composition root 是稳定约束，Feature 或 Module 内展示的职责子目录是参考而非穷举清单。开发时遵循以下规则：

1. 计划实现前先确定一个主要 Domain，并为每个新增或移动的源代码文件确定最窄的归属边界
2. 固定 public seam、依赖方向和目录词汇；Feature 内部按实际职责受控演化，不要求不同 Feature 复制相同目录
3. Renderer Feature 的通用 segment 使用 `ui/api/model/lib/config`；自定义责任目录必须能说明标准 segment 为何会损害 locality，并通过 deletion test 或具有 ADR、安全要求、cross-runtime seam 明确的 owner
4. 不使用同义目录或额外包装层改变既定边界；新增共享层、顶层目录或跨 Domain seam 属于架构变更
5. `app/`、`main/index.ts`、`cmd/server/main.go` 等 composition root 只负责组装；业务逻辑留在对应 Domain/Feature/Module
6. 完成前根据 `git diff --name-status` 复核全部变更路径；共享目录、公共契约、安全边界或跨 Domain 变更仍须遵守 [`AGENTS.md`](AGENTS.md) 的审批规则

---

### IPC 共享类型 (`apps/desktop/src/shared/ipc/`)

```
src/shared/ipc/
├── channels.ts                   # IPC 类型基座（空 interface，各 owner 通过 declaration merging 扩展）
├── authentication/
│   └── types.ts                  # declare module '@ipc/channels' 扩展 + 具名 req/res 类型
├── language/
│   └── types.ts
├── organization/
│   └── types.ts
└── window/                       # 唯一 platform-owned typed IPC 例外
    └── types.ts
```

各 domain 通过 TypeScript **declaration merging** 在自己的 `types.ts` 里扩展 `IpcChannelMap` / `IpcEventMap`，用 path alias `@ipc/channels` 而非相对路径。`tsconfig` 的 `include` glob 覆盖 `shared/**/*.ts`，tsc 自动合并所有 augmentation——无需 barrel 文件。决策背景详见 [ADR-0001](docs/adr/0001-ipc-self-registration.md)。

---

### Electron 主进程 (`apps/desktop/src/main/`)

```
src/main/
├── index.ts                      # composition root：Domain 初始化 + 自动注册 IPC adapters
├── authentication/               # Authentication Domain
│   ├── ipc/
│   │   ├── index.ts              # export function register()，只负责 Channel 注册
│   │   ├── read-session.ts       # 每个 Channel 一个 Handler 文件
│   │   ├── replace-session.ts
│   │   └── clear-session.ts
│   └── session-store.ts          # Domain implementation，不依赖 IPC
├── language/                     # Language Domain
│   ├── index.ts                  # 有外部 Main caller 时才创建的 public interface
│   ├── ipc/
│   │   ├── index.ts
│   │   └── <action>.ts
│   └── <language implementation>
├── window/
│   ├── ipc/                      # 唯一获准的 platform-owned typed IPC adapter
│   └── main-window.ts            # 非 Domain 的 BrowserWindow 平台职责
└── tray/
    └── tray.ts                   # 非 Domain 的平台职责
```

| 目录 | 职责 | 时机 |
|------|------|------|
| `<domain>/` | Domain implementation、可选 public interface 与 domain-local adapters | Domain 实际需要时 |
| `<domain>/ipc/` | IPC registration 与每 Channel 一个 Handler | Domain 拥有 IPC 时 |
| `window/` | BrowserWindow 创建、多窗口管理、窗口状态持久化与 Window lifecycle typed IPC | 初始化即有 |
| `tray/` | 系统托盘图标和菜单 | 产品需要后台常驻时 |

**IPC 架构说明：**

采用 **Domain-first + Type-safe IPC + 自注册** 模式；完整取舍见 [Desktop ADR-0003](apps/desktop/docs/adr/0003-main-domain-first-ipc-adapters.md)：

1. **Domain locality**：Domain-owned IPC adapter 位于 `main/<domain>/ipc/`，依赖同 Domain implementation；implementation 不反向依赖 IPC
2. **Window lifecycle 例外**：`window` 是唯一获准拥有 typed IPC 的非 Domain platform owner，使用 `shared/ipc/window/`、`main/window/ipc/` 与 `window:<action>`；Updater/Tray 仍不拥有 transport
3. **类型与运行时分离**：cross-process interface 位于 `shared/ipc/<owner>/`，运行时 adapter 位于对应 Main owner；两者使用同一 canonical owner 名与 `<owner>:<action>` Channel prefix
4. **每个 Handler 一个文件**：Handler 直接位于 `ipc/`，不增加 `handlers/`；复杂行为留在 owner implementation
5. **类型安全**：每个 IPC owner 在自己的 `shared/ipc/<owner>/types.ts` 里通过 `declare module '@ipc/channels'` 扩展 `IpcChannelMap` / `IpcEventMap`，并导出具名 request/response 类型
6. **纯 registration module**：`main/<owner>/ipc/index.ts` 加载无副作用，只导出同步且顺序无关的 `register(): void`
7. **自动注册**：`main/index.ts` 通过 `import.meta.glob('./*/ipc/index.ts', { eager: true })` 发现 Domain 与获准的 Window registration module；Domain 初始化仍由 composition root 显式编排
8. **Preload 通用化**：preload 只暴露 `typedInvoke` 与 `typedOn`，不增加 per-owner implementation 或中央 registry
9. **按需创建 seam**：Domain 不需要 IPC、Main public interface 或 renderer Feature 时，不创建空镜像目录；Window lifecycle IPC 不把 platform owner 伪装成 Domain

加一个 Handler 只改自己 owner 下的三个文件（`shared/ipc/<owner>/types.ts` + `main/<owner>/ipc/<action>.ts` + `main/<owner>/ipc/index.ts`），不碰中央共享注册文件。

> **Migration note:** 当前 `main/ipc/`、`main/settings/` 与 `main/i18n/` 是已接受架构决定落地前的 migration debt。Domain-first Main、Language Domain 合并、Channel rename 与新 glob 必须原子迁移，不长期保留两套结构或兼容 alias。

---

### Electron 预加载 (`apps/desktop/src/preload/`)

preload 是固定的桥接层，通过 `contextBridge` 暴露通用的 `typedInvoke` / `typedOn` 给 renderer。不含 per-domain 代码，加新 domain 不需要编辑。

---

### 渲染进程 (`apps/desktop/src/renderer/src/`)

```
src/renderer/src/
├── main.tsx                      # 入口
├── app/                          # 应用层（composition root + 全局 shell）
│   ├── globals.css               # 全局样式（Tailwind + shadcn 主题 + 设计 tokens + base）
│   ├── App.tsx                   # 根组件
│   ├── routes/                   # TanStack Router 文件路由（thin）
│   ├── pages/                    # 无 Domain owner 的占位页（Home）
│   ├── settings/                 # Settings Flow（app 拥有的聚合深模块：Section 注册表、离开语义、关闭编排）
│   ├── shell/                    # App Shell（已认证布局外壳）
│   └── providers.tsx             # 全局 providers（QueryClient, ThemeProvider 等）
├── features/                     # ★ 功能模块（每个业务 Domain 一个目录，互不侵入）
│   ├── creation/                 # AI Creation Domain；图片/视频与三个业务页面共用此 owner
│   │   ├── ui/                   # 展示与交互责任
│   │   ├── model/                # 业务状态、规则与流程编排
│   │   ├── api/                  # 后端 queries / mutations
│   │   ├── lib/                  # Feature-local 技术能力
│   │   ├── config/               # 静态配置
│   │   ├── i18n/                 # 满足准入门槛的自定义责任 segment
│   │   │   └── resources.ts      # Feature 自有的本地化资源
│   │   └── index.ts              # 唯一 public interface，显式 named exports
│   └── <other-domain>/           # 其他业务 Domain 各自独占 Feature
├── components/
│   └── ui/                       # shadcn/ui 组件（button, dialog, input...）
├── assets/                       # 静态资源（图片、SVG、字体文件）
├── lib/                          # 共享工具函数（含 shadcn 的 utils）
├── hooks/                        # 共享 hooks
└── env.d.ts                      # Vite 类型声明
```

Feature 目录遵循以下受控演化规则；segment 词汇与 public interface 原则分别以 FSD 的 [Slices and segments](https://fsd.how/docs/reference/slices-segments/) 与 [Public API](https://fsd.how/docs/reference/public-api/) 为依据：

1. Feature 根目录唯一允许的 TypeScript 源文件是 public `index.ts`；它不包含 implementation、初始化副作用或 `export *`
2. 新通用 segment 使用 Feature-Sliced 的 `ui/api/model/lib/config` 词汇，不新增按代码形式命名的 `components/hooks/store/types`
3. custom hook 按实际责任进入 `ui`、`model`、`api` 或 `lib`，不机械归入 `model`
4. `session/policy/i18n` 等自定义责任 segment 必须描述稳定用途；标准 segment 会拆散其 invariant、生命周期或知识；并且通过 deletion test，或具有 ADR、安全要求、cross-runtime seam 明确的 owner
5. Feature 内部直接相对 import，不经过自己的 public index；peer Feature 之间禁止互相 import，包括对方 public index，跨 Feature composition 放在 `app/`
6. 旧 `components/hooks/store` 机会式迁移，不因统一外观进行机械批量改名

---

### Go 后端 (`server/`)

按复杂度分层，详见 [ADR-0003](docs/adr/0003-complexity-driven-ddd-layering.md)。

```
server/
├── cmd/server/
│   └── main.go                   # 入口：显式调用各 module 的 Register()
├── internal/                     # ★ 业务模块（每个业务 Module 一个目录）+ 跨 Module 共享子包
│   ├── event/                    # 事件总线（types.go 定义事件类型，bus.go 定义接口）
│   ├── creation/                 # AI Creation 复杂 Module — 完整 DDD 分层
│   │   ├── domain/
│   │   │   ├── entity.go         # 实体、聚合根
│   │   │   ├── value.go          # 值对象
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
└── go.mod
```

| 层 | 职责 | 依赖方向 |
|---|---|---|
| `domain/` | 实体、值对象、Repository 接口 | 不依赖任何其他层 |
| `application/` | 用例编排，调用 domain 接口 | 依赖 domain |
| `infrastructure/` | Repository 实现、外部服务适配 | 依赖 domain（实现接口） |
| `interface/` | HTTP handler，调用 application | 依赖 application |

跨 Module 的 Domain Event 类型统一定义在 `internal/event/types.go`，Module 内不另建同名事件类型目录或文件。

测试摆放按**边界**决定，不按是否使用真实数据库决定：

- 验证 Module 公开 seam（`LoadConfig`/`NewModule`/`Register`/`RunWorkers` 装配、GoTrue/PostgREST 数据平面、SMTP 投递、OpenAPI 契约）的测试归该 Module 的 `integrationtest/`（Identity 即 `internal/identity/integrationtest/`）
- 验证 owning package 内部责任（SQL、query plan、事务、catalog）的测试留在该 package；依赖真实数据库等外部资源的以 `*_integration_test.go` 命名（资源标签，非 build tag），如 `writetx/`、`invitations/`、`verification/`、`outbox/` 内
- 测试支持代码只存在于 `*_test.go` 测试编译单元；不提前创建跨 Module 共享 testkit（出现第二个真实 Module consumer 且语义一致时再议）
- 缺环境的真库测试：普通 `go test ./...` skip；专用入口（`make test-identity-integration`）设 `NEVIX_IDENTITY_INTEGRATION_REQUESTED=1`，缺环境即 fail，并以零 skip + 代表性 sentinel 证明关键保障实际执行

---

### API 契约 (`contracts/`)

```
contracts/
├── openapi.yaml             # API 总纲
├── identity.yaml            # Identity 可信命令 seam
└── creation.yaml            # AI 创作可信命令 seam（正式开发时按需创建）
```

每个 Server Module 维护自己业务 owner 的 API 契约，`openapi.yaml` 通过 `$ref` 引用各子契约。AI 创作只使用 `creation` contract owner，不按图片与视频拆分。

## 常用命令

```bash
pnpm dev          # 启动 Electron 开发模式
pnpm build        # 构建前端
pnpm lint         # 运行 lint
cd server && go run ./cmd/server  # 启动后端

make dev          # 同 pnpm dev
make server       # 启动 Go 后端
make server-mailpit # 启动 Go 后端，并强制投递邮件到本地 Mailpit
make supabase     # 启动本地 Supabase（含 Mailpit）
make build        # 构建所有
make lint         # lint 所有
```

### 本地开发启动顺序

1. 首次运行 `cp server/.env.example server/.env.local`，然后按需调整本地非邮件配置；不要让 Server 使用 `postgres` owner 凭据。
2. 运行 `make supabase`，启动本地 Supabase 和 Mailpit。
3. 运行 `make server-mailpit`。该命令会为本次 Server 进程随机生成并配置本地 `identity_app` LOGIN 凭据，加载 `server/.env.local` 的其他配置，并强制使用最小权限数据库角色、`127.0.0.1:54325` 的 Mailpit SMTP 和压缩后的开发重试间隔；随机数据库凭据不会写入文件。
4. 运行 `make dev`，启动 Desktop。

Mailpit Web UI 位于 `http://127.0.0.1:54324`。Server 只在进程启动时读取 SMTP 配置；修改配置后必须重启 Server 才会生效。

`server-mailpit` 仅用于本地开发。生产环境继续使用 `make server` 或直接启动部署二进制，并通过部署环境变量提供 Resend（服务商）的 SMTP 配置。

## 打包与应用身份

- **App ID**：`com.nevix.ai`（electron-builder.yml + main 进程 `setAppUserModelId`）
- **Product Name**：`Nevix AI`
- App ID 一旦发布后变更，已安装用户会丢失数据和配置，必须在首次发布前确定

## 分支与交付规范

- 所有改动在短命任务分支完成；保持线性、可独立回滚的历史
- 推送任务分支并开 PR（`gh pr create --fill --base main`），用 `gh pr checks --watch --fail-fast` 等待路径感知的 `CI gate`（E2E 相关改动跑 Smoke，文档/markdown 与 unit/component 测试不触发；需要全量 E2E 时给 PR 打 `full-e2e` 标签，确无必要时可打 `skip-e2e` 跳过，`full-e2e` 优先）
- 检查通过后 squash merge 并删除分支（`gh pr merge --squash --delete-branch`）；每个任务在 `main` 上一个 commit，PR 页面即验收记录
- 本地 hooks 拦截对 `main` 的直接提交与推送（仅 agent 配置目录、`docs/`、根 `*.md` 及嵌套 `AGENTS.md` 的改动可直提直推、跳过 CI）；完整流程见 [`docs/agents/delivery.md`](docs/agents/delivery.md)
