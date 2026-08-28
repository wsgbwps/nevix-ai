import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PlusIcon, SparklesIcon } from 'lucide-react'
import type { CreationSessionView } from '../api/go-creation-http'
import { useCreationWorkbench } from '../model/use-workbench'
import { CreationComposer } from './composer'

/**
 * The production Creation Workbench (issue #177): the accepted prototype
 * layout — a private session list on the left, one continuous workspace on
 * the right, and the fixed bottom Composer with the inline reference deck and
 * upward capability controls. Loading/empty/error stay explicit so cached
 * data can never masquerade as authoritative server facts.
 */
export function CreationWorkbenchPage(): React.JSX.Element | null {
  const workbench = useCreationWorkbench()
  const { t } = useTranslation('creation')
  if (!workbench.ports) return null

  return (
    <section className="flex min-h-0 flex-1 overflow-hidden" data-testid="creation-workbench">
      <aside
        aria-label={t('sessions.label')}
        className="bg-sidebar flex w-[210px] shrink-0 flex-col border-r"
      >
        <div className="flex h-14 items-center justify-between px-3">
          <h2 className="text-foreground text-sm font-semibold">{t('sessions.label')}</h2>
        </div>
        <div className="px-2 pb-1">
          <NewSessionForm onCreate={workbench.createSession} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-2">
          {workbench.sessions.length === 0 && workbench.status === 'ready' ? (
            <p className="text-muted-foreground px-1 py-2 text-xs" role="status">
              {t('sessions.empty')}
            </p>
          ) : (
            <ul className="grid gap-1" data-testid="session-list">
              {workbench.sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
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
        <p className="text-muted-foreground border-t px-3 py-3 text-[10px]">
          {t('sessions.private')}
        </p>
      </aside>
      <main aria-label={t('workspace.label')} className="relative min-w-0 flex-1 overflow-hidden">
        {workbench.selected ? (
          <>
            <div className="h-full overflow-y-auto px-6 pb-[190px]">
              <header className="pt-6">
                <h1 className="text-foreground truncate text-base font-semibold">
                  {workbench.selected.name.length > 0
                    ? workbench.selected.name
                    : t('sessions.unnamed')}
                </h1>
              </header>
              <div className="text-muted-foreground grid place-items-center pt-16">
                <p className="text-xs" role="status">
                  {t('workspace.generationPending')}
                </p>
              </div>
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

function SessionRow({
  session,
  selected,
  onSelect,
  onDelete
}: {
  readonly session: CreationSessionView
  readonly selected: boolean
  readonly onSelect: () => void
  readonly onDelete: () => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const name = session.name.length > 0 ? session.name : t('sessions.unnamed')
  return (
    <li className="group flex items-center gap-1">
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={
          'min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-xs ' +
          (selected
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/60')
        }
      >
        {name}
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

function NewSessionForm({
  onCreate
}: {
  readonly onCreate: (name: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const [name, setName] = useState('')
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault()
        onCreate(name)
        setName('')
      }}
    >
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder={t('sessions.newPlaceholder')}
        aria-label={t('sessions.newLabel')}
        maxLength={128}
        data-testid="session-new-input"
        className="border-input focus-visible:ring-ring min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-xs outline-none focus-visible:ring-2"
      />
      <button
        type="submit"
        aria-label={t('sessions.newSubmit')}
        className="hover:bg-accent text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50"
      >
        <PlusIcon className="size-3.5" aria-hidden />
      </button>
    </form>
  )
}
