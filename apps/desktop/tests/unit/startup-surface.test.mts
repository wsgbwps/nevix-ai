import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveStartupSurface } from '../../src/renderer/src/app/startup-surface.ts'

type ConnectionStatus = 'restoring' | 'unconfigured' | 'configured'
type Pathname = '/connect' | '/auth' | '/' | '/settings' | '/projects/example'
type StartupSurfaceDecision = { readonly navigate: string } | { readonly render: 'outlet' }

const connectionStatuses: readonly ConnectionStatus[] = ['restoring', 'unconfigured', 'configured']
const sessionAvailability: readonly boolean[] = [false, true]
const pathnames: readonly Pathname[] = ['/connect', '/auth', '/', '/settings', '/projects/example']

test('startup surface exhaustively resolves connection, authentication, and route states', () => {
  const resolvedCombinations = new Set<string>()

  for (const connectionStatus of connectionStatuses) {
    for (const sessionAvailable of sessionAvailability) {
      for (const pathname of pathnames) {
        const combination = JSON.stringify([connectionStatus, sessionAvailable, pathname])
        assert.ok(!resolvedCombinations.has(combination), `duplicate case: ${combination}`)
        resolvedCombinations.add(combination)

        const decision = resolveStartupSurface({
          connectionStatus,
          sessionAvailable,
          pathname
        })
        const expected: StartupSurfaceDecision =
          connectionStatus === 'unconfigured'
            ? pathname === '/connect'
              ? { render: 'outlet' }
              : { navigate: '/connect' }
            : !sessionAvailable
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
    connectionStatuses.length * sessionAvailability.length * pathnames.length
  )
})

test('every pre-authenticated session state is a pre-business surface, not a shell', () => {
  // Restore, unauthenticated, Instance Claim, registration, and the forced
  // password change all collapse to session-unavailable for routing.
  assert.deepEqual(
    resolveStartupSurface({
      connectionStatus: 'configured',
      sessionAvailable: false,
      pathname: '/'
    }),
    { navigate: '/auth' }
  )
  assert.deepEqual(
    resolveStartupSurface({
      connectionStatus: 'configured',
      sessionAvailable: false,
      pathname: '/auth'
    }),
    { render: 'outlet' }
  )
})
