import i18next from 'i18next'
import { useLayoutEffect } from 'react'
import { I18nextProvider } from 'react-i18next'
import { createI18nOptions } from '../../../src/shared/i18n/i18next-options'
import {
  creationResources,
  ProviderConnectionSettings,
  type ProviderConnectionProofAction
} from '../../../src/renderer/src/features/creation'
import type { ProviderConnectionView } from '../../../src/renderer/src/features/creation/api/provider-connection-http'

/**
 * Black-box composition for the AI Creation Settings card (issue #157): the
 * exported settings contribution mounted over a scripted trusted-command
 * transport and a scripted proof acquisition, exactly as app/settings
 * composes it. One named story per scenario (the established fixture
 * convention); tests drive visible UI and observe the recorded wire calls.
 */

const testI18n = i18next.createInstance()
await testI18n.init(
  createI18nOptions({
    language: 'en',
    resources: creationResources,
    defaultNS: 'creation',
    environment: 'test'
  })
)

interface ProviderConnectionTestControls {
  proofCalls(): ReadonlyArray<ProviderConnectionProofAction>
  wireCalls(): ReadonlyArray<{ method: string; path: string }>
  respondConfigureWith(status: 'created' | 'secure-transport' | 'invalid-key'): void
}

declare global {
  interface Window {
    __providerConnectionTest?: ProviderConnectionTestControls
    __providerConnectionScenario?: string
    __providerConnectionConfigureOutcome?: 'created' | 'secure-transport' | 'invalid-key'
    __providerConnectionProofCalls?: ProviderConnectionProofAction[]
    __providerConnectionWireCalls?: Array<{ method: string; path: string }>
  }
}

function connectionView(partial: {
  credentialState: ProviderConnectionView['credentialState']
  imageCapability: ProviderConnectionView['imageCapability']
  videoCapability: ProviderConnectionView['videoCapability']
  adminState?: ProviderConnectionView['adminState']
}): ProviderConnectionView {
  return {
    id: '4b7a2b1e-0d5f-4a3c-9d2e-107cb28a1111',
    admin_state: partial.adminState ?? 'enabled',
    credential_state: partial.credentialState,
    image_capability: partial.imageCapability,
    video_capability: partial.videoCapability,
    created_at: '2026-08-27T02:00:00Z',
    updated_at: '2026-08-27T02:00:00Z',
    last_checked_at: '2026-08-27T02:00:00Z',
    last_check_outcome: 'completed',
    needs_attention:
      partial.credentialState !== 'valid' ||
      partial.imageCapability !== 'available' ||
      partial.videoCapability !== 'available'
  }
}

// Fixture state lives on window: the spec's page.evaluate and the mounted
// component always share the page's window object even across module copies.
window.__providerConnectionScenario ??= 'not-configured'
window.__providerConnectionConfigureOutcome ??= 'created'
window.__providerConnectionProofCalls ??= []
window.__providerConnectionWireCalls ??= []

window.__providerConnectionTest = {
  proofCalls: () => [...(window.__providerConnectionProofCalls ?? [])],
  wireCalls: () => [...(window.__providerConnectionWireCalls ?? [])],
  respondConfigureWith(next) {
    window.__providerConnectionConfigureOutcome = next
  }
}

