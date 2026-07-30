// Contract tests for the Desktop architecture verifier. Each case uses a
// minimal representative fixture: one canonical tree that must pass, and one
// mutation per deterministic rule class that must fail with a stable,
// actionable diagnostic. Fixtures never copy the real application tree.
// This suite must run directly in Node (node --test) without TypeScript.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyDesktopArchitecture, formatViolations } from './verifier.mjs'

function canonicalTree() {
  return {
    'src/main/index.ts': [
      "import { app } from 'electron'",
      "import { initializeLanguage } from './language'",
      "import { createWindow } from './window/main-window'",
      '',
      "const ipcModules = import.meta.glob('./*/ipc/index.ts', { eager: true })",
      '',
      'app.whenReady().then(async () => {',
      '  await initializeLanguage()',
      '  for (const mod of Object.values(ipcModules)) {',
      '    ;(mod as { register: () => void }).register()',
      '  }',
      '  createWindow()',
      '})',
      ''
    ].join('\n'),
    'src/main/authentication/session-store.ts': [
      "import { safeStorage } from 'electron'",
      '',
      'export function readPersistedSession(): string | null {',
      '  return safeStorage.isEncryptionAvailable() ? null : null',
      '}',
      ''
    ].join('\n'),
    'src/main/authentication/ipc/index.ts': [
      "import { ipcMain } from 'electron'",
      "import { readSessionHandler } from './read-session'",
      '',
      'export function register(): void {',
      "  ipcMain.handle('authentication:read-session', readSessionHandler)",
      '}',
      ''
    ].join('\n'),
    'src/main/authentication/ipc/read-session.ts': [
      "import { readPersistedSession } from '../session-store'",
      '',
      'export function readSessionHandler(): string | null {',
      '  return readPersistedSession()',
      '}',
      ''
    ].join('\n'),
    'src/main/language/index.ts':
      "export { initializeLanguage, getMainWindowTitle } from './runtime'\n",
    'src/main/language/runtime.ts': [
      'export async function initializeLanguage(): Promise<void> {}',
      '',
      'export function getMainWindowTitle(): string {',
      "  return 'Nevix AI'",
      '}',
      ''
    ].join('\n'),
    'src/main/language/language-mode-store.ts': [
      "import { app } from 'electron'",
      '',
      'export function languageModePath(): string {',
      "  return app.getPath('userData')",
      '}',
      ''
    ].join('\n'),
    'src/main/language/ipc/index.ts': [
      "import { ipcMain } from 'electron'",
      "import { getBootstrapHandler } from './get-bootstrap'",
      '',
      'export function register(): void {',
      "  ipcMain.handle('language:get-bootstrap', getBootstrapHandler)",
      '}',
      ''
    ].join('\n'),
    'src/main/language/ipc/get-bootstrap.ts': [
      "import { getMainWindowTitle } from '../runtime'",
      '',
      'export function getBootstrapHandler(): { title: string } {',
      '  return { title: getMainWindowTitle() }',
      '}',
      ''
    ].join('\n'),
    'src/main/window/main-window.ts': [
      "import { BrowserWindow } from 'electron'",
      "import { getMainWindowTitle } from '../language'",
      '',
      'export function createWindow(): BrowserWindow {',
      '  return new BrowserWindow({ title: getMainWindowTitle() })',
      '}',
      ''
    ].join('\n'),
    'src/preload/index.ts': [
      "import { contextBridge, ipcRenderer } from 'electron'",
      "import type { IpcChannelMap } from '@ipc/channels'",
      '',
      'function typedInvoke<K extends keyof IpcChannelMap>(channel: K): Promise<unknown> {',
      '  return ipcRenderer.invoke(channel as string)',
      '}',
      '',
      "contextBridge.exposeInMainWorld('api', { invoke: typedInvoke })",
      ''
    ].join('\n'),
    'src/shared/ipc/channels.ts':
      'export interface IpcChannelMap {}\n\nexport interface IpcEventMap {}\n',
    'src/shared/ipc/authentication/types.ts': [
      "declare module '@ipc/channels' {",
      '  interface IpcChannelMap {',
      "    'authentication:read-session': { response: string | null }",
      '  }',
      '}',
      '',
      'export {}',
      ''
    ].join('\n'),
    'src/shared/ipc/language/types.ts': [
      "declare module '@ipc/channels' {",
      '  interface IpcChannelMap {',
      "    'language:get-bootstrap': { response: { title: string } }",
      '  }',
      '  interface IpcEventMap {',
      "    'language:language-mode-changed': { languageMode: string }",
      '  }',
      '}',
      '',
      'export {}',
      ''
    ].join('\n'),
    'src/renderer/src/main.tsx': [
      "import { App } from './app/App'",
      '',
      'export function bootstrap(): void {',
      "  void window.api.invoke('language:get-bootstrap')",
      '  void App',
      '}',
      ''
    ].join('\n'),
    'src/renderer/src/app/App.tsx': [
      "import { AuthenticationScreen } from '../features/authentication'",
      "import { LanguageModeSettings } from '../features/language'",
      '',
      'export function App(): string {',
      '  return AuthenticationScreen() + LanguageModeSettings()',
      '}',
      ''
    ].join('\n'),
    'src/renderer/src/features/authentication/index.ts': [
      "export { AuthenticationScreen } from './ui/authentication-screen'",
      "export { useAuthentication } from './model/use-authentication'",
      ''
    ].join('\n'),
    'src/renderer/src/features/authentication/ui/authentication-screen.tsx': [
      "import { useAuthentication } from '../model/use-authentication'",
      '',
      'export function AuthenticationScreen(): string {',
      '  return useAuthentication()',
      '}',
      ''
    ].join('\n'),
    'src/renderer/src/features/authentication/model/use-authentication.ts': [
      'export function useAuthentication(): string {',
      "  return 'authentication'",
      '}',
      ''
    ].join('\n'),
    'src/renderer/src/features/language/index.ts':
      "export { LanguageModeSettings } from './ui/language-mode-settings'\n",
    'src/renderer/src/features/language/ui/language-mode-settings.tsx': [
      'export function LanguageModeSettings(): string {',
      "  return 'language'",
      '}',
      ''
    ].join('\n')
  }
}

