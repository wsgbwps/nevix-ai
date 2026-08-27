import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SparklesIcon } from 'lucide-react'
import type { CreationSessionView, ReferenceMaterialView } from '../api/go-creation-http'
import { useCreationRuntime } from '../model/runtime-context'
import { ReferencePile } from './reference-pile'

interface WorkbenchState {
  readonly sessions: readonly CreationSessionView[]
  readonly selected: CreationSessionView | null
  readonly materials: readonly ReferenceMaterialView[]
  readonly status: 'loading' | 'ready' | 'error'
  readonly pileThumbnails: Readonly<Record<string, string>>
}

/**
 * The Creation Workbench page (V1 slice 06): the creator's private session
 * list on the left, an empty-state workspace, and the reference pile. State
 * loading/empty/error are explicit so cached data can never masquerade as
 * authoritative server facts.
 */
export function CreationWorkbenchPage(): React.JSX.Element | null {
  const ports = useCreationRuntime()
  const { t } = useTranslation('creation')
  const [state, setState] = useState<WorkbenchState>({
    sessions: [],
    selected: null,
    materials: [],
    status: 'loading',
    pileThumbnails: {}
  })
  const [reloadAttempt, setReloadAttempt] = useState(0)
  const mountedRef = useRef(false)
  useEffect(() => {
    // StrictMode's dev-only simulated unmount/remount re-runs this effect
    // while the ref object persists, so liveness must be re-asserted on every
    // run; initializing it once leaves it permanently false after the cycle
    // and silently drops every async continuation (create, material loads).
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!ports) return
    let active = true
    void (async () => {
      const result = await ports.listSessions().catch(() => null)
      if (!active) return
      if (result !== null && result.outcome === 'succeeded') {
        setState({
          sessions: result.value.sessions,
          selected: null,
          materials: [],
          status: 'ready',
          pileThumbnails: {}
        })
      } else {
        setState((current) => ({ ...current, status: 'error' }))
      }
    })()
    return () => {
      active = false
    }
  }, [ports, reloadAttempt])

  const selectSession = useCallback(
    async (session: CreationSessionView): Promise<void> => {
      if (!ports) return
      setState((current) => ({ ...current, selected: session, materials: [] }))
      const result = await ports.listMaterials(session.id).catch(() => null)
      if (!mountedRef.current) return
      if (result === null || result.outcome !== 'succeeded') {
        setState((current) => ({ ...current, status: 'error', selected: null }))
        return
      }
      // Thumbnails load only for image kinds; other kinds keep kind glyphs.
      const thumbEntries = await Promise.all(
        result.value.materials.map(async (material) =>
          material.kind === 'image'
            ? ([material.id, await ports.loadImageBlobUrl(material.id)] as const)
            : ([material.id, null] as const)
        )
      )
      if (!mountedRef.current) return
      const thumbnails: Record<string, string> = {}
      for (const [id, url] of thumbEntries) {
        if (url) thumbnails[id] = url
      }
      setState((current) => ({
        ...current,
        selected: session,
        materials: result.value.materials,
        pileThumbnails: thumbnails,
        status: 'ready'
      }))
    },
    [ports]
  )

  if (!ports) return null

  const stateBox =
    state.status === 'loading' ? (
      <p role="status" className="text-muted-foreground text-sm">
        {t('state.loading')}
      </p>
    ) : state.status === 'error' ? (
      <div role="alert" className="grid gap-2">
        <p className="text-sm">{t('state.loadFailed')}</p>
        <button
          type="button"
          className="border-input hover:bg-accent rounded border px-3 py-1 text-sm"
          onClick={() => setReloadAttempt((attempt) => attempt + 1)}
        >
          {t('state.retry')}
        </button>
      </div>
    ) : null

  async function handleCreate(name: string): Promise<void> {
    if (!ports) return
    const result = await ports.createSession(name.trim()).catch(() => null)
    if (!mountedRef.current) return
    if (result === null || result.outcome !== 'succeeded') {
      setState((current) => ({ ...current, status: 'error' }))
      return
    }
    setState((current) => ({
      ...current,
      sessions: [result.value, ...current.sessions],
      status: 'ready'
    }))
    await selectSession(result.value)
  }

  function handleDeleteSession(sessionId: string): void {
    if (!ports) return
    setState((current) => ({
      ...current,
      sessions: current.sessions.filter((session) => session.id !== sessionId),
      selected: current.selected?.id === sessionId ? null : current.selected,
      materials: current.selected?.id === sessionId ? [] : current.materials,
      status: 'ready'
    }))
    void ports.deleteSession(sessionId).catch(() => undefined)
  }

  function handleUpload(file: File): void {
    const session = state.selected
    if (!ports || !session) return
    void ports
      .uploadMaterial(session.id, file)
      .then((result) => {
        if (result.outcome !== 'succeeded') {
          setState((current) => ({ ...current, status: 'error' }))
          return
        }
        const material = result.value
        setState((current) => ({
          ...current,
          materials: [...current.materials, material],
          status: 'ready'
        }))
        if (material.kind === 'image') {
          void ports
            .loadImageBlobUrl(material.id)
            .then((url) => {
              if (!url) return
              setState((current) => ({
                ...current,
                pileThumbnails: { ...current.pileThumbnails, [material.id]: url }
              }))
            })
            .catch(() => undefined)
        }
      })
      .catch(() => undefined)
  }

  function handleDeleteMaterial(materialId: string): void {
    if (!ports) return
    setState((current) => ({
      ...current,
      materials: current.materials.filter((material) => material.id !== materialId),
      status: 'ready'
    }))
    void ports.deleteMaterial(materialId).catch(() => undefined)
  }

  return (
    <div className="flex h-full min-h-0" data-testid="creation-workbench">
      <aside aria-label={t('sessions.label')} className="bg-sidebar w-64 shrink-0 border-r p-3">
        <h2 className="text-muted-foreground mb-2 text-xs font-medium uppercase">
          {t('sessions.label')}
        </h2>
        <NewSessionForm onCreate={handleCreate} />
        {state.sessions.length === 0 && state.status === 'ready' ? (
          <p className="text-muted-foreground mt-4 text-sm" role="status">
            {t('sessions.empty')}
          </p>
        ) : (
          <ul className="mt-2 grid gap-1" data-testid="session-list">
            {state.sessions.map((session) => (
              <li key={session.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    void selectSession(session)
                  }}
                  className={
                    'hover:bg-accent flex-1 truncate rounded px-2 py-1.5 text-left text-sm ' +
                    (state.selected?.id === session.id ? 'bg-accent' : '')
                  }
                >
                  {session.name.length > 0 ? session.name : t('sessions.unnamed')}
                </button>
                <button
                  type="button"
                  aria-label={t('sessions.remove', { name: session.name || t('sessions.unnamed') })}
                  className="text-muted-foreground hover:text-foreground rounded p-1 text-xs"
                  onClick={() => handleDeleteSession(session.id)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        {stateBox}
      </aside>
      <section className="flex min-w-0 flex-1 flex-col" aria-label={t('workspace.label')}>
        {state.selected ? (
          <>
            <header className="border-b px-4 py-3">
              <h1 className="truncate text-sm font-semibold">
                {state.selected.name.length > 0 ? state.selected.name : t('sessions.unnamed')}
              </h1>
            </header>
            <ReferencePile
              materials={state.materials}
              thumbnails={state.pileThumbnails}
              onAdd={handleUpload}
              onDelete={handleDeleteMaterial}
            />
            <div className="text-muted-foreground grid flex-1 place-items-center">
              <p className="text-sm" role="status">
                {t('workspace.generationPending')}
              </p>
            </div>
          </>
        ) : (
          <EmptyWorkspace />
        )}
      </section>
    </div>
  )
}

function EmptyWorkspace(): React.JSX.Element {
  const { t } = useTranslation('creation')
  return (
    <div className="grid flex-1 place-items-center">
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
      className="flex gap-1"
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
        className="border-input focus-visible:ring-ring min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-sm outline-none focus-visible:ring-2"
      />
      <button
        type="submit"
        className="bg-primary text-primary-foreground rounded px-2 py-1 text-sm"
        aria-label={t('sessions.newSubmit')}
      >
        +
      </button>
    </form>
  )
}
