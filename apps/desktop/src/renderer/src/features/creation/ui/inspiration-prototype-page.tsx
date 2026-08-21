import { useEffect, useMemo, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  BadgeCheckIcon,
  BoxesIcon,
  CirclePlayIcon,
  CopyPlusIcon,
  GiftIcon,
  ImageIcon,
  PackageCheckIcon,
  PackageIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  VideoIcon,
  WandSparklesIcon
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  InspirationPrototypeSwitcher,
  type PrototypeVariant
} from './inspiration-prototype-switcher'

// PROTOTYPE — throwaway UI. Three variants of the Inspiration Page live on the same
// /inspiration-prototype route and switch through ?variant=A|B|C.

type Source = 'all' | 'official' | 'discovery'
type MediaType = 'all' | 'image' | 'video'
type Category = 'all' | 'scene' | 'marketing' | 'video-ad'
type Motif = 'bottle' | 'package' | 'shoe' | 'gift' | 'speaker' | 'outdoor'

interface InspirationItem {
  readonly id: string
  readonly source: Exclude<Source, 'all'>
  readonly mediaType: Exclude<MediaType, 'all'>
  readonly category: Exclude<Category, 'all'>
  readonly title: string
  readonly description: string
  readonly prompt: string
  readonly parameters: readonly string[]
  readonly references: readonly string[]
  readonly motif: Motif
  readonly coverClass: string
  readonly author?: string
  readonly publishedAt?: string
}

interface CreationSessionDraft {
  readonly visibility: 'private'
  readonly sourcePublicationId: string
  readonly sourceTitle: string
  readonly sourceType: InspirationItem['source']
  readonly mediaType: InspirationItem['mediaType']
  readonly references: readonly string[]
  readonly parameters: readonly string[]
  readonly prompt: string
}

