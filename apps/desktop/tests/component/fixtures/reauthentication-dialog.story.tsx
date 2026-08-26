import i18next from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { useState } from 'react'
import { createI18nOptions } from '../../../src/shared/i18n/i18next-options'
import {
  authenticationResources,
  ReauthenticationDialog,
  type IssuedReauthProof,
  type ReauthAction,
  type ReauthIssueResult,
  type ReauthProofRequester
} from '../../../src/renderer/src/features/authentication'

/**
 * Black-box composition for the Reauthentication confirmation surface (issue
 * #154): the public dialog mounted with a scripted proof requester and a
 * recorded session acquisition, exactly as a future Provider Connection
 * settings card would compose it. Tests drive the visible dialog and observe
 * the caller-visible proof and cancel outcomes.
 */

const testI18n = i18next.createInstance()
await testI18n.init(
  createI18nOptions({
    language: 'en',
    resources: authenticationResources,
    defaultNS: 'authentication',
    environment: 'test'
  })
)

export interface IssueCall {
  readonly token: string
  readonly action: ReauthAction
  readonly password: string
}

interface ReauthDialogTestControls {
  enqueueIssue(result: unknown): void
  issueCalls(): IssueCall[]
  acquireCalls(): number
  receivedProofs(): IssuedReauthProof[]
  cancelCount(): number
  recordProof(proof: IssuedReauthProof): void
  recordCancel(): void
  recordAcquire(): void
}

declare global {
  interface Window {
    __reauthDialogTest?: ReauthDialogTestControls
  }
}

/** Created once per page; idempotent under React's double-invoked dev renders. */
function getControls(): { controls: ReauthDialogTestControls; requester: ReauthProofRequester } {
  const queued: unknown[] = []
  const calls: IssueCall[] = []
  const proofs: IssuedReauthProof[] = []
  let acquireCalls = 0
  let cancels = 0

  const requester: ReauthProofRequester = {
    issue(token, action, password) {
      calls.push({ token, action, password })
      const next = queued.shift()
      // An empty queue answers a never-settling pending request: the test
      // observes the submitting state and ends the page.
      return (
        next === undefined
          ? new Promise<ReauthIssueResult>(() => {})
          : Promise.resolve(next as ReauthIssueResult)
      ) as never
    }
  }

  const controls: ReauthDialogTestControls = {
    enqueueIssue(result) {
      queued.push(result)
    },
    issueCalls() {
      return [...calls]
    },
    acquireCalls() {
      return acquireCalls
    },
    receivedProofs() {
      return [...proofs]
    },
    cancelCount() {
      return cancels
    },
    recordProof(proof) {
      proofs.push(proof)
    },
    recordCancel() {
      cancels += 1
    },
    recordAcquire() {
      acquireCalls += 1
    }
  }
  window.__reauthDialogTest = controls

  return { controls, requester }
}

let wired: { controls: ReauthDialogTestControls; requester: ReauthProofRequester } | undefined

export function ReauthenticationDialogStory({
  action = 'provider_connection.replace'
}: {
  readonly action?: ReauthAction
}): React.JSX.Element {
  wired ??= getControls()
  const controls = wired.controls
  const [open, setOpen] = useState(true)
  const [lastProof, setLastProof] = useState<string>('none')

  return (
    <I18nextProvider i18n={testI18n}>
      <ReauthenticationDialog
        open={open}
        action={action}
        serverUrl="https://module-test-server.example"
        acquireSession={async () => {
          controls.recordAcquire()
          return { token: 'opaque-session-token' }
        }}
        issueProof={wired.requester}
        onProof={(proof) => {
          controls.recordProof(proof)
          setLastProof(proof.proof)
          setOpen(false)
        }}
        onCancel={() => {
          controls.recordCancel()
          setOpen(false)
        }}
      />
      <button type="button" data-testid="reopen-confirmation" onClick={() => setOpen(true)}>
        reopen confirmation
      </button>
      <output data-testid="last-proof">{lastProof}</output>
    </I18nextProvider>
  )
}
