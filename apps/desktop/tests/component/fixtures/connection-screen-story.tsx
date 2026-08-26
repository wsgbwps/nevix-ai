import i18next from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { createI18nOptions } from '../../../src/shared/i18n/i18next-options'
import {
  ConnectionScreen,
  connectionResources
} from '../../../src/renderer/src/features/connection'
import { ThemeProvider } from '../../../src/renderer/src/components/theme-provider'

/**
 * Black-box module-test composition for the Connection public surface
 * (#153): the Connection Screen page mounted on a scripted preload bridge, so
 * tests drive visible user behavior and observe the rendered verdicts exactly
 * as the real IPC would deliver them.
 */

const testI18n = i18next.createInstance()
await testI18n.init(
  createI18nOptions({
    language: 'en',
    resources: connectionResources,
    defaultNS: 'connection',
    environment: 'test'
  })
)

export interface ConnectionInvokeCall {
  readonly channel: string
  readonly request: unknown
}

export interface ConnectionModuleTestControls {
  enqueue(channel: string, result: unknown): void
  readonly calls: readonly ConnectionInvokeCall[]
}

declare global {
  interface Window {
    __connectionTest?: ConnectionModuleTestControls
  }
}

/**
 * Installs the scripted preload bridge once per page. The Connection Screen
 * issues no IPC on mount, so tests enqueue verdicts between mount and click.
 */
function ensureControls(): ConnectionModuleTestControls {
  if (window.__connectionTest !== undefined) return window.__connectionTest

  const calls: ConnectionInvokeCall[] = []
  const queues = new Map<string, unknown[]>()
  const controls: ConnectionModuleTestControls = {
    enqueue(channel, result) {
      const queue = queues.get(channel) ?? []
      queue.push(result)
      queues.set(channel, queue)
    },
    calls
  }
  window.__connectionTest = controls
  window.api = {
    invoke: (channel, ...args) => {
      calls.push({ channel: channel as string, request: args[0] })
      const next = queues.get(channel as string)?.shift()
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next as never)
    },
    on: () => () => undefined
  } as typeof window.api
  return controls
}

export function ConnectionScreenStory(): React.JSX.Element {
  ensureControls()
  return (
    <ThemeProvider defaultTheme="dark" storageKey="nevix-connection-module-test-theme">
      <I18nextProvider i18n={testI18n}>
        <ConnectionScreen />
      </I18nextProvider>
    </ThemeProvider>
  )
}
