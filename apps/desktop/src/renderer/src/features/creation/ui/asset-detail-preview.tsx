import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog as DialogPrimitive, HoverCard } from 'radix-ui'
import { ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon, CopyIcon, InfoIcon } from 'lucide-react'
import type {
  AssetGenerationSpecification,
  AssetSpecificationReference
} from '../api/asset-library-http'
import type {
  GenerationSpecificationView,
  GenerationSpecificationReferenceView
} from '../api/generation-task-http'
import { modeLabelKey } from '../i18n/mode-keys'
import { ReferenceKindIcon } from './reference-kind-icon'

export interface AssetPreviewReference {
  readonly id: string
  readonly kind: 'image' | 'video' | 'audio'
  readonly fileName: string
}

export interface AssetReferencePreviewSource {
  readonly url: string
  readonly release?: () => void
}

export interface AssetDetailPreviewProps {
  readonly open: boolean
  readonly title: string
  readonly description?: string
  readonly onClose: () => void
  readonly media: React.ReactNode
  readonly status?: 'loading' | 'failed' | 'ready'
  readonly results?: readonly {
    readonly id: string
    readonly label: string
    readonly media: React.ReactNode
  }[]
  readonly selectedResultId?: string
  readonly onSelectResult?: (id: string) => void
  readonly specification?: AssetGenerationSpecification | GenerationSpecificationView | null
  readonly references?: readonly (AssetPreviewReference | null)[]
  readonly loadReferencePreview?: (id: string) => Promise<AssetReferencePreviewSource | null>
  readonly referenceThumbnails?: Readonly<Record<string, string>>
  readonly metadata?: React.ReactNode
  readonly headerActions?: React.ReactNode
  readonly actions?: React.ReactNode
  readonly messages?: React.ReactNode
}

export function AssetPreviewAction({
  icon,
  destructive = false,
  className = '',
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly icon?: React.ReactNode
  readonly destructive?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`hover:bg-accent focus-visible:ring-ring flex min-h-8 min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] outline-none focus-visible:ring-2 disabled:opacity-50 [&>svg]:size-3.5 [&>svg]:shrink-0 ${destructive ? 'text-destructive' : ''} ${className}`}
      {...props}
    >
      {icon}
      {children}
    </button>
  )
}

const EMPTY_RESULTS: NonNullable<AssetDetailPreviewProps['results']> = []
const EMPTY_REFERENCES: NonNullable<AssetDetailPreviewProps['references']> = []

