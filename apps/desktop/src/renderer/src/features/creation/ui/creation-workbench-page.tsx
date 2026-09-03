import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FileImageIcon,
  ImageIcon,
  MoreHorizontalIcon,
  PencilLineIcon,
  SparklesIcon,
  Trash2Icon,
  VideoIcon
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../../../components/ui/dropdown-menu'
import type { CreationSessionView } from '../api/go-creation-http'
import { useCreationWorkbench } from '../model/use-workbench'
import { textPromptDocument } from '../model/prompt-document'
import { ComposerMenuContent } from './composer-menu-content'
import { CreationComposer } from './composer'
import { ResultGallery } from './result-gallery'
import { isScrolledToBottom } from './use-composer-presence'

/**
 * The production Creation Workbench (issue #177): the accepted prototype
 * layout — a private session list on the left, one continuous workspace on
 * the right, and the fixed bottom Composer with the inline reference deck and
 * upward capability controls. Loading/empty/error stay explicit so cached
 * data can never masquerade as authoritative server facts.
 *
 * Intentional deviations from the prototype snapshot (6e465e8): no asset
 * library entry (this slice has no production asset-library destination), no
 * list-collapse control (dead controls are not shipped), and session rows
 * carry a hover actions menu (rename, delete) instead of inline controls.
 * The "new conversation" row enters a composing round without a server
 * session; the session materializes only at first submit (see
 * useCreationWorkbench).
 */
