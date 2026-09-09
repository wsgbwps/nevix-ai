import i18next from 'i18next'
import { useLayoutEffect } from 'react'
import { I18nextProvider } from 'react-i18next'
import { createI18nOptions } from '../../../src/shared/i18n/i18next-options'
import {
  creationResources,
  ObjectStorageConnectionSettings,
  type ObjectStorageConnectionProofAction,
  type ObjectStorageConnectionSettingsContribution
} from '../../../src/renderer/src/features/creation'

const testI18n = i18next.createInstance()
await testI18n.init(
  createI18nOptions({
    language: 'en',
    resources: creationResources,
    defaultNS: 'creation',
    environment: 'test'
  })
)

type Scenario = 'unconfigured' | 'ready' | 'frozen' | 'credential-unavailable' | 'member'

interface ObjectStorageConnectionTestControls {
  proofCalls(): ReadonlyArray<ObjectStorageConnectionProofAction>
  wireCalls(): ReadonlyArray<{ method: string; path: string }>
  contribution(): ObjectStorageConnectionSettingsContribution | undefined
  discard(): void
  respondCreateWith(outcome: 'created' | 'unavailable'): void
  respondMaintenanceWith(outcome: 'succeeded' | 'revision-conflict'): void
}

declare global {
  interface Window {
    __objectStorageConnectionTest?: ObjectStorageConnectionTestControls
    __objectStorageConnectionScenario?: Scenario
    __objectStorageConnectionCreateOutcome?: 'created' | 'unavailable'
    __objectStorageConnectionMaintenanceOutcome?: 'succeeded' | 'revision-conflict'
    __objectStorageConnectionProofCalls?: ObjectStorageConnectionProofAction[]
    __objectStorageConnectionWireCalls?: Array<{ method: string; path: string }>
    __objectStorageConnectionContribution?: ObjectStorageConnectionSettingsContribution
  }
}

const readyView = {
  state: 'ready',
  provider: 'oss',
  region: 'cn-hangzhou',
  bucket: 'nevix-reference-materials',
  revision: 7,
  location_frozen: false,
  credential: {
    access_key_id_masked: '****7890',
    secret_access_key_configured: true
  },
  observation: { checked_at: '2026-09-09T05:00:00Z', outcome: 'completed' }
}

window.__objectStorageConnectionScenario ??= 'unconfigured'
window.__objectStorageConnectionCreateOutcome ??= 'created'
window.__objectStorageConnectionMaintenanceOutcome ??= 'succeeded'
window.__objectStorageConnectionProofCalls ??= []
window.__objectStorageConnectionWireCalls ??= []

window.__objectStorageConnectionTest = {
  proofCalls: () => [...(window.__objectStorageConnectionProofCalls ?? [])],
  wireCalls: () => [...(window.__objectStorageConnectionWireCalls ?? [])],
  contribution: () => window.__objectStorageConnectionContribution,
  discard: () => window.__objectStorageConnectionContribution?.discard?.(),
  respondCreateWith(outcome) {
    window.__objectStorageConnectionCreateOutcome = outcome
  },
  respondMaintenanceWith(outcome) {
    window.__objectStorageConnectionMaintenanceOutcome = outcome
  }
}

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init)
  const path = new URL(request.url).pathname
  const scenario = window.__objectStorageConnectionScenario ?? 'unconfigured'
  window.__objectStorageConnectionWireCalls?.push({ method: request.method, path })
  const respond = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })

  if (path === '/creation/object-storage-connection' && request.method === 'GET') {
    if (scenario === 'unconfigured') return respond(200, { state: 'unconfigured' })
    if (scenario === 'credential-unavailable') {
      return respond(200, { ...readyView, state: 'credential_unavailable' })
    }
    if (scenario === 'frozen') return respond(200, { ...readyView, location_frozen: true })
    return respond(200, readyView)
  }
  if (path === '/creation/object-storage-connection' && request.method === 'POST') {
    if (window.__objectStorageConnectionCreateOutcome === 'unavailable') {
      return respond(503, { error: 'object_storage_unavailable', message: 'sanitized' })
    }
    window.__objectStorageConnectionScenario = 'ready'
    return respond(201, readyView)
  }
  if (path === '/creation/object-storage-connection/recheck' && request.method === 'POST') {
    return respond(200, {
      ...readyView,
      location_frozen: scenario === 'frozen',
      observation: { checked_at: '2026-09-09T06:00:00Z', outcome: 'completed' }
    })
  }
  if (path === '/creation/object-storage-connection' && request.method === 'PUT') {
    if (window.__objectStorageConnectionMaintenanceOutcome === 'revision-conflict') {
      return respond(409, {
        error: 'object_storage_connection_revision_conflict',
        message: 'sanitized'
      })
    }
    return respond(200, {
      ...readyView,
      revision: 8,
      location_frozen: scenario === 'frozen'
    })
  }
  if (path === '/creation/object-storage-connection/credential' && request.method === 'PUT') {
    if (window.__objectStorageConnectionMaintenanceOutcome === 'revision-conflict') {
      return respond(409, {
        error: 'object_storage_connection_revision_conflict',
        message: 'sanitized'
      })
    }
    return respond(200, {
      ...readyView,
      revision: 8,
      location_frozen: scenario === 'frozen'
    })
  }
  if (
    path === '/creation/object-storage-connection/credential/recover' &&
    request.method === 'POST'
  ) {
    window.__objectStorageConnectionScenario = 'ready'
    return respond(200, { ...readyView, revision: 8 })
  }
  if (path === '/creation/object-storage-connection' && request.method === 'DELETE') {
    window.__objectStorageConnectionScenario = 'unconfigured'
    return respond(200, { state: 'unconfigured' })
  }
  return respond(404, { error: 'not_found', message: 'missing' })
}

function StoryShell({
  scenario,
  isAdmin
}: {
  scenario: Scenario
  isAdmin: boolean
}): React.JSX.Element {
  useLayoutEffect(() => {
    window.__objectStorageConnectionScenario = scenario
    window.__objectStorageConnectionCreateOutcome = 'created'
    window.__objectStorageConnectionMaintenanceOutcome = 'succeeded'
    window.__objectStorageConnectionProofCalls = []
    window.__objectStorageConnectionWireCalls = []
    window.__objectStorageConnectionContribution = undefined
  }, [scenario])

  return (
    <I18nextProvider i18n={testI18n}>
      <ObjectStorageConnectionSettings
        isAdmin={isAdmin}
        getSession={async () => ({ token: 'story-token' })}
        serverUrl="https://server.example"
        acquireProof={async (action) => {
          window.__objectStorageConnectionProofCalls?.push(action)
          return { proof: `object-storage-${action}-proof` }
        }}
        onContributionChange={(contribution) => {
          window.__objectStorageConnectionContribution = contribution
        }}
      />
    </I18nextProvider>
  )
}

export function ObjectStorageConnectionAdminEmptyStory(): React.JSX.Element {
  return <StoryShell scenario="unconfigured" isAdmin />
}

export function ObjectStorageConnectionAdminReadyStory(): React.JSX.Element {
  return <StoryShell scenario="ready" isAdmin />
}

export function ObjectStorageConnectionAdminFrozenStory(): React.JSX.Element {
  return <StoryShell scenario="frozen" isAdmin />
}

export function ObjectStorageConnectionCredentialUnavailableStory(): React.JSX.Element {
  return <StoryShell scenario="credential-unavailable" isAdmin />
}

export function ObjectStorageConnectionMemberStory(): React.JSX.Element {
  return <StoryShell scenario="member" isAdmin={false} />
}
