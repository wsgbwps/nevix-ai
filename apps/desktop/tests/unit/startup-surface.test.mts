import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveStartupSurface } from '../../src/renderer/src/app/startup-surface.ts'

type AuthenticationStatus =
  | 'restoring'
  | 'configuration-error'
  | 'restore-failure'
  | 'unauthenticated'
  | 'authenticated'
type OrganizationStartupPhase = 'idle' | 'resolving' | 'ready'
type Pathname = '/auth' | '/onboarding' | '/select-organization' | '/' | '/projects/example'
type StartupSurfaceDecision =
  | { readonly navigate: string }
  | { readonly render: 'restoring' | 'outlet' }

const statuses: readonly AuthenticationStatus[] = [
  'restoring',
  'configuration-error',
  'restore-failure',
  'unauthenticated',
  'authenticated'
]
const eligibility: readonly boolean[] = [true, false]
const phases: readonly OrganizationStartupPhase[] = ['idle', 'resolving', 'ready']
const activeOrganizationStates: readonly boolean[] = [true, false]
const pathnames: readonly Pathname[] = [
  '/auth',
  '/onboarding',
  '/select-organization',
  '/',
  '/projects/example'
]

interface SurfaceRule {
  readonly statuses: readonly AuthenticationStatus[]
  readonly eligibility: readonly boolean[]
  readonly phases: readonly OrganizationStartupPhase[]
  readonly activeOrganizationStates: readonly boolean[]
  readonly expectedByPathname: Readonly<Record<Pathname, StartupSurfaceDecision>>
}

const surfaceRules: readonly SurfaceRule[] = [
  {
    statuses: ['restoring', 'configuration-error', 'restore-failure', 'unauthenticated'],
    eligibility,
    phases,
    activeOrganizationStates,
    expectedByPathname: {
      '/auth': { render: 'outlet' },
      '/onboarding': { navigate: '/auth' },
      '/select-organization': { navigate: '/auth' },
      '/': { navigate: '/auth' },
      '/projects/example': { navigate: '/auth' }
    }
  },
  {
    statuses: ['authenticated'],
    eligibility: [true],
    phases,
    activeOrganizationStates,
    expectedByPathname: {
      '/auth': { navigate: '/onboarding' },
      '/onboarding': { render: 'outlet' },
      '/select-organization': { navigate: '/onboarding' },
      '/': { navigate: '/onboarding' },
      '/projects/example': { navigate: '/onboarding' }
    }
  },
  {
    statuses: ['authenticated'],
    eligibility: [false],
    phases: ['idle', 'resolving'],
    activeOrganizationStates,
    expectedByPathname: {
      '/auth': { render: 'restoring' },
      '/onboarding': { render: 'restoring' },
      '/select-organization': { render: 'restoring' },
      '/': { render: 'restoring' },
      '/projects/example': { render: 'restoring' }
    }
  },
  {
    statuses: ['authenticated'],
    eligibility: [false],
    phases: ['ready'],
    activeOrganizationStates: [false],
    expectedByPathname: {
      '/auth': { navigate: '/select-organization' },
      '/onboarding': { navigate: '/select-organization' },
      '/select-organization': { render: 'outlet' },
      '/': { navigate: '/select-organization' },
      '/projects/example': { navigate: '/select-organization' }
    }
  },
  {
    statuses: ['authenticated'],
    eligibility: [false],
    phases: ['ready'],
    activeOrganizationStates: [true],
    expectedByPathname: {
      '/auth': { navigate: '/' },
      '/onboarding': { render: 'outlet' },
      '/select-organization': { navigate: '/' },
      '/': { render: 'outlet' },
      '/projects/example': { render: 'outlet' }
    }
  }
]

test('startup surface exhaustively resolves authentication, Organization, and route states', () => {
  const resolvedCombinations = new Set<string>()

  for (const rule of surfaceRules) {
    for (const status of rule.statuses) {
      for (const isEligible of rule.eligibility) {
        for (const phase of rule.phases) {
          for (const hasActiveOrganization of rule.activeOrganizationStates) {
            for (const pathname of pathnames) {
              const combination = JSON.stringify([
                status,
                isEligible,
                phase,
                hasActiveOrganization,
                pathname
              ])
              assert.ok(!resolvedCombinations.has(combination), `duplicate case: ${combination}`)
              resolvedCombinations.add(combination)
              assert.deepEqual(
                resolveStartupSurface({
                  status,
                  isEligible,
                  phase,
                  hasActiveOrganization,
                  pathname
                }),
                rule.expectedByPathname[pathname],
                combination
              )
            }
          }
        }
      }
    }
  }

  assert.equal(
    resolvedCombinations.size,
    statuses.length *
      eligibility.length *
      phases.length *
      activeOrganizationStates.length *
      pathnames.length
  )
})