const inspirationItems: readonly InspirationItem[] = [
  {
    id: 'official-clean-studio',
    source: 'official',
    mediaType: 'image',
    category: 'scene',
    title: '纯净商拍',
    description: '把随手拍的商品图转成有呼吸感的棚拍主图。',
    prompt: '保留商品外形与材质，在浅暖灰摄影棚中完成干净、柔和的商业产品摄影。',
    parameters: ['1:1', '2K', '2 张', '图片'],
    references: ['主商品图', '可选：补充角度'],
    motif: 'bottle',
    coverClass: 'from-amber-100 via-stone-100 to-orange-200'
  },
  {
    id: 'official-context-display',
    source: 'official',
    mediaType: 'image',
    category: 'scene',
    title: '情境陈列',
    description: '让商品自然进入厨房、居家或户外使用场景。',
    prompt: '将主商品陈列在温暖现代厨房，保持尺寸可信，使用清晨侧光和自然生活痕迹。',
    parameters: ['4:3', '2K', '2 张', '图片'],
    references: ['主商品图', '场景参考图'],
    motif: 'package',
    coverClass: 'from-lime-100 via-emerald-100 to-teal-300'
  },
  {
    id: 'official-selling-point',
    source: 'official',
    mediaType: 'image',
    category: 'marketing',
    title: '卖点聚焦',
    description: '用一个清楚的视觉动作突出商品核心卖点。',
    prompt: '围绕轻量与缓震卖点制作高冲击商品海报，鞋体悬浮，保留后续排版留白。',
    parameters: ['4:5', '2K', '2 张', '图片'],
    references: ['主商品图'],
    motif: 'shoe',
    coverClass: 'from-blue-500 via-indigo-400 to-rose-400'
  },
  {
    id: 'official-festival',
    source: 'official',
    mediaType: 'image',
    category: 'marketing',
    title: '节日氛围',
    description: '快速形成可继续排版的节庆商品视觉。',
    prompt: '在克制的新年红金氛围中呈现礼盒，使用丝绸与柔光，不生成任何文字。',
    parameters: ['4:5', '2K', '2 张', '图片'],
    references: ['主商品图', '配色参考'],
    motif: 'gift',
    coverClass: 'from-red-950 via-red-700 to-amber-400'
  },
  {
    id: 'official-product-camera',
    source: 'official',
    mediaType: 'video',
    category: 'video-ad',
    title: '商品运镜',
    description: '用单一、明确的镜头动作建立短视频开场。',
    prompt: '镜头快速靠近便携音箱后环绕半周，灯带随节奏流动，商品外观保持一致。',
    parameters: ['9:16', '720p', '5 秒', '1 条'],
    references: ['首帧商品图'],
    motif: 'speaker',
    coverClass: 'from-fuchsia-950 via-violet-700 to-cyan-400'
  },
  {
    id: 'official-scene-performance',
    source: 'official',
    mediaType: 'video',
    category: 'video-ad',
    title: '场景演绎',
    description: '让商品在真实情境里完成一段可理解的动作。',
    prompt: '清晨户外营地，镜头横移跟随保温杯被放上木桌，远景雾气缓慢流动。',
    parameters: ['16:9', '720p', '5 秒', '1 条'],
    references: ['首帧商品图', '场景参考图'],
    motif: 'outdoor',
    coverClass: 'from-sky-300 via-emerald-200 to-amber-200'
  },
  {
    id: 'publication-linen-lamp',
    source: 'discovery',
    mediaType: 'image',
    category: 'scene',
    title: '亚麻晨光里的便携灯',
    description: '用低饱和室内光把便携灯做成生活方式主图。',
    prompt: '便携灯放在亚麻桌布上，窗外晨光形成柔和阴影，环境安静、真实、有生活感。',
    parameters: ['4:5', '2K', '2 张', '图片'],
    references: ['便携灯正面', '亚麻材质参考'],
    motif: 'bottle',
    coverClass: 'from-stone-200 via-amber-100 to-orange-300',
    author: '林一',
    publishedAt: '今天 10:24'
  },
  {
    id: 'publication-coffee-motion',
    source: 'discovery',
    mediaType: 'video',
    category: 'video-ad',
    title: '咖啡机的一镜到底',
    description: '组织成员发布的 5 秒横版产品运镜。',
    prompt: '镜头从咖啡豆落下开始，平滑推进到咖啡机出液，最后停在完整商品与杯子。',
    parameters: ['16:9', '720p', '5 秒', '1 条'],
    references: ['咖啡机首帧', '镜头节奏参考'],
    motif: 'package',
    coverClass: 'from-amber-950 via-orange-700 to-yellow-300',
    author: '周屿',
    publishedAt: '昨天 18:03'
  },
  {
    id: 'publication-summer-shoe',
    source: 'discovery',
    mediaType: 'image',
    category: 'marketing',
    title: '轻跑鞋夏日主视觉',
    description: '强调透气与轻量的高饱和视觉实验。',
    prompt: '鞋体从蓝色水面跃起，细小水珠定格，珊瑚色光带强调轻盈轨迹，预留标题区。',
    parameters: ['4:5', '2K', '4 张', '图片'],
    references: ['鞋侧面', '鞋底', '色彩参考'],
    motif: 'shoe',
    coverClass: 'from-cyan-400 via-blue-600 to-orange-400',
    author: 'Mira',
    publishedAt: '8 月 19 日'
  },
  {
    id: 'publication-holiday-box',
    source: 'discovery',
    mediaType: 'image',
    category: 'marketing',
    title: '秋季礼盒陈列',
    description: '组织内部复用次数最多的礼盒氛围方案。',
    prompt: '深棕木台上陈列礼盒，以枫叶与暖色反射形成秋季氛围，保持商品标签区域干净。',
    parameters: ['1:1', '2K', '2 张', '图片'],
    references: ['礼盒正面', '材质参考'],
    motif: 'gift',
    coverClass: 'from-orange-950 via-amber-700 to-yellow-300',
    author: '陈梨',
    publishedAt: '8 月 18 日'
  },
  {
    id: 'publication-serum-macro',
    source: 'discovery',
    mediaType: 'image',
    category: 'marketing',
    title: '精华液水光微距',
    description: '以水面反射和玻璃质感突出精华液的通透卖点。',
    prompt: '透明精华液瓶悬浮在浅蓝水面上，微距水珠与折射高光清晰，画面轻盈、通透。',
    parameters: ['3:4', '2K', '2 张', '图片'],
    references: ['精华液正面', '瓶身材质参考'],
    motif: 'bottle',
    coverClass: 'from-sky-100 via-cyan-300 to-blue-700',
    author: 'Ada',
    publishedAt: '8 月 17 日'
  },
  {
    id: 'publication-travel-organizer',
    source: 'discovery',
    mediaType: 'image',
    category: 'scene',
    title: '旅行收纳包窗边场景',
    description: '把收纳包放进真实出行前的整理时刻。',
    prompt: '旅行收纳包摊开放在窗边木桌，衣物分区整齐，午后自然光呈现真实织物纹理。',
    parameters: ['4:3', '2K', '2 张', '图片'],
    references: ['收纳包俯拍', '织物细节'],
    motif: 'package',
    coverClass: 'from-rose-200 via-orange-100 to-sky-300',
    author: '宋嘉',
    publishedAt: '8 月 16 日'
  },
  {
    id: 'publication-camp-bottle',
    source: 'discovery',
    mediaType: 'video',
    category: 'video-ad',
    title: '晨雾营地水杯运镜',
    description: '用纵向镜头完成保温杯户外功能感开场。',
    prompt: '竖版镜头贴近带露水的保温杯向上移动，背景营地晨雾缓慢散开，保持杯身一致。',
    parameters: ['9:16', '720p', '5 秒', '1 条'],
    references: ['保温杯首帧', '营地氛围'],
    motif: 'outdoor',
    coverClass: 'from-slate-700 via-emerald-500 to-amber-200',
    author: 'Kiko',
    publishedAt: '8 月 15 日'
  },
  {
    id: 'publication-speaker-beat',
    source: 'discovery',
    mediaType: 'video',
    category: 'video-ad',
    title: '音箱节奏光影实验',
    description: '让光带和镜头节奏共同表达便携音箱的能量感。',
    prompt: '黑色空间中便携音箱缓慢旋转，紫青光带随低频闪动，镜头最终推近材质细节。',
    parameters: ['9:16', '720p', '5 秒', '1 条'],
    references: ['音箱三视图', '灯光节奏参考'],
    motif: 'speaker',
    coverClass: 'from-neutral-950 via-purple-800 to-cyan-400',
    author: 'Arlo',
    publishedAt: '8 月 14 日'
  }
]

const coverIcons: Record<Motif, LucideIcon> = {
  bottle: PackageIcon,
  package: BoxesIcon,
  shoe: PackageCheckIcon,
  gift: GiftIcon,
  speaker: CirclePlayIcon,
  outdoor: SparklesIcon
}

const mediaLabels: Record<MediaType, string> = {
  all: '全部媒体',
  image: '图片',
  video: '视频'
}

const categoryLabels: Record<Category, string> = {
  all: '全部场景',
  scene: '商品场景',
  marketing: '营销视觉',
  'video-ad': '短视频广告'
}

export interface InspirationPrototypePageProps {
  readonly variant: PrototypeVariant
  readonly onVariantChange: (variant: PrototypeVariant) => void
}

