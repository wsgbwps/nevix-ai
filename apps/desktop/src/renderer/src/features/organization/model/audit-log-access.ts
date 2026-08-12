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
  const { activeOrganization, refreshActiveOrganization } = useActiveOrganization()
  const activeOrganizationId = activeOrganization?.organizationId
  const [verification, setVerification] = useState<AuditLogAccessVerification>()
  const [verificationAttempt, setVerificationAttempt] = useState(0)

  useEffect(() => {
    let isMounted = true
    if (!activeOrganizationId) return

    void refreshActiveOrganization()
      .then((membership) => {
        if (!isMounted) return
        setVerification(
          canViewAuditLog(membership)
            ? { status: 'authorized', organizationId: activeOrganizationId, membership }
            : { status: 'denied', organizationId: activeOrganizationId }
        )
      })
      .catch(() => {
        if (isMounted) {
          setVerification({ status: 'error', organizationId: activeOrganizationId })
        }
      })

    return () => {
      isMounted = false
    }
  }, [activeOrganizationId, refreshActiveOrganization, verificationAttempt])

  return {
    verification: verification?.organizationId === activeOrganizationId ? verification : undefined,
    retry: () => {
      setVerification(undefined)
      setVerificationAttempt((attempt) => attempt + 1)
    }
  }
}
