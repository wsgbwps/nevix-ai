import type { ActiveMembership } from '../api/memberships'

export type StartupBranch =
  | { readonly kind: 'enter'; readonly membership: ActiveMembership }
  | { readonly kind: 'picker' }
  | { readonly kind: 'onboarding' }

export function resolveStartupBranch(
  memberships: readonly ActiveMembership[],
  rememberedOrganizationId: string | undefined
): StartupBranch {
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
