---
kind: frontend_style
name: Tailwind + shadcn/ui 样式体系与 CSS 变量主题
category: frontend_style
scope:
    - '**'
source_files:
    - apps/desktop/src/renderer/src/app/globals.css
    - apps/desktop/components.json
    - apps/desktop/src/renderer/src/components/ui/button.tsx
    - apps/desktop/src/renderer/src/lib/utils.ts
    - apps/desktop/electron.vite.config.ts
    - apps/desktop/package.json
---

该 Electron 桌面应用采用 Tailwind CSS v4 + shadcn/ui（Radix Luma 风格）作为前端样式体系，通过 CSS 变量驱动明暗主题，结合 class-variance-authority 实现组件变体系统。

**系统与工具链**
- 样式框架：Tailwind CSS v4（`@tailwindcss/vite` 插件），在 `electron.vite.config.ts` 和 `vite.config.ts` 中启用
- UI 组件库：shadcn/ui，配置位于 `components.json`，使用 `radix-luma` 风格、`mauve` 基础色、CSS 变量模式、Lucide 图标库
- 构建集成：Vite + React，通过 `@import 'tailwindcss'` 在 `globals.css` 中引入
- 类名合并：`clsx` + `tailwind-merge` 封装为 `@/lib/utils` 的 `cn()` 函数
- 动画：`tw-animate-css` 提供原子化动画
- 字体：`@fontsource-variable/dm-sans` 作为全局无衬线字体
- 格式化：Prettier + `prettier-plugin-tailwindcss` 自动排序 Tailwind 类名

**设计令牌与主题**
- 所有颜色、圆角、字体均通过 CSS 自定义属性定义在 `:root` 和 `.dark` 选择器中
- 使用 oklch 色彩空间保证感知均匀性，主色调围绕 180°-186° 青绿色域
- 语义化变量：`--background`、`--foreground`、`--primary`、`--destructive`、`--sidebar-*`、`--chart-*` 等
- 圆角层级：`--radius-sm/md/lg/xl/2xl/3xl/4xl` 基于 `--radius` 计算派生
- 通过 `@theme inline` 将 CSS 变量映射到 Tailwind 设计令牌

**组件样式约定**
- 基础组件位于 `src/renderer/src/components/ui/`，当前仅有 `button.tsx`
- 使用 `class-variance-authority` 声明 `variants`（variant/size）和 `defaultVariants`
- 通过 `data-slot`、`data-variant`、`data-size` 属性暴露组件状态供测试与调试
- 所有组件样式通过 `cn(buttonVariants({ variant, size, className }))` 组合
- 支持 `asChild` 透传 Radix UI Slot，保持无障碍属性

**架构与组织**
- 全局样式入口：`src/renderer/src/app/globals.css`，按顺序导入 Tailwind → 动画 → shadcn → 字体
- 组件分层：`components/ui`（基础原子组件）、`features/*`（业务功能组件）、`app/`（应用级布局与 Provider）
- 路径别名：`@/components`、`@/lib`、`@/hooks`、`@/components/ui` 等在 `components.json` 中统一声明
- 响应式策略：依赖 Tailwind 默认断点，未定义自定义断点或媒体查询覆盖

**约束与规范**
- 所有新组件必须放在 `components/ui/` 下并通过 shadcn CLI 生成
- 类名冲突统一通过 `cn()` 处理，禁止直接使用 `className` 拼接
- 主题切换通过 HTML 根元素添加/移除 `.dark` 类实现
- 颜色值必须使用 oklch 格式，禁止硬编码 hex/rgb
- Prettier 强制 Tailwind 类名排序，提交前由 Husky pre-commit 钩子执行