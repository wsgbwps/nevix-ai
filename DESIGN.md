---
version: alpha
name: Jimeng AI
description: "Design system specification for the Jimeng AI all-in-one creation platform."

colors:
  primary: "#00cae0"
  primary-hover: "#0ad4ea"
  primary-pressed: "#00b8cc"
  on-primary: "#0f1419"
  dark-background: "#0f0f12"
  dark-surface: "#15161a"
  dark-surface-float: "#22252a"
  dark-surface-glass: "#202127b8"
  dark-text-primary: "#f5fbff"
  light-background: "#f8f9fa"
  light-surface: "#ffffff"
  light-text-primary: "#0f1419"
  media-panel: "#18191de5"
  media-text-primary: "#ffffff"
  media-block-default: "#00000033"
  warning: "#ffa21e"
  error: "#ff3355"

typography:
  marketing-display:
    fontFamily: "Albert Sans, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Arial, sans-serif"
    fontSize: 64px
    fontWeight: 600
    lineHeight: 64px
  marketing-section:
    fontFamily: "Albert Sans, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Arial, sans-serif"
    fontSize: 54px
    fontWeight: 500
    lineHeight: 64px
    letterSpacing: 0.03em
  marketing-feature:
    fontFamily: "Albert Sans, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Arial, sans-serif"
    fontSize: 36px
    fontWeight: 400
    lineHeight: 50px
  app-page-title:
    fontFamily: "CapCut Sans, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Arial, sans-serif"
    fontSize: 24px
    fontWeight: 600
    lineHeight: 32px
  app-heading:
    fontFamily: "CapCut Sans, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Arial, sans-serif"
    fontSize: 20px
    fontWeight: 600
    lineHeight: 28px
  app-subheading:
    fontFamily: "CapCut Sans, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Arial, sans-serif"
    fontSize: 16px
    fontWeight: 500
    lineHeight: 24px
  body:
    fontFamily: "CapCut Sans, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Arial, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 22px
  compact:
    fontFamily: "CapCut Sans, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Arial, sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 20px
  caption:
    fontFamily: "CapCut Sans, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Arial, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 18px
  micro:
    fontFamily: "CapCut Sans, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Arial, sans-serif"
    fontSize: 10px
    fontWeight: 400
    lineHeight: 14px

spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 20px
  2xl: 24px
  3xl: 32px
  4xl: 40px
  5xl: 48px
  6xl: 60px
  7xl: 80px
  8xl: 96px
  9xl: 120px

rounded:
  none: 0px
  xs: 2px
  sm: 4px
  nav: 6px
  md: 8px
  lg: 12px
  xl: 16px
  2xl: 24px
  full: 9999px

components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
    height: 40px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-primary-active:
    backgroundColor: "{colors.primary-pressed}"
  button-secondary-dark:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-text-primary}"
    rounded: "{rounded.md}"
    height: 40px
  button-compact:
    textColor: "{colors.dark-text-primary}"
    rounded: "{rounded.nav}"
    height: 28px
  page-dark:
    backgroundColor: "{colors.dark-background}"
    textColor: "{colors.dark-text-primary}"
  navigation-rail:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-text-primary}"
    width: 76px
  navigation-item:
    textColor: "{colors.dark-text-primary}"
    rounded: "{rounded.nav}"
    height: 48px
  menu-dark:
    backgroundColor: "{colors.dark-surface-float}"
    textColor: "{colors.dark-text-primary}"
  input-dark:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-text-primary}"
    rounded: "{rounded.md}"
    height: 40px
  prompt-composer:
    backgroundColor: "{colors.dark-surface-glass}"
    textColor: "{colors.dark-text-primary}"
    rounded: "{rounded.2xl}"
    width: 925px
    height: 176px
  page-light:
    backgroundColor: "{colors.light-background}"
    textColor: "{colors.light-text-primary}"
  card-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-text-primary}"
    rounded: "{rounded.lg}"
  media-panel:
    backgroundColor: "{colors.media-panel}"
    textColor: "{colors.media-text-primary}"
    rounded: "{rounded.lg}"
  media-action:
    backgroundColor: "{colors.media-block-default}"
    textColor: "{colors.media-text-primary}"
    rounded: "{rounded.md}"
  toast-warning:
    backgroundColor: "{colors.warning}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
  toast-error:
    backgroundColor: "{colors.error}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
