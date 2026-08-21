// PROTOTYPE — throwaway branch only.
// Reference-aligned winner refinement: a dense, date-grouped Asset Library wall.
// The three exploratory variants remain available in branch history at commit f2d2832.

import {
  ArrowUpDown,
  Check,
  ChevronDown,
  CircleAlert,
  Compass,
  CopyPlus,
  Download,
  FolderOpen,
  LibraryBig,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  SlidersHorizontal,
  Sparkles,
  SquareCheckBig,
  UserRound,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

type SurfaceState = 'ready' | 'empty' | 'error'
type LibraryTab = 'all' | 'mine' | 'published'
type MediaFilter = 'all' | 'image' | 'video'
type CreatorFilter = 'all' | 'mine' | 'lin-xia' | 'chen-mo'
type TimeFilter = 'all' | 'today' | 'week'
type SortOrder = 'newest' | 'oldest'
type AssetBucket = 'today' | 'week' | 'older'
type Motif = 'bottle' | 'shoe' | 'lamp' | 'bag' | 'speaker' | 'cosmetic' | 'chair' | 'box'

type Asset = {
  id: string
  title: string
  type: 'image' | 'video'
  creator: '我' | '林夏' | '陈默'
  creatorKey: Exclude<CreatorFilter, 'all'>
  mine: boolean
  bucket: AssetBucket
  time: string
  ratio: string
  resolution: string
  duration?: string
  source: string
  sourceKind: string
  prompt: string
  published: boolean
  background: string
  accent: string
  motif: Motif
  wide?: boolean
}

type AssetBlueprint = Omit<Asset, 'id' | 'bucket' | 'time' | 'wide'>

const BLUEPRINTS: AssetBlueprint[] = [
  {
    title: '夏日玻璃杯主图',
    type: 'image',
    creator: '我',
    creatorKey: 'mine',
    mine: true,
    ratio: '4:5',
    resolution: '2K',
    source: '夏日杯具主图 · 8 月 21 日',
    sourceKind: '参考图生图',
    prompt: '透明玻璃杯置于浅蓝水面，硬朗日光与清澈高光，电商主图构图。',
    published: false,
    background: 'linear-gradient(145deg, #91dce6 0%, #348fa3 48%, #0f3a50 100%)',
    accent: '#d7fbff',
    motif: 'bottle'
  },
  {
    title: '露营灯氛围短片',
    type: 'video',
    creator: '林夏',
    creatorKey: 'lin-xia',
    mine: false,
    ratio: '9:16',
    resolution: '1080p',
    duration: '00:08',
    source: '露营灯广告 · 8 月 21 日',
    sourceKind: '首尾帧视频',
    prompt: '黄昏森林营地，暖光露营灯逐渐点亮，镜头缓慢推进。',
    published: true,
    background: 'linear-gradient(150deg, #263e35 0%, #7d6333 55%, #dc9444 100%)',
    accent: '#ffe0a8',
    motif: 'lamp'
  },
  {
    title: '跑鞋悬浮海报',
    type: 'image',
    creator: '陈默',
    creatorKey: 'chen-mo',
    mine: false,
    ratio: '1:1',
    resolution: '4K',
    source: '秋季跑鞋系列 · 8 月 21 日',
    sourceKind: '参考图生图',
    prompt: '白色跑鞋悬浮于赤红渐变空间，速度线和颗粒光，潮流广告视觉。',
    published: false,
    background: 'linear-gradient(135deg, #ffb69e 0%, #de4d42 45%, #59131e 100%)',
    accent: '#fff1e8',
    motif: 'shoe'
  },
  {
    title: '耳机城市通勤片',
    type: 'video',
    creator: '我',
    creatorKey: 'mine',
    mine: true,
    ratio: '16:9',
    resolution: '1080p',
    duration: '00:12',
    source: '通勤耳机发布 · 8 月 21 日',
    sourceKind: '全能参考视频',
    prompt: '清晨地铁与城市街道快速切换，银色头戴耳机保持视觉中心。',
    published: true,
    background: 'linear-gradient(135deg, #aab5cc 0%, #59677f 48%, #1a2030 100%)',
    accent: '#eef3ff',
    motif: 'speaker'
  },
  {
    title: '咖啡机详情页头图',
    type: 'image',
    creator: '林夏',
    creatorKey: 'lin-xia',
    mine: false,
    ratio: '16:9',
    resolution: '2K',
    source: '家电详情页 · 8 月 20 日',
    sourceKind: '文生图',
    prompt: '不锈钢咖啡机位于米白色厨房中岛，晨光，高级家居杂志质感。',
    published: false,
    background: 'linear-gradient(145deg, #e9dbc4 0%, #a48769 50%, #413329 100%)',
    accent: '#fff4df',
    motif: 'box'
  },
  {
    title: '护肤套装水波主图',
    type: 'image',
    creator: '我',
    creatorKey: 'mine',
    mine: true,
    ratio: '4:5',
    resolution: '4K',
    source: '夏季护肤礼盒 · 8 月 19 日',
    sourceKind: '参考图生图',
    prompt: '珍珠白护肤瓶悬浮于透明水波之上，银色柔光，洁净高端。',
    published: false,
    background: 'linear-gradient(150deg, #e9f7f8 0%, #96cbd5 52%, #467386 100%)',
    accent: '#ffffff',
    motif: 'cosmetic'
  },
  {
    title: '折叠桌收纳演示',
    type: 'video',
    creator: '陈默',
    creatorKey: 'chen-mo',
    mine: false,
    ratio: '4:5',
    resolution: '720p',
    duration: '00:10',
    source: '小户型折叠桌 · 8 月 18 日',
    sourceKind: '全能参考视频',
    prompt: '小户型客厅中，折叠桌从展开到收起，固定机位，动作清晰。',
    published: false,
    background: 'linear-gradient(145deg, #e0ceb4 0%, #92775a 48%, #3f362f 100%)',
    accent: '#fcebd2',
    motif: 'chair'
  },
  {
    title: '旅行箱霓虹广告',
    type: 'image',
    creator: '林夏',
    creatorKey: 'lin-xia',
    mine: false,
    ratio: '1:1',
    resolution: '2K',
    source: '旅行箱视觉探索 · 8 月 14 日',
    sourceKind: '文生图',
    prompt: '金属旅行箱位于紫蓝霓虹通道中央，镜面地面，未来感广告。',
    published: true,
    background: 'linear-gradient(135deg, #a172f4 0%, #543ba8 47%, #172443 100%)',
    accent: '#e7ddff',
    motif: 'bag'
  }
]

const TIME_LABELS = [
  '今天 14:32',
  '今天 14:08',
  '今天 13:18',
  '今天 12:46',
  '今天 11:10',
  '今天 10:35',
  '今天 09:42',
  '昨天 21:04',
  '昨天 21:04',
  '昨天 19:28',
  '昨天 18:04',
  '昨天 16:22',
  '周二 15:40',
  '周二 13:12',
  '周一 18:54',
  '周一 10:35',
  '上周五 16:40',
  '上周四 11:24',
  '8 月 14 日',
  '8 月 12 日'
]

const ASSETS: Asset[] = Array.from({ length: 40 }, (_, index) => {
  const base = BLUEPRINTS[index % BLUEPRINTS.length]
  const cycle = Math.floor(index / BLUEPRINTS.length)
  const bucket: AssetBucket = index < 14 ? 'today' : index < 32 ? 'week' : 'older'
  return {
    ...base,
    id: `asset-${String(index + 1).padStart(2, '0')}`,
    title: cycle === 0 ? base.title : `${base.title} · 变体 ${cycle + 1}`,
    bucket,
    time: TIME_LABELS[Math.min(Math.floor(index / 2), TIME_LABELS.length - 1)],
    wide: index === 0 || index === 3 || index === 33
  }
})

const GROUPS: Array<{ key: AssetBucket; label: string }> = [
  { key: 'today', label: '今天' },
  { key: 'week', label: '本周' },
  { key: 'older', label: '更早' }
]

function readSurfaceState(): SurfaceState {
  const state = new URLSearchParams(window.location.search).get('state')
  return state === 'empty' || state === 'error' ? state : 'ready'
}

function updateSurfaceState(state: SurfaceState): void {
  const url = new URL(window.location.href)
  url.searchParams.set('state', state)
  window.history.replaceState({}, '', url)
}

function ProductMark(): React.JSX.Element {
  return (
    <div className="relative grid size-8 place-items-center">
      <div className="absolute size-5 rotate-45 rounded-[4px] bg-cyan-300 shadow-[0_0_22px_rgba(103,232,249,0.2)]" />
      <div className="absolute size-3 rotate-45 rounded-[3px] bg-[#15171b]" />
    </div>
  )
}

function AppRail(): React.JSX.Element {
  const items = [
    { label: '灵感', icon: Compass },
    { label: '创作', icon: Sparkles },
    { label: '资产', icon: LibraryBig, active: true }
  ]
  return (
    <aside className="flex h-screen w-[64px] shrink-0 flex-col items-center border-r border-white/6 bg-[#0d0e11] py-4">
      <ProductMark />
      <button
        type="button"
        title="Atlas Commerce"
        className="mt-5 grid size-8 place-items-center rounded-lg border border-white/8 bg-white/4 text-[9px] font-semibold text-white/55"
      >
        AC
      </button>
      <nav className="mt-16 flex w-full flex-col gap-5">
        {items.map((item) => {
          const Icon = item.icon
          return (
            <button
              type="button"
              key={item.label}
              className={`relative flex h-10 flex-col items-center justify-center gap-1 text-[9px] transition ${item.active ? 'text-white' : 'text-white/36 hover:text-white/65'}`}
            >
              {item.active ? (
                <span className="absolute left-0 h-7 w-0.5 rounded-r bg-cyan-300" />
              ) : null}
              <Icon className="size-[16px]" strokeWidth={1.7} />
              {item.label}
            </button>
          )
        })}
      </nav>
      <div className="mt-auto flex flex-col items-center gap-3">
        <button
          type="button"
          className="grid size-8 place-items-center rounded-full bg-gradient-to-br from-violet-400 to-indigo-600 text-[10px] font-semibold"
        >
          E
        </button>
        <MoreHorizontal className="size-4 text-white/28" />
      </div>
    </aside>
  )
}

function MotifGraphic({ motif, accent }: { motif: Motif; accent: string }): React.JSX.Element {
  const common = { fill: `${accent}d9`, stroke: `${accent}f0`, strokeWidth: 1.2 }

  if (motif === 'bottle') {
    return (
      <g transform="rotate(-8 100 85)">
        <rect x="78" y="39" width="44" height="93" rx="15" {...common} />
        <rect x="87" y="29" width="26" height="18" rx="6" fill={`${accent}b8`} />
        <path
          d="M84 102 Q100 88 116 102"
          fill="none"
          stroke="#fff"
          strokeOpacity=".58"
          strokeWidth="2"
        />
      </g>
    )
  }
  if (motif === 'shoe') {
    return (
      <g transform="rotate(-14 100 86)">
        <path d="M49 92 C71 91 84 62 95 66 C112 72 120 91 151 97 L151 113 L48 113 Z" {...common} />
        <path d="M55 106 H148" fill="none" stroke="#fff" strokeOpacity=".65" strokeWidth="3" />
      </g>
    )
  }
  if (motif === 'lamp') {
    return (
      <g>
        <circle cx="100" cy="70" r="33" fill={`${accent}47`} stroke={accent} strokeWidth="2" />
        <rect x="95" y="72" width="10" height="48" rx="5" {...common} />
        <rect x="77" y="117" width="46" height="8" rx="4" fill={`${accent}d9`} />
      </g>
    )
  }
  if (motif === 'bag') {
    return (
      <g transform="rotate(4 100 85)">
        <rect x="65" y="54" width="70" height="78" rx="16" {...common} />
        <path d="M82 60 V48 C82 34 118 34 118 48 V60" fill="none" stroke={accent} strokeWidth="5" />
        <circle cx="78" cy="72" r="3" fill="#fff" fillOpacity=".7" />
      </g>
    )
  }
  if (motif === 'speaker') {
    return (
      <g>
        <rect x="68" y="35" width="64" height="100" rx="20" {...common} />
        <circle
          cx="100"
          cy="71"
          r="21"
          fill="none"
          stroke="#fff"
          strokeOpacity=".55"
          strokeWidth="3"
        />
        <circle cx="100" cy="112" r="9" fill="#fff" fillOpacity=".52" />
      </g>
    )
  }
  if (motif === 'cosmetic') {
    return (
      <g>
        <rect x="58" y="67" width="31" height="63" rx="8" {...common} />
        <rect x="65" y="53" width="17" height="18" rx="4" fill={`${accent}bd`} />
        <rect x="96" y="45" width="40" height="85" rx="12" {...common} />
        <rect x="105" y="33" width="22" height="18" rx="4" fill={`${accent}bd`} />
      </g>
    )
  }
  if (motif === 'chair') {
    return (
      <g transform="rotate(-5 100 90)">
        <rect x="66" y="36" width="60" height="57" rx="13" {...common} />
        <rect x="58" y="88" width="84" height="24" rx="10" fill={`${accent}d0`} />
        <path
          d="M72 110 L63 136 M128 110 L138 136"
          stroke={accent}
          strokeWidth="5"
          strokeLinecap="round"
        />
      </g>
    )
  }
  return (
    <g transform="rotate(-7 100 87)">
      <rect x="57" y="46" width="86" height="83" rx="12" {...common} />
      <path
        d="M57 70 L100 93 L143 70 M100 93 V129"
        fill="none"
        stroke="#fff"
        strokeOpacity=".48"
        strokeWidth="2"
      />
    </g>
  )
}

function AssetVisual({
  asset,
  detail = false
}: {
  asset: Asset
  detail?: boolean
}): React.JSX.Element {
  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{ background: asset.background }}
    >
      <div
        className={`absolute rounded-full bg-white/28 blur-3xl ${detail ? '-top-24 -left-14 size-72' : '-top-12 -left-8 size-40'}`}
      />
      <svg
        viewBox="0 0 200 160"
        aria-hidden="true"
        className="absolute inset-0 h-full w-full drop-shadow-[0_16px_18px_rgba(0,0,0,0.25)]"
      >
        <MotifGraphic motif={asset.motif} accent={asset.accent} />
      </svg>
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/38 to-transparent" />
      {asset.type === 'video' ? (
        <div className="absolute inset-0 grid place-items-center">
          <span
            className={`grid place-items-center rounded-full border border-white/45 bg-black/22 backdrop-blur-sm ${detail ? 'size-12' : 'size-8'}`}
          >
            <Play className={`${detail ? 'size-4' : 'size-3'} ml-0.5 fill-white text-white`} />
          </span>
        </div>
      ) : null}
      <span className="absolute right-2 bottom-1.5 rounded bg-black/36 px-1.5 py-0.5 text-[8px] font-medium text-white/75 backdrop-blur-sm">
        {asset.duration ?? asset.ratio}
      </span>
    </div>
  )
}

