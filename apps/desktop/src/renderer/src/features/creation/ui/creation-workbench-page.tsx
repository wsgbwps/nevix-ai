import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FileImageIcon,
  ImageIcon,
  PencilLineIcon,
  PlusIcon,
  SparklesIcon,
  VideoIcon
} from 'lucide-react'
import type { CreationSessionView } from '../api/go-creation-http'
import { useCreationWorkbench } from '../model/use-workbench'
import { CreationComposer } from './composer'
import { ResultGallery } from './result-gallery'

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
 * carry the delete affordance required by the draft lifecycle.
 */
export function CreationWorkbenchPage(): React.JSX.Element | null {
  const workbench = useCreationWorkbench()
  const { t, i18n } = useTranslation('creation')
  // The relative "updated" labels anchor to when the list mounted; re-renders
  // never resample the clock, so a row's label cannot change between renders.
  const [listClock] = useState(() => Date.now())
  if (!workbench.ports) return null

  return (
    <section className="flex min-h-0 flex-1 overflow-hidden" data-testid="creation-workbench">
      <aside
        aria-label={t('sessions.label')}
        className="bg-sidebar flex w-[210px] shrink-0 flex-col border-r"
      >
        <div className="flex h-14 shrink-0 items-center px-4">
          <h2 className="text-foreground text-sm font-semibold">{t('sessions.label')}</h2>
        </div>
        <div className="px-2 pb-1">
          <NewSessionForm onCreate={workbench.createSession} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-3">
          {workbench.sessions.length === 0 && workbench.status === 'ready' ? (
            <p className="text-muted-foreground px-1 py-2 text-xs" role="status">
              {t('sessions.empty')}
            </p>
          ) : (
            <ul className="grid gap-1" data-testid="session-list">
              {workbench.sessions.map((session, index) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  index={index}
                  now={listClock}
                  language={i18n.language}
                  selected={workbench.selectedId === session.id}
                  onSelect={() => workbench.selectSession(session)}
                  onDelete={() => workbench.deleteSession(session.id)}
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
        {workbench.selected ? (
          <>
            <div className="h-full overflow-y-auto px-6 pb-[190px]">
              {workbench.draft.prompt.length === 0 ? (
                <div className="mx-auto flex min-h-full max-w-[720px] flex-col items-center justify-center pb-10">
                  <EmptyDraftHero onUseTemplate={(prompt) => workbench.patchDraft({ prompt })} />
                </div>
              ) : (
                <div className="mx-auto max-w-[820px] pt-16">
                  <div className="mb-3 flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <h1 className="text-foreground truncate text-base font-semibold">
                        {workbench.selected.name.length > 0
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
                  <p className="text-foreground/70 mb-3 text-xs leading-5">
                    {workbench.draft.prompt}
                  </p>
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
            <CreationComposer workbench={workbench} />
          </>
        ) : (
          <EmptyWorkspace />
        )}
      </main>
    </section>
  )
}

/**
 * The list rows mirror the prototype's density (prototype 6e465e8): a
 * gradient thumbnail tile plus the relative update time. The tile is purely
 * decorative — the list endpoint carries no media type, and no Generation
 * Task state exists in this slice to color a status dot.
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
  now,
  language,
  selected,
  onSelect,
  onDelete
}: {
  readonly session: CreationSessionView
  readonly index: number
  readonly now: number
  readonly language: string
  readonly selected: boolean
  readonly onSelect: () => void
  readonly onDelete: () => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const name = session.name.length > 0 ? session.name : t('sessions.unnamed')
  const updated = new Date(session.updatedAt)
  const minutes = Math.floor((now - updated.getTime()) / 60_000)
  const meta =
    minutes < 1
      ? String(t('sessions.meta.justNow'))
      : minutes < 60
        ? String(t('sessions.meta.minutesAgo', { n: minutes }))
        : minutes < 24 * 60
          ? String(t('sessions.meta.hoursAgo', { n: Math.floor(minutes / 60) }))
          : minutes < 7 * 24 * 60
            ? String(t('sessions.meta.daysAgo', { n: Math.floor(minutes / (24 * 60)) }))
            : updated.toLocaleDateString(language)
  return (
    <li className="group flex items-center gap-1">
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        aria-label={name}
        className={
          'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50 ' +
          (selected ? 'bg-accent' : 'hover:bg-foreground/[0.04]')
        }
      >
        <span
          className={`grid size-8 shrink-0 place-items-center rounded-md bg-gradient-to-br ${rowGradients[index % rowGradients.length]}`}
        >
          <FileImageIcon className="size-3.5 text-white/75" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="text-foreground block truncate text-xs font-medium">{name}</span>
          <span className="text-muted-foreground block truncate text-[9px]">{meta}</span>
        </span>
      </button>
      <button
        type="button"
        aria-label={t('sessions.remove', { name })}
        onClick={onDelete}
        className="text-muted-foreground hover:text-foreground rounded p-1 text-[10px] opacity-0 outline-none group-hover:opacity-100 focus-visible:opacity-100"
      >
        ✕
      </button>
    </li>
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

/**
 * The create row mirrors the prototype's "新对话" pill (a full-width h-9
 * quiet surface with a pencil glyph); the inline input keeps the optional
 * naming capability, and the plus submits.
 */
function NewSessionForm({
  onCreate
}: {
  readonly onCreate: (name: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const [name, setName] = useState('')
  return (
    <form
      className="bg-foreground/[0.065] hover:bg-foreground/[0.09] focus-within:bg-foreground/[0.09] flex h-9 w-full items-center gap-2 rounded-lg px-3 transition-colors"
      onSubmit={(event) => {
        event.preventDefault()
        onCreate(name)
        setName('')
      }}
    >
      <PencilLineIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder={t('sessions.newPlaceholder')}
        aria-label={t('sessions.newLabel')}
        maxLength={128}
        data-testid="session-new-input"
        className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-xs font-medium outline-none"
      />
      <button
        type="submit"
        aria-label={t('sessions.newSubmit')}
        className="text-muted-foreground hover:text-foreground flex size-5 shrink-0 items-center justify-center rounded outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50"
      >
        <PlusIcon className="size-3.5" aria-hidden />
      </button>
    </form>
  )
}
