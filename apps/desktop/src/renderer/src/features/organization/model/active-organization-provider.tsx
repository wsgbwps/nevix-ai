import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { readActiveMemberships, type ActiveMembership } from '../api/memberships'
import {
  ActiveOrganizationContext,
  type ActiveOrganizationState,
  type OrganizationStartupPhase
} from './active-organization-state'
import { resolveStartupBranch } from './startup-resolution'
import { useOrganizationOnboarding } from './onboarding-state'

interface ActiveOrganizationProviderProps {
  readonly isAuthenticated: boolean
  readonly getSession: () => Promise<
    { readonly accessToken: string; readonly userId: string } | undefined
  >
  readonly children: React.ReactNode
}

/**
 * Holds the Active Organization in renderer memory and runs the startup verification once per
 * authenticated Session: reads active Memberships (RLS direct read, the single source of truth)
 * plus the remembered Organization id from main-process persistence, then takes one branch —
 * remembered Membership valid enters directly, zero Organizations begins onboarding, a single
 * Organization is auto-selected only without a device memory, and everything else lands on the
 * Organization picker. A remembered Membership that has ended therefore never auto-enters.
 *
 * The composition root remounts this provider whenever authentication status changes, so the
 * state of a signed-out Session can never leak into the next Session.
 */
export function ActiveOrganizationProvider({
  isAuthenticated,
  getSession,
  children
}: ActiveOrganizationProviderProps): React.JSX.Element {
  const onboarding = useOrganizationOnboarding()
  const [startupPhase, setStartupPhase] = useState<OrganizationStartupPhase>('idle')
  const [activeOrganization, setActiveOrganization] = useState<ActiveMembership>()
  const [availableOrganizations, setAvailableOrganizations] = useState<readonly ActiveMembership[]>(
    []
  )
  const [rememberedOrganizationId, setRememberedOrganizationId] = useState<string>()
  // The startup verification runs at most once per authenticated Session; a failed fetch stays
  // on the restoring view instead of retrying in a loop.
  const resolutionRef = useRef<'none' | 'running' | 'done' | 'failed'>('none')

  const enterOrganization = useCallback((membership: ActiveMembership): void => {
    setActiveOrganization(membership)
    setRememberedOrganizationId(membership.organizationId)
    setAvailableOrganizations((organizations) =>
      organizations.some((each) => each.organizationId === membership.organizationId)
        ? organizations
        : [...organizations, membership]
    )
    setStartupPhase('ready')
    void window.api.invoke('organization:set-remembered-active-organization', {
      organizationId: membership.organizationId
    })
  }, [])

  useEffect(() => {
    if (!isAuthenticated) return
    if (onboarding.isEligible || activeOrganization) return
    if (resolutionRef.current !== 'none') return

    resolutionRef.current = 'running'
    setStartupPhase('resolving')
    void (async () => {
      try {
        const session = await getSession()
        if (resolutionRef.current !== 'running') return
        if (!session) {
          resolutionRef.current = 'failed'
          return
        }

        const [memberships, remembered] = await Promise.all([
          readActiveMemberships(session),
          window.api.invoke('organization:get-remembered-active-organization')
        ])
        if (resolutionRef.current !== 'running') return

        resolutionRef.current = 'done'
        setAvailableOrganizations(memberships)
        const rememberedId = remembered.organizationId ?? undefined
        setRememberedOrganizationId(rememberedId)

        const branch = resolveStartupBranch(memberships, rememberedId)
        if (branch.kind === 'enter') {
          enterOrganization(branch.membership)
          return
        }

        setStartupPhase('ready')
        if (branch.kind === 'onboarding') onboarding.beginOnboarding()
      } catch {
        resolutionRef.current = 'failed'
      }
    })()
  }, [isAuthenticated, onboarding, activeOrganization, getSession, enterOrganization])

  const value = useMemo<ActiveOrganizationState>(
    () => ({
      startupPhase,
      activeOrganization,
      availableOrganizations,
      rememberedOrganizationId,
      enterOrganization
    }),
    [
      startupPhase,
      activeOrganization,
      availableOrganizations,
      rememberedOrganizationId,
      enterOrganization
    ]
  )

  return (
    <ActiveOrganizationContext.Provider value={value}>
      {children}
    </ActiveOrganizationContext.Provider>
  )
}
