// PROTOTYPE — throwaway branch only.
// Three variants of the Asset Library, switchable via ?variant=, on /prototype/asset-library.

import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Compass,
  CopyPlus,
  Download,
  Film,
  FolderOpen,
  Grid2X2,
  Image as ImageIcon,
  LibraryBig,
  ListFilter,
  LoaderCircle,
  Maximize2,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  SquareCheckBig,
  UserRound,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

type VariantKey = 'A' | 'B' | 'C'
type SurfaceState = 'ready' | 'empty' | 'error'
type MediaFilter = 'all' | 'image' | 'video'
type CreatorFilter = 'all' | 'mine' | 'lin-xia' | 'chen-mo'
type TimeFilter = 'all' | 'today' | 'week'

type Asset = {
  id: string
  title: string
  type: 'image' | 'video'
  creator: '我' | '林夏' | '陈默'
  creatorKey: Exclude<CreatorFilter, 'all'>
  mine: boolean
  bucket: 'today' | 'week' | 'older'
  time: string
  day: string
  ratio: string
  resolution: string
  duration?: string
  source: string
  sourceKind: string
  prompt: string
  published: boolean
  background: string
  accent: string
}

const VARIANTS: Array<{ key: VariantKey; name: string }> = [
  { key: 'A', name: '画廊 + 侧滑详情' },
  { key: 'B', name: '时间线 + 固定详情' },
  { key: 'C', name: '沉浸预览 + 片带' }
]

const ASSETS: Asset[] = [
  {
    id: 'asset-01',
    title: '夏日玻璃杯主图',
    type: 'image',
    creator: '我',
    creatorKey: 'mine',
    mine: true,
    bucket: 'today',
    time: '今天 14:32',
    day: '今天',
    ratio: '4:5',
    resolution: '2K',
    source: '夏日杯具主图 · 8 月 21 日',
    sourceKind: '参考图生图',
    prompt: '透明玻璃杯置于浅蓝水面，硬朗日光与清澈高光，电商主图构图。',
    published: false,
    background: 'linear-gradient(145deg, #75d8e8 0%, #2b8297 42%, #0f3348 100%)',
    accent: '#bdf7ff'
  },
  {
    id: 'asset-02',
    title: '露营灯氛围短片',
    type: 'video',
    creator: '林夏',
    creatorKey: 'lin-xia',
    mine: false,
    bucket: 'today',
    time: '今天 13:18',
    day: '今天',
    ratio: '9:16',
    resolution: '1080p',
    duration: '00:08',
    source: '露营灯广告 · 8 月 21 日',
    sourceKind: '首尾帧视频',
    prompt: '黄昏森林营地，暖光露营灯逐渐点亮，镜头缓慢推进。',
    published: true,
    background: 'linear-gradient(155deg, #1b2f38 0%, #253f2e 47%, #cc8642 100%)',
    accent: '#ffd59b'
  },
  {
    id: 'asset-03',
    title: '跑鞋悬浮海报',
    type: 'image',
    creator: '陈默',
    creatorKey: 'chen-mo',
    mine: false,
    bucket: 'today',
    time: '今天 11:46',
    day: '今天',
    ratio: '1:1',
    resolution: '4K',
    source: '秋季跑鞋系列 · 8 月 21 日',
    sourceKind: '参考图生图',
    prompt: '白色跑鞋悬浮于赤红渐变空间，速度线和颗粒光，潮流广告视觉。',
    published: false,
    background: 'linear-gradient(135deg, #f5b7a6 0%, #d94a3c 46%, #4d0e18 100%)',
    accent: '#ffe0d5'
  },
  {
    id: 'asset-04',
    title: '耳机城市通勤片',
    type: 'video',
    creator: '我',
    creatorKey: 'mine',
    mine: true,
    bucket: 'today',
    time: '今天 09:10',
    day: '今天',
    ratio: '16:9',
    resolution: '1080p',
    duration: '00:12',
    source: '通勤耳机发布 · 8 月 21 日',
    sourceKind: '全能参考视频',
    prompt: '清晨地铁与城市街道快速切换，银色头戴耳机保持视觉中心。',
    published: true,
    background: 'linear-gradient(135deg, #9ca9c5 0%, #52617c 48%, #161d2e 100%)',
    accent: '#dce6ff'
  },
  {
    id: 'asset-05',
    title: '咖啡机详情页头图',
    type: 'image',
    creator: '林夏',
    creatorKey: 'lin-xia',
    mine: false,
    bucket: 'week',
    time: '昨天 18:04',
    day: '昨天',
    ratio: '16:9',
    resolution: '2K',
    source: '家电详情页 · 8 月 20 日',
    sourceKind: '文生图',
    prompt: '不锈钢咖啡机位于米白色厨房中岛，晨光，高级家居杂志质感。',
    published: false,
    background: 'linear-gradient(145deg, #e8d9c3 0%, #a98b6e 48%, #3f332b 100%)',
    accent: '#fff3df'
  },
  {
    id: 'asset-06',
    title: '护肤套装水波主图',
    type: 'image',
    creator: '我',
    creatorKey: 'mine',
    mine: true,
    bucket: 'week',
    time: '周二 16:22',
    day: '本周',
    ratio: '4:5',
    resolution: '4K',
    source: '夏季护肤礼盒 · 8 月 19 日',
    sourceKind: '参考图生图',
    prompt: '珍珠白护肤瓶悬浮于透明水波之上，银色柔光，洁净高端。',
    published: false,
    background: 'linear-gradient(150deg, #e7f6f7 0%, #96c9d3 52%, #437187 100%)',
    accent: '#ffffff'
  },
  {
    id: 'asset-07',
    title: '折叠桌收纳演示',
    type: 'video',
    creator: '陈默',
    creatorKey: 'chen-mo',
    mine: false,
    bucket: 'week',
    time: '周一 10:35',
    day: '本周',
    ratio: '4:5',
    resolution: '720p',
    duration: '00:10',
    source: '小户型折叠桌 · 8 月 18 日',
    sourceKind: '全能参考视频',
    prompt: '小户型客厅中，折叠桌从展开到收起，固定机位，动作清晰。',
    published: false,
    background: 'linear-gradient(145deg, #dcccb4 0%, #8f775d 48%, #3d352f 100%)',
    accent: '#fcebd2'
  },
  {
    id: 'asset-08',
    title: '旅行箱霓虹广告',
    type: 'image',
    creator: '林夏',
    creatorKey: 'lin-xia',
    mine: false,
    bucket: 'older',
    time: '8 月 14 日 21:08',
    day: '更早',
    ratio: '1:1',
    resolution: '2K',
    source: '旅行箱视觉探索 · 8 月 14 日',
    sourceKind: '文生图',
    prompt: '金属旅行箱位于紫蓝霓虹通道中央，镜面地面，未来感广告。',
    published: true,
    background: 'linear-gradient(135deg, #9d70f2 0%, #5039a5 46%, #152141 100%)',
    accent: '#e3d7ff'
  }
]