function run(files, allowlist = []) {
  return verifyDesktopArchitecture(files, allowlist)
}

function assertViolation(result, rule, path) {
  assert.equal(result.ok, false, `expected a ${rule} violation`)
  const match = result.violations.find((v) => v.rule === rule && v.path === path)
  assert.ok(
    match,
    `expected ${rule} at ${path}, got:\n${formatViolations(result.violations).join('\n')}`
  )
  assert.ok(match.message.length > 0, 'diagnostic names the finding')
  assert.ok(match.expected.length > 0, 'diagnostic states the expected shape')
}

test('canonical tree with Domain and non-Domain Main owners passes', () => {
  const result = run(canonicalTree())
  assert.deepEqual(formatViolations(result.violations), [])
  assert.equal(result.ok, true)
})

test('diagnostics are deterministic across runs', () => {
  const files = canonicalTree()
  files['src/main/ipc/language/index.ts'] = 'export function register(): void {}\n'
  files['src/main/settings/store.ts'] = 'export const store = 1\n'
  const first = formatViolations(run(files).violations)
  const second = formatViolations(run(files).violations)
  assert.deepEqual(first, second)
  assert.ok(first.length >= 2)
})

test('legacy Adapter-first Main IPC path fails', () => {
  const files = canonicalTree()
  files['src/main/ipc/language/index.ts'] = 'export function register(): void {}\n'
  assertViolation(run(files), 'main/adapter-first-ipc', 'src/main/ipc/language/index.ts')
})

test('IPC adapter under a non-Domain platform owner fails', () => {
  const files = canonicalTree()
  files['src/main/window/ipc/index.ts'] = [
    "import { ipcMain } from 'electron'",
    '',
    'export function register(): void {',
    "  ipcMain.handle('window:focus', () => undefined)",
    '}',
    ''
  ].join('\n')
  assertViolation(run(files), 'main/platform-owner-ipc', 'src/main/window/ipc/index.ts')
})

test('legacy Main Domain names fail', () => {
  const files = canonicalTree()
  files['src/main/settings/store.ts'] = 'export const store = 1\n'
  assertViolation(run(files), 'main/legacy-domain-name', 'src/main/settings/store.ts')
})