export function InspirationPrototypePage({
  variant,
  onVariantChange
}: InspirationPrototypePageProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<Source>(() => (variant === 'A' ? 'official' : 'all'))
  const [mediaType, setMediaType] = useState<MediaType>('all')
  const [category, setCategory] = useState<Category>('all')
  const [selectedItem, setSelectedItem] = useState<InspirationItem | null>(null)
  const [draft, setDraft] = useState<CreationSessionDraft | null>(null)
  const [view, setView] = useState<'inspiration' | 'session'>('inspiration')
  const topAnchorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    topAnchorRef.current?.scrollIntoView({ block: 'start' })
  }, [variant, view])

  const commonFilteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return inspirationItems.filter((item) => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        [item.title, item.description, item.prompt, item.author ?? '']
          .join(' ')
          .toLocaleLowerCase()
          .includes(normalizedQuery)
      const matchesMedia = mediaType === 'all' || item.mediaType === mediaType
      const matchesCategory = category === 'all' || item.category === category
      return matchesQuery && matchesMedia && matchesCategory
    })
  }, [category, mediaType, query])

  const visibleItems =
    source === 'all'
      ? commonFilteredItems
      : commonFilteredItems.filter((item) => item.source === source)

  function resetFilters(): void {
    setQuery('')
    setMediaType('all')
    setCategory('all')
  }

  function createSimilar(item: InspirationItem): void {
    setDraft({
      visibility: 'private',
      sourcePublicationId: item.id,
      sourceTitle: item.title,
      sourceType: item.source,
      mediaType: item.mediaType,
      references: [...item.references],
      parameters: [...item.parameters],
      prompt: item.prompt
    })
    setSelectedItem(null)
    setView('session')
  }

  const stateSnapshot = {
    variant,
    view,
    filters: { query, source, mediaType, category },
    visibleItemIds: visibleItems.map((item) => item.id),
    selectedItemId: selectedItem?.id ?? null,
    creationSessionDraft: draft
  }

  return (
    <>
      <div ref={topAnchorRef} />
      {view === 'session' && draft ? (
        <CreationWorkbenchPrototype
          draft={draft}
          onDraftChange={setDraft}
          onBack={() => setView('inspiration')}
        />
      ) : variant === 'A' ? (
        <VariantA
          query={query}
          source={source === 'discovery' ? 'discovery' : 'official'}
          mediaType={mediaType}
          category={category}
          items={visibleItems}
          onQueryChange={setQuery}
          onSourceChange={setSource}
          onMediaTypeChange={setMediaType}
          onCategoryChange={setCategory}
          onSelect={setSelectedItem}
          onReset={resetFilters}
        />
      ) : variant === 'B' ? (
        <VariantB
          query={query}
          mediaType={mediaType}
          category={category}
          items={commonFilteredItems}
          onQueryChange={setQuery}
          onMediaTypeChange={setMediaType}
          onCategoryChange={setCategory}
          onSelect={setSelectedItem}
          onReset={resetFilters}
        />
      ) : (
        <VariantC
          query={query}
          source={source}
          mediaType={mediaType}
          category={category}
          items={visibleItems}
          selectedItem={selectedItem}
          onQueryChange={setQuery}
          onSourceChange={setSource}
          onMediaTypeChange={setMediaType}
          onCategoryChange={setCategory}
          onSelect={setSelectedItem}
          onCreateSimilar={createSimilar}
          onReset={resetFilters}
        />
      )}

      <ItemDetailSheet
        item={variant === 'C' ? null : selectedItem}
        onOpenChange={(open) => {
          if (!open) setSelectedItem(null)
        }}
        onCreateSimilar={createSimilar}
      />
      <PrototypeStateInspector state={stateSnapshot} />
      <InspirationPrototypeSwitcher
        variant={variant}
        onVariantChange={(nextVariant) => {
          setView('inspiration')
          setSelectedItem(null)
          setSource(nextVariant === 'A' ? 'official' : 'all')
          onVariantChange(nextVariant)
        }}
      />
    </>
  )
}

interface FilterControlsProps {
  readonly query: string
  readonly mediaType: MediaType
  readonly category: Category
  readonly onQueryChange: (value: string) => void
  readonly onMediaTypeChange: (value: MediaType) => void
  readonly onCategoryChange: (value: Category) => void
  readonly compact?: boolean
}