const navItems = [
  { label: '灵感', icon: Compass },
  { label: '创作', icon: Sparkles },
  { label: '资产', icon: LibraryBig, active: true }
]

function isVariant(value: string | null): value is VariantKey {
  return value === 'A' || value === 'B' || value === 'C'
}

function isSurfaceState(value: string | null): value is SurfaceState {
  return value === 'ready' || value === 'empty' || value === 'error'
}

function readUrlState(): { variant: VariantKey; surfaceState: SurfaceState } {
  const params = new URLSearchParams(window.location.search)
  const variant = params.get('variant')
  const surfaceState = params.get('state')
  return {
    variant: isVariant(variant) ? variant : 'A',
    surfaceState: isSurfaceState(surfaceState) ? surfaceState : 'ready'
  }
}

function writeUrlState(variant: VariantKey, surfaceState: SurfaceState): void {
  const url = new URL(window.location.href)
  url.searchParams.set('variant', variant)
  url.searchParams.set('state', surfaceState)
  window.history.replaceState({}, '', url)
}

function ProductMark(): React.JSX.Element {
  return (
    <div className="grid size-9 place-items-center rounded-[11px] bg-cyan-300 font-black text-neutral-950 shadow-[0_0_26px_rgba(103,232,249,0.18)]">
      N
    </div>
  )
}

function AppChrome({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-screen bg-[#101114] text-white">
      <aside className="flex w-[92px] shrink-0 flex-col items-center border-r border-white/7 bg-[#0b0c0f] py-5">
        <ProductMark />
        <nav className="mt-12 flex w-full flex-col gap-2 px-3">
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                type="button"
                key={item.label}
                className={`group flex h-14 flex-col items-center justify-center gap-1 rounded-xl text-[11px] transition ${item.active ? 'bg-white/9 text-cyan-200' : 'text-white/42 hover:bg-white/5 hover:text-white/70'}`}
              >
                <Icon className="size-[19px]" strokeWidth={1.8} />
                {item.label}
              </button>
            )
          })}
        </nav>
        <div className="mt-auto flex flex-col items-center gap-2 text-[10px] text-white/35">
          <div className="grid size-9 place-items-center rounded-full bg-gradient-to-br from-fuchsia-400 to-indigo-500 font-semibold text-white">
            E
          </div>
          Elio
        </div>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  )
}

