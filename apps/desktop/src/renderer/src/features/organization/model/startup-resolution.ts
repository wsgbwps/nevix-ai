import type { ActiveMembership } from '../api/memberships'

export type StartupBranch =
  | { readonly kind: 'enter'; readonly membership: ActiveMembership }
  | { readonly kind: 'picker' }
  | { readonly kind: 'onboarding' }

export function resolveStartupBranch(
  memberships: readonly ActiveMembership[],
  rememberedOrganizationId: string | undefined,
  hasPendingInvitation = false
): StartupBranch {
  if (hasPendingInvitation) return { kind: 'picker' }

  const rememberedMembership = memberships.find(
    (membership) => membership.organizationId === rememberedOrganizationId
  )
  if (rememberedMembership) {
    return { kind: 'enter', membership: rememberedMembership }
  }

  if (rememberedOrganizationId === undefined && memberships.length === 1) {
    return { kind: 'enter', membership: memberships[0] }
  }

  return memberships.length === 0 ? { kind: 'onboarding' } : { kind: 'picker' }
}

export function reconcileStartupBranch(
  memberships: readonly ActiveMembership[],
  rememberedOrganizationId: string | undefined,
  hasPendingInvitation: boolean,
  actions: {
    readonly beginOnboarding: () => void
    readonly enterOrganization: (membership: ActiveMembership) => void
  }
): void {
  const branch = resolveStartupBranch(memberships, rememberedOrganizationId, hasPendingInvitation)
  if (branch.kind === 'onboarding') {
    actions.beginOnboarding()
  } else if (branch.kind === 'enter') {
    actions.enterOrganization(branch.membership)
  }
}
