import { StrictMode, useEffect, useMemo, useState } from 'react'
import {
  CreationRuntimeContext,
  CreationSessionNavigationProvider,
  createCreationRuntime,
  createCreationWorkspacePorts,
  useCreationRuntime,
  useOpenCreationSession
} from '../../../src/renderer/src/features/creation'
import { useCreationSessionNavigation } from '../../../src/renderer/src/features/creation/model/creation-session-navigation-context'
import type {
  CreationApiResult,
  SessionDetailView
} from '../../../src/renderer/src/features/creation/api/go-creation-http'

const basePorts = createCreationWorkspacePorts('https://nevix.example.test', async () => ({
  token: 'test-token'
}))

function Opener({
  onOutcome
}: {
  readonly onOutcome: (id: string, opened: boolean) => void
}): React.JSX.Element {
  const open = useOpenCreationSession()
  return (
    <>
      {['slow', 'fast'].map((id) => (
        <button
          key={id}
          type="button"
          disabled={!open}
          onClick={() => {
            void open?.(id).then((opened) => onOutcome(id, opened))
          }}
        >
          Open {id}
        </button>
      ))}
    </>
  )
}

function NavigationObservation(): React.JSX.Element {
  const navigation = useCreationSessionNavigation()
  const runtime = useCreationRuntime()
  return (
    <>
      <output data-testid="navigation-target">
        {navigation?.target.kind === 'session' ? navigation.target.session.id : 'inactive'}
      </output>
      <output data-testid="current-user">{runtime?.userId}</output>
    </>
  )
}

function Story(): React.JSX.Element {
  const [userId, setUserId] = useState('user-a')
  const [showOpener, setShowOpener] = useState(true)
  const [outcomes, setOutcomes] = useState<readonly string[]>([])
  const pending = useMemo(
    () =>
      new Map<
        string,
        { resolve: (result: CreationApiResult<SessionDetailView>) => void; reject: () => void }
      >(),
    []
  )
  const ports = useMemo(
    () => ({
      ...basePorts,
      listSessions: async () => ({
        outcome: 'succeeded' as const,
        value: { sessions: [], nextCursor: null }
      }),
      getSessionDetail: (id: string) =>
        new Promise<CreationApiResult<SessionDetailView>>((resolve, reject) =>
          pending.set(id, {
            resolve,
            reject: () => reject(new Error('Session read failed'))
          })
        )
    }),
    [pending]
  )
  const runtime = useMemo(() => createCreationRuntime(ports, userId), [ports, userId])
  useEffect(() => () => runtime.retire(), [runtime])
  const complete = (id: string): void =>
    pending.get(id)?.resolve({
      outcome: 'succeeded',
      value: { id, name: id, createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z' }
    })
  return (
    <>
      <button type="button" onClick={() => setShowOpener(false)}>
        Unmount opener
      </button>
      <button type="button" onClick={() => setUserId('user-b')}>
        Replace runtime
      </button>
      <button type="button" onClick={() => complete('slow')}>
        Complete slow
      </button>
      <button type="button" onClick={() => complete('fast')}>
        Complete fast
      </button>
      <button type="button" onClick={() => pending.get('slow')?.reject()}>
        Reject slow
      </button>
      <output data-testid="open-outcomes">{outcomes.join(',')}</output>
      <CreationRuntimeContext.Provider value={runtime}>
        <CreationSessionNavigationProvider>
          {showOpener && (
            <Opener
              onOutcome={(id, opened) => setOutcomes((current) => [...current, `${id}:${opened}`])}
            />
          )}
          <NavigationObservation />
        </CreationSessionNavigationProvider>
      </CreationRuntimeContext.Provider>
    </>
  )
}

export function CreationSessionOpeningStory(): React.JSX.Element {
  return (
    <StrictMode>
      <Story />
    </StrictMode>
  )
}
