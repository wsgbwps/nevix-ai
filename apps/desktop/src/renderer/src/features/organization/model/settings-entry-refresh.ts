import { useEffect } from 'react'
import { useActiveOrganization } from './active-organization-state'

export function useSettingsEntryMembershipRefresh(): void {
  const { activeOrganization, refreshActiveOrganization } = useActiveOrganization()
  const activeOrganizationId = activeOrganization?.organizationId

  useEffect(() => {
    if (!activeOrganizationId) return
    void refreshActiveOrganization().catch(() => {
      // Preserve cached Settings chrome; domain sections verify their own RLS projections.
    })
  }, [activeOrganizationId, refreshActiveOrganization])
}
