import { ScrollTextIcon, UsersRoundIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { canViewAuditLog } from '../model/audit-log-access'
import { useActiveOrganization } from '../model/active-organization-state'
import { useSettingsEntryMembershipRefresh } from '../model/settings-entry-refresh'

export function ActiveOrganizationSettingsContext({
  onOpenOrganizationPicker,
  switchDisabled
}: {
  readonly onOpenOrganizationPicker: () => void
  readonly switchDisabled: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation('organization')
  const { activeOrganization } = useActiveOrganization()
  useSettingsEntryMembershipRefresh()

  if (!activeOrganization) return null

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
  const { activeOrganization } = useActiveOrganization()

  if (!activeOrganization) return null

  return (
    <div className="grid gap-1">
      <p className="text-muted-foreground px-2.5 text-xs font-medium tracking-wide uppercase">
        {t('settingsChrome.groupOrg')}
      </p>
      <button
        type="button"
        aria-pressed={activeSection === 'members'}
        disabled={disabled}
        onClick={() => onSelectSection('members')}
        className="text-sidebar-foreground hover:bg-sidebar-accent aria-pressed:bg-sidebar-accent flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm font-medium"
      >
        <UsersRoundIcon className="size-4" />
        {t('members.title')}
      </button>
      {canViewAuditLog(activeOrganization) ? (
        <button
          type="button"
          aria-pressed={activeSection === 'audit-log'}
          disabled={disabled}
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
