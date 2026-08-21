// PROTOTYPE — three Creation Workbench information architectures, switchable via ?variant=,
// mounted on the existing authenticated root route. Throw this code away after ticket #92.

import { useEffect, useState } from 'react'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  Clock3Icon,
  FileImageIcon,
  FolderOpenIcon,
  ImageIcon,
  InfoIcon,
  LayoutDashboardIcon,
  ListRestartIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  MoreHorizontalIcon,
  PencilLineIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  VideoIcon,
  XIcon
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type VariantKey = 'A' | 'B' | 'C'
type ScenarioKey = 'queued' | 'processing' | 'partial' | 'failed' | 'success'
type MediaMode = 'image' | 'video'
type VideoComposer = 'frames' | 'references'

type Scenario = {
  key: ScenarioKey
  label: string
  shortLabel: string
  detail: string
  progress: number
  completed: number
  total: number
  tone: 'neutral' | 'primary' | 'warning' | 'danger' | 'success'
}

const SCENARIOS: readonly Scenario[] = [
  {
    key: 'queued',
    label: '排队中',
    shortLabel: '排队',
    detail: '前方还有 2 个任务 · 可取消',
    progress: 8,
    completed: 0,
    total: 4,
    tone: 'neutral'
  },
  {
    key: 'processing',
    label: '生成中',
    shortLabel: '生成中',
    detail: '已完成 1/4 · 预计还需约 45 秒',
    progress: 46,
    completed: 1,
    total: 4,
    tone: 'primary'
  },
  {
    key: 'partial',
    label: '部分成功',
    shortLabel: '部分成功',
    detail: '2 个结果已保存 · 2 个未完成',
    progress: 100,
    completed: 2,
    total: 4,
    tone: 'warning'
  },
  {
    key: 'failed',
    label: '失败',
    shortLabel: '失败',
    detail: '连接暂不可用 · 请联系管理员',
    progress: 100,
    completed: 0,
    total: 4,
    tone: 'danger'
  },
  {
    key: 'success',
    label: '成功',
    shortLabel: '成功',
    detail: '4 个结果均已保存到资产库',
    progress: 100,
    completed: 4,
    total: 4,
    tone: 'success'
  }
]

const SESSION_ITEMS = [
  { id: 'shoe', title: '夏季跑鞋主图', meta: '图片 · 刚刚', scenario: 'partial' as const },
  {
    id: 'video',
    title: '户外冲锋衣短片',
    meta: '视频 · 4 分钟前',
    scenario: 'processing' as const
  },
  { id: 'bottle', title: '保温杯场景变体', meta: '图片 · 12 分钟前', scenario: 'queued' as const },
  { id: 'bag', title: '通勤包广告素材', meta: '图片 · 昨天', scenario: 'failed' as const },
  { id: 'lamp', title: '露营灯氛围图', meta: '图片 · 周二', scenario: 'success' as const }
] as const

const VARIANT_NAMES: Record<VariantKey, string> = {
  A: '任务舞台',
  B: '会话时间线',
  C: '规格指挥台'
}

const RESULT_GRADIENTS = [
  'from-cyan-950 via-slate-800 to-amber-900',
  'from-sky-950 via-zinc-800 to-rose-950',
  'from-indigo-950 via-slate-800 to-emerald-950',
  'from-neutral-900 via-cyan-950 to-orange-950'
] as const

function readVariant(): VariantKey {
  const candidate = new URLSearchParams(window.location.search).get('variant')?.toUpperCase()
  return candidate === 'B' || candidate === 'C' ? candidate : 'A'
}

function scenarioByKey(key: ScenarioKey): Scenario {
  return SCENARIOS.find((scenario) => scenario.key === key) ?? SCENARIOS[0]
}

function StatusBadge({
  scenario,
  compact = false
}: {
  scenario: Scenario
  compact?: boolean
}): React.JSX.Element {
  const icon =
    scenario.key === 'processing' ? (
      <LoaderCircleIcon className="animate-spin" />
    ) : scenario.key === 'success' ? (
      <CircleCheckIcon />
    ) : scenario.key === 'failed' ? (
      <CircleAlertIcon />
    ) : scenario.key === 'partial' ? (
      <InfoIcon />
    ) : (
      <Clock3Icon />
    )

  return (
    <Badge
      variant="outline"
      className={cn(
        'border-transparent',
        scenario.tone === 'primary' && 'bg-primary/12 text-primary',
        scenario.tone === 'warning' && 'bg-warning/12 text-warning',
        scenario.tone === 'danger' && 'bg-destructive/12 text-destructive',
        scenario.tone === 'success' && 'bg-emerald-400/12 text-emerald-300',
        scenario.tone === 'neutral' && 'bg-muted text-muted-foreground'
      )}
    >
      {icon}
      {compact ? scenario.shortLabel : scenario.label}
    </Badge>
  )
}

function TaskProgress({ scenario }: { scenario: Scenario }): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{scenario.detail}</span>
        <span className="shrink-0 font-medium tabular-nums">
          {scenario.completed}/{scenario.total}
        </span>
      </div>
      <div className="bg-muted h-1.5 overflow-hidden rounded-full">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-300',
            scenario.tone === 'danger'
              ? 'bg-destructive'
              : scenario.tone === 'warning'
                ? 'bg-warning'
                : scenario.tone === 'success'
                  ? 'bg-emerald-400'
                  : 'bg-primary'
          )}
          style={{ width: `${scenario.progress}%` }}
        />
      </div>
    </div>
  )
}

function ModePicker({
  mediaMode,
  videoComposer,
  onMediaModeChange,
  onVideoComposerChange
}: {
  mediaMode: MediaMode
  videoComposer: VideoComposer
  onMediaModeChange: (mode: MediaMode) => void
  onVideoComposerChange: (composer: VideoComposer) => void
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="bg-muted/60 grid grid-cols-2 rounded-lg p-1">
        <button
          className={cn(
            'flex h-8 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors',
            mediaMode === 'image' ? 'bg-card shadow-sm' : 'text-muted-foreground'
          )}
          onClick={() => onMediaModeChange('image')}
        >
          <ImageIcon className="size-3.5" /> 图片
        </button>
        <button
          className={cn(
            'flex h-8 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors',
            mediaMode === 'video' ? 'bg-card shadow-sm' : 'text-muted-foreground'
          )}
          onClick={() => onMediaModeChange('video')}
        >
          <VideoIcon className="size-3.5" /> 视频
        </button>
      </div>
      {mediaMode === 'video' ? (
        <div className="flex gap-1">
          <button
            className={cn(
              'rounded-md border px-2 py-1 text-[11px]',
              videoComposer === 'frames'
                ? 'border-primary/50 bg-primary/10 text-primary'
                : 'text-muted-foreground'
            )}
            onClick={() => onVideoComposerChange('frames')}
          >
            首尾帧
          </button>
          <button
            className={cn(
              'rounded-md border px-2 py-1 text-[11px]',
              videoComposer === 'references'
                ? 'border-primary/50 bg-primary/10 text-primary'
                : 'text-muted-foreground'
            )}
            onClick={() => onVideoComposerChange('references')}
          >
            全能参考
          </button>
        </div>
      ) : null}
    </div>
  )
}