function CompactSelect<T extends string>({
  label,
  icon,
  value,
  options,
  onChange
}: {
  label: string
  icon: React.ReactNode
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <label className="relative flex items-center gap-1.5 text-[11px] text-white/50 hover:text-white/75">
      {icon}
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="appearance-none bg-transparent pr-4 outline-none"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-0 size-3" />
    </label>
  )
}

function EmptyState({ onReady }: { onReady: () => void }): React.JSX.Element {
  return (
    <div className="grid min-h-[520px] place-items-center text-center">
      <div className="max-w-sm">
        <div className="mx-auto grid size-12 place-items-center rounded-xl border border-white/8 bg-white/4 text-white/35">
          <FolderOpen className="size-5" />
        </div>
        <h2 className="mt-4 text-sm font-medium">还没有成功生成的资产</h2>
        <p className="mt-2 text-[11px] leading-5 text-white/35">
          图片或视频成功生成并转存后会出现在这里；进行中的任务和临时参考上传仍留在创作工作台。
        </p>
        <button
          type="button"
          onClick={onReady}
          className="mt-4 inline-flex h-8 items-center gap-2 rounded-md bg-white px-3 text-[11px] font-medium text-black"
        >
          <Sparkles className="size-3.5" /> 去创作
        </button>
      </div>
    </div>
  )
}

