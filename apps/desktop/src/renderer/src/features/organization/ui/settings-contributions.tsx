import { useEffect, useState } from 'react'
import { ScrollTextIcon, UsersRoundIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { canViewAuditLog } from '../model/audit-log-access'
import { useActiveOrganization } from '../model/active-organization-state'

export function ActiveOrganizationSettingsContext({
  onOpenOrganizationPicker,
  switchDisabled
}: {
  readonly onOpenOrganizationPicker: () => void
  readonly switchDisabled: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation('organization')
  const { activeOrganization, membershipVerification, verifyActiveMembership } =
    useActiveOrganization()
  const activeOrganizationId = activeOrganization?.organizationId

  useEffect(() => {
    if (!activeOrganizationId) return
    void verifyActiveMembership()
  }, [activeOrganizationId, verifyActiveMembership])

  if (!activeOrganization) return null
  const verificationUnknown =
    membershipVerification?.status === 'unknown' &&
    membershipVerification.organizationId === activeOrganization.organizationId

  return (
    <div className="bg-background/70 grid gap-3 rounded-lg border p-3">
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className="bg-primary text-primary-foreground grid size-9 shrink-0 place-items-center rounded-lg font-bold"
        >
          {activeOrganization.organizationName.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{activeOrganization.organizationName}</p>
          <p className="text-muted-foreground text-xs">
            {t(`common.roles.${activeOrganization.role}`)}
          </p>
          {verificationUnknown ? (
            <p className="text-destructive text-xs">{t('settingsChrome.verificationUnknown')}</p>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        disabled={switchDisabled}
        className="text-muted-foreground hover:text-foreground text-left text-xs font-medium"
        onClick={onOpenOrganizationPicker}
      >
        {t('shell.switchToPicker')}
      </button>
    </div>
  )
}

export type OrganizationSettingsSection = 'members' | 'audit-log'

export function OrganizationSettingsNavigation({
  activeSection,
  disabled,
  onSelectSection
}: {
  readonly activeSection: OrganizationSettingsSection | undefined
  readonly disabled: boolean
  readonly onSelectSection: (section: OrganizationSettingsSection) => void
}): React.JSX.Element | null {
  const { t } = useTranslation('organization')
  const { activeOrganization, verifyActiveMembership } = useActiveOrganization()
  const [sectionVerificationPending, setSectionVerificationPending] = useState(false)

  if (!activeOrganization) return null

  async function selectMembersSection(): Promise<void> {
    if (disabled || sectionVerificationPending) return

    setSectionVerificationPending(true)
    try {
      const verification = await verifyActiveMembership()
      if (verification.status !== 'lost') onSelectSection('members')
    } finally {
      setSectionVerificationPending(false)
    }
  }

  return (
    <div className="grid gap-1">
      <p className="text-muted-foreground px-2.5 text-xs font-medium tracking-wide uppercase">
        {t('settingsChrome.groupOrg')}
      </p>
      <button
        type="button"
        aria-pressed={activeSection === 'members'}
        disabled={disabled || sectionVerificationPending}
        onClick={() => void selectMembersSection()}
        className="text-sidebar-foreground hover:bg-sidebar-accent aria-pressed:bg-sidebar-accent flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm font-medium"
      >
        <UsersRoundIcon className="size-4" />
        {t('members.title')}
      </button>
      {canViewAuditLog(activeOrganization) ? (
        <button
          type="button"
          aria-pressed={activeSection === 'audit-log'}
          disabled={disabled || sectionVerificationPending}
          onClick={() => onSelectSection('audit-log')}
          className="text-sidebar-foreground hover:bg-sidebar-accent aria-pressed:bg-sidebar-accent flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm font-medium"
        >
          <ScrollTextIcon className="size-4" />
          {t('audit.title')}
        </button>
      ) : null}
    </div>
  )
}