---

## Overview

Jimeng is an immersive, dark creation environment. Its base atmosphere comes from a near-black `{colors.dark-background}` canvas, a narrow `{colors.dark-surface}` navigation rail, restrained light text, and a translucent prompt composer suspended near the center of the workspace. The interface does not manufacture an "AI look" with broad gradients or neon decoration. It gives visual priority to user intent, generated output, and the media itself.

The home and generation surfaces share one application shell but operate at different rhythms. Home is exploratory: capability entries, skills, short films, and campaigns unfold around a prompt entry point. The generation workspace is task-focused: the canvas stays deliberately open, leaving only assets, Agent mode, automatic strategy, skills, and submission controls. `{component.navigation-rail}` and `{component.prompt-composer}` are the two strongest spatial anchors across both surfaces.

Product typography uses CapCut Sans, falling back through PingFang SC, Hiragino Sans GB, and Microsoft YaHei for Chinese text. Body copy remains compact at 14px. Hierarchy comes primarily from space, surface contrast, and component scale rather than steadily increasing font weight. Independent marketing pages use larger Albert Sans typography as a separate display subsystem.

**Key Characteristics:**

- The creation workspace sits on `{colors.dark-background}`. Persistent navigation rises only to `{colors.dark-surface}`, keeping the layer contrast intentionally subtle.
- `{component.navigation-rail}` is always 76px wide, with 48px-tall primary navigation items. It is the stable spatial anchor across product surfaces.
- `{component.prompt-composer}` is the visual center: 925 × 176px, a 24px radius, a translucent dark surface, and 80px backdrop blur.
- Brand cyan `{colors.primary}` is reserved for primary actions, focus, and selection feedback. It is not a large-area background color.
- Home follows a capability entry → content tabs → examples or skills rhythm. The generation workspace intentionally reduces content density.
- Radius is hierarchical: `{rounded.nav}` for compact navigation, `{rounded.md}` for standard controls, `{rounded.lg}` / `{rounded.xl}` for cards, and `{rounded.2xl}` only for the core prompt composer.
- Submission remains disabled while the prompt is empty. Input state directly determines whether the task can proceed.

## Colors

### Brand & Accent

