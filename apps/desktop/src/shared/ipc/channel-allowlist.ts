import type { IpcChannelMap, IpcEventMap } from '@ipc/channels'

// Runtime mirror of the compile-time Channel contract, kept adjacent to the
// @ipc/channels declarations. The `satisfies` clauses fail the typecheck when a
// Channel is declared in IpcChannelMap/IpcEventMap but missing here, or listed
// here without a declaration; tests/unit/ipc-channel-allowlist-drift.test.mts
// enforces the same lockstep at runtime.
const invokeChannels = {
  'authentication:clear-session': true,
  'authentication:read-session': true,
  'authentication:replace-session': true,
  'language:get-bootstrap': true,
  'language:get-language-mode': true,
  'language:set-language-mode': true,
  'organization:get-remembered-active-organization': true,
  'organization:set-remembered-active-organization': true,
  'organization:export-audit-log': true,
  'window:decide-ordinary-close': true,
  'window:ordinary-close-ready': true
} satisfies Record<keyof IpcChannelMap, true>

const eventChannels = {
  'language:language-mode-changed': true,
  'window:deactivated': true,
  'window:ordinary-close-requested': true
} satisfies Record<keyof IpcEventMap, true>

export const INVOKE_CHANNEL_ALLOWLIST: ReadonlySet<string> = new Set(Object.keys(invokeChannels))

export const EVENT_CHANNEL_ALLOWLIST: ReadonlySet<string> = new Set(Object.keys(eventChannels))
