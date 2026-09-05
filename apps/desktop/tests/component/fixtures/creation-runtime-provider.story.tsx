import { StrictMode, useState } from 'react'
import {
  CreationRuntimeProvider,
  useCreationRuntime,
  type CreationRuntime
} from '../../../src/renderer/src/features/creation'

let retainedRuntime: Exclude<CreationRuntime, null> | undefined
const acquireSession = async (): Promise<{ readonly token: string }> => ({ token: 'token' })

function RuntimeProbe(): React.JSX.Element {
  const runtime = useCreationRuntime()
  const [retainedStatus, setRetainedStatus] = useState('none')

  return (
    <>
      <output data-testid="current-runtime">
        {runtime === null
          ? 'none'
          : `${runtime.userId}:${runtime.actions.snapshot('probe').status}`}
      </output>
      <output data-testid="retained-runtime">{retainedStatus}</output>
      <button
        type="button"
        disabled={runtime === null}
        onClick={() => {
          retainedRuntime = runtime ?? undefined
          setRetainedStatus('captured')
        }}
      >
        Retain current
      </button>
      <button
        type="button"
        onClick={() =>
          setRetainedStatus(
            retainedRuntime === undefined
              ? 'none'
              : `${retainedRuntime.userId}:${retainedRuntime.actions.snapshot('probe').status}`
          )
        }
      >
        Inspect retained
      </button>
    </>
  )
}

function Story(): React.JSX.Element {
  const [userId, setUserId] = useState<string | undefined>('user-a')
  const [serverUrl, setServerUrl] = useState('https://nevix-a.example.test')

  return (
    <>
      <button type="button" onClick={() => setServerUrl('https://nevix-b.example.test')}>
        Change server
      </button>
      <button type="button" onClick={() => setUserId('user-b')}>
        Change user
      </button>
      <button type="button" onClick={() => setUserId(undefined)}>
        End session
      </button>
      <CreationRuntimeProvider
        acquireSession={acquireSession}
        serverUrl={serverUrl}
        userId={userId}
      >
        <RuntimeProbe />
      </CreationRuntimeProvider>
    </>
  )
}

export function CreationRuntimeProviderStory(): React.JSX.Element {
  return (
    <StrictMode>
      <Story />
    </StrictMode>
  )
}