export function AssetDetailPreview({
  open,
  title,
  description,
  onClose,
  media,
  status = 'ready',
  results = EMPTY_RESULTS,
  selectedResultId,
  onSelectResult,
  specification,
  references = EMPTY_REFERENCES,
  loadReferencePreview,
  referenceThumbnails,
  metadata,
  headerActions,
  actions,
  messages
}: AssetDetailPreviewProps): React.JSX.Element {
  const { t } = useTranslation('creation')
  const frameRef = useRef<HTMLDivElement | null>(null)
  const backRef = useRef<HTMLButtonElement | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const [promptExpanded, setPromptExpanded] = useState(false)
  const [detailsExpanded, setDetailsExpanded] = useState(false)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const resultIndex = Math.max(
    0,
    results.findIndex((result) => result.id === selectedResultId)
  )
  const changeResult = (direction: number): void => {
    if (!onSelectResult || results.length < 2) return
    onSelectResult(results[(resultIndex + direction + results.length) % results.length].id)
  }

  useLayoutEffect(() => {
    if (!open) return
    const frame = frameRef.current
    if (!frame) return
    // Only the covered page becomes inert; App Shell navigation remains usable.
    const covered = Array.from(frame.parentElement?.children ?? []).filter(
      (element): element is HTMLElement => element instanceof HTMLElement && element !== frame
    )
    const previous = covered.map((element) => element.inert)
    covered.forEach((element) => {
      element.inert = true
    })
    return () =>
      covered.forEach((element, index) => {
        element.inert = previous[index]
      })
  }, [open])

  const keyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
      !(
        event.target instanceof HTMLElement &&
        event.target.closest('input,textarea,video,audio,[contenteditable]')
      )
    ) {
      if (results.length > 1) {
        event.preventDefault()
        changeResult(event.key === 'ArrowLeft' ? -1 : 1)
      }
    }
    if (event.key !== 'Tab') return
    const frame = frameRef.current
    if (!frame) return
    const focusable = Array.from(
      document.querySelectorAll<HTMLElement>(
        'a[href],button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),video[controls],audio[controls],[tabindex="0"]'
      )
    ).filter(
      (element) =>
        element.getClientRects().length > 0 &&
        !element.closest('[inert],[aria-hidden="true"]') &&
        getComputedStyle(element).visibility !== 'hidden'
    )
    const inside = focusable.filter((element) => frame.contains(element))
    const edge = event.shiftKey ? inside[0] : inside.at(-1)
    // Non-modal Radix loops Tab by default. At the edge, allow the sidebar.
    if (event.target === edge && focusable.some((element) => !frame.contains(element))) {
      const index = focusable.indexOf(edge)
      event.preventDefault()
      focusable[(index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus()
    }
  }

  return (
    <DialogPrimitive.Root
      open={open}
      modal={false}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogPrimitive.Content
        ref={frameRef}
        data-testid="asset-detail-preview"
        className="bg-background text-foreground absolute inset-0 z-30 grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_310px] overflow-hidden outline-none max-[720px]:grid-cols-1 max-[720px]:grid-rows-[minmax(0,1fr)_320px] min-[1100px]:grid-cols-[minmax(0,1fr)_346px]"
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          returnFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
          setPromptExpanded(false)
          setCopyStatus('idle')
          backRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true })
        }}
        onKeyDown={keyboard}
      >
        <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
        <DialogPrimitive.Description className="sr-only">
          {description ?? t('assets.detailDescription')}
        </DialogPrimitive.Description>
        <section
          className="relative grid min-h-0 min-w-0 place-items-center overflow-hidden px-5 pt-16 pb-[18px] min-[1100px]:px-[42px]"
          aria-label={t('preview.media')}
        >
          <button
            ref={backRef}
            type="button"
            aria-label={t('preview.close')}
            onClick={onClose}
            className="group hover:bg-accent focus-visible:ring-ring absolute top-[15px] left-[17px] z-10 flex items-center gap-2 rounded-md p-1.5 outline-none focus-visible:ring-2"
          >
            <ArrowLeftIcon className="size-5" aria-hidden />
            <span className="text-muted-foreground text-xs opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">
              {t('preview.back')}
            </span>
          </button>
          <div className="size-full max-h-[calc(100svh-180px)] max-w-[945px] min-w-0 [&_img]:object-contain [&_video]:object-contain">
            {status === 'loading' ? (
              <p
                role="status"
                className="text-muted-foreground grid size-full place-items-center text-sm"
              >
                {t('assets.loadingDetail')}
              </p>
            ) : status === 'failed' ? (
              <p
                role="alert"
                className="text-muted-foreground grid size-full place-items-center text-sm"
              >
                {t('assets.detailFailed')}
              </p>
            ) : (
              media
            )}
          </div>
          {results.length > 1 && onSelectResult && (
            <div
              className="bg-popover/90 text-muted-foreground absolute bottom-7 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-[9px] border px-[7px] py-1 text-xs"
              aria-label={t('assets.siblings')}
            >
              <AssetPreviewAction
                aria-label={t('preview.previous')}
                onClick={() => changeResult(-1)}
                className="min-h-6 px-1 py-0"
              >
                <ChevronLeftIcon className="size-3.5" aria-hidden />
              </AssetPreviewAction>
              <span className="tabular-nums">
                {resultIndex + 1} / {results.length}
              </span>
              <AssetPreviewAction
                aria-label={t('preview.next')}
                onClick={() => changeResult(1)}
                className="min-h-6 px-1 py-0"
              >
                <ChevronRightIcon className="size-3.5" aria-hidden />
              </AssetPreviewAction>
            </div>
          )}
        </section>
        <aside
          className="bg-card flex min-h-0 min-w-0 flex-col border-l max-[720px]:border-t max-[720px]:border-l-0"
          aria-label={t('preview.information')}
        >
          <header className="flex h-20 shrink-0 items-center gap-2 border-b px-5 max-[720px]:h-12">
            {headerActions}
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-[30px] pb-3 text-xs">
            {results.length > 0 && (
              <div
                className="mb-[17px] flex gap-1.5 overflow-x-auto pb-1"
                role="group"
                aria-label={t('assets.siblings')}
              >
                {results.map((result) => (
                  <button
                    key={result.id}
                    type="button"
                    aria-label={result.label}
                    aria-pressed={result.id === selectedResultId}
                    onClick={() => onSelectResult?.(result.id)}
                    className={`bg-muted focus-visible:ring-ring size-[72px] shrink-0 overflow-hidden rounded-[10px] border-2 outline-none focus-visible:ring-2 ${result.id === selectedResultId ? 'border-foreground' : 'border-transparent'}`}
                  >
                    <span className="pointer-events-none block size-full [&_img]:object-cover [&_video]:object-cover">
                      {result.media}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {specification && (
              <>
                <section className="mb-[17px]">
                  <div className="text-muted-foreground mb-2 flex items-center justify-between text-[11px]">
                    <h2>{t('preview.prompt')}</h2>
                    <button
                      type="button"
                      aria-label={t('preview.copyPrompt')}
                      title={t('preview.copyPrompt')}
                      className="hover:text-foreground rounded p-1"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(specification.prompt)
                          setCopyStatus('copied')
                        } catch {
                          setCopyStatus('failed')
                        }
                      }}
                    >
                      <CopyIcon className="size-3" aria-hidden />
                    </button>
                  </div>
                  <p
                    className={`text-foreground/80 leading-[1.6] whitespace-pre-wrap ${promptExpanded ? '' : 'line-clamp-3'}`}
                  >
                    {specification.prompt}
                  </p>
                  <button
                    type="button"
                    aria-expanded={promptExpanded}
                    className="text-muted-foreground hover:text-foreground pt-1.5 text-[11px]"
                    onClick={() => setPromptExpanded((current) => !current)}
                  >
                    {t(promptExpanded ? 'preview.collapsePrompt' : 'preview.expandPrompt')}
                  </button>
                  {copyStatus !== 'idle' && (
                    <p
                      role={copyStatus === 'failed' ? 'alert' : 'status'}
                      className="text-muted-foreground mt-1 text-[10px]"
                    >
                      {t(copyStatus === 'copied' ? 'preview.copied' : 'preview.copyFailed')}
                    </p>
                  )}
                </section>
                <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-[11px]">
                  {specification.references.length > 0 && (
                    <ReferenceCarousel
                      key={selectedResultId ?? title}
                      frozen={specification.references}
                      references={references}
                      thumbnails={referenceThumbnails}
                      loadPreview={loadReferencePreview}
                    />
                  )}
                  <span>{t(modeLabelKey(specification.mode))}</span>
                  <span aria-hidden className="text-border px-0.5">
                    |
                  </span>
                  <span className="break-all">{specification.model}</span>
                  {specification.ratio && (
                    <>
                      <span aria-hidden className="text-border px-0.5">
                        |
                      </span>
                      <span>{specification.ratio}</span>
                    </>
                  )}
                  {specification.resolution && (
                    <>
                      <span aria-hidden className="text-border px-0.5">
                        |
                      </span>
                      <span>{specification.resolution}</span>
                    </>
                  )}
                </div>
              </>
            )}
            <button
              type="button"
              aria-expanded={detailsExpanded}
              onClick={() => setDetailsExpanded((current) => !current)}
              className="text-muted-foreground hover:text-foreground mt-2.5 flex items-center gap-1.5 text-xs"
            >
              {t('preview.details')}
              <InfoIcon className="size-3.5" aria-hidden />
            </button>
            {detailsExpanded && (
              <div className="mt-2.5 space-y-3 border-t pt-2.5">
                {metadata}
                {specification && (
                  <>
                    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[10px]">
                      <dt className="text-muted-foreground">{t('gallery.details.mode')}</dt>
                      <dd>{t(modeLabelKey(specification.mode))}</dd>
                      <dt className="text-muted-foreground">{t('composer.model.label')}</dt>
                      <dd className="break-all">{specification.model}</dd>
                      <dt className="text-muted-foreground">{t('composer.params.ratio')}</dt>
                      <dd>{specification.ratio ?? '—'}</dd>
                      <dt className="text-muted-foreground">{t('composer.params.resolution')}</dt>
                      <dd>{specification.resolution ?? '—'}</dd>
                      {specification.quality != null && (
                        <>
                          <dt className="text-muted-foreground">{t('composer.params.quality')}</dt>
                          <dd>{specification.quality}</dd>
                        </>
                      )}
                      <dt className="text-muted-foreground">{t('gallery.details.quantity')}</dt>
                      <dd>{specification.quantity}</dd>
                      <dt className="text-muted-foreground">{t('gallery.details.duration')}</dt>
                      <dd>
                        {specification.durationSeconds === null
                          ? '—'
                          : t('assets.details.seconds', { n: specification.durationSeconds })}
                      </dd>
                      {'schemaVersion' in specification && (
                        <>
                          <dt className="text-muted-foreground">
                            {t('inspiration.schemaVersion')}
                          </dt>
                          <dd>{specification.schemaVersion}</dd>
                          <dt className="text-muted-foreground">
                            {t('inspiration.manifestVersion')}
                          </dt>
                          <dd>{specification.manifestVersion}</dd>
                        </>
                      )}
                    </dl>
                    <section className="space-y-1.5 text-[10px]">
                      <h3 className="text-muted-foreground">
                        {t('inspiration.references')} ({specification.references.length})
                      </h3>
                      {specification.references.length === 0 ? (
                        <p>{t('inspiration.noReferences')}</p>
                      ) : (
                        <ol className="space-y-1.5">
                          {specification.references.map(
                            (
                              frozen:
                                | GenerationSpecificationReferenceView
                                | AssetSpecificationReference,
                              index: number
                            ) => {
                              const reference = references[index]
                              const roleKeys = {
                                reference: 'gallery.role.reference',
                                first_frame: 'gallery.role.firstFrame',
                                last_frame: 'gallery.role.lastFrame',
                                omni: 'gallery.role.omni'
                              } as const
                              const role =
                                frozen.role in roleKeys
                                  ? t(roleKeys[frozen.role as keyof typeof roleKeys])
                                  : frozen.role
                              return (
                                <li key={`${index}:${frozen.materialId}`} className="break-words">
                                  {index + 1}.{' '}
                                  {reference?.fileName ?? t('inspiration.unavailableReference')} ·{' '}
                                  {role} · {t(`composer.mention.kind.${frozen.kind}`)}
                                  {'claimsVersion' in frozen && reference ? (
                                    <>
                                      {' '}
                                      ·{' '}
                                      {t('inspiration.claimsVersion', {
                                        version: frozen.claimsVersion
                                      })}
                                    </>
                                  ) : null}
                                </li>
                              )
                            }
                          )}
                        </ol>
                      )}
                    </section>
                  </>
                )}
              </div>
            )}
          </div>
          {(actions || messages) && (
            <footer
              className="shrink-0 px-4 pt-3 pb-4 max-[720px]:max-h-[140px] max-[720px]:overflow-auto"
              aria-label={t('preview.actions')}
            >
              {actions && (
                <div className="bg-foreground/[0.06] dark:bg-foreground/[0.08] grid auto-rows-fr grid-cols-2 gap-1 rounded-xl p-1.5 [&_button]:min-h-10 [&_button]:gap-2.5 [&_button]:rounded-lg [&_button]:px-3 [&_button]:py-2 [&_button]:text-xs [&_button>svg]:size-4">
                  {actions}
                </div>
              )}
              {messages && <div className="mt-2 text-xs">{messages}</div>}
            </footer>
          )}
        </aside>
      </DialogPrimitive.Content>
    </DialogPrimitive.Root>
  )
}