- **Primary** (`{colors.primary}` — #00cae0): Brand cyan for primary actions, focus, selection, and limited state emphasis. It should appear with the precision of a cursor, never as a broad background wash.
- **Primary Hover** (`{colors.primary-hover}` — #0ad4ea): Hover state for primary actions.
- **Primary Active** (`{colors.primary-pressed}` — #00b8cc): Pressed state for primary actions.
- **On Primary** (`{colors.on-primary}` — #0f1419): Dark text and icons on brand-cyan controls.

### Dark Surfaces

- **Dark Background** (`{colors.dark-background}` — #0f0f12): The application background and default generation canvas.
- **Dark Surface** (`{colors.dark-surface}` — #15161a): Navigation rail, solid inputs, and persistent structural surfaces. Its contrast against the background is intentionally slight.
- **Dark Surface Float** (`{colors.dark-surface-float}` — #22252a): Dropdowns, popovers, and temporary floating surfaces.
- **Dark Surface Glass** (`{colors.dark-surface-glass}` — #202127b8): The translucent prompt-composer surface, paired with `backdrop-filter: blur(80px)`.
- **Dark Text Primary** (`{colors.dark-text-primary}` — #f5fbff): Primary text and icons on dark surfaces.

### Light & Media Surfaces

- **Light Background** (`{colors.light-background}` — #f8f9fa): Candidate background for light content and management surfaces.
- **Light Surface** (`{colors.light-surface}` — #ffffff): Light cards and content containers.
- **Light Text Primary** (`{colors.light-text-primary}` — #0f1419): Primary text on light surfaces.
- **Media Panel** (`{colors.media-panel}` — #18191de5): Control panels over images and video.
- **Media Text Primary** (`{colors.media-text-primary}` — #ffffff): Text and icons on media surfaces.
- **Media Block Default** (`{colors.media-block-default}` — #00000033): Secondary media actions and overlays.

### Semantic

- **Warning** (`{colors.warning}` — #ffa21e): Quota, risk, and attention states that do not block the task.
- **Error** (`{colors.error}` — #ff3355): Generation failures, upload failures, and input errors.

Dark hierarchy follows **surface contrast first, shadow second**. Persistent structures do not use strong elevation, and brand color does not participate in persistent layering. Media overlays may increase opacity and contrast, but they must not overpower the underlying work.

## Typography

### Font Family

The product workspace uses **CapCut Sans**. The fallback stack is `PingFang SC, Hiragino Sans GB, Microsoft YaHei, Arial, sans-serif`. CapCut Sans carries Latin text, numbers, model names, and version labels; system CJK fonts preserve readability for longer Chinese text.

The marketing display subsystem uses **Albert Sans**. It is limited to large titles on independent marketing pages and should not enter the generation workspace, parameter panels, or asset-management surfaces.

### Hierarchy

| Token | Size | Weight | Line Height | Letter Spacing | Use |
|---|---|---|---|---|---|
| `{typography.marketing-display}` | 64px | 600 | 64px | 0 | Marketing hero title |
| `{typography.marketing-section}` | 54px | 500 | 64px | 0.03em | Marketing section title |
| `{typography.marketing-feature}` | 36px | 400 | 50px | 0 | Marketing feature title |
| `{typography.app-page-title}` | 24px | 600 | 32px | 0 | Product page title |
| `{typography.app-heading}` | 20px | 600 | 28px | 0 | Panel and major section heading |
| `{typography.app-subheading}` | 16px | 500 | 24px | 0 | Card and parameter-group title |
| `{typography.body}` | 14px | 400 | 22px | 0 | Body copy, navigation, and standard controls |
| Prompt text | 14px | 400 | 24px | 0 | Prompt input and placeholder guidance |
| `{typography.compact}` | 13px | 400 | 20px | 0 | Compact parameters and list metadata |
| `{typography.caption}` | 12px | 400 | 18px | 0 | Source, usage count, and helper text |
| `{typography.micro}` | 10px | 400 | 14px | Badges and tertiary labels |

### Principles

Jimeng uses a compact product type scale. Fourteen pixels is the shared baseline for navigation, input, and body copy. The visual center belongs to the composer, cards, and media—not oversized control labels. Primary navigation may use more weight to reinforce location, while long skill descriptions and generation parameters remain at 400.

Model names, version numbers, and product terms such as `Agent` retain official capitalization. Numbers, quotas, and participation counts do not break away from their units. Skill descriptions show only enough text to answer what the skill does, when to use it, and what it does not handle; full descriptions belong on detail surfaces.

### Note on Font Substitutes

If CapCut Sans is unavailable, use the system CJK stack rather than substituting a decorative geometric face for product copy. If Albert Sans is unavailable on marketing pages, Inter or system-ui can substitute, but the width, wrapping, and line height of 54px and 64px titles must be rechecked.

## Layout

### Spacing System

- **Base unit:** 4px.
- **Tokens:** `{spacing.xs}` 4px, `{spacing.sm}` 8px, `{spacing.md}` 12px, `{spacing.lg}` 16px, `{spacing.xl}` 20px, `{spacing.2xl}` 24px, `{spacing.3xl}` 32px, `{spacing.5xl}` 48px, `{spacing.8xl}` 96px.
- **Navigation rail padding:** 20px vertical × 10px horizontal. The 10px value is an optical correction internal to the component, not a global spacing token.
- **Prompt composer padding:** 14px top × 16px horizontal × 16px bottom. The 14px value is another component-level exception.
- **Card padding:** 12–16px for compact lists, 16–24px for content cards, and 24–32px for large media or task cards.

### Application Shell

`{component.page-dark}` fills the viewport. `{component.navigation-rail}` remains fixed on the left at 76px wide and full viewport height; the main canvas occupies the remaining space. The rail does not need a shadow. The difference between `{colors.dark-surface}` and `{colors.dark-background}` is the boundary.

Primary navigation uses `{component.navigation-item}` at 76 × 48px with `{rounded.nav}` corners. Inspiration, Generate, Assets, and Canvas retain a stable order. Experimental capabilities, membership or quota controls, and account actions remain grouped separately from the core task navigation.

### Task Canvas

The generation workspace deliberately preserves a large empty canvas. On desktop, `{component.prompt-composer}` is centered at a fixed 925px width, with an editable region of approximately 823 × 96px. Supporting actions such as Asset Library remain at the top of the canvas and do not compete with the primary input.

Home uses a richer vertical rhythm: the prompt entry point is followed by capability cards, Discover / Skills / Short Films / Campaigns tabs, and content panels. Tabs replace only their content panel; navigation and prompt entry remain spatially stable.

### Whitespace Philosophy

Dark negative space is the primary atmospheric tool in the Jimeng workspace. The generation surface should not fill an empty state with tutorials, banners, and recommendation cards merely because content is absent. The empty canvas is part of task focus. Home can carry discovery content, but each band should still center on one action rather than stacking several equal-weight recommendation modules.

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| Canvas | `{colors.dark-background}`, no border, no shadow | Generation canvas and application shell |
| Persistent surface | `{colors.dark-surface}`, layered through luminance contrast | Navigation rail, persistent inputs, and panels |
| Glass task surface | `{colors.dark-surface-glass}` + 80px backdrop blur | Core prompt composer |
| Floating surface | `{colors.dark-surface-float}`, optional hairline or short shadow | Dropdowns, context menus, and popovers |
| Media overlay | `{colors.media-panel}` / `{colors.media-block-default}` | Controls over images and video |
| Modal | Dark scrim + solid floating surface | Blocking confirmation and complex settings |

The elevation philosophy is **surface first, shadow second**. The prompt composer has no visible heavy shadow; translucency, blur, and a large 24px radius establish its priority. Persistent navigation also remains flat. Only elements that leave the document flow—menus, popovers, and modals—need shadow or scrim treatment.

### Decorative Depth

- Backdrop blur belongs to `{component.prompt-composer}` and a limited set of overlays. It does not spread to every card.
- Images and video provide most of the visual depth. Text and controls over media retreat into translucent panels.
- Generation animation may communicate process, but it cannot replace status text, progress, or completion feedback.

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `{rounded.xs}` | 2px | Dense system states and tiny labels |
| `{rounded.sm}` | 4px | Micro controls and compact parameter blocks |
| `{rounded.nav}` | 6px | Primary navigation items and compact top-bar buttons |
| `{rounded.md}` | 8px | Standard buttons, inputs, and media actions |
| `{rounded.lg}` | 12px | Content cards, menus, and media panels |
| `{rounded.xl}` | 16px | Large cards and result containers |
| `{rounded.2xl}` | 24px | Core prompt composer |
| `{rounded.full}` | 9999px / 50% | Avatars, circular icon buttons, and pills |

Radius increases with component scale and task importance. Twenty-four pixels is not a generic "AI radius." It belongs to the compound task surface that carries input, mode, skills, and submission. Standard buttons return to 8px and navigation items use 6px. Do not turn every control into a pill.

### Media Geometry

Image and video cards preserve source aspect ratios where possible and crop within containers to keep grids stable. Result previews use 12–16px corners; controls layered over media use 8px. Avatars and single icon actions may use `{rounded.full}`. Freeform media on the infinite canvas should not be forced into a uniform card ratio.

## Components

> Component specifications prioritize Default, Active/Pressed, Disabled, and Loading states. Hover follows existing tokens when available but is not treated as a component's defining identity. Variants use separate keys in frontmatter.

**`navigation-rail`** — A 76px-wide persistent dark sidebar. Background `{colors.dark-surface}`, text `{colors.dark-text-primary}`, and 20px × 10px padding. It carries Inspiration, Generate, Assets, Canvas, and supporting destinations, forming the stable spatial anchor across product surfaces.

**`navigation-item`** — A 76 × 48px primary navigation target with `{rounded.nav}` corners. Icon and label form one hit area. The current destination needs both visible selection feedback and accessible current-location semantics.

### Prompt & Generation

**`prompt-composer`** — Jimeng's core compound component. It is 925 × 176px with `{colors.dark-surface-glass}`, `{colors.dark-text-primary}`, `{rounded.2xl}`, and 80px backdrop blur. It contains an 823 × 96px editable region, asset and subject entry points, Agent mode, automatic strategy, skill selection, and submission. Long prompts scroll inside the editor while the action row stays visible.

**`prompt-editor`** — A 14px / 24px, 400-weight `contenteditable` textbox. It supports typing, paste, and `/` skill invocation. Placeholder text may introduce skills and subjects, but it cannot replace a persistent label. Uploading assets, selecting a skill, or adding a subject must not clear existing input.

**`generation-submit`** — The primary icon action for starting generation. It remains disabled while the prompt is empty or required assets are missing. During generation it preserves its dimensions and prevents duplicate submission. Failure keeps the user's prompt and selected assets intact.

**`asset-library-trigger`** — A compact supporting action in the workspace header. The observed control is 75 × 28px with a transparent background, 14px / 400 text, a 6px radius, and 8px horizontal padding. The 28px value is only its desktop visual height; the touch hit area expands to at least 44px.

### Buttons

**`button-primary`** — The brand-cyan primary action. Background `{colors.primary}`, text `{colors.on-primary}`, radius `{rounded.md}`, and 40px height. Use one primary button per task region.

- Hover state: `{component.button-primary-hover}` uses `{colors.primary-hover}`.
- Active state: `{component.button-primary-active}` uses `{colors.primary-pressed}`.

**`button-secondary-dark`** — Secondary action on dark surfaces. Background `{colors.dark-surface}`, text `{colors.dark-text-primary}`, radius `{rounded.md}`, and 40px height. Use it for cancel, back, settings, and lower-commitment actions paired with a primary control.

**`button-compact`** — Compact control for headers, filters, and list utility areas. Height 28px with `{rounded.nav}` corners. It is not a mobile primary action or a high-risk confirmation control.

**`button-icon`** — Upload, send, add, more, and media actions. Every icon-only button requires an `aria-label` and tooltip. Disabled, Loading, and Complete states cannot rely on icon color alone.

### Mode Controls

**`agent-mode-select`** — A combobox that exposes the current Agent mode. It shows the selected value, not only the "Agent Mode" field label, and supports keyboard opening, arrow-key navigation, Escape to close, and focus return.

**`auto-strategy-toggle`** — The "Auto" strategy control. When automatic and manual model or strategy selection are mutually exclusive, selection and value must be explicit. Users should not have to guess whether Auto controls the model, parameters, or workflow.

**`skill-select`** — The "Use Skill" combobox. It supports search and previously added skills. Selection remains visible in the prompt context.

### Discovery

**`feature-entry-card`** — Primary capability entry on Home, such as Infinite Canvas, Agent Mode, Image 5.0 Pro, Video Generation, and Digital Human. The title describes user output first; model and version information remain secondary. `New` and Beta badges retain visible text.

**`content-tabs`** — Discover, Skills, Short Films, and Campaigns. A tab replaces only its associated tabpanel and does not reset the prompt draft. Use the standard tabs keyboard pattern and expose `aria-selected` on the active tab.

**`skill-card`** — A skill name, scenario summary, usage count, source, and independent add action. The card opens details; "Add Skill" is a separate reversible control. The list summary covers what the skill does, when to use it, and what it does not handle, rather than exposing the complete description.

**`short-film-card`** — A short-film cover, title, creator or campaign metadata, and detail action. Media holds primary visual weight. Metadata uses `{typography.caption}` and does not compete with the cover through excessive text hierarchy.

**`search-field`** — Search input for discovery and short-film lists. An example term such as "Architecture" can be a placeholder, but the field still needs a visible label or equivalent accessible name.

### Cards, Media & Feedback

**`card-light`** — Light content card. Background `{colors.light-surface}`, text `{colors.light-text-primary}`, and radius `{rounded.lg}`. It belongs to an explicit light-content subsystem and should not be mixed casually among dark workspace controls.

**`media-panel`** — Control panel over images or video. Background `{colors.media-panel}`, text `{colors.media-text-primary}`, and radius `{rounded.lg}`. It appears only when actions are needed and does not permanently obscure the subject.

**`media-action`** — Secondary action over media. Background `{colors.media-block-default}`, white text or icon, and radius `{rounded.md}`.

**`toast-warning`** — Non-blocking alert using `{colors.warning}`. It explains quota, risk, or the next step without making a decision for the user.

**`toast-error`** — Failure feedback using `{colors.error}`. It states what happened, whether user input was preserved, and how to retry.

## Do's and Don'ts

### Do

- Treat `{component.prompt-composer}` as the generation workspace's visual center. Organize mode, skills, assets, and submission around it.
- Keep the width, grouping, and destination order of `{component.navigation-rail}` stable so users retain orientation across product surfaces.
- Use the subtle luminance difference between `{colors.dark-background}` and `{colors.dark-surface}` for persistent hierarchy.
- Reserve `{colors.primary}` for primary actions, focus, and selection. Keep one brand-cyan primary action per task region.
- Name capabilities by task and output first, then add model names, versions, and technical labels.
- Provide textual or semantic feedback for empty input, generation, failure, and completion.
- Preserve dark negative space. An open generation canvas is part of task focus, not missing content.

### Don't

- Do not add broad brand-cyan fills, neon gradients, grid glows, or decorative "AI aura" effects to the main canvas.
- Do not give every card and button a 24px radius. `{rounded.2xl}` belongs only to the core compound task surface.
- Do not combine strong outlines, heavy shadows, and backdrop blur on persistent navigation or standard cards.
- Do not let a model name replace the user task. "Seedance 2.0" must appear with an understandable outcome such as "Video Creation."
- Do not expose complete skill descriptions in dense list views.
- Do not use color as the only signal for selection, disabled state, error, generation, or new content.
- Do not reduce the actual touch target to 28px simply because a compact desktop control is visually 28px tall.

## Responsive Behavior

### Breakpoints

| Name | Width | Key Changes |
|---|---|---|
| Mobile | < 768px | Not yet extracted; do not directly preserve the 76px side rail or 925px fixed composer |
| Tablet | 768–1024px | Composer becomes fluid; Home card grids reduce columns; navigation collapse pattern remains unverified |
| Desktop | 1024–1440px | 76px side rail, full primary tabs, prompt composer capped at 925px |
| Wide | > 1440px | Preserve component max widths and add outer breathing room rather than scaling the composer and type indefinitely |

### Touch Targets

- `{component.button-primary}` and `{component.button-secondary-dark}` provide at least a 44 × 44px hit area.
- `{component.button-compact}` may retain a 28px visual height but uses transparent padding or an outer target to reach touch size.
- Navigation items are 48px tall and already meet common touch-target guidance.
- Icon-only controls use at least a 40px visual container and a 44px actual hit area.

### Collapsing Strategy

- Card grids reduce columns before reducing type or target size.
- `{component.prompt-composer}` becomes `calc(100% - 2 × gutter)` when fixed width can no longer preserve safe outer margins.
- Mode, skill, and submission controls may wrap on narrow screens, but prompt input remains first in visual order.
- The official mobile navigation pattern has not been verified. Do not prescribe either a hamburger menu or bottom navigation until it is observed.

### Media Behavior

- Images and video crop within cards to preserve grid rhythm; detail and canvas views prioritize showing the full asset.
- Media control panels consolidate secondary actions on narrow screens and avoid covering the subject.
- Scaling freeform assets on Infinite Canvas does not reduce text and control hit areas.

## Iteration Guide

1. Adjust one component at a time and reference its token directly, such as `{component.prompt-composer}` or `{component.navigation-rail}`.
2. Before adding a component, decide which surface it belongs to: the dark creation workspace, the light content-management subsystem, or the independent marketing display subsystem.
3. Variants of existing components (`-active`, `-disabled`, `-loading`, `-focus`) use separate component keys, never nested state objects.
4. Use `{token.refs}` whenever prose mentions a color, type role, radius, or spacing value. Hex values appear only with the first definition in Colors.
5. Establish emphasis with space, surface, and component scale before increasing font weight or adding brand color.
6. Run `npx @google/design.md lint DESIGN.md` after edits and resolve broken-ref, contrast, and orphaned-token warnings.
7. Verify a precise value in at least one real page state before promoting it to a global token. Do not infer global tokens from a single screenshot.

## Known Gaps

- Mobile and 768–1024px tablet layouts have not been measured. The navigation collapse pattern remains unknown.
- Default, Hover, and Active values for `{colors.primary}` still need to be re-read from an interactive primary button.
- Marketing display typography comes from earlier extraction and was not rechecked against an independent marketing page in this pass.
- Light content surfaces, media detail, Asset Library, and Infinite Canvas have only confirmed entry points; complete layouts and component states remain unextracted.
- Dropdown, popover, modal, drawer, toast, upload, generation, success, and failure states have not been inspected individually.
- Keyboard order, focus-visible treatment, screen-reader announcements, dynamic-content live regions, and reduced-motion behavior remain untested.
- Image and video ratios, icon dimensions and stroke weight, skeleton screens, and motion timing are not yet formalized as tokens.