test('non-canonical discovery pattern fails', () => {
  const files = canonicalTree()
  files['src/main/index.ts'] = files['src/main/index.ts'].replace(
    "'./*/ipc/index.ts'",
    "'./ipc/*/index.ts'"
  )
  assertViolation(run(files), 'main/registration-discovery', 'src/main/index.ts')
})

test('missing discovery pattern fails', () => {
  const files = canonicalTree()
  files['src/main/index.ts'] = "import { app } from 'electron'\napp.whenReady()\n"
  assertViolation(run(files), 'main/registration-discovery', 'src/main/index.ts')
})

test('asynchronous or missing registration export fails', () => {
  const files = canonicalTree()
  files['src/main/language/ipc/index.ts'] = 'export async function register(): Promise<void> {}\n'
  assertViolation(run(files), 'main/registration-module-shape', 'src/main/language/ipc/index.ts')

  const missing = canonicalTree()
  delete missing['src/main/language/ipc/index.ts']
  assertViolation(run(missing), 'main/registration-module-shape', 'src/main/language/ipc/')
})

test('registration module load-time side effects fail', () => {
  const files = canonicalTree()
  files['src/main/language/ipc/index.ts'] = [
    "import { ipcMain } from 'electron'",
    "import { getBootstrapHandler } from './get-bootstrap'",
    "import './boot'",
    '',
    'const eager = getBootstrapHandler()',
    '',
    'export function register(): void {',
    "  ipcMain.handle('language:get-bootstrap', getBootstrapHandler)",
    '  void eager',
    '}',
    ''
  ].join('\n')
  assertViolation(run(files), 'main/registration-module-shape', 'src/main/language/ipc/index.ts')
})

test('extra Handler nesting fails', () => {
  const files = canonicalTree()
  files['src/main/language/ipc/handlers/set-language-mode.ts'] =
    'export function setLanguageModeHandler(): void {}\n'
  assertViolation(
    run(files),
    'main/handler-nesting',
    'src/main/language/ipc/handlers/set-language-mode.ts'
  )
})

test('Domain implementation depending on IPC fails', () => {
  const files = canonicalTree()
  files['src/main/language/runtime.ts'] = [
    "import { ipcMain } from 'electron'",
    "import { getBootstrapHandler } from './ipc/get-bootstrap'",
    '',
    'export async function initializeLanguage(): Promise<void> {',
    "  ipcMain.handle('language:boot', getBootstrapHandler)",
    '}',
    '',
    'export function getMainWindowTitle(): string {',
    "  return 'Nevix AI'",
    '}',
    ''
  ].join('\n')
  assertViolation(
    run(files),
    'main/implementation-ipc-independence',
    'src/main/language/runtime.ts'
  )
})

test('cross-Domain deep import in Main fails', () => {
  const files = canonicalTree()
  files['src/main/window/main-window.ts'] = files['src/main/window/main-window.ts'].replace(
    "from '../language'",
    "from '../language/language-mode-store'"
  )
  assertViolation(run(files), 'main/cross-domain-deep-import', 'src/main/window/main-window.ts')
})

test('Main Domain dependency cycle fails', () => {
  const files = canonicalTree()
  files['src/main/authentication/index.ts'] =
    "export { readPersistedSession } from './session-store'\n"
  files['src/main/authentication/session-store.ts'] = [
    "import { getMainWindowTitle } from '../language'",
    '',
    'export function readPersistedSession(): string | null {',
    '  return getMainWindowTitle() ? null : null',
    '}',
    ''
  ].join('\n')
  files['src/main/language/runtime.ts'] = [
    "import { readPersistedSession } from '../authentication'",
    '',
    'export async function initializeLanguage(): Promise<void> {',
    '  void readPersistedSession()',
    '}',
    '',
    'export function getMainWindowTitle(): string {',
    "  return 'Nevix AI'",
    '}',
    ''
  ].join('\n')
  assertViolation(run(files), 'main/domain-cycle', 'src/main/authentication')
})

test('shared Channel declarations disagreeing with the Domain prefix fail', () => {
  const files = canonicalTree()
  files['src/shared/ipc/language/types.ts'] = files['src/shared/ipc/language/types.ts'].replace(
    "'language:get-bootstrap'",
    "'other:get-bootstrap'"
  )
  assertViolation(run(files), 'channels/domain-prefix', 'src/shared/ipc/language/types.ts')
})