function ErrorState({ onReady }: { onReady: () => void }): React.JSX.Element {
  return (
    <div className="grid min-h-[520px] place-items-center text-center">
      <div className="max-w-sm">
        <div className="mx-auto grid size-12 place-items-center rounded-xl border border-rose-300/12 bg-rose-300/6 text-rose-200/70">
          <CircleAlert className="size-5" />
        </div>
        <h2 className="mt-4 text-sm font-medium">资产暂时无法加载</h2>
        <p className="mt-2 text-[11px] leading-5 text-white/35">
          已有资产不会受影响，请检查网络后重试。
        </p>
        <button
          type="button"
          onClick={onReady}
          className="mt-4 inline-flex h-8 items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 text-[11px] text-white/70"
        >
          <RefreshCw className="size-3.5" /> 重新加载
        </button>
      </div>
    </div>
  )
}

function DetailPanel({
  asset,
  relatedAssets,
  onClose,
  onSelectAsset,
  onAction
}: {
  asset: Asset
  relatedAssets: Asset[]
  onClose: () => void
  onSelectAsset: (asset: Asset) => void
  onAction: (message: string) => void
}): React.JSX.Element {
  const previewStyle =
    asset.ratio === '16:9'
      ? { aspectRatio: '16 / 9', width: 'min(92%, 1040px)' }
      : asset.ratio === '1:1'
        ? { aspectRatio: '1 / 1', width: 'min(72vh, calc(100vw - 500px))' }
        : {
            aspectRatio: asset.ratio.replace(':', ' / '),
            height: 'calc(100vh - 52px)',
            maxHeight: '100%'
          }

  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-label={`资产详情：${asset.title}`}
      className="fixed top-0 right-0 bottom-0 left-[64px] z-50 flex bg-[#0b0c0f]"
    >
      <div className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-[#0b0c0f] p-6">
        <div className="absolute top-4 left-5 z-10 rounded-md bg-black/25 px-2.5 py-1.5 text-[9px] text-white/38 backdrop-blur-md">
          {asset.title} · {asset.ratio}
        </div>
        <button
          type="button"
          aria-label="关闭资产详情"
          onClick={onClose}
          className="absolute top-4 right-4 z-10 grid size-8 place-items-center rounded-md bg-white/6 text-white/55 backdrop-blur-md hover:bg-white/10 hover:text-white"
        >
          <X className="size-4" />
        </button>
        <div
          className="max-h-full max-w-full overflow-hidden rounded-md bg-black shadow-[0_24px_80px_rgba(0,0,0,0.38)]"
          style={previewStyle}
        >
          <AssetVisual asset={asset} detail />
        </div>
      </div>

      <aside className="prototype-scrollbar flex h-full w-[360px] shrink-0 flex-col overflow-y-auto border-l border-white/7 bg-[#111216] shadow-[-24px_0_70px_rgba(0,0,0,0.2)]">
        <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-white/7 px-4">
          <span className="text-[10px] font-medium text-white/50">资产详情</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onAction(`已准备下载「${asset.title}」（原型）`)}
              className="flex h-7 items-center gap-1.5 rounded-md bg-white/6 px-2.5 text-[9px] text-white/62 hover:bg-white/10"
            >
              <Download className="size-3" /> 下载
            </button>
            <button
              type="button"
              aria-label="更多操作"
              className="grid size-7 place-items-center rounded-md text-white/35 hover:bg-white/6 hover:text-white/70"
            >
              <MoreHorizontal className="size-4" />
            </button>
          </div>
        </div>

        <div className="flex flex-1 flex-col p-4">
          <section>
            <div className="grid grid-cols-4 gap-1.5">
              {relatedAssets.map((relatedAsset) => (
                <button
                  type="button"
                  key={relatedAsset.id}
                  aria-label={`查看同组资产 ${relatedAsset.title}`}
                  onClick={() => onSelectAsset(relatedAsset)}
                  className={`aspect-square overflow-hidden rounded-md bg-black ${relatedAsset.id === asset.id ? 'ring-1 ring-white ring-offset-1 ring-offset-[#111216]' : 'opacity-62 hover:opacity-100'}`}
                >
                  <AssetVisual asset={relatedAsset} />
                </button>
              ))}
            </div>
            <p className="mt-2 text-[8px] tracking-[0.12em] text-white/24 uppercase">
              同组结果 · {relatedAssets.length} 项
            </p>
          </section>

          <section className="mt-5">
            <p className="text-[9px] font-medium tracking-[0.12em] text-white/28 uppercase">
              {asset.type === 'video' ? '视频资产' : '图片资产'}
              {asset.published ? <span className="ml-2 text-emerald-300/65">已发布</span> : null}
            </p>
            <h2 className="mt-1.5 text-[16px] font-semibold text-white/88">{asset.title}</h2>
            <div className="mt-2 flex gap-3 text-[9px] text-white/32">
              <span>{asset.creator}</span>
              <span>{asset.time}</span>
            </div>
          </section>

          <section className="mt-5 border-t border-white/7 pt-4">
            <p className="text-[9px] tracking-[0.12em] text-white/28 uppercase">提示词</p>
            <p className="mt-2 text-[10px] leading-[1.7] text-white/55">{asset.prompt}</p>
          </section>

          <section className="mt-4 grid grid-cols-3 gap-px overflow-hidden rounded-md border border-white/7 bg-white/7">
            {[
              ['类型', asset.type === 'video' ? '视频' : '图片'],
              ['比例', asset.ratio],
              ['分辨率', asset.resolution]
            ].map(([label, value]) => (
              <div key={label} className="bg-[#15161a] px-2.5 py-2.5">
                <span className="block text-[8px] text-white/24">{label}</span>
                <span className="mt-1 block text-[9px] text-white/58">{value}</span>
              </div>
            ))}
          </section>

          <section className="mt-5">
            <p className="text-[9px] tracking-[0.12em] text-white/28 uppercase">来源</p>
            <button
              type="button"
              onClick={() => onAction(`打开来源 Creation Session「${asset.source}」（原型）`)}
              className="mt-2 flex w-full items-center justify-between rounded-lg border border-white/7 bg-white/3 p-3 text-left hover:bg-white/5"
            >
              <span>
                <span className="block text-[10px] text-white/64">{asset.source}</span>
                <span className="mt-1 block text-[8px] text-white/28">{asset.sourceKind}</span>
              </span>
              <ChevronDown className="size-3.5 -rotate-90 text-white/28" />
            </button>
            <p className="mt-2 flex items-start gap-2 rounded-md border border-dashed border-white/7 px-2.5 py-2 text-[8px] leading-4 text-white/26">
              <CircleAlert className="mt-0.5 size-3 shrink-0" />
              临时参考上传只保留在来源上下文，不会作为 Media Asset 出现在这里。
            </p>
          </section>

          <div className="mt-auto grid grid-cols-2 gap-2 pt-6">
            <button
              type="button"
              onClick={() => onAction(`已准备下载「${asset.title}」（原型）`)}
              className="flex h-9 items-center justify-center gap-2 rounded-md border border-white/9 bg-white/4 text-[10px] text-white/64 hover:bg-white/8"
            >
              <Download className="size-3.5" /> 下载
            </button>
            <button
              type="button"
              onClick={() =>
                onAction(`将以「${asset.title}」创建新的私有 Creation Session（原型）`)
              }
              className="flex h-9 items-center justify-center gap-2 rounded-md bg-white text-[10px] font-medium text-black hover:bg-white/90"
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
              className="col-span-2 flex h-9 items-center justify-center gap-2 rounded-md border border-white/9 bg-white/4 text-[10px] text-white/60 enabled:hover:bg-white/8 disabled:cursor-not-allowed disabled:text-white/22"
            >
              <Send className="size-3.5" />
              {asset.mine
                ? asset.published
                  ? '查看 Discovery 发布'
                  : '发布到 Discovery'
                : '仅创建者可发布'}
            </button>
          </div>
        </div>
      </aside>
    </section>
  )
}

