# IPC 类型基座与路径别名配置

Status: done

## Parent

[Architecture Scaffolding PRD](../PRD.md)

## What to build

建立 IPC 类型系统的基础设施：在 `src/shared/ipc/channels.ts` 中定义空的 `IpcChannelMap` 和 `IpcEventMap` 两个 interface，作为未来各 feature domain 通过 declaration merging 独立扩展的基座。

配置 `@ipc/channels` path alias，使所有 `declare module` 使用稳定路径而非相对路径。alias 需要同时在 tsconfig（node + web）和 electron-vite config 中配置。

扩展 `tsconfig.web.json` 和 `tsconfig.node.json` 的 include glob 覆盖 `src/shared/**/*.ts`，使 tsc 自动聚合所有未来的 type augmentation。

参考 ADR-0001 中关于类型分散声明和 tsconfig include 聚合的决策。

## Acceptance criteria

- [x] `src/shared/ipc/channels.ts` 存在，导出空的 `IpcChannelMap` 和 `IpcEventMap` interface
- [x] `tsconfig.json` 的 `compilerOptions.paths` 中配置了 `@ipc/channels` 指向 `src/shared/ipc/channels.ts`
- [x] `tsconfig.web.json` 的 include 数组包含 `src/shared/**/*.ts`
- [x] `tsconfig.node.json` 的 include 数组包含 `src/shared/**/*.ts`
- [x] `electron.vite.config.ts` 的 main 和 renderer 配置中均添加了 `@ipc/channels` alias
- [x] `pnpm typecheck` 通过
- [x] `pnpm build` 通过

## Blocked by

None - can start immediately