test('Main adapter Channels disagreeing with the Domain prefix fail', () => {
  const files = canonicalTree()
  files['src/main/language/ipc/index.ts'] = files['src/main/language/ipc/index.ts'].replace(
    "'language:get-bootstrap'",
    "'authentication:get-bootstrap'"
  )
  assertViolation(run(files), 'channels/domain-prefix', 'src/main/language/ipc/index.ts')
})

test('seam names disagreeing between shared IPC and Main fail', () => {
  const withOrphanDeclaration = canonicalTree()
  withOrphanDeclaration['src/shared/ipc/auth/types.ts'] = [
    "declare module '@ipc/channels' {",
    '  interface IpcChannelMap {',
    "    'auth:read-session': { response: string | null }",
    '  }',
    '}',
    '',
    'export {}',
    ''
  ].join('\n')
  assertViolation(
    run(withOrphanDeclaration),
    'channels/seam-name-agreement',
    'src/shared/ipc/auth/types.ts'
  )

  const withOrphanAdapter = canonicalTree()
  delete withOrphanAdapter['src/shared/ipc/language/types.ts']
  assertViolation(
    run(withOrphanAdapter),
    'channels/seam-name-agreement',
    'src/main/language/ipc/index.ts'
  )
})

test('legacy Language Channel prefixes fail', () => {
  const files = canonicalTree()
  files['src/renderer/src/main.tsx'] = files['src/renderer/src/main.tsx'].replace(
    "'language:get-bootstrap'",
    "'i18n:get-bootstrap'"
  )
  assertViolation(run(files), 'channels/legacy-language-prefix', 'src/renderer/src/main.tsx')
})

test('legacy shared IPC and renderer Feature Domain names fail', () => {
  const files = canonicalTree()
  files['src/shared/ipc/i18n/types.ts'] = 'export {}\n'
  files['src/renderer/src/features/settings/index.ts'] = 'export {}\n'
  const result = run(files)
  assertViolation(result, 'shared/legacy-domain-name', 'src/shared/ipc/i18n/types.ts')
  assertViolation(
    result,
    'renderer/legacy-feature-name',
    'src/renderer/src/features/settings/index.ts'
  )
})

test('Channel map augmentation outside shared IPC types fails', () => {
  const files = canonicalTree()
  files['src/renderer/src/app/channels.d.ts'] =
    "declare module '@ipc/channels' {\n  interface IpcChannelMap {}\n}\n"
  assertViolation(
    run(files),
    'shared/channel-declaration-placement',
    'src/renderer/src/app/channels.d.ts'
  )
})

test('non-empty shared Channel base fails', () => {
  const files = canonicalTree()
  files['src/shared/ipc/channels.ts'] = [
    "import type { LanguageMode } from '../i18n/language-mode'",
    '',
    'export interface IpcChannelMap {',
    "  'language:get-language-mode': { response: LanguageMode }",
    '}',
    '',
    'export interface IpcEventMap {}',
    ''
  ].join('\n')
  assertViolation(run(files), 'shared/channels-base', 'src/shared/ipc/channels.ts')
})

test('per-Domain preload imports and Channel constants fail', () => {
  const files = canonicalTree()
  files['src/preload/index.ts'] = [
    "import { contextBridge, ipcRenderer } from 'electron'",
    "import type { PersistedSessionRead } from '../shared/ipc/authentication/types'",
    '',
    'function readSession(): Promise<PersistedSessionRead> {',
    "  return ipcRenderer.invoke('authentication:read-session')",
    '}',
    '',
    "contextBridge.exposeInMainWorld('api', { readSession })",
    ''
  ].join('\n')
  const result = run(files)
  assertViolation(result, 'preload/generic-bridge', 'src/preload/index.ts')
  assert.equal(result.violations.filter((v) => v.rule === 'preload/generic-bridge').length, 2)
})

test('deep import into a Feature from outside fails', () => {
  const files = canonicalTree()
  files['src/renderer/src/app/App.tsx'] = files['src/renderer/src/app/App.tsx'].replace(
    "from '../features/authentication'",
    "from '../features/authentication/ui/authentication-screen'"
  )
  assertViolation(run(files), 'renderer/feature-deep-import', 'src/renderer/src/app/App.tsx')
})