function FilterControls({
  query,
  mediaType,
  category,
  onQueryChange,
  onMediaTypeChange,
  onCategoryChange,
  compact = false
}: FilterControlsProps): React.JSX.Element {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${compact ? '' : 'w-full'}`}>
      <div className={`relative ${compact ? 'min-w-56 flex-1' : 'min-w-64 flex-1'}`}>
        <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          className="bg-background/70 pl-9"
          placeholder="搜索场景、提示词或发布者"
          aria-label="搜索灵感"
        />
      </div>
      <FilterPillGroup
        label="媒体"
        value={mediaType}
        options={mediaLabels}
        onChange={(value) => onMediaTypeChange(value as MediaType)}
      />
      <FilterPillGroup
        label="场景"
        value={category}
        options={categoryLabels}
        onChange={(value) => onCategoryChange(value as Category)}
      />
    </div>
  )
}

function FilterPillGroup({
  label,
  value,
  options,
  onChange
}: {
  readonly label: string
  readonly value: string
  readonly options: Record<string, string>
  readonly onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <label className="border-border bg-background/70 flex h-9 items-center gap-2 rounded-lg border px-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="bg-transparent font-medium outline-none"
      >
        {Object.entries(options).map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue} className="bg-popover">
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  )
}

function VariantA({
  query,
  source,
  mediaType,
  category,
  items,
  onQueryChange,
  onSourceChange,
  onMediaTypeChange,
  onCategoryChange,
  onSelect,
  onReset
}: {
  readonly query: string
  readonly source: Exclude<Source, 'all'>
  readonly mediaType: MediaType
  readonly category: Category
  readonly items: readonly InspirationItem[]
  readonly onQueryChange: (value: string) => void
  readonly onSourceChange: (value: Source) => void
  readonly onMediaTypeChange: (value: MediaType) => void
  readonly onCategoryChange: (value: Category) => void
  readonly onSelect: (item: InspirationItem) => void
  readonly onReset: () => void
}): React.JSX.Element {
  return (
    <main className="bg-background min-h-full flex-1 px-4 pb-28 sm:px-6">
      <section className="mx-auto max-w-[1500px]">
        <header className="relative overflow-hidden px-4 pt-12 pb-9 text-center sm:pt-16">
          <div className="bg-primary/12 absolute top-4 left-1/2 h-44 w-[34rem] -translate-x-1/2 rounded-full blur-[100px]" />
          <div className="relative">
            <p className="text-primary text-xs font-semibold tracking-[0.2em] uppercase">
              Nevix AI Creation
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              今天，想从哪种灵感开始？
            </h1>
            <p className="text-muted-foreground mx-auto mt-3 max-w-xl text-sm leading-6">
              浏览官方模板与当前 Organization 已发布作品，找到起点后直接做同款。
            </p>

            <div className="border-border bg-card/80 focus-within:border-primary/45 focus-within:ring-primary/10 mx-auto mt-7 flex max-w-3xl items-center rounded-2xl border p-1.5 shadow-2xl shadow-black/20 transition focus-within:ring-4">
              <SearchIcon className="text-muted-foreground ml-3 size-5 shrink-0" />
              <Input
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                className="h-12 border-0 bg-transparent px-3 text-base shadow-none focus-visible:ring-0"
                placeholder="搜索商品、场景、提示词或发布者"
                aria-label="搜索灵感"
              />
              <div className="bg-primary text-primary-foreground mr-1 grid size-9 shrink-0 place-items-center rounded-xl">
                <SparklesIcon className="size-4" />
              </div>
            </div>
          </div>
        </header>

        <Tabs value={source} onValueChange={(value) => onSourceChange(value as Source)}>
          <div className="border-border flex flex-wrap items-end justify-between gap-x-5 gap-y-3 border-b">
            <TabsList variant="line" className="h-12 gap-6 bg-transparent">
              <TabsTrigger value="official" className="h-12 px-0 text-base">
                <BadgeCheckIcon /> 官方精选
              </TabsTrigger>
              <TabsTrigger value="discovery" className="h-12 px-0 text-base">
                <SparklesIcon /> 当前组织 · 发现
              </TabsTrigger>
            </TabsList>
            <span className="text-muted-foreground pb-3 text-xs">
              {source === 'official' ? 'Nevix 策划 · Official Template' : '星河出海 · 已发布'} ·{' '}
              {items.length} 个结果
            </span>
          </div>
        </Tabs>

        <div className="flex flex-wrap items-center gap-2 py-4">
          {(Object.entries(categoryLabels) as [Category, string][]).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`rounded-full px-3 py-1.5 text-xs transition-colors ${
                category === value
                  ? 'bg-foreground text-background font-medium'
                  : 'bg-muted/60 text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
              onClick={() => onCategoryChange(value)}
            >
              {label}
            </button>
          ))}
          <span className="bg-border mx-1 h-4 w-px" />
          {(Object.entries(mediaLabels) as [MediaType, string][]).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`rounded-full px-3 py-1.5 text-xs transition-colors ${
                mediaType === value
                  ? 'bg-primary/15 text-primary font-medium'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
              onClick={() => onMediaTypeChange(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {items.length > 0 ? (
          <div className="columns-2 gap-3 md:columns-3 lg:columns-4">
            {items.map((item) => (
              <MasonryGalleryCard key={item.id} item={item} onSelect={onSelect} />
            ))}
          </div>
        ) : (
          <EmptyState onReset={onReset} />
        )}
      </section>
    </main>
  )
}

function VariantB({
  query,
  mediaType,
  category,
  items,
  onQueryChange,
  onMediaTypeChange,
  onCategoryChange,
  onSelect,
  onReset
}: {
  readonly query: string
  readonly mediaType: MediaType
  readonly category: Category
  readonly items: readonly InspirationItem[]
  readonly onQueryChange: (value: string) => void
  readonly onMediaTypeChange: (value: MediaType) => void
  readonly onCategoryChange: (value: Category) => void
  readonly onSelect: (item: InspirationItem) => void
  readonly onReset: () => void
}): React.JSX.Element {
  const official = items.filter((item) => item.source === 'official')
  const discovery = items.filter((item) => item.source === 'discovery')

  return (
    <main className="bg-muted/20 min-h-full flex-1 px-6 pb-28">
      <div className="mx-auto max-w-7xl">
        <header className="border-border bg-background/90 sticky top-0 z-10 -mx-6 border-b px-6 py-5 backdrop-blur">
          <div className="mb-4 flex items-start justify-between gap-6">
            <div>
              <p className="text-primary text-xs font-semibold tracking-[0.18em] uppercase">
                Inspiration room
              </p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">灵感展厅</h1>
            </div>
            <div className="text-muted-foreground max-w-sm text-right text-xs leading-5">
              两种来源并列展示，不需要先选择频道。来源、维护者和可复用边界始终在视野内。
            </div>
          </div>
          <FilterControls
            query={query}
            mediaType={mediaType}
            category={category}
            onQueryChange={onQueryChange}
            onMediaTypeChange={onMediaTypeChange}
            onCategoryChange={onCategoryChange}
          />
        </header>

        {items.length === 0 ? (
          <div className="mt-8">
            <EmptyState onReset={onReset} />
          </div>
        ) : (
          <div className="grid min-h-[700px] grid-cols-[minmax(280px,0.8fr)_minmax(0,1.7fr)] gap-6 py-6">
            <section className="border-border bg-card rounded-2xl border p-4 shadow-sm">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2 font-semibold">
                    <BadgeCheckIcon className="text-primary size-4" /> 官方精选
                  </div>
                  <p className="text-muted-foreground mt-1 text-xs">稳定、策划、可预测</p>
                </div>
                <Badge variant="secondary">{official.length}</Badge>
              </div>
              <div className="space-y-2">
                {official.map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    className="border-border hover:bg-accent flex w-full items-center gap-3 rounded-xl border p-2 text-left transition-colors"
                    onClick={() => onSelect(item)}
                  >
                    <CoverVisual item={item} className="size-16 shrink-0 rounded-lg" compact />
                    <span className="min-w-0 flex-1">
                      <span className="text-muted-foreground text-[10px] font-medium tracking-widest">
                        0{index + 1}
                      </span>
                      <span className="block truncate text-sm font-medium">{item.title}</span>
                      <span className="text-muted-foreground block truncate text-xs">
                        {item.parameters.slice(0, 2).join(' · ')}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2 font-semibold">
                    <SparklesIcon className="text-primary size-4" /> 当前组织 · 发现
                  </div>
                  <p className="text-muted-foreground mt-1 text-xs">星河出海成员发布的可复用快照</p>
                </div>
                <Badge variant="outline">{discovery.length} 个已发布</Badge>
              </div>

              {discovery.length > 0 ? (
                <>
                  <button
                    type="button"
                    className="group border-border bg-card grid w-full grid-cols-[1.2fr_1fr] overflow-hidden rounded-2xl border text-left shadow-sm"
                    onClick={() => onSelect(discovery[0])}
                  >
                    <CoverVisual item={discovery[0]} className="min-h-64" />
                    <span className="flex flex-col justify-between p-6">
                      <span>
                        <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                          已发布
                        </Badge>
                        <span className="mt-4 block text-xl font-semibold">
                          {discovery[0].title}
                        </span>
                        <span className="text-muted-foreground mt-2 block text-sm leading-6">
                          {discovery[0].description}
                        </span>
                      </span>
                      <span className="text-muted-foreground mt-6 block text-xs">
                        {discovery[0].author} · {discovery[0].publishedAt}
                      </span>
                    </span>
                  </button>

                  <div className="space-y-2">
                    {discovery.slice(1).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="border-border bg-card hover:bg-accent flex w-full items-center gap-4 rounded-xl border p-3 text-left transition-colors"
                        onClick={() => onSelect(item)}
                      >
                        <CoverVisual
                          item={item}
                          className="h-20 w-28 shrink-0 rounded-lg"
                          compact
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate font-medium">{item.title}</span>
                            <Badge variant="secondary" className="shrink-0 text-[10px]">
                              已发布
                            </Badge>
                          </span>
                          <span className="text-muted-foreground mt-1 block truncate text-xs">
                            {item.author} · {item.parameters.join(' · ')}
                          </span>
                        </span>
                        <CopyPlusIcon className="text-muted-foreground size-4" />
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <OrganizationEmptyState onReset={onReset} />
              )}
            </section>
          </div>
        )}
      </div>
    </main>
  )
}

function VariantC({
  query,
  source,
  mediaType,
  category,
  items,
  selectedItem,
  onQueryChange,
  onSourceChange,
  onMediaTypeChange,
  onCategoryChange,
  onSelect,
  onCreateSimilar,
  onReset
}: {
  readonly query: string
  readonly source: Source
  readonly mediaType: MediaType
  readonly category: Category
  readonly items: readonly InspirationItem[]
  readonly selectedItem: InspirationItem | null
  readonly onQueryChange: (value: string) => void
  readonly onSourceChange: (value: Source) => void
  readonly onMediaTypeChange: (value: MediaType) => void
  readonly onCategoryChange: (value: Category) => void
  readonly onSelect: (item: InspirationItem) => void
  readonly onCreateSimilar: (item: InspirationItem) => void
  readonly onReset: () => void
}): React.JSX.Element {
  const inspectedItem = selectedItem ?? items[0] ?? null

  return (
    <main className="bg-background min-h-full flex-1 pb-28">
      <div className="grid min-h-[calc(100vh-4rem)] grid-cols-[220px_minmax(360px,1fr)_minmax(320px,0.9fr)]">
        <aside className="border-border bg-muted/25 border-r p-4">
          <div className="mb-7 flex items-center gap-2 font-semibold">
            <SlidersHorizontalIcon className="size-4" /> 灵感检索
          </div>
          <FilterSection title="来源">
            {(
              [
                ['all', '全部来源'],
                ['official', '官方精选'],
                ['discovery', '组织发现']
              ] as const
            ).map(([value, label]) => (
              <FilterButton
                key={value}
                active={source === value}
                label={label}
                onClick={() => onSourceChange(value)}
              />
            ))}
          </FilterSection>
          <FilterSection title="媒体">
            {(Object.entries(mediaLabels) as [MediaType, string][]).map(([value, label]) => (
              <FilterButton
                key={value}
                active={mediaType === value}
                label={label}
                onClick={() => onMediaTypeChange(value)}
              />
            ))}
          </FilterSection>
          <FilterSection title="场景">
            {(Object.entries(categoryLabels) as [Category, string][]).map(([value, label]) => (
              <FilterButton
                key={value}
                active={category === value}
                label={label}
                onClick={() => onCategoryChange(value)}
              />
            ))}
          </FilterSection>
        </aside>

        <section className="border-border min-w-0 border-r p-5">
          <div className="mb-5">
            <p className="text-muted-foreground text-xs font-medium tracking-[0.16em] uppercase">
              Search-first catalogue
            </p>
            <h1 className="mt-1 text-2xl font-semibold">先找对起点，再看细节</h1>
          </div>
          <div className="relative mb-4">
            <SearchIcon className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              className="pl-9"
              placeholder="搜索提示词、作品或成员"
              aria-label="搜索灵感"
            />
          </div>
          <div className="text-muted-foreground mb-2 flex items-center justify-between text-xs">
            <span>{items.length} 个匹配项</span>
            <span>来源清楚优先于视觉沉浸</span>
          </div>

          {items.length > 0 ? (
            <div className="divide-border border-border overflow-hidden rounded-xl border">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`flex w-full items-center gap-3 border-b p-3 text-left transition-colors last:border-b-0 ${
                    inspectedItem?.id === item.id ? 'bg-accent' : 'hover:bg-muted/50'
                  }`}
                  onClick={() => onSelect(item)}
                >
                  <CoverVisual item={item} className="h-16 w-20 shrink-0 rounded-md" compact />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{item.title}</span>
                      <SourceBadge item={item} compact />
                    </span>
                    <span className="text-muted-foreground mt-1 block truncate text-xs">
                      {item.parameters.join(' · ')}
                    </span>
                  </span>
                  {item.mediaType === 'video' ? (
                    <VideoIcon className="text-muted-foreground size-4" />
                  ) : (
                    <ImageIcon className="text-muted-foreground size-4" />
                  )}
                </button>
              ))}
            </div>
          ) : (
            <EmptyState onReset={onReset} />
          )}
        </section>

        <aside className="bg-card min-w-0 p-5">
          {inspectedItem ? (
            <InlineDetail item={inspectedItem} onCreateSimilar={onCreateSimilar} />
          ) : (
            <div className="text-muted-foreground grid h-full place-items-center text-sm">
              选择一个结果查看完整复用快照
            </div>
          )}
        </aside>
      </div>
    </main>
  )
}

const masonryCoverClasses: Record<string, string> = {
  'official-clean-studio': 'aspect-[4/5]',
  'official-context-display': 'aspect-[3/4]',
  'official-selling-point': 'aspect-[4/5]',
  'official-festival': 'aspect-square',
  'official-product-camera': 'aspect-[9/14]',
  'official-scene-performance': 'aspect-[4/3]',
  'publication-linen-lamp': 'aspect-[4/5]',
  'publication-coffee-motion': 'aspect-[9/14]',
  'publication-summer-shoe': 'aspect-[3/4]',
  'publication-holiday-box': 'aspect-square',
  'publication-serum-macro': 'aspect-[3/4]',
  'publication-travel-organizer': 'aspect-[4/3]',
  'publication-camp-bottle': 'aspect-[9/14]',
  'publication-speaker-beat': 'aspect-[9/16]'
}

function MasonryGalleryCard({
  item,
  onSelect
}: {
  readonly item: InspirationItem
  readonly onSelect: (item: InspirationItem) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="group mb-3 inline-block w-full break-inside-avoid text-left"
      onClick={() => onSelect(item)}
    >
      <span className="bg-card relative block overflow-hidden rounded-xl">
        <CoverVisual item={item} className={masonryCoverClasses[item.id] ?? 'aspect-[4/5]'} />
        <span className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-black/15 opacity-70 transition-opacity group-hover:opacity-90" />
        <span className="absolute top-3 left-3">
          <SourceBadge item={item} compact />
        </span>
        <span className="absolute right-3 bottom-3 translate-y-1 rounded-full bg-black/55 px-3 py-1.5 text-[11px] font-medium text-white opacity-0 backdrop-blur transition group-hover:translate-y-0 group-hover:opacity-100">
          查看详情
        </span>
      </span>
      <span className="block px-1 pt-2.5 pb-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.title}</span>
          {item.mediaType === 'video' ? (
            <CirclePlayIcon className="text-muted-foreground size-3.5 shrink-0" />
          ) : null}
        </span>
        <span className="text-muted-foreground mt-1 flex items-center justify-between gap-2 text-[11px]">
          <span className="truncate">
            {item.source === 'official' ? 'Nevix 策划' : item.author}
          </span>
          <span className="shrink-0">{item.parameters.slice(0, 2).join(' · ')}</span>
        </span>
      </span>
    </button>
  )
}

function CoverVisual({
  item,
  className,
  compact = false
}: {
  readonly item: InspirationItem
  readonly className: string
  readonly compact?: boolean
}): React.JSX.Element {
  const Icon = coverIcons[item.motif]
  return (
    <span
      className={`relative grid overflow-hidden bg-gradient-to-br ${item.coverClass} ${className}`}
      aria-hidden="true"
    >
      <span className="absolute -top-8 -right-6 size-24 rounded-full bg-white/35 blur-xl" />
      <span className="absolute -bottom-8 -left-6 size-28 rounded-full bg-black/15 blur-2xl" />
      <span className="relative grid place-items-center self-stretch">
        <span
          className={`grid place-items-center rounded-[28%] border border-white/35 bg-black/20 text-white shadow-2xl backdrop-blur-sm ${
            compact ? 'size-9' : 'size-20'
          }`}
        >
          <Icon className={compact ? 'size-4' : 'size-9'} strokeWidth={1.4} />
        </span>
      </span>
      {item.mediaType === 'video' ? (
        <span className="absolute right-2 bottom-2 grid size-7 place-items-center rounded-full bg-black/65 text-white">
          <CirclePlayIcon className="size-4" />
        </span>
      ) : null}
    </span>
  )
}

function SourceBadge({
  item,
  compact = false
}: {
  readonly item: InspirationItem
  readonly compact?: boolean
}): React.JSX.Element {
  return item.source === 'official' ? (
    <Badge variant="secondary" className={compact ? 'text-[10px]' : ''}>
      官方模板
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className={`border-emerald-500/30 text-emerald-700 dark:text-emerald-300 ${compact ? 'text-[10px]' : ''}`}
    >
      已发布
    </Badge>
  )
}

function ItemDetailSheet({
  item,
  onOpenChange,
  onCreateSimilar
}: {
  readonly item: InspirationItem | null
  readonly onOpenChange: (open: boolean) => void
  readonly onCreateSimilar: (item: InspirationItem) => void
}): React.JSX.Element {
  return (
    <Sheet open={item !== null} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto sm:max-w-lg">
        {item ? (
          <>
            <CoverVisual item={item} className="aspect-[16/10] w-full" />
            <SheetHeader>
              <div className="mb-2 flex items-center gap-2">
                <SourceBadge item={item} />
                <Badge variant="outline">
                  {item.source === 'official' ? 'Nevix 策划' : '当前 Organization'}
                </Badge>
              </div>
              <SheetTitle className="text-xl">{item.title}</SheetTitle>
              <SheetDescription>{item.description}</SheetDescription>
              {item.source === 'discovery' ? (
                <p className="text-muted-foreground pt-1 text-xs">
                  {item.author} 发布于 {item.publishedAt} · 不可变复用快照
                </p>
              ) : null}
            </SheetHeader>
            <div className="space-y-5 px-4 pb-4">
              <DetailSection title="提示词">
                <p className="bg-muted rounded-lg p-3 text-sm leading-6">{item.prompt}</p>
              </DetailSection>
              <DetailSection title="生成参数">
                <div className="flex flex-wrap gap-2">
                  {item.parameters.map((parameter) => (
                    <Badge key={parameter} variant="secondary">
                      {parameter}
                    </Badge>
                  ))}
                </div>
              </DetailSection>
              <DetailSection title="可复用参考素材">
                <div className="grid grid-cols-2 gap-2">
                  {item.references.map((reference, index) => (
                    <div key={reference} className="border-border rounded-lg border p-3">
                      <div className="bg-muted mb-2 grid aspect-[4/3] place-items-center rounded-md">
                        <PackageIcon className="text-muted-foreground size-6" />
                      </div>
                      <p className="text-xs font-medium">
                        {index + 1}. {reference}
                      </p>
                    </div>
                  ))}
                </div>
              </DetailSection>
              <p className="border-border text-muted-foreground border-t pt-4 text-xs leading-5">
                “做同款”只复制提示词、参数与授权参考素材；不会复制成品、发布者、任务、用量或供应商连接。
              </p>
            </div>
            <SheetFooter>
              <Button className="w-full" onClick={() => onCreateSimilar(item)}>
                <WandSparklesIcon /> 做同款
              </Button>
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function InlineDetail({
  item,
  onCreateSimilar
}: {
  readonly item: InspirationItem
  readonly onCreateSimilar: (item: InspirationItem) => void
}): React.JSX.Element {
  return (
    <div className="space-y-5">
      <CoverVisual item={item} className="aspect-[16/10] rounded-xl" />
      <div>
        <div className="mb-2 flex items-center gap-2">
          <SourceBadge item={item} />
          <Badge variant="outline">{item.mediaType === 'image' ? '图片' : '视频'}</Badge>
        </div>
        <h2 className="text-xl font-semibold">{item.title}</h2>
        <p className="text-muted-foreground mt-1 text-sm leading-5">{item.description}</p>
      </div>
      <DetailSection title="提示词">
        <p className="bg-muted rounded-lg p-3 text-sm leading-6">{item.prompt}</p>
      </DetailSection>
      <DetailSection title="参数">
        <div className="flex flex-wrap gap-2">
          {item.parameters.map((parameter) => (
            <Badge key={parameter} variant="secondary">
              {parameter}
            </Badge>
          ))}
        </div>
      </DetailSection>
      <DetailSection title={`参考素材 · ${item.references.length}`}>
        <ol className="text-muted-foreground space-y-1 text-xs">
          {item.references.map((reference, index) => (
            <li key={reference}>
              {index + 1}. {reference}
            </li>
          ))}
        </ol>
      </DetailSection>
      <Button className="w-full" onClick={() => onCreateSimilar(item)}>
        <WandSparklesIcon /> 做同款，进入私有创作会话
      </Button>
    </div>
  )
}

function DetailSection({
  title,
  children
}: {
  readonly title: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold tracking-wide">{title}</h3>
      {children}
    </section>
  )
}

function CreationWorkbenchPrototype({
  draft,
  onDraftChange,
  onBack
}: {
  readonly draft: CreationSessionDraft
  readonly onDraftChange: (draft: CreationSessionDraft) => void
  readonly onBack: () => void
}): React.JSX.Element {
  return (
    <main className="bg-muted/20 min-h-full flex-1 px-6 pb-28">
      <div className="mx-auto max-w-6xl py-6">
        <div className="mb-6 flex items-center justify-between gap-4">
          <div>
            <Button variant="ghost" size="sm" className="mb-2 -ml-3" onClick={onBack}>
              ← 返回灵感页
            </Button>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold">新的 Creation Session</h1>
              <Badge className="bg-violet-500/15 text-violet-700 dark:text-violet-300">
                仅自己可见
              </Badge>
            </div>
            <p className="text-muted-foreground mt-1 text-sm">
              来源：{draft.sourceTitle} · 已按值复制为可编辑草稿，尚未创建 Generation Task
            </p>
          </div>
          <Badge variant="outline">PROTOTYPE · 不会保存</Badge>
        </div>

        <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(280px,0.7fr)] gap-5">
          <section className="border-border bg-card space-y-6 rounded-2xl border p-5 shadow-sm">
            <DetailSection title="参考素材">
              <div className="flex gap-3 overflow-x-auto pb-1">
                {draft.references.map((reference, index) => (
                  <div
                    key={reference}
                    className="border-border w-32 shrink-0 rounded-xl border p-2"
                  >
                    <div className="bg-muted grid aspect-square place-items-center rounded-lg">
                      <PackageIcon className="text-muted-foreground size-7" />
                    </div>
                    <p className="mt-2 truncate text-xs">
                      {index + 1}. {reference}
                    </p>
                  </div>
                ))}
                <button
                  type="button"
                  className="border-border text-muted-foreground hover:bg-accent grid w-32 shrink-0 place-items-center rounded-xl border border-dashed text-xs"
                >
                  + 添加参考
                </button>
              </div>
            </DetailSection>
            <DetailSection title="提示词">
              <textarea
                value={draft.prompt}
                onChange={(event) => onDraftChange({ ...draft, prompt: event.target.value })}
                className="border-input bg-background focus-visible:ring-ring min-h-40 w-full resize-none rounded-xl border p-4 text-sm leading-6 outline-none focus-visible:ring-2"
              />
            </DetailSection>
            <div className="border-border bg-muted/40 rounded-xl border p-4 text-xs leading-5">
              <div className="mb-1 flex items-center gap-2 font-medium">
                <CopyPlusIcon className="size-4" /> 直接来源已记录
              </div>
              <p className="text-muted-foreground">
                该关系只表示“从这里开始创作”，不授予权限，也不会让草稿随来源撤回而消失。
              </p>
            </div>
          </section>

          <aside className="border-border bg-card h-fit rounded-2xl border p-5 shadow-sm">
            <h2 className="mb-5 font-semibold">生成设置</h2>
            <div className="space-y-3">
              {draft.parameters.map((parameter, index) => (
                <div
                  key={`${parameter}-${index}`}
                  className="border-border flex items-center justify-between rounded-lg border px-3 py-2 text-sm"
                >
                  <span className="text-muted-foreground">参数 {index + 1}</span>
                  <span className="font-medium">{parameter}</span>
                </div>
              ))}
            </div>
            <div className="mt-5 rounded-lg bg-amber-500/10 p-3 text-xs leading-5 text-amber-800 dark:text-amber-200">
              当前模型能力若不再支持复制值，正式产品必须保留草稿并要求显式调整，不能静默降级。
            </div>
            <Button className="mt-5 w-full" disabled>
              原型不提交真实生成
            </Button>
          </aside>
        </div>
      </div>
    </main>
  )
}

function EmptyState({ onReset }: { readonly onReset: () => void }): React.JSX.Element {
  return (
    <div className="border-border bg-card grid min-h-72 place-items-center rounded-2xl border border-dashed p-8 text-center">
      <div>
        <SearchIcon className="text-muted-foreground mx-auto size-8" />
        <h2 className="mt-4 font-semibold">没有匹配的灵感</h2>
        <p className="text-muted-foreground mt-1 text-sm">换一个关键词，或清除媒体与场景筛选。</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={onReset}>
          清除筛选
        </Button>
      </div>
    </div>
  )
}

function OrganizationEmptyState({ onReset }: { readonly onReset: () => void }): React.JSX.Element {
  return (
    <div className="border-border bg-card rounded-2xl border border-dashed p-8 text-center">
      <SparklesIcon className="text-muted-foreground mx-auto size-7" />
      <h3 className="mt-3 font-medium">当前筛选下还没有组织发布</h3>
      <p className="text-muted-foreground mt-1 text-xs">
        Discovery 为空不影响成员从 Official Selection 开始创作。
      </p>
      <Button variant="ghost" size="sm" className="mt-3" onClick={onReset}>
        查看全部发布
      </Button>
    </div>
  )
}

function FilterSection({
  title,
  children
}: {
  readonly title: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mb-6">
      <h2 className="text-muted-foreground mb-2 text-xs font-medium">{title}</h2>
      <div className="space-y-1">{children}</div>
    </section>
  )
}

function FilterButton({
  active,
  label,
  onClick
}: {
  readonly active: boolean
  readonly label: string
  readonly onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
        active ? 'bg-foreground text-background font-medium' : 'hover:bg-accent'
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function PrototypeStateInspector({ state }: { readonly state: unknown }): React.JSX.Element {
  if (import.meta.env.PROD) return <></>
  return (
    <aside className="pointer-events-none fixed right-4 bottom-4 z-[65] max-h-44 w-72 overflow-auto rounded-xl border border-white/10 bg-neutral-950/90 p-3 text-[10px] leading-4 text-white/75 shadow-2xl backdrop-blur">
      <div className="mb-1 flex items-center gap-1.5 font-semibold text-white">
        <SlidersHorizontalIcon className="size-3" /> 完整原型状态
      </div>
      <pre className="whitespace-pre-wrap">{JSON.stringify(state, null, 2)}</pre>
    </aside>
  )
}