function ReferenceCarousel({
  frozen,
  references,
  thumbnails,
  loadPreview
}: {
  readonly frozen: readonly {
    readonly materialId: string
    readonly kind: AssetPreviewReference['kind']
  }[]
  readonly references: readonly (AssetPreviewReference | null)[]
  readonly thumbnails?: Readonly<Record<string, string>>
  readonly loadPreview?: (id: string) => Promise<AssetReferencePreviewSource | null>
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const [source, setSource] = useState<{
    index: number
    attempt: number
    url: string | null
  } | null>(null)
  const [failedThumbnail, setFailedThumbnail] = useState<string | null>(null)
  const automaticRetry = useRef(false)
  const reference = references[index]
  const current = source?.index === index && source.attempt === attempt ? source : null
  const suppliedThumbnail = reference ? thumbnails?.[reference.id] : undefined
  const validThumbnail = suppliedThumbnail !== failedThumbnail ? suppliedThumbnail : undefined
  const shouldLoad = Boolean(
    reference &&
    loadPreview &&
    (open || source?.index === index || (reference.kind === 'image' && !validThumbnail))
  )
  const change = (direction: number): void => {
    automaticRetry.current = false
    setIndex((current) => (current + direction + frozen.length) % frozen.length)
  }
  useEffect(() => {
    if (!reference || !loadPreview || !shouldLoad) return
    let active = true
    let release: (() => void) | undefined
    void loadPreview(reference.id)
      .then((result) => {
        if (!active) {
          result?.release?.()
          return
        }
        release = result?.release
        setSource({ index, attempt, url: result?.url ?? null })
      })
      .catch(() => {
        if (active) setSource({ index, attempt, url: null })
      })
    return () => {
      active = false
      release?.()
    }
  }, [attempt, index, loadPreview, reference, shouldLoad])
  const elementError = (): void => {
    if (automaticRetry.current) setSource({ index, attempt, url: null })
    else {
      automaticRetry.current = true
      setAttempt((current) => current + 1)
    }
  }
  const thumbnail = reference
    ? (validThumbnail ?? (reference.kind === 'image' ? current?.url : null))
    : null
  return (
    <HoverCard.Root open={open} onOpenChange={setOpen} openDelay={150} closeDelay={180}>
      <HoverCard.Trigger asChild>
        <button
          type="button"
          aria-label={t('preview.references', { count: frozen.length })}
          aria-expanded={open}
          onClick={() => setOpen(true)}
          onFocus={() => setOpen(true)}
          className="focus-visible:ring-ring relative mr-0.5 h-[31px] w-[34px] shrink-0 outline-none focus-visible:ring-2"
        >
          <span className="bg-muted absolute top-[3px] right-0 grid size-[23px] place-items-center overflow-hidden rounded-[7px] border">
            <ReferenceKindIcon
              kind={frozen[Math.min(1, frozen.length - 1)].kind}
              className="size-3"
            />
          </span>
          <span className="bg-muted absolute top-px left-0 z-10 grid size-[27px] place-items-center overflow-hidden rounded-[7px] border">
            {thumbnail ? (
              <img
                src={thumbnail}
                alt=""
                className="size-full object-cover"
                onError={() => {
                  if (validThumbnail) setFailedThumbnail(validThumbnail)
                  else elementError()
                }}
              />
            ) : (
              <ReferenceKindIcon kind={frozen[index].kind} className="size-3.5" />
            )}
          </span>
        </button>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="left"
          align="start"
          sideOffset={12}
          collisionPadding={10}
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            setOpen(false)
          }}
          className="bg-popover text-popover-foreground z-50 h-[540px] max-h-[calc(100svh-20px)] w-[360px] max-w-[calc(100vw-20px)] overflow-hidden rounded-[30px] border shadow-2xl"
          data-testid="asset-reference-preview"
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault()
              event.stopPropagation()
              change(event.key === 'ArrowLeft' ? -1 : 1)
            }
          }}
        >
          {!reference || !loadPreview ? (
            <p
              role="status"
              className="text-muted-foreground grid size-full place-items-center p-6 text-center"
            >
              {t('inspiration.unavailableReference')}
            </p>
          ) : current === null ? (
            <p role="status" className="text-muted-foreground grid size-full place-items-center">
              {t('gallery.media.loading')}
            </p>
          ) : current.url === null ? (
            <div
              role="alert"
              className="grid size-full place-content-center justify-items-center gap-3 p-6"
            >
              <p>{t('gallery.media.failed')}</p>
              <AssetPreviewAction
                onClick={() => {
                  automaticRetry.current = false
                  setAttempt((current) => current + 1)
                }}
              >
                {t('state.retry')}
              </AssetPreviewAction>
            </div>
          ) : reference.kind === 'image' ? (
            <img
              src={current.url}
              alt={reference.fileName}
              className="size-full object-contain"
              onError={elementError}
              onLoad={() => {
                automaticRetry.current = false
              }}
            />
          ) : reference.kind === 'video' ? (
            <video
              src={current.url}
              aria-label={reference.fileName}
              className="size-full object-contain"
              controls
              playsInline
              onError={elementError}
              onLoadedData={() => {
                automaticRetry.current = false
              }}
            />
          ) : (
            <div className="grid size-full place-items-center px-5">
              <audio
                src={current.url}
                aria-label={reference.fileName}
                className="w-full"
                controls
                onError={elementError}
                onLoadedData={() => {
                  automaticRetry.current = false
                }}
              />
            </div>
          )}
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 bg-gradient-to-b from-black/60 to-transparent px-[18px] pt-4 pb-9 text-white">
            <div className="min-w-0 text-sm font-medium">
              <p>{t('preview.referenceCount', { index: index + 1, total: frozen.length })}</p>
              <p className="mt-1 truncate text-[10px] font-normal">
                {reference?.fileName ?? t('inspiration.unavailableReference')}
              </p>
            </div>
            {frozen.length > 1 && (
              <div className="pointer-events-auto flex overflow-hidden rounded-xl bg-black/40">
                <AssetPreviewAction
                  aria-label={t('preview.previousReference')}
                  onClick={() => change(-1)}
                  className="min-h-[42px] px-3"
                >
                  <ChevronLeftIcon className="size-5" aria-hidden />
                </AssetPreviewAction>
                <AssetPreviewAction
                  aria-label={t('preview.nextReference')}
                  onClick={() => change(1)}
                  className="min-h-[42px] px-3"
                >
                  <ChevronRightIcon className="size-5" aria-hidden />
                </AssetPreviewAction>
              </div>
            )}
          </div>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  )
}
