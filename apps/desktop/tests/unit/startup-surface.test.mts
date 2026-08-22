import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveStartupSurface } from '../../src/renderer/src/app/startup-surface.ts'

type AuthenticationStatus =
  | 'restoring'
  | 'configuration-error'
  | 'restore-failure'
  | 'unauthenticated'
  | 'password-change-required'
  | 'authenticated'
type Pathname = '/auth' | '/' | '/settings' | '/projects/example'
type StartupSurfaceDecision = { readonly navigate: string } | { readonly render: 'outlet' }

const statuses: readonly AuthenticationStatus[] = [
  'restoring',
  'configuration-error',
  'restore-failure',
  'unauthenticated',
  'password-change-required',
  'authenticated'
]
const pathnames: readonly Pathname[] = ['/auth', '/', '/settings', '/projects/example']

test('startup surface exhaustively resolves authentication and route states', () => {
  const resolvedCombinations = new Set<string>()

  for (const status of statuses) {
    for (const pathname of pathnames) {
      const combination = JSON.stringify([status, pathname])
      assert.ok(!resolvedCombinations.has(combination), `duplicate case: ${combination}`)
      resolvedCombinations.add(combination)

      const decision = resolveStartupSurface({ status, pathname })
      const expected: StartupSurfaceDecision =
        status !== 'authenticated'
          ? pathname === '/auth'
            ? { render: 'outlet' }
            : { navigate: '/auth' }
          : pathname === '/auth'
            ? { navigate: '/' }
            : { render: 'outlet' }

      assert.deepEqual(decision, expected, combination)
    }
  }

  assert.equal(resolvedCombinations.size, statuses.length * pathnames.length)
})

test('the forced first-login password change is a pre-business surface, not a shell', () => {
  assert.deepEqual(resolveStartupSurface({ status: 'password-change-required', pathname: '/' }), {
    navigate: '/auth'
  })
  assert.deepEqual(
    resolveStartupSurface({ status: 'password-change-required', pathname: '/auth' }),
    { render: 'outlet' }
  )
})
