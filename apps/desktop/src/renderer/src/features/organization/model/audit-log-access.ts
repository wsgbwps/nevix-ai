import { useCallback, useEffect, useState } from 'react'
import type { ActiveMembership } from '../api/memberships'
import {
  useActiveOrganization,
  type ActiveMembershipVerification
} from './active-organization-state'

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

function projectAuditLogAccess(
  result: ActiveMembershipVerification,
  organizationId: string
): AuditLogAccessVerification {
  return result.status === 'verified' && canViewAuditLog(result.membership)
    ? { status: 'authorized', organizationId, membership: result.membership }
    : { status: result.status === 'unknown' ? 'error' : 'denied', organizationId }
}

function isVerificationForOrganization(
  result: ActiveMembershipVerification,
  organizationId: string
): boolean {
  return result.status === 'verified'
    ? result.membership.organizationId === organizationId
    : result.organizationId === organizationId
}
export function useVerifiedAuditLogOrganization(): {
  readonly verification: AuditLogAccessVerification | undefined
  readonly refresh: () => Promise<AuditLogAccessVerification | undefined>
  readonly retry: () => void
} {
  const { activeOrganization, membershipVerification, verifyActiveMembership } =
    useActiveOrganization()
  const activeOrganizationId = activeOrganization?.organizationId
  const [verification, setVerification] = useState<AuditLogAccessVerification>()
  const [verificationAttempt, setVerificationAttempt] = useState(0)

  const readFreshAccess = useCallback(async (): Promise<AuditLogAccessVerification | undefined> => {
    if (!activeOrganizationId) return undefined
    const result = await verifyActiveMembership()
    return projectAuditLogAccess(result, activeOrganizationId)
  }, [activeOrganizationId, verifyActiveMembership])
  const refresh = useCallback(async (): Promise<AuditLogAccessVerification | undefined> => {
    const nextVerification = await readFreshAccess()
    if (nextVerification) setVerification(nextVerification)
    return nextVerification
  }, [readFreshAccess])

  useEffect(() => {
    let isMounted = true
    if (!activeOrganizationId) return

    void readFreshAccess().then((nextVerification) => {
      if (isMounted && nextVerification) setVerification(nextVerification)
    })

    return () => {
      isMounted = false
    }
  }, [activeOrganizationId, readFreshAccess, verificationAttempt])

  const entryVerification =
    verification?.organizationId === activeOrganizationId ? verification : undefined
  const currentVerification =
    entryVerification &&
    activeOrganizationId &&
    membershipVerification &&
    isVerificationForOrganization(membershipVerification, activeOrganizationId)
      ? projectAuditLogAccess(membershipVerification, activeOrganizationId)
      : entryVerification

  return {
    verification: currentVerification,
    refresh,
    retry: () => {
      setVerification(undefined)
      setVerificationAttempt((attempt) => attempt + 1)
    }
  }
}