function ReferenceMaterials({
  mediaMode,
  videoComposer,
  referenceCount,
  onAdd,
  onRemove
}: {
  mediaMode: MediaMode
  videoComposer: VideoComposer
  referenceCount: number
  onAdd: () => void
  onRemove: () => void
}): React.JSX.Element {
  const frameMode = mediaMode === 'video' && videoComposer === 'frames'
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">参考素材</span>
        <span className="text-muted-foreground text-[10px]">
          {frameMode ? '首帧 / 尾帧' : `${referenceCount} 项 · 有序引用`}
        </span>
      </div>
      <div className="flex gap-2">
        {Array.from({ length: frameMode ? 2 : referenceCount }).map((_, index) => (
          <div
            key={index}
            className="group relative grid size-14 shrink-0 place-items-center overflow-hidden rounded-lg border bg-gradient-to-br from-cyan-950 to-stone-800"
          >
            {frameMode && index === 1 && referenceCount < 2 ? (
              <PlusIcon className="text-muted-foreground size-4" />
            ) : (
              <FileImageIcon className="size-4 text-white/80" />
            )}
            <span className="absolute bottom-0.5 left-1 text-[8px] text-white/65">
              {frameMode ? (index === 0 ? '首帧' : '尾帧') : `@图片${index + 1}`}
            </span>
            {!frameMode && index === referenceCount - 1 ? (
              <button
                className="bg-background/80 absolute top-0.5 right-0.5 hidden size-4 place-items-center rounded-full group-hover:grid"
                aria-label="移除最后一项参考素材"
                onClick={onRemove}
              >
                <XIcon className="size-2.5" />
              </button>
            ) : null}
          </div>
        ))}
        {!frameMode && referenceCount < 4 ? (
          <button
            className="text-muted-foreground hover:border-primary/50 hover:text-foreground grid size-14 shrink-0 place-items-center rounded-lg border border-dashed transition-colors"
            aria-label="添加参考素材"
            onClick={onAdd}
          >
            <PlusIcon className="size-4" />
          </button>
        ) : null}
      </div>
    </div>
  )
}

