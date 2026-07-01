## Code rules

### Frontend (apps/desktop/)

- `features/A/` 禁止直接 import `features/B/` 的内部文件，feature 间通信走 `lib/` 或事件机制
- 每个 feature 的 `index.ts` 是唯一的公共导出
- `components/ui/` 是 shadcn 默认路径，视为 shared 层，改动需要额外 review
- `app/globals.css` 是全局样式的唯一归属地
- `assets/` 仅存放静态资源（图片、SVG、字体），禁止放置 CSS 或配置文件
- 加新 IPC handler 只改自己 domain 下的两个文件：`shared/ipc/<domain>/types.ts` + `main/ipc/<domain>/index.ts`，不碰共享文件
- Preload 层不含 per-domain 代码，加新 domain 不需要编辑

### Backend (server/)

- `internal/A/` 禁止 import `internal/B/`，模块间通信通过 `pkg/event/` 事件总线
- 事件类型集中定义在 `pkg/event/types.go`
- 每个 module 导出 `Register(r chi.Router, bus event.Bus)`，在 `main.go` 中显式调用，不使用 `init()` + blank import
- 简单 module 用单文件，出现第二个 adapter 时再拆出 repository 接口

### 共享区域

- `components/ui/`、`lib/`、`pkg/` 是公共区域，改动需要额外 review
- 一个 PR 只改 `features/<name>/` + `ipc/<name>/` + `internal/<name>/` + `contracts/<name>.yaml`

## Agent skills

### Issue tracker

Local markdown — issues live as `.scratch/<feature-slug>/` files. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context — `CONTEXT-MAP.md` at root points to per-context `CONTEXT.md` files in `apps/desktop/` and `server/`. See `docs/agents/domain.md`.
