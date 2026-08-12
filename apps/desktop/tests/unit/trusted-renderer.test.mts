import assert from 'node:assert/strict'
import test from 'node:test'
import { isTrustedTopLevelRenderer } from '../../src/main/window/trusted-renderer.ts'

const trustedRendererUrl = 'file:///Applications/Nevix%20AI/renderer/index.html'
const liveWindow = { isDestroyed: () => false }
const destroyedWindow = { isDestroyed: () => true }

interface TrustedRendererCandidate {
  readonly ownerWindow: { readonly isDestroyed: () => boolean } | null
  readonly senderFrame: { readonly url: string } | null
  readonly mainFrame: { readonly url: string }
  readonly trustedRendererUrl: string
}

function candidate(overrides: Partial<TrustedRendererCandidate> = {}): TrustedRendererCandidate {
  const mainFrame = { url: trustedRendererUrl }
  return {
    ownerWindow: liveWindow,
    senderFrame: mainFrame,
    mainFrame,
    trustedRendererUrl,
    ...overrides
  }
}

test('accepts the exact Nevix AI top-level renderer URL', () => {
  assert.equal(isTrustedTopLevelRenderer(candidate()), true)
})

const rejectedCandidates = [
  {
    name: 'a fragment URL',
    value: candidate({ senderFrame: { url: `${trustedRendererUrl}#audit-log` } })
  },
  {
    name: 'an untrusted URL',
    value: candidate({ senderFrame: { url: 'https://attacker.invalid/' } })
  },
  {
    name: 'a subframe',
    value: candidate({ senderFrame: { url: trustedRendererUrl } })
  },
  {
    name: 'a sender without an owning window',
    value: candidate({ ownerWindow: null })
  },
  {
    name: 'a destroyed owning window',
    value: candidate({ ownerWindow: destroyedWindow })
  },
  {
    name: 'a sender without a frame',
    value: candidate({ senderFrame: null })
  }
] as const

for (const rejected of rejectedCandidates) {
  test(`rejects ${rejected.name}`, () => {
    assert.equal(isTrustedTopLevelRenderer(rejected.value), false)
  })
}