globalThis.fetch = (input, init) => {
  const request = new Request(input, init)
  const path = new URL(request.url).pathname
  const scenario = window.__providerConnectionScenario ?? 'not-configured'
  const configureOutcome = window.__providerConnectionConfigureOutcome ?? 'created'
  window.__providerConnectionWireCalls?.push({ method: request.method, path })
  const respond = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  if (path === '/creation/provider-connection' && request.method === 'GET') {
    if (scenario === 'not-configured' || scenario.startsWith('member')) {
      return Promise.resolve(
        respond(404, { error: 'provider_connection_not_configured', message: 'none' })
      )
    }
    if (scenario === 'credential-unavailable') {
      return Promise.resolve(
        respond(
          200,
          connectionView({
            credentialState: 'credential_unavailable',
            imageCapability: 'unavailable',
            videoCapability: 'unavailable'
          })
        )
      )
    }
    return Promise.resolve(
      respond(
        200,
        connectionView({
          credentialState: 'valid',
          imageCapability: 'available',
          videoCapability: 'available'
        })
      )
    )
  }
  if (path === '/creation/media-capabilities') {
    const unavailable = (reason: string): { status: string; reason: string; action: string } => ({
      status: 'unavailable',
      reason,
      action: 'contact_admin'
    })
    if (scenario === 'member-paused') {
      return Promise.resolve(
        respond(200, {
          image: unavailable('connection_paused'),
          video: unavailable('connection_paused')
        })
      )
    }
    return Promise.resolve(
      respond(200, {
        image: { status: 'available', reason: null, action: null },
        video: { status: 'available', reason: null, action: null }
      })
    )
  }
  if (path === '/creation/provider-connection' && request.method === 'POST') {
    if (configureOutcome === 'created') {
      window.__providerConnectionScenario = 'configured'
      return Promise.resolve(
        respond(
          201,
          connectionView({
            credentialState: 'valid',
            imageCapability: 'available',
            videoCapability: 'available'
          })
        )
      )
    }
    if (configureOutcome === 'secure-transport') {
      return Promise.resolve(respond(400, { error: 'secure_transport_required', message: 'https' }))
    }
    return Promise.resolve(
      respond(400, { error: 'provider_credential_invalid', message: 'rejected' })
    )
  }
  if (path === '/creation/provider-connection' && request.method === 'PATCH') {
    return Promise.resolve(
      respond(
        200,
        connectionView({
          credentialState: 'valid',
          imageCapability: 'available',
          videoCapability: 'available',
          adminState: 'paused'
        })
      )
    )
  }
  if (path === '/creation/provider-connection' && request.method === 'DELETE') {
    window.__providerConnectionScenario = 'not-configured'
    return Promise.resolve(
      respond(
        200,
        connectionView({
          credentialState: 'valid',
          imageCapability: 'available',
          videoCapability: 'available'
        })
      )
    )
  }
  return Promise.resolve(
    respond(
      200,
      connectionView({
        credentialState: 'valid',
        imageCapability: 'available',
        videoCapability: 'available'
      })
    )
  )
}

// The shared shell pins one scenario on window during render — before the
// card's mount effect issues its first lookup — so each story starts
// deterministic regardless of a previous test's wire transitions.
function StoryShell({
  scenario,
  isAdmin
}: {
  readonly scenario: string
  readonly isAdmin: boolean
}): React.JSX.Element {
  // Pin the scenario in a layout effect: parent layout effects run before
  // the card's passive mount effect issues its first lookup, and the pin
  // stays out of render (react-hooks immutability).
  useLayoutEffect(() => {
    window.__providerConnectionScenario = scenario
  }, [scenario])
  return (
    <I18nextProvider i18n={testI18n}>
      <div className="bg-card rounded-lg border p-4">
        <ProviderConnectionSettings
          isAdmin={isAdmin}
          getSession={async () => ({ token: 'story-token' })}
          serverUrl="https://server.example"
          acquireProof={async (action) => {
            window.__providerConnectionProofCalls?.push(action)
            return { proof: `story-proof-${action}` }
          }}
        />
      </div>
    </I18nextProvider>
  )
}

export function ProviderConnectionAdminEmptyStory(): React.JSX.Element {
  return <StoryShell scenario="not-configured" isAdmin />
}

export function ProviderConnectionAdminConfiguredStory(): React.JSX.Element {
  return <StoryShell scenario="configured" isAdmin />
}

export function ProviderConnectionCredentialUnavailableStory(): React.JSX.Element {
  return <StoryShell scenario="credential-unavailable" isAdmin />
}

export function ProviderConnectionMemberPausedStory(): React.JSX.Element {
  return <StoryShell scenario="member-paused" isAdmin={false} />
}

export function ProviderConnectionMemberAvailableStory(): React.JSX.Element {
  return <StoryShell scenario="member-available" isAdmin={false} />
}