function ParameterControls({
  mediaMode,
  ratio,
  resolution,
  quantity,
  onRatioChange,
  onResolutionChange,
  onQuantityChange
}: {
  mediaMode: MediaMode
  ratio: string
  resolution: string
  quantity: number
  onRatioChange: (value: string) => void
  onResolutionChange: (value: string) => void
  onQuantityChange: (value: number) => void
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-2">
      <label className="space-y-1">
        <span className="text-muted-foreground block text-[10px]">比例</span>
        <select
          aria-label="比例"
          className="bg-input h-8 w-full rounded-md border px-2 text-xs"
          value={ratio}
          onChange={(event) => onRatioChange(event.target.value)}
        >
          <option>1:1</option>
          <option>4:5</option>
          <option>16:9</option>
          <option>9:16</option>
        </select>
      </label>
      <label className="space-y-1">
        <span className="text-muted-foreground block text-[10px]">
          {mediaMode === 'image' ? '分辨率' : '清晰度'}
        </span>
        <select
          aria-label="分辨率"
          className="bg-input h-8 w-full rounded-md border px-2 text-xs"
          value={resolution}
          onChange={(event) => onResolutionChange(event.target.value)}
        >
          {mediaMode === 'image' ? (
            <>
              <option>1K</option>
              <option>2K</option>
              <option>4K</option>
            </>
          ) : (
            <>
              <option>480p</option>
              <option>720p</option>
              <option>1080p</option>
            </>
          )}
        </select>
      </label>
      <label className="space-y-1">
        <span className="text-muted-foreground block text-[10px]">数量</span>
        <select
          aria-label="生成数量"
          className="bg-input h-8 w-full rounded-md border px-2 text-xs"
          value={quantity}
          onChange={(event) => onQuantityChange(Number(event.target.value))}
        >
          {[1, 2, 3, 4].map((value) => (
            <option key={value} value={value}>
              {value} 个
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

function RightsConfirmation({
  confirmed,
  onChange
}: {
  confirmed: boolean
  onChange: (confirmed: boolean) => void
}): React.JSX.Element {
  return (
    <label className="text-muted-foreground flex items-start gap-2 text-[10px] leading-4">
      <input
        className="accent-primary mt-0.5 size-3.5"
        type="checkbox"
        checked={confirmed}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>我确认拥有上传、商业生成及 Organization 内使用这些素材所需的权利</span>
    </label>
  )
}

function PromptBox({
  prompt,
  compact = false,
  onPromptChange
}: {
  prompt: string
  compact?: boolean
  onPromptChange: (prompt: string) => void
}): React.JSX.Element {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium">创作描述</span>
      <textarea
        aria-label="创作描述"
        className={cn(
          'bg-input/60 placeholder:text-muted-foreground focus:border-primary/50 w-full resize-none rounded-xl border p-3 text-xs leading-5 outline-none',
          compact ? 'h-20' : 'h-28'
        )}
        value={prompt}
        onChange={(event) => onPromptChange(event.target.value)}
      />
      <div className="text-muted-foreground flex justify-between text-[10px]">
        <span>可在描述中使用 @图片1、@图片2</span>
        <span>{prompt.length}/2000</span>
      </div>
    </label>
  )
}

function ResultCard({
  index,
  state,
  flat = false
}: {
  index: number
  state: 'success' | 'processing' | 'failed' | 'queued'
  flat?: boolean
}): React.JSX.Element {
  return (
    <article
      className={cn(
        'bg-card group relative min-h-24 overflow-hidden',
        flat ? 'aspect-[3/4] border-0' : 'aspect-square rounded-xl border'
      )}
    >
      <div className={cn('absolute inset-0 bg-gradient-to-br', RESULT_GRADIENTS[index % 4])} />
      <div className="absolute inset-0 grid place-items-center">
        {state === 'success' ? (
          <div className="relative grid size-20 place-items-center rounded-[40%_55%_45%_60%] bg-white/80 shadow-2xl shadow-cyan-300/20">
            <SparklesIcon className="size-7 text-slate-800" />
            <span className="absolute -bottom-6 text-[9px] tracking-[0.2em] text-white/70">
              NEVIX SAMPLE
            </span>
          </div>
        ) : state === 'processing' ? (
          <div className="flex flex-col items-center gap-2 text-white/80">
            <LoaderCircleIcon className="size-6 animate-spin" />
            <span className="text-[10px]">正在生成</span>
          </div>
        ) : state === 'failed' ? (
          <div className="mx-4 rounded-lg border border-red-300/20 bg-black/40 px-3 py-2 text-center text-white/75 backdrop-blur">
            <CircleAlertIcon className="mx-auto mb-1 size-5 text-red-300" />
            <span className="text-[10px]">未生成结果</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 text-white/50">
            <Clock3Icon className="size-5" />
            <span className="text-[10px]">等待中</span>
          </div>
        )}
      </div>
      {!flat ? (
        <div className="absolute top-2 left-2 rounded-md bg-black/45 px-1.5 py-0.5 text-[9px] text-white/80 backdrop-blur">
          #{index + 1}
        </div>
      ) : null}
      {state === 'success' && !flat ? (
        <div className="absolute inset-x-2 bottom-2 flex translate-y-8 justify-end gap-1 opacity-0 transition-all group-hover:translate-y-0 group-hover:opacity-100">
          <Button size="icon-xs" variant="secondary" aria-label={`放大结果 ${index + 1}`}>
            <Maximize2Icon />
          </Button>
          <Button size="icon-xs" variant="secondary" aria-label={`打开结果 ${index + 1} 的资产`}>
            <FolderOpenIcon />
          </Button>
        </div>
      ) : null}
    </article>
  )
}

function ResultGrid({
  scenario,
  dense = false
}: {
  scenario: Scenario
  dense?: boolean
}): React.JSX.Element {
  const states = Array.from(
    { length: 4 },
    (_, index): 'success' | 'processing' | 'failed' | 'queued' => {
      if (index < scenario.completed) return 'success'
      if (scenario.key === 'processing' && index === scenario.completed) return 'processing'
      if (scenario.key === 'failed' || scenario.key === 'partial') return 'failed'
      return 'queued'
    }
  )

  return (
    <div className={cn('grid min-h-0 grid-cols-2 gap-2', dense && 'gap-1.5')}>
      {states.map((state, index) => (
        <ResultCard key={`${scenario.key}-${index}`} index={index} state={state} />
      ))}
    </div>
  )
}

function ResultActions({
  scenario,
  onEdit,
  onRegenerate,
  onRetry,
  onOpenAssets
}: {
  scenario: Scenario
  onEdit: () => void
  onRegenerate: () => void
  onRetry: () => void
  onOpenAssets: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5">
      <Button size="sm" variant="outline" onClick={onEdit}>
        <PencilLineIcon /> 重新编辑
      </Button>
      <Button size="sm" variant="outline" onClick={onRegenerate}>
        <RefreshCwIcon /> 再次生成
      </Button>
      {scenario.key === 'partial' ? (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <ListRestartIcon /> 重试未完成项
        </Button>
      ) : null}
      {scenario.completed > 0 ? (
        <Button size="sm" variant="ghost" onClick={onOpenAssets}>
          <FolderOpenIcon /> 查看资产
        </Button>
      ) : null}
    </div>
  )
}

type VariantProps = {
  includeProductRail: boolean
  activeSessionId: string
  mediaMode: MediaMode
  videoComposer: VideoComposer
  prompt: string
  referenceCount: number
  ratio: string
  resolution: string
  quantity: number
  rightsConfirmed: boolean
  scenario: Scenario
  onNewSession: () => void
  onSelectSession: (id: string, scenario: ScenarioKey) => void
  onMediaModeChange: (mode: MediaMode) => void
  onVideoComposerChange: (composer: VideoComposer) => void
  onPromptChange: (prompt: string) => void
  onAddReference: () => void
  onRemoveReference: () => void
  onRatioChange: (value: string) => void
  onResolutionChange: (value: string) => void
  onQuantityChange: (value: number) => void
  onRightsConfirmedChange: (confirmed: boolean) => void
  onSubmit: () => void
  onEdit: () => void
  onRegenerate: () => void
  onRetry: () => void
  onOpenAssets: () => void
  onToggleState: () => void
}

function VariantA(props: VariantProps): React.JSX.Element {
  const isEmptySession = props.activeSessionId === 'new'
  const templateCards = [
    {
      title: '商品场景合成',
      detail: '将商品自然放入真实使用场景',
      prompt: '将商品放入干净明亮的生活方式场景，突出真实材质与核心卖点。',
      gradient: 'from-amber-950 via-stone-900 to-sky-950'
    },
    {
      title: '系列主图变体',
      detail: '统一风格，快速探索多种构图',
      prompt: '围绕同一商品生成一组视觉统一、构图不同的跨境电商主图。',
      gradient: 'from-sky-950 via-zinc-900 to-violet-950'
    },
    {
      title: '短视频广告创意',
      detail: '用清晰节奏展示商品使用价值',
      prompt: '为商品制作一支节奏明快的短视频广告，包含开场钩子、卖点展示和结尾定格。',
      gradient: 'from-rose-950 via-stone-900 to-amber-950'
    }
  ] as const

  return (
    <section className="flex min-h-0 flex-1 overflow-hidden bg-[#0d0e11] text-zinc-100">
      {props.includeProductRail ? (
        <nav className="flex w-[60px] shrink-0 flex-col items-center border-r border-white/[0.06] bg-[#101115] py-3">
          <div className="mb-7 grid size-8 place-items-center rounded-xl bg-cyan-300 text-sm font-black text-zinc-950 shadow-lg shadow-cyan-400/10">
            N
          </div>
          <div className="flex flex-1 flex-col gap-4">
            {[
              { label: '灵感', icon: <ImageIcon /> },
              { label: '生成', icon: <SparklesIcon />, active: true },
              { label: '资产', icon: <FolderOpenIcon /> }
            ].map((item) => (
              <button
                key={item.label}
                className={cn(
                  'flex w-11 flex-col items-center gap-1 rounded-lg py-2 text-[9px] transition-colors [&_svg]:size-4',
                  item.active ? 'bg-white/[0.07] text-white' : 'text-zinc-500 hover:text-zinc-200'
                )}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
          <button className="grid size-8 place-items-center rounded-full bg-gradient-to-br from-cyan-800 to-violet-900 text-[10px] text-white">
            E
          </button>
        </nav>
      ) : null}

      <aside className="flex w-[210px] shrink-0 flex-col border-r border-white/[0.06] bg-[#15161a]">
        <div className="flex h-14 items-center justify-between px-4">
          <span className="text-sm font-semibold">开启创作</span>
          <Button
            size="icon-xs"
            variant="ghost"
            className="text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200"
            aria-label="收起会话列表"
          >
            <SlidersHorizontalIcon />
          </Button>
        </div>
        <div className="px-2">
          <button
            className="flex h-9 w-full items-center gap-2 rounded-lg bg-white/[0.065] px-3 text-left text-xs font-medium text-zinc-200 hover:bg-white/[0.09]"
            onClick={props.onNewSession}
          >
            <PencilLineIcon className="size-3.5" />
            新对话
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pt-3">
          <button
            className={cn(
              'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
              isEmptySession ? 'bg-[#24262d]' : 'hover:bg-white/[0.04]'
            )}
            onClick={() => props.onSelectSession('new', 'queued')}
          >
            <div className="grid size-8 shrink-0 place-items-center rounded-md bg-gradient-to-br from-cyan-950 to-slate-800">
              <SparklesIcon className="size-3.5 text-cyan-200" />
            </div>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">默认创作</span>
              <span className="block truncate text-[9px] text-zinc-500">空白会话 · 仅自己可见</span>
            </span>
          </button>
          {SESSION_ITEMS.slice(0, 4).map((session) => (
            <button
              key={session.id}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                props.activeSessionId === session.id ? 'bg-[#24262d]' : 'hover:bg-white/[0.04]'
              )}
              onClick={() => props.onSelectSession(session.id, session.scenario)}
            >
              <div
                className={cn(
                  'relative grid size-8 shrink-0 place-items-center rounded-md bg-gradient-to-br',
                  RESULT_GRADIENTS[SESSION_ITEMS.indexOf(session) % RESULT_GRADIENTS.length]
                )}
              >
                {session.scenario === 'processing' ? (
                  <LoaderCircleIcon className="size-3.5 animate-spin text-cyan-200" />
                ) : (
                  <FileImageIcon className="size-3.5 text-white/75" />
                )}
                <span
                  className={cn(
                    'absolute -right-0.5 -bottom-0.5 size-2 rounded-full border border-[#15161a]',
                    session.scenario === 'processing' && 'bg-cyan-400',
                    session.scenario === 'partial' && 'bg-amber-400',
                    session.scenario === 'queued' && 'bg-zinc-500',
                    session.scenario === 'failed' && 'bg-red-400'
                  )}
                />
              </div>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{session.title}</span>
                <span className="block truncate text-[9px] text-zinc-500">{session.meta}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="border-t border-white/[0.05] px-3 py-3 text-[9px] text-zinc-600">
          Creation Session 由创建者私有
        </div>
      </aside>

      <main className="relative min-w-0 flex-1 overflow-hidden bg-[#0d0e11]">
        <div className="absolute top-3 right-3 z-20 flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="border-white/[0.08] bg-[#18191e] text-zinc-300 hover:bg-[#22242b] hover:text-white"
            onClick={props.onOpenAssets}
          >
            <FolderOpenIcon /> 资产库
          </Button>
          <Button
            size="icon-sm"
            variant="outline"
            className="border-white/[0.08] bg-[#18191e] text-zinc-400 hover:bg-[#22242b] hover:text-white"
            aria-label="查看原型完整状态"
            onClick={props.onToggleState}
          >
            <InfoIcon />
          </Button>
        </div>

        <div className="h-full overflow-y-auto px-6 pb-[190px]">
          {isEmptySession ? (
            <div className="mx-auto flex min-h-full max-w-[720px] flex-col items-center justify-center pb-10">
              <div className="mb-6 text-center">
                <div className="mx-auto mb-3 grid size-10 place-items-center rounded-2xl bg-white/[0.05] text-cyan-200">
                  <SparklesIcon className="size-5" />
                </div>
                <h1 className="text-xl font-semibold tracking-tight">你好，想创作什么？</h1>
                <p className="mt-2 text-xs text-zinc-500">从描述开始，或选一个电商创作起点</p>
              </div>
              <div className="grid w-full grid-cols-3 gap-2.5">
                {templateCards.map((card, index) => (
                  <button
                    key={card.title}
                    className="group overflow-hidden rounded-xl border border-white/[0.07] bg-[#15161a] text-left transition-colors hover:border-white/[0.15] hover:bg-[#191a1f]"
                    onClick={() => props.onPromptChange(card.prompt)}
                  >
                    <div
                      className={cn(
                        'relative aspect-[1.65] overflow-hidden bg-gradient-to-br',
                        card.gradient
                      )}
                    >
                      <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_30%,rgba(255,255,255,0.18),transparent_32%)]" />
                      <div className="absolute right-4 bottom-3 grid size-11 place-items-center rounded-[45%] bg-white/80 shadow-2xl transition-transform group-hover:scale-105">
                        {index === 2 ? (
                          <VideoIcon className="size-5 text-zinc-800" />
                        ) : (
                          <ImageIcon className="size-5 text-zinc-800" />
                        )}
                      </div>
                      <span className="absolute bottom-2 left-2 rounded-md bg-black/35 px-1.5 py-0.5 text-[9px] text-white/80 backdrop-blur">
                        Official Template
                      </span>
                    </div>
                    <div className="p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[11px] font-medium text-zinc-200">{card.title}</p>
                        <span className="rounded-md border border-white/[0.08] px-1.5 py-0.5 text-[9px] text-zinc-500">
                          试一试
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[9px] leading-4 text-zinc-600">
                        {card.detail}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-[820px] pt-16">
              <div className="mb-3 flex items-start justify-between gap-4">
                <div>
                  <h1 className="text-base font-semibold">
                    {SESSION_ITEMS.find((session) => session.id === props.activeSessionId)?.title ??
                      '夏季跑鞋主图'}
                  </h1>
                  <p className="mt-1 text-[10px] text-zinc-600">图片 · Generation Task #3</p>
                </div>
                <StatusBadge scenario={props.scenario} />
              </div>
              <p className="mb-3 text-xs leading-5 text-zinc-400">{props.prompt}</p>
              <div className="mb-3 overflow-hidden rounded-[3px] border border-white/[0.06] bg-black">
                <div className="grid grid-cols-4 gap-px">
                  {Array.from({ length: props.scenario.total }, (_, index) => {
                    const state =
                      index < props.scenario.completed
                        ? 'success'
                        : props.scenario.key === 'processing' && index === props.scenario.completed
                          ? 'processing'
                          : props.scenario.key === 'partial' || props.scenario.key === 'failed'
                            ? 'failed'
                            : 'queued'
                    return <ResultCard key={index} index={index} state={state} flat />
                  })}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="outline" onClick={props.onEdit}>
                  <PencilLineIcon /> 重新编辑
                </Button>
                <Button size="sm" variant="outline" onClick={props.onRegenerate}>
                  <RefreshCwIcon /> 再次生成
                </Button>
                {props.scenario.key === 'partial' ? (
                  <Button size="sm" variant="outline" onClick={props.onRetry}>
                    <ListRestartIcon /> 重试未完成项
                  </Button>
                ) : null}
                <Button size="icon-sm" variant="outline" aria-label="更多任务操作">
                  <MoreHorizontalIcon />
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="absolute right-6 bottom-5 left-6 z-20 mx-auto max-w-[760px]">
          <div className="rounded-[22px] border border-white/[0.08] bg-[#1a1b20] p-3 shadow-2xl shadow-black/40">
            {props.referenceCount > 0 ? (
              <div className="mb-2 flex gap-1.5">
                {Array.from({ length: props.referenceCount }, (_, index) => (
                  <div
                    key={index}
                    className="relative grid size-10 place-items-center rounded-lg border border-white/[0.07] bg-gradient-to-br from-cyan-950 to-stone-800"
                  >
                    <FileImageIcon className="size-3.5 text-white/70" />
                    <span className="absolute bottom-0.5 left-1 text-[7px] text-white/45">
                      @图片{index + 1}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="flex items-start gap-2">
              <button
                className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#24262d] text-zinc-500 hover:text-zinc-200"
                aria-label="添加参考素材"
                onClick={props.onAddReference}
              >
                <PlusIcon className="size-4" />
              </button>
              <textarea
                aria-label="创作描述"
                className="min-h-14 flex-1 resize-none bg-transparent px-1 py-1 text-xs leading-5 text-zinc-200 outline-none placeholder:text-zinc-600"
                placeholder="输入想法、上传参考素材，或选择 Official Template 开始创作"
                value={props.prompt}
                onChange={(event) => props.onPromptChange(event.target.value)}
              />
              <Button
                size="icon-lg"
                className="self-end rounded-full bg-zinc-600 text-zinc-200 hover:bg-cyan-300 hover:text-zinc-950"
                aria-label="提交生成任务"
                onClick={props.onSubmit}
              >
                <SendIcon />
              </Button>
            </div>
            <div className="mt-2 flex min-w-0 items-center gap-1.5 border-t border-white/[0.05] pt-2">
              <button
                className={cn(
                  'flex h-7 items-center gap-1 rounded-lg px-2 text-[10px]',
                  props.mediaMode === 'image'
                    ? 'bg-cyan-400/10 text-cyan-200'
                    : 'text-zinc-500 hover:bg-white/[0.05]'
                )}
                onClick={() => props.onMediaModeChange('image')}
              >
                <ImageIcon className="size-3" /> 图片
              </button>
              <button
                className={cn(
                  'flex h-7 items-center gap-1 rounded-lg px-2 text-[10px]',
                  props.mediaMode === 'video'
                    ? 'bg-cyan-400/10 text-cyan-200'
                    : 'text-zinc-500 hover:bg-white/[0.05]'
                )}
                onClick={() => props.onMediaModeChange('video')}
              >
                <VideoIcon className="size-3" /> 视频
              </button>
              {props.mediaMode === 'video' ? (
                <select
                  aria-label="视频 composer"
                  className="h-7 rounded-lg border border-white/[0.06] bg-[#202126] px-2 text-[10px] text-zinc-400"
                  value={props.videoComposer}
                  onChange={(event) =>
                    props.onVideoComposerChange(event.target.value as VideoComposer)
                  }
                >
                  <option value="frames">首尾帧</option>
                  <option value="references">全能参考</option>
                </select>
              ) : null}
              <select
                aria-label="比例"
                className="h-7 rounded-lg border border-white/[0.06] bg-[#202126] px-2 text-[10px] text-zinc-400"
                value={props.ratio}
                onChange={(event) => props.onRatioChange(event.target.value)}
              >
                <option>1:1</option>
                <option>4:5</option>
                <option>16:9</option>
                <option>9:16</option>
              </select>
              <select
                aria-label="分辨率"
                className="h-7 rounded-lg border border-white/[0.06] bg-[#202126] px-2 text-[10px] text-zinc-400"
                value={props.resolution}
                onChange={(event) => props.onResolutionChange(event.target.value)}
              >
                {props.mediaMode === 'image' ? (
                  <>
                    <option>1K</option>
                    <option>2K</option>
                    <option>4K</option>
                  </>
                ) : (
                  <>
                    <option>480p</option>
                    <option>720p</option>
                    <option>1080p</option>
                  </>
                )}
              </select>
              <select
                aria-label="生成数量"
                className="h-7 rounded-lg border border-white/[0.06] bg-[#202126] px-2 text-[10px] text-zinc-400"
                value={props.quantity}
                onChange={(event) => props.onQuantityChange(Number(event.target.value))}
              >
                {[1, 2, 3, 4].map((value) => (
                  <option key={value} value={value}>
                    {value} 个
                  </option>
                ))}
              </select>
              <label className="ml-auto flex min-w-0 items-center gap-1 text-[9px] text-zinc-600">
                <input
                  className="size-3 accent-cyan-300"
                  type="checkbox"
                  checked={props.rightsConfirmed}
                  onChange={(event) => props.onRightsConfirmedChange(event.target.checked)}
                />
                <span className="truncate">已确认素材权利</span>
              </label>
            </div>
          </div>
        </div>
      </main>
    </section>
  )
}

function VariantB(props: VariantProps): React.JSX.Element {
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden pb-16">
      <header className="bg-card/50 flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <Button size="icon-sm" variant="outline" aria-label="新建创作" onClick={props.onNewSession}>
          <PlusIcon />
        </Button>
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {SESSION_ITEMS.slice(0, 4).map((session) => (
            <button
              key={session.id}
              className={cn(
                'flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 text-xs',
                props.activeSessionId === session.id
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50'
              )}
              onClick={() => props.onSelectSession(session.id, session.scenario)}
            >
              {session.title}
              <span className="size-1.5 rounded-full bg-current opacity-45" />
            </button>
          ))}
        </div>
        <Badge variant="outline">仅自己可见</Badge>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto max-w-3xl space-y-4">
          <div className="ml-auto max-w-[78%] rounded-2xl rounded-tr-sm bg-cyan-950/40 px-4 py-3 ring-1 ring-cyan-700/20">
            <div className="mb-2 flex items-center justify-between gap-3 text-[10px] text-cyan-100/55">
              <span>你提交了图片生成</span>
              <span>10:42</span>
            </div>
            <p className="text-xs leading-5">{props.prompt}</p>
            <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] text-cyan-50/70">
              <span className="rounded border border-cyan-400/15 px-1.5 py-0.5">@图片1</span>
              <span className="rounded border border-cyan-400/15 px-1.5 py-0.5">@图片2</span>
              <span>{props.ratio}</span>
              <span>·</span>
              <span>{props.resolution}</span>
              <span>·</span>
              <span>{props.quantity} 个结果</span>
            </div>
          </div>
          <div className="bg-card/70 rounded-2xl rounded-tl-sm border p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="bg-primary/15 text-primary grid size-7 place-items-center rounded-lg">
                  <SparklesIcon className="size-3.5" />
                </span>
                <div>
                  <p className="text-xs font-semibold">Generation Task #3</p>
                  <p className="text-muted-foreground text-[10px]">
                    每次提交形成一个不可变规格快照
                  </p>
                </div>
              </div>
              <StatusBadge scenario={props.scenario} />
            </div>
            <TaskProgress scenario={props.scenario} />
            <div className="mt-3 grid grid-cols-4 gap-2">
              {Array.from({ length: 4 }, (_, index) => {
                const state =
                  index < props.scenario.completed
                    ? 'success'
                    : props.scenario.key === 'processing' && index === props.scenario.completed
                      ? 'processing'
                      : props.scenario.key === 'partial' || props.scenario.key === 'failed'
                        ? 'failed'
                        : 'queued'
                return <ResultCard key={index} index={index} state={state} />
              })}
            </div>
            {props.scenario.key === 'partial' ? (
              <div className="bg-warning/8 text-warning mt-3 flex items-start gap-2 rounded-lg border border-yellow-400/15 px-3 py-2 text-[11px]">
                <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  结果 3 暂时不可用，可稍后重试；结果 4 因输入策略被拒绝，需修改后重新提交。
                </span>
              </div>
            ) : null}
            <div className="mt-3">
              <ResultActions
                scenario={props.scenario}
                onEdit={props.onEdit}
                onRegenerate={props.onRegenerate}
                onRetry={props.onRetry}
                onOpenAssets={props.onOpenAssets}
              />
            </div>
          </div>
          <p className="text-muted-foreground text-center text-[10px]">
            成功结果立即进入资产库，不等待整个任务完成
          </p>
        </div>
      </div>
      <div className="bg-background/95 shrink-0 border-t px-5 py-3 backdrop-blur">
        <div className="bg-card mx-auto grid max-w-4xl grid-cols-[150px_minmax(0,1fr)_auto] gap-3 rounded-2xl border p-3 shadow-xl">
          <div className="space-y-2 border-r pr-3">
            <ModePicker
              mediaMode={props.mediaMode}
              videoComposer={props.videoComposer}
              onMediaModeChange={props.onMediaModeChange}
              onVideoComposerChange={props.onVideoComposerChange}
            />
          </div>
          <div className="min-w-0 space-y-2">
            <textarea
              aria-label="创作描述"
              className="placeholder:text-muted-foreground h-12 w-full resize-none bg-transparent text-xs leading-5 outline-none"
              value={props.prompt}
              onChange={(event) => props.onPromptChange(event.target.value)}
            />
            <div className="flex items-center gap-2">
              <Button size="xs" variant="outline" onClick={props.onAddReference}>
                <FileImageIcon /> {props.referenceCount} 项参考
              </Button>
              <span className="text-muted-foreground text-[10px]">
                {props.ratio} · {props.resolution} · {props.quantity} 个
              </span>
              <label className="text-muted-foreground ml-auto flex items-center gap-1 text-[10px]">
                <input
                  className="accent-primary size-3"
                  type="checkbox"
                  checked={props.rightsConfirmed}
                  onChange={(event) => props.onRightsConfirmedChange(event.target.checked)}
                />
                已确认素材权利
              </label>
            </div>
          </div>
          <Button size="icon-lg" aria-label="开始生成" onClick={props.onSubmit}>
            <SendIcon />
          </Button>
        </div>
      </div>
    </section>
  )
}

function VariantC(props: VariantProps): React.JSX.Element {
  return (
    <section className="grid min-h-0 flex-1 grid-cols-[286px_minmax(300px,1fr)_226px] gap-2 overflow-hidden bg-black/10 p-2 pb-16">
      <aside className="bg-card/70 min-h-0 overflow-y-auto rounded-xl border p-3">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">规格草稿</p>
            <p className="text-muted-foreground text-[10px]">先描述，再组织素材与参数</p>
          </div>
          <Badge variant="outline">自动保存</Badge>
        </div>
        <div className="space-y-4">
          <PromptBox compact prompt={props.prompt} onPromptChange={props.onPromptChange} />
          <ModePicker
            mediaMode={props.mediaMode}
            videoComposer={props.videoComposer}
            onMediaModeChange={props.onMediaModeChange}
            onVideoComposerChange={props.onVideoComposerChange}
          />
          <ReferenceMaterials
            mediaMode={props.mediaMode}
            videoComposer={props.videoComposer}
            referenceCount={props.referenceCount}
            onAdd={props.onAddReference}
            onRemove={props.onRemoveReference}
          />
          <ParameterControls
            mediaMode={props.mediaMode}
            ratio={props.ratio}
            resolution={props.resolution}
            quantity={props.quantity}
            onRatioChange={props.onRatioChange}
            onResolutionChange={props.onResolutionChange}
            onQuantityChange={props.onQuantityChange}
          />
          <RightsConfirmation
            confirmed={props.rightsConfirmed}
            onChange={props.onRightsConfirmedChange}
          />
          <Button className="w-full" onClick={props.onSubmit}>
            <SparklesIcon /> 提交 Generation Task
          </Button>
        </div>
      </aside>
      <main className="bg-card/40 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border p-3">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">输出画布</p>
            <p className="text-muted-foreground text-[10px]">夏季跑鞋主图 · Task #3</p>
          </div>
          <StatusBadge scenario={props.scenario} />
        </div>
        <div className="bg-background/45 mb-3 rounded-lg border p-2.5">
          <TaskProgress scenario={props.scenario} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ResultGrid dense scenario={props.scenario} />
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <ResultActions
            scenario={props.scenario}
            onEdit={props.onEdit}
            onRegenerate={props.onRegenerate}
            onRetry={props.onRetry}
            onOpenAssets={props.onOpenAssets}
          />
          <span className="text-muted-foreground shrink-0 text-[9px]">成功槽位已形成独立资产</span>
        </div>
      </main>
      <aside className="bg-card/70 flex min-h-0 flex-col overflow-hidden rounded-xl border">
        <div className="flex items-center justify-between border-b px-3 py-2.5">
          <div>
            <p className="text-xs font-semibold">Session 与任务</p>
            <p className="text-muted-foreground text-[9px]">历史状态一眼可扫</p>
          </div>
          <Button
            size="icon-xs"
            variant="outline"
            aria-label="新建创作"
            onClick={props.onNewSession}
          >
            <PlusIcon />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {SCENARIOS.map((scenario, index) => (
            <button
              key={scenario.key}
              className={cn(
                'mb-1.5 w-full rounded-lg border p-2 text-left transition-colors',
                props.scenario.key === scenario.key
                  ? 'border-primary/35 bg-primary/7'
                  : 'hover:bg-muted/40'
              )}
              onClick={() =>
                props.onSelectSession(SESSION_ITEMS[index]?.id ?? 'shoe', scenario.key)
              }
            >
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="truncate text-[11px] font-medium">
                  {SESSION_ITEMS[index]?.title}
                </span>
                <StatusBadge compact scenario={scenario} />
              </div>
              <div className="text-muted-foreground flex items-center justify-between text-[9px]">
                <span>
                  {scenario.key === 'processing' ? '视频' : '图片'} Task #{7 - index}
                </span>
                <span>
                  {scenario.completed}/{scenario.total}
                </span>
              </div>
            </button>
          ))}
        </div>
        <div className="border-t p-2">
          <button
            className="text-muted-foreground hover:text-foreground flex w-full items-center justify-between rounded-md px-2 py-1.5 text-[10px]"
            onClick={props.onOpenAssets}
          >
            <span className="flex items-center gap-1.5">
              <FolderOpenIcon className="size-3" />
              打开资产库
            </span>
            <ChevronRightIcon className="size-3" />
          </button>
        </div>
      </aside>
    </section>
  )
}

function PrototypeControls({
  scenario,
  onScenarioChange,
  onToggleState
}: {
  scenario: Scenario
  onScenarioChange: (scenario: ScenarioKey) => void
  onToggleState: () => void
}): React.JSX.Element {
  return (
    <div className="bg-background/96 flex h-10 shrink-0 items-center gap-2 border-b px-3 text-[10px] backdrop-blur">
      <span className="text-muted-foreground flex items-center gap-1.5 font-medium">
        <LayoutDashboardIcon className="size-3.5" /> 原型代表状态
      </span>
      <div className="flex gap-1">
        {SCENARIOS.map((item) => (
          <button
            key={item.key}
            className={cn(
              'rounded-md px-2 py-1 transition-colors',
              scenario.key === item.key
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-muted/50'
            )}
            onClick={() => onScenarioChange(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <span className="text-muted-foreground ml-auto hidden truncate md:block">
        所有操作仅更新内存，不调用生产后端
      </span>
      <Button size="xs" variant="outline" onClick={onToggleState}>
        <InfoIcon /> 完整状态
      </Button>
    </div>
  )
}

function PrototypeSwitcher({
  variant,
  onChange
}: {
  variant: VariantKey
  onChange: (variant: VariantKey) => void
}): React.JSX.Element {
  const variants: VariantKey[] = ['A', 'B', 'C']
  const currentIndex = variants.indexOf(variant)
  const previous = variants[(currentIndex - 1 + variants.length) % variants.length]
  const next = variants[(currentIndex + 1) % variants.length]

  return (
    <div className="fixed bottom-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/15 bg-black/85 p-1 text-white shadow-2xl backdrop-blur-xl">
      <Button
        size="icon-sm"
        variant="ghost"
        className="rounded-full text-white hover:bg-white/10 hover:text-white"
        aria-label="上一个原型方案"
        onClick={() => onChange(previous)}
      >
        <ArrowLeftIcon />
      </Button>
      <span className="min-w-36 px-2 text-center text-xs font-medium">
        {variant} — {VARIANT_NAMES[variant]}
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        className="rounded-full text-white hover:bg-white/10 hover:text-white"
        aria-label="下一个原型方案"
        onClick={() => onChange(next)}
      >
        <ArrowRightIcon />
      </Button>
    </div>
  )
}

export function CreationWorkbenchPrototype({
  includeProductRail = false
}: {
  includeProductRail?: boolean
} = {}): React.JSX.Element {
  const [variant, setVariant] = useState<VariantKey>(readVariant)
  const [scenarioKey, setScenarioKey] = useState<ScenarioKey>('queued')
  const [activeSessionId, setActiveSessionId] = useState('new')
  const [mediaMode, setMediaMode] = useState<MediaMode>('image')
  const [videoComposer, setVideoComposer] = useState<VideoComposer>('frames')
  const [prompt, setPrompt] = useState('')
  const [referenceCount, setReferenceCount] = useState(0)
  const [ratio, setRatio] = useState('4:5')
  const [resolution, setResolution] = useState('2K')
  const [quantity, setQuantity] = useState(1)
  const [expectedSlots, setExpectedSlots] = useState(1)
  const [rightsConfirmed, setRightsConfirmed] = useState(true)
  const [showState, setShowState] = useState(false)
  const [lastAction, setLastAction] = useState('打开空白 Creation Session')

  const baseScenario = scenarioByKey(scenarioKey)
  const scenario: Scenario = {
    ...baseScenario,
    completed: Math.min(baseScenario.completed, expectedSlots),
    total: expectedSlots
  }

  const changeVariant = (nextVariant: VariantKey): void => {
    const url = new URL(window.location.href)
    url.searchParams.set('variant', nextVariant)
    window.history.replaceState({}, '', url)
    setVariant(nextVariant)
    setLastAction(`切换为方案 ${nextVariant} — ${VARIANT_NAMES[nextVariant]}`)
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const variants: VariantKey[] = ['A', 'B', 'C']
      const currentIndex = variants.indexOf(variant)
      const direction = event.key === 'ArrowRight' ? 1 : -1
      changeVariant(variants[(currentIndex + direction + variants.length) % variants.length])
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [variant])

  const selectSession = (id: string, nextScenario: ScenarioKey): void => {
    setActiveSessionId(id)
    setScenarioKey(nextScenario)
    if (id === 'new') {
      setPrompt('')
      setReferenceCount(0)
      setMediaMode('image')
      setVideoComposer('frames')
      setRatio('4:5')
      setResolution('2K')
      setQuantity(1)
      setExpectedSlots(1)
      setRightsConfirmed(true)
    } else {
      setPrompt(
        '将 @图片1 的白色跑鞋放在雨后城市街道，保留鞋面结构，加入清晨侧逆光和轻微水汽，适合跨境电商首页主视觉。'
      )
      setReferenceCount(2)
      setRightsConfirmed(true)
      setMediaMode(id === 'video' ? 'video' : 'image')
      setResolution(id === 'video' ? '720p' : '2K')
      setQuantity(4)
      setExpectedSlots(4)
    }
    const title = SESSION_ITEMS.find((session) => session.id === id)?.title ?? '未命名创作'
    setLastAction(`打开 Creation Session“${title}”`)
  }

  const newSession = (): void => {
    setActiveSessionId('new')
    setScenarioKey('queued')
    setExpectedSlots(1)
    setPrompt('')
    setReferenceCount(0)
    setMediaMode('image')
    setVideoComposer('frames')
    setRatio('4:5')
    setResolution('2K')
    setQuantity(1)
    setRightsConfirmed(true)
    setLastAction('创建仅当前创建者可见的内存草稿 Session')
  }

  const submit = (): void => {
    if (referenceCount > 0 && !rightsConfirmed) {
      setLastAction('未提交：请先确认参考素材权利')
      return
    }
    setScenarioKey('queued')
    setExpectedSlots(quantity)
    setLastAction(`提交 1 个 Generation Task，预留 ${quantity} 个稳定结果槽位`)
  }

  const editAgain = (): void => {
    setPrompt('将 @图片1 的白色跑鞋放在雨后城市街道，增强鞋底细节与产品轮廓光。')
    setLastAction('把 Task #3 的不可变规格复制回可编辑 composer；原 Task 未改变')
  }

  const regenerate = (): void => {
    setScenarioKey('queued')
    setQuantity(4)
    setExpectedSlots(4)
    setLastAction('按原完整数量创建新的 Generation Task；原 Task 保持终态')
  }

  const retryIncomplete = (): void => {
    setScenarioKey('queued')
    setQuantity(2)
    setExpectedSlots(2)
    setRightsConfirmed(true)
    setLastAction('只为可重试的 2 个未完成槽位创建新的 Generation Task')
  }

  const openAssets = (): void => {
    setLastAction(`准备打开资产库；当前 ${scenario.completed} 个成功槽位已形成独立 Media Asset`)
  }

  const stateSnapshot = {
    variant,
    activeSessionId,
    visibility: 'creator-private',
    draft: {
      mediaMode,
      videoComposer: mediaMode === 'video' ? videoComposer : null,
      prompt,
      referenceMaterialIds: Array.from(
        { length: referenceCount },
        (_, index) => `ref-${index + 1}`
      ),
      ratio,
      resolution,
      quantity,
      rightsConfirmed
    },
    activeGenerationTask: {
      id: 'task-3',
      status: scenario.key === 'partial' ? 'partially_succeeded' : scenario.key,
      completedSlots: scenario.completed,
      expectedSlots: scenario.total
    },
    lastAction
  }

  const variantProps: VariantProps = {
    includeProductRail,
    activeSessionId,
    mediaMode,
    videoComposer,
    prompt,
    referenceCount,
    ratio,
    resolution,
    quantity,
    rightsConfirmed,
    scenario,
    onNewSession: newSession,
    onSelectSession: selectSession,
    onMediaModeChange: (mode) => {
      setMediaMode(mode)
      setResolution(mode === 'image' ? '2K' : '720p')
      setLastAction(`composer 切换为${mode === 'image' ? '图片' : '视频'}模式`)
    },
    onVideoComposerChange: (composer) => {
      setVideoComposer(composer)
      setLastAction(`视频 composer 切换为${composer === 'frames' ? '首尾帧' : '全能参考'}`)
    },
    onPromptChange: (value) => {
      setPrompt(value)
      setLastAction('编辑草稿提示词')
    },
    onAddReference: () => {
      setReferenceCount((count) => Math.min(4, count + 1))
      setLastAction('添加新的内存 Reference Material')
    },
    onRemoveReference: () => {
      setReferenceCount((count) => Math.max(0, count - 1))
      setLastAction('从草稿移除最后一项 Reference Material')
    },
    onRatioChange: (value) => {
      setRatio(value)
      setLastAction(`选择当前模型已验证比例 ${value}`)
    },
    onResolutionChange: (value) => {
      setResolution(value)
      setLastAction(`选择当前模型已验证分辨率 ${value}`)
    },
    onQuantityChange: (value) => {
      setQuantity(value)
      setLastAction(`将新 Task 的输出数量设为 ${value}`)
    },
    onRightsConfirmedChange: (confirmed) => {
      setRightsConfirmed(confirmed)
      setLastAction(confirmed ? '确认参考素材权利声明' : '取消参考素材权利声明')
    },
    onSubmit: submit,
    onEdit: editAgain,
    onRegenerate: regenerate,
    onRetry: retryIncomplete,
    onOpenAssets: openAssets,
    onToggleState: () => setShowState((visible) => !visible)
  }

  return (
    <div className="bg-background text-foreground relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {variant !== 'A' ? (
        <PrototypeControls
          scenario={scenario}
          onScenarioChange={(nextScenario) => {
            setScenarioKey(nextScenario)
            setLastAction(`切换代表状态为“${scenarioByKey(nextScenario).label}”`)
          }}
          onToggleState={() => setShowState((visible) => !visible)}
        />
      ) : null}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {variant === 'A' ? <VariantA {...variantProps} /> : null}
        {variant === 'B' ? <VariantB {...variantProps} /> : null}
        {variant === 'C' ? <VariantC {...variantProps} /> : null}
      </div>

      {showState ? (
        <aside className="bg-popover/98 absolute top-3 right-3 z-40 flex max-h-[calc(100%-1.5rem)] w-[340px] flex-col overflow-hidden rounded-xl border shadow-2xl backdrop-blur-xl">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <div>
              <p className="text-xs font-semibold">完整内存状态</p>
              <p className="text-muted-foreground text-[9px]">每次操作都会更新这里</p>
            </div>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="关闭完整状态"
              onClick={() => setShowState(false)}
            >
              <XIcon />
            </Button>
          </div>
          <pre className="text-muted-foreground min-h-0 flex-1 overflow-auto p-3 text-[10px] leading-4">
            {JSON.stringify(stateSnapshot, null, 2)}
          </pre>
        </aside>
      ) : null}

      {variant !== 'A' ? (
        <div className="bg-popover/95 pointer-events-none absolute right-3 bottom-14 z-30 max-w-[380px] rounded-lg border px-3 py-2 text-[10px] shadow-lg backdrop-blur">
          <span className="text-muted-foreground">最近动作：</span> {lastAction}
        </div>
      ) : null}
      {variant !== 'A' && import.meta.env.DEV ? (
        <PrototypeSwitcher variant={variant} onChange={changeVariant} />
      ) : null}
    </div>
  )
}