function AssetWall({
  assets,
  batchMode,
  selectedIds,
  onAssetClick
}: {
  assets: Asset[]
  batchMode: boolean
  selectedIds: Set<string>
  onAssetClick: (asset: Asset) => void
}): React.JSX.Element {
  return (
    <div className="pb-28">
      {GROUPS.map((group) => {
        const groupAssets = assets.filter((asset) => asset.bucket === group.key)
        if (groupAssets.length === 0) return null
        return (
          <section key={group.key} className="mb-7">
            <h2 className="mb-2 text-[14px] font-medium tracking-tight text-white/78">
              {group.label}
            </h2>
            <div className="prototype-asset-wall grid gap-[2px]">
              {groupAssets.map((asset) => {
                const selected = selectedIds.has(asset.id)
                return (
                  <button
                    type="button"
                    key={asset.id}
                    aria-label={`${batchMode ? (selected ? '取消选择' : '选择') : '查看'} ${asset.title}`}
                    onClick={() => onAssetClick(asset)}
                    className={`group relative overflow-hidden bg-[#202126] text-left ${asset.wide ? 'col-span-2 aspect-[8/3]' : 'aspect-[4/3]'} ${selected ? 'ring-2 ring-cyan-300 ring-inset' : ''}`}
                  >
                    <AssetVisual asset={asset} />
                    <div className="absolute inset-0 bg-black/0 transition group-hover:bg-black/16" />
                    <div className="absolute inset-x-0 bottom-0 translate-y-full bg-gradient-to-t from-black/80 to-transparent px-2 pt-7 pb-1.5 transition group-hover:translate-y-0">
                      <p className="truncate text-[9px] font-medium text-white/88">{asset.title}</p>
                      <p className="mt-0.5 text-[8px] text-white/48">
                        {asset.creator} · {asset.time}
                      </p>
                    </div>
                    {batchMode ? (
                      <span
                        className={`absolute top-1.5 left-1.5 grid size-5 place-items-center rounded border backdrop-blur-sm ${selected ? 'border-cyan-200 bg-cyan-300 text-black' : 'border-white/40 bg-black/25 text-transparent'}`}
                      >
                        <Check className="size-3" strokeWidth={3} />
                      </span>
                    ) : null}
                    {asset.published ? (
                      <span className="absolute top-1.5 right-1.5 rounded bg-black/30 px-1.5 py-0.5 text-[7px] text-emerald-200/75 backdrop-blur-sm">
                        已发布
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function PrototypeControls({
  surfaceState,
  assetCount,
  selectedCount,
  onChange
}: {
  surfaceState: SurfaceState
  assetCount: number
  selectedCount: number
  onChange: (state: SurfaceState) => void
}): React.JSX.Element {
  return (
    <details className="fixed right-4 bottom-4 z-[90] rounded-lg border border-white/8 bg-black/82 text-[9px] text-white/40 shadow-xl backdrop-blur-xl">
      <summary className="cursor-pointer px-2.5 py-2">原型状态 · {surfaceState}</summary>
      <div className="border-t border-white/7 p-2">
        <div className="flex gap-1">
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
              onClick={() => onChange(state)}
              className={`rounded px-2 py-1 ${surfaceState === state ? 'bg-white/12 text-white' : 'hover:bg-white/6'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <pre className="mt-2 leading-4 text-white/28">
          {JSON.stringify({ assetCount, selectedCount }, null, 2)}
        </pre>
      </div>
    </details>
  )
}

export function AssetLibraryPrototype(): React.JSX.Element {
  const [surfaceState, setSurfaceState] = useState<SurfaceState>(readSurfaceState)
  const [tab, setTab] = useState<LibraryTab>('all')
  const [media, setMedia] = useState<MediaFilter>('all')
  const [creator, setCreator] = useState<CreatorFilter>('all')
  const [time, setTime] = useState<TimeFilter>('all')
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest')
  const [searchOpen, setSearchOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [batchMode, setBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [detailAssetId, setDetailAssetId] = useState<string>()
  const [toast, setToast] = useState<string>()

  const assets = useMemo(() => {
    const filtered = ASSETS.filter((asset) => {
      if (tab === 'mine' && !asset.mine) return false
      if (tab === 'published' && !asset.published) return false
      if (media !== 'all' && asset.type !== media) return false
      if (creator !== 'all' && asset.creatorKey !== creator) return false
      if (time === 'today' && asset.bucket !== 'today') return false
      if (time === 'week' && asset.bucket === 'older') return false
      if (search && !asset.title.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
    return sortOrder === 'newest' ? filtered : [...filtered].reverse()
  }, [creator, media, search, sortOrder, tab, time])

  const detailAsset = ASSETS.find((asset) => asset.id === detailAssetId)
  const relatedAssets = detailAsset
    ? ASSETS.filter((asset) => asset.source === detailAsset.source).slice(0, 4)
    : []

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(undefined), 2400)
    return () => window.clearTimeout(timeout)
  }, [toast])

  const changeSurfaceState = (state: SurfaceState): void => {
    setSurfaceState(state)
    updateSurfaceState(state)
  }

  const handleAssetClick = (asset: Asset): void => {
    if (!batchMode) {
      setDetailAssetId(asset.id)
      return
    }
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(asset.id)) next.delete(asset.id)
      else next.add(asset.id)
      return next
    })
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[#111215] text-white">
      <AppRail />
      <main className="prototype-scrollbar min-w-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-30 border-b border-white/6 bg-[#111215]/96 backdrop-blur-xl">
          <div className="mx-auto flex h-[55px] max-w-[1240px] items-center justify-between px-7">
            <nav className="flex h-full items-center gap-7">
              {(
                [
                  ['all', '全部资产'],
                  ['mine', '我的资产'],
                  ['published', '已发布']
                ] as Array<[LibraryTab, string]>
              ).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  onClick={() => setTab(value)}
                  className={`relative h-full text-[11px] transition ${tab === value ? 'text-white' : 'text-white/38 hover:text-white/65'}`}
                >
                  {label}
                  {tab === value ? (
                    <span className="absolute right-0 bottom-0 left-0 h-0.5 bg-white" />
                  ) : null}
                </button>
              ))}
            </nav>
            <div className="flex items-center gap-1.5">
              {searchOpen ? (
                <label className="relative mr-1">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-white/30" />
                  <input
                    autoFocus
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="搜索资产"
                    className="h-8 w-44 rounded-md border border-white/8 bg-white/4 pr-7 pl-8 text-[10px] outline-none placeholder:text-white/24 focus:border-white/16"
                  />
                  <button
                    type="button"
                    aria-label="关闭搜索"
                    onClick={() => {
                      setSearchOpen(false)
                      setSearch('')
                    }}
                    className="absolute top-1/2 right-2 -translate-y-1/2 text-white/25 hover:text-white/60"
                  >
                    <X className="size-3" />
                  </button>
                </label>
              ) : (
                <button
                  type="button"
                  aria-label="搜索资产"
                  onClick={() => setSearchOpen(true)}
                  className="grid size-8 place-items-center rounded-md text-white/45 hover:bg-white/5 hover:text-white/75"
                >
                  <Search className="size-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setBatchMode((value) => !value)
                  setSelectedIds(new Set())
                }}
                className={`flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[10px] ${batchMode ? 'bg-white text-black' : 'bg-white/5 text-white/58 hover:bg-white/8'}`}
              >
                <SquareCheckBig className="size-3.5" /> {batchMode ? '退出批量' : '批量操作'}
              </button>
              <button
                type="button"
                className="flex h-8 items-center gap-1.5 rounded-md bg-white/5 px-2.5 text-[10px] text-white/58 hover:bg-white/8"
              >
                <Plus className="size-3.5" /> 去创作
              </button>
            </div>
          </div>
          <div className="mx-auto flex h-[43px] max-w-[1240px] items-center justify-between px-7">
            <div className="flex items-center gap-5">
              <div className="flex items-center gap-4">
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
                    onClick={() => setMedia(value)}
                    className={`text-[10px] ${media === value ? 'text-white' : 'text-white/36 hover:text-white/65'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="h-3 w-px bg-white/8" />
              <CompactSelect
                label="按创建者筛选"
                icon={<UserRound className="size-3" />}
                value={creator}
                options={[
                  { value: 'all', label: '创建者' },
                  { value: 'mine', label: '我' },
                  { value: 'lin-xia', label: '林夏' },
                  { value: 'chen-mo', label: '陈默' }
                ]}
                onChange={setCreator}
              />
              <CompactSelect
                label="按时间筛选"
                icon={<SlidersHorizontal className="size-3" />}
                value={time}
                options={[
                  { value: 'all', label: '时间' },
                  { value: 'today', label: '今天' },
                  { value: 'week', label: '本周' }
                ]}
                onChange={setTime}
              />
              <CompactSelect
                label="排序"
                icon={<ArrowUpDown className="size-3" />}
                value={sortOrder}
                options={[
                  { value: 'newest', label: '最新优先' },
                  { value: 'oldest', label: '最早优先' }
                ]}
                onChange={setSortOrder}
              />
            </div>
            <span className="text-[9px] text-white/24">
              Atlas Commerce · {assets.length} 项 Media Asset
            </span>
          </div>
        </div>
        <div className="mx-auto max-w-[1240px] px-7 pt-6">
          {surfaceState === 'empty' ? (
            <EmptyState onReady={() => changeSurfaceState('ready')} />
          ) : null}
          {surfaceState === 'error' ? (
            <ErrorState onReady={() => changeSurfaceState('ready')} />
          ) : null}
          {surfaceState === 'ready' ? (
            assets.length > 0 ? (
              <AssetWall
                assets={assets}
                batchMode={batchMode}
                selectedIds={selectedIds}
                onAssetClick={handleAssetClick}
              />
            ) : (
              <EmptyState
                onReady={() => {
                  setTab('all')
                  setMedia('all')
                  setCreator('all')
                  setTime('all')
                  setSearch('')
                }}
              />
            )
          ) : null}
        </div>
      </main>
      {batchMode ? (
        <div className="fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-4 rounded-lg border border-white/10 bg-[#24252a]/96 px-4 py-2.5 shadow-2xl backdrop-blur-xl">
          <span className="text-[11px] text-white/70">已选择 {selectedIds.size} 项</span>
          <span className="h-3 w-px bg-white/10" />
          <button
            type="button"
            disabled={selectedIds.size === 0}
            onClick={() => setToast(`批量下载 ${selectedIds.size} 项资产（原型）`)}
            className="flex items-center gap-1.5 text-[10px] text-white/62 enabled:hover:text-white disabled:opacity-25"
          >
            <Download className="size-3.5" /> 下载选中
          </button>
          <span className="text-[9px] text-white/25">做同款与发布仅支持单项</span>
        </div>
      ) : null}
      {detailAsset ? (
        <DetailPanel
          asset={detailAsset}
          relatedAssets={relatedAssets}
          onClose={() => setDetailAssetId(undefined)}
          onSelectAsset={(asset) => setDetailAssetId(asset.id)}
          onAction={setToast}
        />
      ) : null}
      {import.meta.env.DEV ? (
        <PrototypeControls
          surfaceState={surfaceState}
          assetCount={assets.length}
          selectedCount={selectedIds.size}
          onChange={changeSurfaceState}
        />
      ) : null}
      {toast ? (
        <div
          role="status"
          className="fixed top-4 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-2 rounded-md border border-white/10 bg-[#27282d]/96 px-3 py-2 text-[10px] text-white/75 shadow-xl backdrop-blur-xl"
        >
          <Check className="size-3.5 text-cyan-200" /> {toast}
        </div>
      ) : null}
    </div>
  )
}
