import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveStartupSurface } from '../../src/renderer/src/app/startup-surface.ts'

type ConnectionStatus = 'restoring' | 'unconfigured' | 'configured'
type AuthenticationStatus =
  | 'restoring'
  | 'restore-failure'
  | 'unauthenticated'
  | 'password-change-required'
  | 'authenticated'
type Pathname = '/connect' | '/auth' | '/' | '/settings' | '/projects/example'
type StartupSurfaceDecision = { readonly navigate: string } | { readonly render: 'outlet' }

const connectionStatuses: readonly ConnectionStatus[] = ['restoring', 'unconfigured', 'configured']
const statuses: readonly AuthenticationStatus[] = [
  'restoring',
  'restore-failure',
  'unauthenticated',
  'password-change-required',
  'authenticated'
]
const pathnames: readonly Pathname[] = ['/connect', '/auth', '/', '/settings', '/projects/example']

test('startup surface exhaustively resolves connection, authentication, and route states', () => {
  const resolvedCombinations = new Set<string>()

  for (const connectionStatus of connectionStatuses) {
    for (const status of statuses) {
      for (const pathname of pathnames) {
        const combination = JSON.stringify([connectionStatus, status, pathname])
        assert.ok(!resolvedCombinations.has(combination), `duplicate case: ${combination}`)
        resolvedCombinations.add(combination)

        const decision = resolveStartupSurface({
          connectionStatus,
          authenticationStatus: status,
          pathname
        })
        const expected: StartupSurfaceDecision =
          connectionStatus === 'unconfigured'
            ? pathname === '/connect'
              ? { render: 'outlet' }
              : { navigate: '/connect' }
            : status !== 'authenticated'
              ? pathname === '/auth'
                ? { render: 'outlet' }
                : { navigate: '/auth' }
              : pathname === '/auth' || pathname === '/connect'
                ? { navigate: '/' }
                : { render: 'outlet' }

        assert.deepEqual(decision, expected, combination)
      }
    }
  }

  assert.equal(
    resolvedCombinations.size,
    connectionStatuses.length * statuses.length * pathnames.length
  )
})

test('the forced first-login password change is a pre-business surface, not a shell', () => {
  assert.deepEqual(
    resolveStartupSurface({
      connectionStatus: 'configured',
      authenticationStatus: 'password-change-required',
      pathname: '/'
    }),
    { navigate: '/auth' }
  )
  assert.deepEqual(
    resolveStartupSurface({
      connectionStatus: 'configured',
      authenticationStatus: 'password-change-required',
      pathname: '/auth'
    }),
    { render: 'outlet' }
  )
})