export function CreationWorkbenchPage(): React.JSX.Element | null {
  const workbench = useCreationWorkbench()
  const { t } = useTranslation('creation')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [showBackToBottom, setShowBackToBottom] = useState(false)
  // The gallery displays tasks old→new, so the head of the server's
  // newest-first page is the newest card at the bottom; a changed head means
  // new content to reveal there. That jump is instant so the back-to-bottom
  // pill never flashes mid-glide — only the creator-invited return animates.
  const newestTaskId = workbench.tasks[0]?.id ?? null
  const returningRef = useRef(false)
  const lastScrollTopRef = useRef(0)
  useEffect(() => {
    if (newestTaskId === null) return
    const scroller = scrollRef.current
    if (scroller === null) return
    const frame = requestAnimationFrame(() => {
      scroller.scrollTo({ top: scroller.scrollHeight })
    })
    return () => cancelAnimationFrame(frame)
  }, [newestTaskId])
  const scrollToBottom = (): void => {
    const scroller = scrollRef.current
    if (scroller === null) return
    returningRef.current = true
    setShowBackToBottom(false)
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
  }

  // A composing round owns the workspace exactly like a selected session —
  // its session does not exist on the server yet.
  const workspaceActive = workbench.selected !== null || workbench.composingNew

  // The bottom reserve keeps gallery content clear of the floating
  // composer: the wrapper's measured height plus its bottom inset and a
  // clearance gap. Grow-only (high-water): shrinking with the compact form
  // would pull a scrolled-away view back inside the at-bottom slack and
  // oscillate. While bottom-pinned, growth bumps scrollTop by the same
  // delta so it never reads as scrolled-away.
  const composerWrapRef = useRef<HTMLDivElement | null>(null)
  const reserveRef = useRef(0)
  useLayoutEffect(() => {
    if (!workspaceActive) return
    const scroller = scrollRef.current
    const wrap = composerWrapRef.current
    if (scroller === null || wrap === null) return
    const apply = (): void => {
      const needed =
        Math.ceil(wrap.getBoundingClientRect().height) +
        parseFloat(getComputedStyle(wrap).bottom) +
        16
      const current = reserveRef.current
      if (needed <= current) return
      const pinned = isScrolledToBottom(scroller)
      scroller.style.paddingBottom = `${needed}px`
      reserveRef.current = needed
      if (pinned) scroller.scrollTop += needed - current
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [workspaceActive])

  if (!workbench.ports) return null

  return (
    <section className="flex min-h-0 flex-1 overflow-hidden" data-testid="creation-workbench">
      <aside
        aria-label={t('sessions.label')}
        className="bg-sidebar flex w-[210px] shrink-0 flex-col border-r"
      >
        <div className="flex h-12 shrink-0 items-center px-4">
          <h2 className="text-foreground text-sm font-semibold">{t('sessions.label')}</h2>
        </div>
        <div className="px-2 pb-1">
          <button
            type="button"
            data-testid="session-new"
            onClick={workbench.startNewDraft}
            className="hover:bg-foreground/[0.04] flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50"
          >
            <span className="bg-foreground/[0.06] text-foreground grid size-7 shrink-0 place-items-center rounded-md border">
              <PencilLineIcon className="size-3.5" aria-hidden />
            </span>
            <span className="text-foreground truncate text-xs font-medium">
              {t('sessions.newAction')}
            </span>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-1">
          {workbench.sessions.length === 0 && workbench.status === 'ready' ? (
            <p className="text-muted-foreground px-1 py-2 text-xs" role="status">
              {t('sessions.empty')}
            </p>
          ) : (
            <ul className="grid gap-0.5" data-testid="session-list">
              {workbench.sessions.map((session, index) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  index={index}
                  selected={workbench.selectedId === session.id}
                  onSelect={() => workbench.selectSession(session)}
                  onDelete={() => workbench.deleteSession(session.id)}
                  onRename={(name) => workbench.renameSession(session.id, name)}
                />
              ))}
            </ul>
          )}
          {workbench.status === 'loading' && (
            <p role="status" className="text-muted-foreground px-1 py-2 text-xs">
              {t('state.loading')}
            </p>
          )}
          {workbench.status === 'error' && (
            <div role="alert" className="grid gap-1 px-1 py-2">
              <p className="text-xs">{t('state.loadFailed')}</p>
              <button
                type="button"
                className="hover:bg-accent rounded border px-2 py-1 text-xs"
                onClick={workbench.reload}
              >
                {t('state.retry')}
              </button>
            </div>
          )}
        </div>
        <p className="text-muted-foreground border-t px-3 py-3 text-[9px]">
          {t('sessions.private')}
        </p>
      </aside>
      <main aria-label={t('workspace.label')} className="relative min-w-0 flex-1 overflow-hidden">
        {workspaceActive ? (
          <>
            <div
              ref={scrollRef}
              onScroll={() => {
                const scroller = scrollRef.current
                if (scroller === null) return
                const { scrollTop } = scroller
                const away = !isScrolledToBottom(scroller)
                // An upward move means the creator took over mid-glide; stop
                // suppressing the pill so it reflects where they actually are.
                const tookOver = scrollTop < lastScrollTopRef.current
                lastScrollTopRef.current = scrollTop
                if (returningRef.current) {
                  if (!away || tookOver) returningRef.current = false
                  else return
                }
                setShowBackToBottom(away)
              }}
              className="h-full overflow-y-auto px-6"
            >
              {/* The greeting hero is the empty-session state: clearing the
                  prompt must never hide a session that already holds tasks. */}
              {workbench.expandedPrompt.length === 0 && workbench.tasks.length === 0 ? (
                <div className="mx-auto flex min-h-full max-w-[720px] flex-col items-center justify-center pb-10">
                  <EmptyDraftHero
                    onUseTemplate={(prompt) =>
                      workbench.patchDraft({ promptDocument: textPromptDocument(prompt) })
                    }
                  />
                </div>
              ) : (
                <div className="mx-auto max-w-[820px] pt-16">
                  <div className="mb-3 flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <h1 className="text-foreground truncate text-base font-semibold">
                        {workbench.selected !== null && workbench.selected.name.length > 0
                          ? workbench.selected.name
                          : t('sessions.unnamed')}
                      </h1>
                      <p className="text-muted-foreground mt-1 text-[10px]">
                        {workbench.draft.mediaType !== null
                          ? t(`composer.media.${workbench.draft.mediaType}`)
                          : t('workspace.draftMeta')}
                      </p>
                    </div>
                  </div>
                  {workbench.submitError !== null && (
                    <p
                      role="alert"
                      data-testid="gallery-submit-error"
                      className="text-destructive mb-3 text-[11px]"
                    >
                      {t('gallery.submitFailed', { code: workbench.submitError })}
                      <button
                        type="button"
                        onClick={workbench.dismissSubmitError}
                        className="text-muted-foreground ml-2 underline outline-none"
                      >
                        {t('gallery.indeterminate.cancel')}
                      </button>
                    </p>
                  )}
                  <ResultGallery workbench={workbench} />
                </div>
              )}
            </div>
            <CreationComposer
              workbench={workbench}
              scrollerRef={scrollRef}
              wrapperRef={composerWrapRef}
              backToBottomVisible={showBackToBottom}
              onBackToBottom={scrollToBottom}
            />
          </>
        ) : (
          <EmptyWorkspace />
        )}
      </main>
    </section>
  )
}

/**
 * The list rows mirror the prototype's compact density (prototype 6e465e8):
 * one line with a gradient thumbnail tile and the name. Hovering reveals the
 * actions trigger; its menu carries rename (edited inline in the row) and
 * delete. The tile is purely decorative — the list endpoint carries no cover
 * or media state.
 */
const rowGradients = [
  'from-cyan-950 to-slate-800',
  'from-sky-950 to-zinc-800',
  'from-indigo-950 to-slate-800',
  'from-neutral-900 to-cyan-950'
] as const

function SessionRow({
  session,
  index,
  selected,
  onSelect,
  onDelete,
  onRename
}: {
  readonly session: CreationSessionView
  readonly index: number
  readonly selected: boolean
  readonly onSelect: () => void
  readonly onDelete: () => void
  readonly onRename: (name: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const name = session.name.length > 0 ? session.name : t('sessions.unnamed')
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  // Escape must not double-fire the blur-driven commit when the input unmounts.
  const renameCancelledRef = useRef(false)

  const beginRename = (): void => {
    renameCancelledRef.current = false
    setDraftName(session.name)
    setRenaming(true)
  }
  const endRename = (): void => {
    setRenaming(false)
    if (renameCancelledRef.current) return
    const next = draftName.trim()
    if (next !== session.name) onRename(next)
  }

  return (
    // The row container owns the background so the primary button and the
    // actions trigger sit on one continuous surface (the trigger cannot nest
    // inside the button — interactive elements do not nest); the controlled
    // menu keeps the row lit while its portal is open.
    <li
      className={
        'group relative flex items-center gap-1 rounded-md ' +
        (renaming ? '' : selected || menuOpen ? 'bg-accent' : 'hover:bg-foreground/[0.04]')
      }
    >
      {renaming ? (
        <form
          className="bg-accent flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            endRename()
          }}
        >
          <SessionTile index={index} />
          <input
            autoFocus
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={endRename}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                renameCancelledRef.current = true
                setRenaming(false)
              }
            }}
            aria-label={t('sessions.rename.label')}
            maxLength={128}
            data-testid="session-rename-input"
            className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-xs font-medium outline-none"
          />
        </form>
      ) : (
        <>
          <button
            type="button"
            onClick={onSelect}
            aria-current={selected ? 'true' : undefined}
            aria-label={name}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50"
          >
            <SessionTile index={index} />
            <span className="text-foreground block truncate text-xs font-medium">{name}</span>
          </button>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger
              aria-label={t('sessions.menu.open')}
              data-testid={`session-menu-${session.id}`}
              className="text-muted-foreground hover:text-foreground mr-1.5 rounded p-1 opacity-0 outline-none group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-sky-400/50 data-[state=open]:opacity-100"
            >
              <MoreHorizontalIcon className="size-5" aria-hidden />
            </DropdownMenuTrigger>
            <ComposerMenuContent side="bottom" align="start" sideOffset={4}>
              <DropdownMenuItem
                onSelect={beginRename}
                data-testid={`session-rename-${session.id}`}
                className="text-xs"
              >
                <PencilLineIcon className="size-3.5" aria-hidden />
                {t('sessions.menu.rename')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={onDelete}
                data-testid={`session-delete-${session.id}`}
                className="text-xs"
              >
                <Trash2Icon className="size-3.5" aria-hidden />
                {t('sessions.menu.delete')}
              </DropdownMenuItem>
            </ComposerMenuContent>
          </DropdownMenu>
        </>
      )}
    </li>
  )
}

