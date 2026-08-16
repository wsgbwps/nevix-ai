import { useEffect, useState } from 'react'
import type { ActiveMembership } from '../api/memberships'
import { useActiveOrganization } from './active-organization-state'

/** UI gating mirrors the Data API policy; RLS remains the authoritative enforcement boundary. */
export function canViewAuditLog(
  organization: ActiveMembership | undefined
): organization is ActiveMembership {
  return organization?.role === 'owner' || organization?.role === 'admin'
}

type AuditLogAccessVerification =
  | {
      readonly status: 'authorized'
      readonly organizationId: string
      readonly membership: ActiveMembership
    }
  | { readonly status: 'denied' | 'error'; readonly organizationId: string }

export function useVerifiedAuditLogOrganization(): {
  readonly verification: AuditLogAccessVerification | undefined
  readonly retry: () => void
} {
  const { activeOrganization, verifyActiveMembership } = useActiveOrganization()
  const activeOrganizationId = activeOrganization?.organizationId
  const [verification, setVerification] = useState<AuditLogAccessVerification>()
  const [verificationAttempt, setVerificationAttempt] = useState(0)

  useEffect(() => {
    let isMounted = true
    if (!activeOrganizationId) return

    void verifyActiveMembership().then((result) => {
      if (!isMounted) return
      setVerification(
        result.status === 'verified' && canViewAuditLog(result.membership)
          ? {
              status: 'authorized',
              organizationId: activeOrganizationId,
              membership: result.membership
            }
          : {
              status: result.status === 'unknown' ? 'error' : 'denied',
              organizationId: activeOrganizationId
            }
      )
    })

    return () => {
      isMounted = false
    }
  }, [activeOrganizationId, verificationAttempt, verifyActiveMembership])

  return {
    verification: verification?.organizationId === activeOrganizationId ? verification : undefined,
    retry: () => {
      setVerification(undefined)
      setVerificationAttempt((attempt) => attempt + 1)
    }
  }
}