test('Feature importing its own public index fails', () => {
  const files = canonicalTree()
  files['src/renderer/src/features/authentication/ui/authentication-screen.tsx'] = [
    "import { useAuthentication } from '../index'",
    '',
    'export function AuthenticationScreen(): string {',
    '  return useAuthentication()',
    '}',
    ''
  ].join('\n')
  assertViolation(
    run(files),
    'renderer/feature-self-import',
    'src/renderer/src/features/authentication/ui/authentication-screen.tsx'
  )
})

test('peer Feature import fails', () => {
  const files = canonicalTree()
  files['src/renderer/src/features/language/ui/language-mode-settings.tsx'] = [
    "import { useAuthentication } from '../../authentication'",
    '',
    'export function LanguageModeSettings(): string {',
    '  return useAuthentication()',
    '}',
    ''
  ].join('\n')
  assertViolation(
    run(files),
    'renderer/peer-feature-import',
    'src/renderer/src/features/language/ui/language-mode-settings.tsx'
  )
})

test('wildcard or implementation-bearing Feature public index fails', () => {
  const files = canonicalTree()
  files['src/renderer/src/features/language/index.ts'] =
    "export * from './ui/language-mode-settings'\nexport const version = 1\n"
  assertViolation(
    run(files),
    'renderer/public-index-shape',
    'src/renderer/src/features/language/index.ts'
  )
})

test('extra source file at a Feature root fails', () => {
  const files = canonicalTree()
  files['src/renderer/src/features/language/i18n.ts'] = 'export const resources = {}\n'
  assertViolation(
    run(files),
    'renderer/feature-root-source',
    'src/renderer/src/features/language/i18n.ts'
  )
})

test('non-canonical general-purpose Feature segment fails', () => {
  const files = canonicalTree()
  files['src/renderer/src/features/language/components/language-picker.tsx'] =
    'export function LanguagePicker(): string {\n  return "picker"\n}\n'
  assertViolation(
    run(files),
    'renderer/segment-vocabulary',
    'src/renderer/src/features/language/components/language-picker.tsx'
  )
})

test('exact allowlist entries suppress only their documented violation', () => {
  const files = canonicalTree()
  files['src/main/ipc/language/index.ts'] = 'export function register(): void {}\n'
  const result = run(files, [
    {
      rule: 'main/adapter-first-ipc',
      path: 'src/main/ipc/language/index.ts',
      reason: 'Documented migration debt.',
      removalTrigger: 'Removed when the atomic migration lands.'
    }
  ])
  assert.equal(result.ok, true, formatViolations(result.violations).join('\n'))
})

test('unused allowlist entries fail so the list only shrinks', () => {
  const result = run(canonicalTree(), [
    {
      rule: 'main/adapter-first-ipc',
      path: 'src/main/ipc/gone/index.ts',
      reason: 'Documented migration debt.',
      removalTrigger: 'Removed when the atomic migration lands.'
    }
  ])
  assertViolation(result, 'allowlist/unused-entry', 'src/main/ipc/gone/index.ts')
})

test('wildcard, reasonless, or unknown-rule allowlist entries fail', () => {
  const files = canonicalTree()
  files['src/main/ipc/language/index.ts'] = 'export function register(): void {}\n'
  const result = run(files, [
    {
      rule: 'main/adapter-first-ipc',
      path: 'src/main/ipc/*',
      reason: 'General disable.',
      removalTrigger: 'Never.'
    },
    {
      rule: 'main/adapter-first-ipc',
      path: 'src/main/ipc/language/index.ts',
      reason: '',
      removalTrigger: 'Removed when the atomic migration lands.'
    },
    {
      rule: 'not-a-rule',
      path: 'src/main/ipc/language/index.ts',
      reason: 'Documented migration debt.',
      removalTrigger: 'Removed when the atomic migration lands.'
    }
  ])
  assert.equal(result.ok, false)
  assert.equal(result.violations.filter((v) => v.rule === 'allowlist/invalid-entry').length, 3)
  assertViolation(result, 'main/adapter-first-ipc', 'src/main/ipc/language/index.ts')
})