function SessionTile({ index }: { readonly index: number }): React.JSX.Element {
  return (
    <span
      className={`grid size-7 shrink-0 place-items-center rounded bg-gradient-to-br ${rowGradients[index % rowGradients.length]}`}
    >
      <FileImageIcon className="size-3.5 text-white/75" aria-hidden />
    </span>
  )
}

/**
 * The empty-draft workspace state follows the accepted prototype's empty
 * session: greeting hero plus starter template cards; picking one fills the
 * draft prompt (prototype `onPromptChange`) and autosaves. The prototype's
 * "Official Template" badge is intentionally dropped — production carries no
 * fake third-party branding.
 */
const templateCards = [
  { key: 'scene', Icon: ImageIcon, gradient: 'from-amber-950 via-stone-900 to-sky-950' },
  { key: 'series', Icon: ImageIcon, gradient: 'from-sky-950 via-zinc-900 to-violet-950' },
  { key: 'videoAd', Icon: VideoIcon, gradient: 'from-rose-950 via-stone-900 to-amber-950' }
] as const

function EmptyDraftHero({
  onUseTemplate
}: {
  readonly onUseTemplate: (prompt: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  return (
    <div className="w-full" data-testid="workspace-hero">
      <div className="mb-6 text-center">
        <div className="bg-foreground/[0.05] mx-auto mb-3 grid size-10 place-items-center rounded-2xl text-cyan-600 dark:text-cyan-300">
          <SparklesIcon className="size-5" aria-hidden />
        </div>
        <h1 className="text-foreground text-xl font-semibold tracking-tight">
          {t('workspace.heroTitle')}
        </h1>
        <p className="text-muted-foreground mt-2 text-xs">{t('workspace.heroSubtitle')}</p>
      </div>
      <div className="grid w-full grid-cols-3 gap-2.5">
        {templateCards.map(({ key, Icon, gradient }) => (
          <button
            key={key}
            type="button"
            data-testid={`template-card-${key}`}
            onClick={() => onUseTemplate(String(t(`workspace.templates.${key}.prompt`)))}
            className="group hover:border-foreground/15 hover:bg-accent/40 focus-visible:ring-ring bg-card overflow-hidden rounded-xl border text-left transition-colors outline-none focus-visible:ring-2"
          >
            <div className={`relative aspect-[1.65] overflow-hidden bg-gradient-to-br ${gradient}`}>
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_30%,rgba(255,255,255,0.18),transparent_32%)]" />
              <div className="absolute right-4 bottom-3 grid size-11 place-items-center rounded-[45%] bg-white/80 shadow-2xl transition-transform group-hover:scale-105">
                <Icon className="size-5 text-zinc-800" aria-hidden />
              </div>
            </div>
            <div className="p-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-foreground text-[11px] font-medium">
                  {t(`workspace.templates.${key}.title`)}
                </p>
                <span className="text-muted-foreground shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] whitespace-nowrap">
                  {t('workspace.templateTry')}
                </span>
              </div>
              <p className="text-muted-foreground mt-1 line-clamp-2 text-[9px] leading-4">
                {t(`workspace.templates.${key}.detail`)}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function EmptyWorkspace(): React.JSX.Element {
  const { t } = useTranslation('creation')
  return (
    <div className="grid h-full place-items-center">
      <div className="text-muted-foreground grid justify-items-center gap-2 text-sm">
        <SparklesIcon className="size-6" aria-hidden />
        <p>{t('workspace.empty')}</p>
      </div>
    </div>
  )
}