function PageHeader({
  surfaceState,
  onSurfaceStateChange
}: {
  surfaceState: SurfaceState
  onSurfaceStateChange: (state: SurfaceState) => void
}): React.JSX.Element {
  return (
    <header className="flex h-[68px] items-center justify-between border-b border-white/7 px-7">
      <div className="flex items-center gap-3">
        <div>
          <p className="text-[11px] font-medium tracking-[0.16em] text-white/32 uppercase">
            Atlas Commerce
          </p>
          <h1 className="mt-0.5 text-[19px] font-semibold tracking-tight">资产库</h1>
        </div>
        <span className="rounded-md border border-cyan-300/15 bg-cyan-300/6 px-2 py-1 text-[10px] text-cyan-100/62">
          仅成功生成的 Media Asset
        </span>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1 rounded-lg border border-white/7 bg-white/3 p-1 text-[11px]">
          <span className="px-2 text-white/32">原型数据</span>
          {(
            [
              ['ready', '正常'],
              ['empty', '空态'],
              ['error', '错误态']
            ] as Array<[SurfaceState, string]>
          ).map(([state, label]) => (
            <button
              type="button"
              key={state}
              onClick={() => onSurfaceStateChange(state)}
              className={`rounded-md px-2.5 py-1.5 transition ${surfaceState === state ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/65'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="flex h-9 items-center gap-2 rounded-lg bg-cyan-300 px-3.5 text-xs font-semibold text-neutral-950 hover:bg-cyan-200"
        >
          <Plus className="size-4" />
          去创作
        </button>
      </div>
    </header>
  )
}

function FilterBar({
  media,
  creator,
  time,
  onMediaChange,
  onCreatorChange,
  onTimeChange,
  resultCount,
  compact = false
}: {
  media: MediaFilter
  creator: CreatorFilter
  time: TimeFilter
  onMediaChange: (filter: MediaFilter) => void
  onCreatorChange: (filter: CreatorFilter) => void
  onTimeChange: (filter: TimeFilter) => void
  resultCount: number
  compact?: boolean
}): React.JSX.Element {
  return (
    <div className={`flex items-center justify-between gap-4 ${compact ? 'py-3' : 'py-4'}`}>
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex rounded-lg bg-white/5 p-1 text-xs">
          {(
            [
              ['all', '全部'],
              ['image', '图片'],
              ['video', '视频']
            ] as Array<[MediaFilter, string]>
          ).map(([value, label]) => (
            <button
              type="button"
              key={value}
              onClick={() => onMediaChange(value)}
              className={`rounded-md px-3 py-1.5 ${media === value ? 'bg-white/12 text-white' : 'text-white/42 hover:text-white/70'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="relative">
          <UserRound className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-white/35" />
          <select
            aria-label="按创建者筛选"
            value={creator}
            onChange={(event) => onCreatorChange(event.target.value as CreatorFilter)}
            className="h-9 appearance-none rounded-lg border border-white/7 bg-white/4 pr-8 pl-8 text-xs text-white/68 outline-none hover:border-white/13"
          >
            <option value="all">全部创建者</option>
            <option value="mine">我</option>
            <option value="lin-xia">林夏</option>
            <option value="chen-mo">陈默</option>
          </select>
          <ChevronRight className="pointer-events-none absolute top-1/2 right-2.5 size-3 -translate-y-1/2 rotate-90 text-white/30" />
        </label>
        <label className="relative">
          <Clock3 className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-white/35" />
          <select
            aria-label="按时间筛选"
            value={time}
            onChange={(event) => onTimeChange(event.target.value as TimeFilter)}
            className="h-9 appearance-none rounded-lg border border-white/7 bg-white/4 pr-8 pl-8 text-xs text-white/68 outline-none hover:border-white/13"
          >
            <option value="all">全部时间</option>
            <option value="today">今天</option>
            <option value="week">本周</option>
          </select>
          <ChevronRight className="pointer-events-none absolute top-1/2 right-2.5 size-3 -translate-y-1/2 rotate-90 text-white/30" />
        </label>
      </div>
      <span className="shrink-0 text-[11px] text-white/30">{resultCount} 项资产</span>
    </div>
  )
}

function AssetVisual({
  asset,
  large = false
}: {
  asset: Asset
  large?: boolean
}): React.JSX.Element {
  return (
    <div
      className="relative h-full w-full overflow-hidden bg-[#202228]"
      style={{ background: asset.background }}
    >
      <div
        className={`absolute rounded-full bg-white/25 blur-2xl ${large ? '-top-20 -left-12 size-64' : '-top-10 -left-8 size-36'}`}
      />
      <div
        className={`absolute rotate-[-12deg] rounded-[28%] border border-white/28 bg-black/12 shadow-2xl backdrop-blur-sm ${large ? 'top-[24%] left-[31%] h-[48%] w-[38%]' : 'top-[24%] left-[29%] h-[50%] w-[42%]'}`}
      >
        <div className="absolute inset-[14%] rounded-[22%] border border-white/22 bg-white/13" />
        <div className="absolute right-[20%] bottom-[14%] left-[20%] h-[8%] rounded-full bg-white/45" />
      </div>
      <div className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-md border border-white/15 bg-black/28 px-2 py-1 text-[9px] font-medium tracking-[0.12em] text-white/72 backdrop-blur-md">
        {asset.type === 'video' ? <Film className="size-3" /> : <ImageIcon className="size-3" />}
        NEVIX SAMPLE
      </div>
      {asset.type === 'video' ? (
        <div className="absolute inset-0 grid place-items-center">
          <span className="grid size-11 place-items-center rounded-full border border-white/35 bg-black/25 backdrop-blur-sm">
            <Play className="ml-0.5 size-4 fill-white text-white" />
          </span>
        </div>
      ) : null}
      <div className="absolute right-3 bottom-3 rounded-md bg-black/35 px-2 py-1 text-[9px] font-medium text-white/76 backdrop-blur-md">
        {asset.duration ?? asset.ratio}
      </div>
    </div>
  )
}

function SelectionButton({
  checked,
  onClick
}: {
  checked: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={checked ? '取消选择' : '选择资产'}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={`grid size-6 place-items-center rounded-md border backdrop-blur-md transition ${checked ? 'border-cyan-200 bg-cyan-300 text-neutral-950' : 'border-white/30 bg-black/25 text-transparent hover:border-white/60'}`}
    >
      <Check className="size-3.5" strokeWidth={3} />
    </button>
  )
}

function AssetActions({
  asset,
  onAction
}: {
  asset: Asset
  onAction: (message: string) => void
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-2">
      <button
        type="button"
        onClick={() => onAction(`已准备下载「${asset.title}」（原型）`)}
        className="flex h-9 items-center justify-center gap-2 rounded-lg border border-white/9 bg-white/4 text-xs text-white/78 hover:bg-white/8"
      >
        <Download className="size-3.5" /> 下载
      </button>
      <button
        type="button"
        onClick={() => onAction(`将以「${asset.title}」创建新的私有 Creation Session（原型）`)}
        className="flex h-9 items-center justify-center gap-2 rounded-lg bg-cyan-300 text-xs font-semibold text-neutral-950 hover:bg-cyan-200"
      >
        <CopyPlus className="size-3.5" /> 做同款
      </button>
      <button
        type="button"
        disabled={!asset.mine}
        onClick={() =>
          onAction(
            asset.published
              ? `打开「${asset.title}」的 Discovery Publication（原型）`
              : `将为「${asset.title}」创建 Organization Publication（原型）`
          )
        }
        className="col-span-2 flex h-9 items-center justify-center gap-2 rounded-lg border border-white/9 bg-white/4 text-xs text-white/78 enabled:hover:bg-white/8 disabled:cursor-not-allowed disabled:text-white/25"
      >
        <Send className="size-3.5" />
        {asset.mine
          ? asset.published
            ? '查看 Discovery 发布'
            : '发布到 Discovery'
          : '仅创建者可发布'}
      </button>
    </div>
  )
}

function DetailContent({
  asset,
  onAction,
  roomy = false
}: {
  asset: Asset
  onAction: (message: string) => void
  roomy?: boolean
}): React.JSX.Element {
  return (
    <div className={`flex min-h-0 flex-1 flex-col ${roomy ? 'gap-6' : 'gap-4'}`}>
      <div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[10px] font-medium tracking-[0.12em] text-white/35 uppercase">
              {asset.type === 'video' ? '视频资产' : '图片资产'}
              {asset.published ? (
                <span className="rounded bg-emerald-300/10 px-1.5 py-0.5 tracking-normal text-emerald-200/70">
                  已发布
                </span>
              ) : null}
            </div>
            <h2 className="mt-2 text-lg font-semibold tracking-tight">{asset.title}</h2>
          </div>
          <button
            type="button"
            className="grid size-8 place-items-center rounded-lg text-white/38 hover:bg-white/6 hover:text-white/70"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/42">
          <span>{asset.creator}</span>
          <span>{asset.time}</span>
          <span>
            {asset.ratio} · {asset.resolution}
          </span>
        </div>
      </div>
      <section className="rounded-xl border border-white/7 bg-white/3 p-4">
        <p className="text-[10px] font-medium tracking-[0.12em] text-white/30 uppercase">提示词</p>
        <p className="mt-2 text-xs leading-5 text-white/66">{asset.prompt}</p>
      </section>
      <section>
        <p className="text-[10px] font-medium tracking-[0.12em] text-white/30 uppercase">来源</p>
        <button
          type="button"
          onClick={() => onAction(`打开来源 Creation Session「${asset.source}」（原型）`)}
          className="mt-2 flex w-full items-center justify-between rounded-xl border border-white/7 bg-white/3 p-3.5 text-left hover:bg-white/5"
        >
          <span>
            <span className="block text-xs text-white/76">{asset.source}</span>
            <span className="mt-1 block text-[10px] text-white/35">{asset.sourceKind}</span>
          </span>
          <ChevronRight className="size-4 text-white/30" />
        </button>
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-dashed border-white/8 px-3 py-2.5 text-[10px] leading-4 text-white/34">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          临时参考上传只保留在来源上下文，不会作为 Media Asset 出现在这里。
        </div>
      </section>
      <div className="mt-auto pt-1">
        <AssetActions asset={asset} onAction={onAction} />
      </div>
    </div>
  )
}

function EmptyState({ onReady }: { onReady: () => void }): React.JSX.Element {
  return (
    <div className="grid h-full place-items-center p-10 text-center">
      <div className="max-w-sm">
        <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-white/8 bg-white/4 text-white/42">
          <FolderOpen className="size-6" strokeWidth={1.6} />
        </div>
        <h2 className="mt-5 text-base font-semibold">还没有成功生成的资产</h2>
        <p className="mt-2 text-xs leading-5 text-white/40">
          图片或视频成功生成并转存后会出现在这里。进行中的任务和临时参考上传仍留在创作工作台。
        </p>
        <button
          type="button"
          onClick={onReady}
          className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-cyan-300 px-4 text-xs font-semibold text-neutral-950"
        >
          <Sparkles className="size-3.5" /> 去创作
        </button>
      </div>
    </div>
  )
}

function ErrorState({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return (
    <div className="grid h-full place-items-center p-10 text-center">
      <div className="max-w-sm">
        <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-rose-300/12 bg-rose-300/6 text-rose-200/75">
          <CircleAlert className="size-6" strokeWidth={1.6} />
        </div>
        <h2 className="mt-5 text-base font-semibold">资产暂时无法加载</h2>
        <p className="mt-2 text-xs leading-5 text-white/40">
          已有资产不会受影响。请检查网络后重试，或稍后再回来。
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg border border-white/9 bg-white/5 px-4 text-xs text-white/78 hover:bg-white/8"
        >
          <RefreshCw className="size-3.5" /> 重新加载
        </button>
      </div>
    </div>
  )
}

function NonReadyState({
  state,
  onReady
}: {
  state: Exclude<SurfaceState, 'ready'>
  onReady: () => void
}): React.JSX.Element {
  return state === 'empty' ? <EmptyState onReady={onReady} /> : <ErrorState onRetry={onReady} />
}

type VariantProps = {
  assets: Asset[]
  selectedIds: Set<string>
  activeAsset: Asset | undefined
  surfaceState: SurfaceState
  filters: {
    media: MediaFilter
    creator: CreatorFilter
    time: TimeFilter
  }
  onMediaChange: (filter: MediaFilter) => void
  onCreatorChange: (filter: CreatorFilter) => void
  onTimeChange: (filter: TimeFilter) => void
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  onClearSelection: () => void
  onReady: () => void
  onAction: (message: string) => void
}

function VariantA(props: VariantProps): React.JSX.Element {
  const [drawerOpen, setDrawerOpen] = useState(false)

  return (
    <div className="relative flex h-[calc(100vh-68px)] flex-col px-7">
      <FilterBar
        media={props.filters.media}
        creator={props.filters.creator}
        time={props.filters.time}
        onMediaChange={props.onMediaChange}
        onCreatorChange={props.onCreatorChange}
        onTimeChange={props.onTimeChange}
        resultCount={props.assets.length}
      />
      <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-white/7 bg-[#15171b]">
        {props.surfaceState !== 'ready' ? (
          <NonReadyState state={props.surfaceState} onReady={props.onReady} />
        ) : (
          <div className="prototype-grid prototype-scrollbar grid h-full gap-3 overflow-y-auto p-4 pb-24">
            {props.assets.map((asset) => (
              <article
                key={asset.id}
                className="group relative overflow-hidden rounded-xl border border-white/7 bg-white/3 transition hover:-translate-y-0.5 hover:border-white/16"
              >
                <div
                  className={`absolute top-2.5 left-2.5 z-10 transition group-hover:opacity-100 ${props.selectedIds.has(asset.id) ? 'opacity-100' : 'opacity-0'}`}
                >
                  <SelectionButton
                    checked={props.selectedIds.has(asset.id)}
                    onClick={() => props.onSelect(asset.id)}
                  />
                </div>
                <button
                  type="button"
                  className="block w-full text-left"
                  onClick={() => {
                    props.onOpen(asset.id)
                    setDrawerOpen(true)
                  }}
                >
                  <div className="aspect-[4/3]">
                    <AssetVisual asset={asset} />
                  </div>
                  <div className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="truncate text-xs font-medium text-white/82">{asset.title}</h3>
                      <span className="shrink-0 text-[9px] text-white/28">{asset.resolution}</span>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-[10px] text-white/34">
                      <span>{asset.creator}</span>
                      <span>{asset.time}</span>
                    </div>
                  </div>
                </button>
              </article>
            ))}
          </div>
        )}
      </div>
      {props.selectedIds.size > 0 ? (
        <div className="absolute bottom-7 left-1/2 z-20 flex -translate-x-1/2 items-center gap-4 rounded-xl border border-white/12 bg-[#222429]/95 px-4 py-3 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center gap-2 text-xs">
            <SquareCheckBig className="size-4 text-cyan-200" /> 已选择 {props.selectedIds.size} 项
          </div>
          <span className="h-4 w-px bg-white/10" />
          <button
            type="button"
            onClick={() => props.onAction(`批量下载 ${props.selectedIds.size} 项资产（原型）`)}
            className="flex items-center gap-2 text-xs text-white/72 hover:text-white"
          >
            <ArrowDownToLine className="size-3.5" /> 下载选中
          </button>
          <span className="text-[10px] text-white/28">做同款与发布仅支持单项</span>
          <button
            type="button"
            onClick={props.onClearSelection}
            className="text-white/35 hover:text-white/70"
          >
            <X className="size-4" />
          </button>
        </div>
      ) : null}
      {drawerOpen && props.activeAsset ? (
        <>
          <button
            type="button"
            aria-label="关闭资产详情"
            className="absolute inset-0 z-30 bg-black/30"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="absolute top-3 right-3 bottom-3 z-40 flex w-[390px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#181a1f] shadow-[-24px_0_80px_rgba(0,0,0,0.42)]">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/7 px-4">
              <span className="text-xs font-medium">资产详情</span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="grid size-8 place-items-center rounded-lg text-white/40 hover:bg-white/6 hover:text-white"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="aspect-[16/10] shrink-0">
              <AssetVisual asset={props.activeAsset} large />
            </div>
            <div className="prototype-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto p-5">
              <DetailContent asset={props.activeAsset} onAction={props.onAction} />
            </div>
          </aside>
        </>
      ) : null}
    </div>
  )
}

function VariantB(props: VariantProps): React.JSX.Element {
  const [batchMode, setBatchMode] = useState(false)
  const groups = ['今天', '本周', '更早']

  return (
    <div className="grid h-[calc(100vh-68px)] grid-cols-[410px_minmax(0,1fr)]">
      <section className="flex min-h-0 flex-col border-r border-white/7 bg-[#121418] px-5">
        <div className="flex items-center justify-between pt-4">
          <label className="relative block flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-white/28" />
            <input
              placeholder="搜索资产名称"
              className="h-9 w-full rounded-lg border border-white/7 bg-white/4 pr-3 pl-9 text-xs text-white outline-none placeholder:text-white/25 focus:border-cyan-200/35"
            />
          </label>
          <button
            type="button"
            onClick={() => {
              setBatchMode((value) => !value)
              if (batchMode) props.onClearSelection()
            }}
            className={`ml-2 grid size-9 place-items-center rounded-lg border ${batchMode ? 'border-cyan-200/35 bg-cyan-300/10 text-cyan-100' : 'border-white/7 bg-white/4 text-white/42'}`}
            title="批量选择"
          >
            <SquareCheckBig className="size-4" />
          </button>
        </div>
        <FilterBar
          media={props.filters.media}
          creator={props.filters.creator}
          time={props.filters.time}
          onMediaChange={props.onMediaChange}
          onCreatorChange={props.onCreatorChange}
          onTimeChange={props.onTimeChange}
          resultCount={props.assets.length}
          compact
        />
        <div className="prototype-scrollbar min-h-0 flex-1 overflow-y-auto pb-5">
          {props.surfaceState !== 'ready' ? (
            <div className="h-full rounded-xl border border-white/7 bg-white/2">
              <NonReadyState state={props.surfaceState} onReady={props.onReady} />
            </div>
          ) : (
            groups.map((group) => {
              const groupedAssets = props.assets.filter((asset) => asset.day === group)
              if (groupedAssets.length === 0) return null
              return (
                <div key={group} className="mb-5">
                  <div className="sticky top-0 z-10 flex items-center gap-2 bg-[#121418]/95 py-2 text-[10px] font-medium tracking-[0.12em] text-white/30 uppercase backdrop-blur">
                    <span>{group}</span>
                    <span className="h-px flex-1 bg-white/6" />
                  </div>
                  <div className="space-y-1.5">
                    {groupedAssets.map((asset) => {
                      const active = props.activeAsset?.id === asset.id
                      return (
                        <div
                          key={asset.id}
                          className={`flex w-full items-center gap-3 rounded-xl border p-2 text-left transition ${active && !batchMode ? 'border-cyan-200/20 bg-cyan-300/8' : 'border-transparent hover:border-white/7 hover:bg-white/4'}`}
                        >
                          {batchMode ? (
                            <SelectionButton
                              checked={props.selectedIds.has(asset.id)}
                              onClick={() => props.onSelect(asset.id)}
                            />
                          ) : null}
                          <button
                            type="button"
                            onClick={() =>
                              batchMode ? props.onSelect(asset.id) : props.onOpen(asset.id)
                            }
                            className="flex min-w-0 flex-1 items-center gap-3 text-left"
                          >
                            <div className="h-[58px] w-[76px] shrink-0 overflow-hidden rounded-lg">
                              <AssetVisual asset={asset} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-xs font-medium text-white/78">
                                  {asset.title}
                                </span>
                                {asset.type === 'video' ? (
                                  <Film className="size-3 shrink-0 text-white/28" />
                                ) : null}
                              </div>
                              <p className="mt-1 text-[10px] text-white/34">
                                {asset.creator} · {asset.time}
                              </p>
                              <p className="mt-1 text-[9px] text-white/22">
                                {asset.sourceKind} · {asset.resolution}
                              </p>
                            </div>
                            {!batchMode ? (
                              <ChevronRight className="size-3.5 text-white/20" />
                            ) : null}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })
          )}
        </div>
        {batchMode ? (
          <div className="mb-4 rounded-xl border border-white/8 bg-white/4 p-3">
            <div className="flex items-center justify-between text-xs">
              <span>已选择 {props.selectedIds.size} 项</span>
              <button
                type="button"
                onClick={props.onClearSelection}
                className="text-[10px] text-white/35 hover:text-white/60"
              >
                清空
              </button>
            </div>
            <button
              type="button"
              disabled={props.selectedIds.size === 0}
              onClick={() => props.onAction(`批量下载 ${props.selectedIds.size} 项资产（原型）`)}
              className="mt-3 flex h-8 w-full items-center justify-center gap-2 rounded-lg bg-white/8 text-[11px] text-white/70 disabled:opacity-30"
            >
              <Download className="size-3.5" /> 下载选中
            </button>
            <p className="mt-2 text-center text-[9px] text-white/28">
              发布与做同款需要回到单项详情
            </p>
          </div>
        ) : null}
      </section>
      <section className="min-w-0 bg-[#101114] p-6">
        {props.surfaceState === 'ready' && props.activeAsset ? (
          <div className="grid h-full min-h-0 grid-cols-[minmax(360px,1.15fr)_minmax(320px,0.85fr)] overflow-hidden rounded-2xl border border-white/7 bg-[#17191e]">
            <div className="relative min-h-0 overflow-hidden border-r border-white/7">
              <AssetVisual asset={props.activeAsset} large />
              <button
                type="button"
                className="absolute top-4 right-4 grid size-9 place-items-center rounded-lg border border-white/15 bg-black/25 text-white/72 backdrop-blur"
              >
                <Maximize2 className="size-4" />
              </button>
            </div>
            <div className="prototype-scrollbar flex min-h-0 flex-col overflow-y-auto p-6">
              <DetailContent asset={props.activeAsset} onAction={props.onAction} roomy />
            </div>
          </div>
        ) : (
          <div className="grid h-full place-items-center rounded-2xl border border-dashed border-white/7 text-xs text-white/26">
            {batchMode ? '批量模式下不执行单项操作' : '从左侧选择一项资产查看详情'}
          </div>
        )}
      </section>
    </div>
  )
}

function VariantC(props: VariantProps): React.JSX.Element {
  const [batchMode, setBatchMode] = useState(false)

  return (
    <div className="grid h-[calc(100vh-68px)] grid-cols-[220px_minmax(0,1fr)]">
      <aside className="border-r border-white/7 bg-[#121318] p-5">
        <div className="flex items-center gap-2 text-xs font-medium text-white/58">
          <ListFilter className="size-4" /> 浏览范围
        </div>
        <div className="mt-6 space-y-6">
          <div>
            <p className="text-[10px] tracking-[0.12em] text-white/27 uppercase">媒体类型</p>
            <div className="mt-2 space-y-1">
              {(
                [
                  ['all', '全部资产', LibraryBig],
                  ['image', '图片', ImageIcon],
                  ['video', '视频', Film]
                ] as const
              ).map(([value, label, Icon]) => (
                <button
                  type="button"
                  key={value}
                  onClick={() => props.onMediaChange(value)}
                  className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-xs ${props.filters.media === value ? 'bg-white/8 text-white' : 'text-white/42 hover:bg-white/4 hover:text-white/65'}`}
                >
                  <Icon className="size-3.5" /> {label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-[10px] tracking-[0.12em] text-white/27 uppercase">创建者</p>
            <div className="mt-2 space-y-1 text-xs">
              {(
                [
                  ['all', '全部成员'],
                  ['mine', '我'],
                  ['lin-xia', '林夏'],
                  ['chen-mo', '陈默']
                ] as Array<[CreatorFilter, string]>
              ).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  onClick={() => props.onCreatorChange(value)}
                  className={`flex h-8 w-full items-center justify-between rounded-lg px-3 ${props.filters.creator === value ? 'bg-cyan-300/8 text-cyan-100/85' : 'text-white/40 hover:text-white/65'}`}
                >
                  {label}
                  {props.filters.creator === value ? <Check className="size-3.5" /> : null}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-[10px] tracking-[0.12em] text-white/27 uppercase">创建时间</p>
            <div className="mt-2 grid grid-cols-1 gap-1">
              {(
                [
                  ['all', '不限'],
                  ['today', '今天'],
                  ['week', '本周']
                ] as Array<[TimeFilter, string]>
              ).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  onClick={() => props.onTimeChange(value)}
                  className={`h-8 rounded-lg px-3 text-left text-xs ${props.filters.time === value ? 'bg-white/8 text-white' : 'text-white/40 hover:text-white/65'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-8 rounded-xl border border-dashed border-white/8 p-3 text-[10px] leading-4 text-white/30">
          <LoaderCircle className="mb-2 size-4" />
          生成中的任务留在创作工作台，不计入这里的 {props.assets.length} 项资产。
        </div>
      </aside>
      <section className="flex min-w-0 flex-col p-5">
        {props.surfaceState !== 'ready' ? (
          <div className="h-full rounded-2xl border border-white/7 bg-[#15171b]">
            <NonReadyState state={props.surfaceState} onReady={props.onReady} />
          </div>
        ) : props.activeAsset ? (
          <>
            <div className="flex items-center justify-between pb-4">
              <div className="flex items-center gap-2 text-xs text-white/38">
                <Grid2X2 className="size-3.5" /> {props.assets.length} 项结果
              </div>
              <button
                type="button"
                onClick={() => {
                  setBatchMode((value) => !value)
                  if (batchMode) props.onClearSelection()
                }}
                className={`flex h-8 items-center gap-2 rounded-lg border px-3 text-[11px] ${batchMode ? 'border-cyan-200/30 bg-cyan-300/8 text-cyan-100' : 'border-white/7 bg-white/3 text-white/48'}`}
              >
                <SquareCheckBig className="size-3.5" /> {batchMode ? '退出批量' : '批量下载'}
              </button>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px] overflow-hidden rounded-2xl border border-white/7 bg-[#17191e]">
              <div className="relative min-h-0 overflow-hidden border-r border-white/7">
                <AssetVisual asset={props.activeAsset} large />
                <div className="absolute top-5 left-5 rounded-lg border border-white/14 bg-black/24 px-3 py-2 backdrop-blur-md">
                  <p className="text-[9px] tracking-[0.12em] text-white/44 uppercase">正在查看</p>
                  <p className="mt-1 text-sm font-medium">{props.activeAsset.title}</p>
                </div>
              </div>
              <div className="prototype-scrollbar flex min-h-0 flex-col overflow-y-auto p-5">
                {batchMode ? (
                  <div className="flex h-full flex-col">
                    <div>
                      <p className="text-[10px] tracking-[0.12em] text-white/30 uppercase">
                        批量操作
                      </p>
                      <h2 className="mt-2 text-lg font-semibold">
                        已选择 {props.selectedIds.size} 项
                      </h2>
                      <p className="mt-2 text-xs leading-5 text-white/38">
                        批量仅用于下载；做同款与发布会创建不同业务上下文，必须逐项确认。
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={props.selectedIds.size === 0}
                      onClick={() =>
                        props.onAction(`批量下载 ${props.selectedIds.size} 项资产（原型）`)
                      }
                      className="mt-auto flex h-10 items-center justify-center gap-2 rounded-lg bg-cyan-300 text-xs font-semibold text-neutral-950 disabled:opacity-30"
                    >
                      <Download className="size-4" /> 下载选中
                    </button>
                  </div>
                ) : (
                  <DetailContent asset={props.activeAsset} onAction={props.onAction} roomy />
                )}
              </div>
            </div>
            <div className="prototype-scrollbar mt-4 flex h-[116px] shrink-0 gap-2 overflow-x-auto rounded-xl border border-white/7 bg-[#14161a] p-2">
              {props.assets.map((asset) => {
                const active = asset.id === props.activeAsset?.id
                return (
                  <div
                    key={asset.id}
                    className={`group relative h-full w-[136px] shrink-0 overflow-hidden rounded-lg border-2 transition ${active && !batchMode ? 'border-cyan-200' : 'border-transparent opacity-68 hover:opacity-100'}`}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        batchMode ? props.onSelect(asset.id) : props.onOpen(asset.id)
                      }
                      className="h-full w-full"
                    >
                      <AssetVisual asset={asset} />
                    </button>
                    {batchMode ? (
                      <span className="absolute top-2 left-2">
                        <SelectionButton
                          checked={props.selectedIds.has(asset.id)}
                          onClick={() => props.onSelect(asset.id)}
                        />
                      </span>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </>
        ) : (
          <div className="grid h-full place-items-center text-xs text-white/30">
            当前筛选没有结果
          </div>
        )}
      </section>
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
  const currentIndex = VARIANTS.findIndex((item) => item.key === variant)
  const move = (direction: -1 | 1): void => {
    const index = (currentIndex + direction + VARIANTS.length) % VARIANTS.length
    onChange(VARIANTS[index].key)
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      if (event.key === 'ArrowLeft') move(-1)
      if (event.key === 'ArrowRight') move(1)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  })

  const current = VARIANTS[currentIndex]
  return (
    <div className="fixed bottom-5 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/14 bg-neutral-950/92 p-1.5 text-white shadow-[0_18px_60px_rgba(0,0,0,0.55)] backdrop-blur-xl">
      <button
        type="button"
        aria-label="上一个原型方案"
        onClick={() => move(-1)}
        className="grid size-8 place-items-center rounded-full text-white/55 hover:bg-white/8 hover:text-white"
      >
        <ArrowLeft className="size-4" />
      </button>
      <div className="min-w-[190px] text-center">
        <span className="text-[10px] font-semibold text-cyan-200">{current.key}</span>
        <span className="mx-2 text-white/20">—</span>
        <span className="text-[11px] text-white/72">{current.name}</span>
      </div>
      <button
        type="button"
        aria-label="下一个原型方案"
        onClick={() => move(1)}
        className="grid size-8 place-items-center rounded-full text-white/55 hover:bg-white/8 hover:text-white"
      >
        <ArrowRight className="size-4" />
      </button>
    </div>
  )
}

function PrototypeState({
  variant,
  surfaceState,
  media,
  creator,
  time,
  selectedCount,
  activeAsset
}: {
  variant: VariantKey
  surfaceState: SurfaceState
  media: MediaFilter
  creator: CreatorFilter
  time: TimeFilter
  selectedCount: number
  activeAsset: string | undefined
}): React.JSX.Element {
  return (
    <details className="fixed bottom-5 left-[108px] z-[90] w-[250px] rounded-xl border border-white/9 bg-neutral-950/88 text-[10px] text-white/48 shadow-xl backdrop-blur-xl">
      <summary className="cursor-pointer px-3 py-2.5 text-white/58">
        原型状态 · {variant}/{surfaceState}
      </summary>
      <pre className="border-t border-white/7 px-3 py-2.5 leading-4 whitespace-pre-wrap text-white/38">
        {JSON.stringify({ media, creator, time, selectedCount, activeAsset }, null, 2)}
      </pre>
    </details>
  )
}

export function AssetLibraryPrototype(): React.JSX.Element {
  const initial = readUrlState()
  const [variant, setVariant] = useState<VariantKey>(initial.variant)
  const [surfaceState, setSurfaceState] = useState<SurfaceState>(initial.surfaceState)
  const [media, setMedia] = useState<MediaFilter>('all')
  const [creator, setCreator] = useState<CreatorFilter>('all')
  const [time, setTime] = useState<TimeFilter>('all')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [activeAssetId, setActiveAssetId] = useState<string>(ASSETS[0].id)
  const [toast, setToast] = useState<string>()

  const filteredAssets = useMemo(
    () =>
      ASSETS.filter((asset) => {
        if (media !== 'all' && asset.type !== media) return false
        if (creator !== 'all' && asset.creatorKey !== creator) return false
        if (time === 'today' && asset.bucket !== 'today') return false
        if (time === 'week' && asset.bucket === 'older') return false
        return true
      }),
    [media, creator, time]
  )
  const activeAsset =
    filteredAssets.find((asset) => asset.id === activeAssetId) ?? filteredAssets[0]

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(undefined), 2600)
    return () => window.clearTimeout(timeout)
  }, [toast])

  const changeVariant = (nextVariant: VariantKey): void => {
    setVariant(nextVariant)
    writeUrlState(nextVariant, surfaceState)
  }
  const changeSurfaceState = (nextState: SurfaceState): void => {
    setSurfaceState(nextState)
    writeUrlState(variant, nextState)
  }
  const toggleSelection = (id: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const props: VariantProps = {
    assets: filteredAssets,
    selectedIds,
    activeAsset,
    surfaceState,
    filters: { media, creator, time },
    onMediaChange: setMedia,
    onCreatorChange: setCreator,
    onTimeChange: setTime,
    onSelect: toggleSelection,
    onOpen: setActiveAssetId,
    onClearSelection: () => setSelectedIds(new Set()),
    onReady: () => changeSurfaceState('ready'),
    onAction: setToast
  }

  return (
    <AppChrome>
      <PageHeader surfaceState={surfaceState} onSurfaceStateChange={changeSurfaceState} />
      {variant === 'A' ? <VariantA {...props} /> : null}
      {variant === 'B' ? <VariantB {...props} /> : null}
      {variant === 'C' ? <VariantC {...props} /> : null}
      {import.meta.env.DEV ? (
        <>
          <PrototypeState
            variant={variant}
            surfaceState={surfaceState}
            media={media}
            creator={creator}
            time={time}
            selectedCount={selectedIds.size}
            activeAsset={activeAsset?.id}
          />
          <PrototypeSwitcher variant={variant} onChange={changeVariant} />
        </>
      ) : null}
      {toast ? (
        <div
          role="status"
          className="fixed top-5 left-1/2 z-[120] flex -translate-x-1/2 items-center gap-2 rounded-xl border border-cyan-200/20 bg-[#202328]/95 px-4 py-3 text-xs text-white/78 shadow-2xl backdrop-blur-xl"
        >
          <Check className="size-4 text-cyan-200" /> {toast}
        </div>
      ) : null}
    </AppChrome>
  )
}
