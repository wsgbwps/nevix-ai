import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeftIcon,
  LanguagesIcon,
  ScrollTextIcon,
  UserRoundIcon,
  UsersRoundIcon
} from 'lucide-react'
import { canViewAuditLog } from '../model/audit-log-access'
import { useActiveOrganization } from '../model/active-organization-state'
import { useSettingsEntryMembershipRefresh } from '../model/settings-entry-refresh'

export function OrganizationSettingsSidebar({
  backLabel,
  navigationLabel,
  profileLabel,
  languageLabel
}: {
  readonly backLabel: string
  readonly navigationLabel: string
  readonly profileLabel: string
  readonly languageLabel: string
}): React.JSX.Element | null {
  const { t } = useTranslation('organization')
  const { activeOrganization, openOrganizationPicker } = useActiveOrganization()
  useSettingsEntryMembershipRefresh()

  if (!activeOrganization) return null

  return (
    <aside className="bg-sidebar text-sidebar-foreground flex w-64 shrink-0 flex-col gap-5 border-r p-4">
      <Link
        to="/"
        className="text-muted-foreground hover:text-foreground flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors"
      >
        <ArrowLeftIcon className="size-4" />
        {backLabel}
      </Link>

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
          className="text-muted-foreground hover:text-foreground text-left text-xs font-medium"
          onClick={openOrganizationPicker}
        >
          {t('shell.switchToPicker')}
        </button>
      </div>

      <nav aria-label={navigationLabel} className="grid gap-4">
        <div className="grid gap-1">
          <p className="text-muted-foreground px-2.5 text-xs font-medium tracking-wide uppercase">
            {t('settingsChrome.groupAccount')}
          </p>
          <a
            href="#profile"
            className="text-sidebar-foreground hover:bg-sidebar-accent flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium"
          >
            <UserRoundIcon className="size-4" />
            {profileLabel}
          </a>
          <a
            href="#language"
            className="text-sidebar-foreground hover:bg-sidebar-accent flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium"
          >
            <LanguagesIcon className="size-4" />
            {languageLabel}
          </a>
        </div>

        <div className="grid gap-1">
          <p className="text-muted-foreground px-2.5 text-xs font-medium tracking-wide uppercase">
            {t('settingsChrome.groupOrg')}
          </p>
          <button
            type="button"
            aria-controls="members"
            onClick={() => document.getElementById('members')?.scrollIntoView({ block: 'start' })}
            className="text-sidebar-foreground hover:bg-sidebar-accent flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm font-medium"
          >
            <UsersRoundIcon className="size-4" />
            {t('members.title')}
          </button>
          {canViewAuditLog(activeOrganization) ? (
            <button
              type="button"
              aria-controls="audit-log"
              onClick={() =>
                document.getElementById('audit-log')?.scrollIntoView({ block: 'start' })
              }
              className="text-sidebar-foreground hover:bg-sidebar-accent flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm font-medium"
            >
              <ScrollTextIcon className="size-4" />
              {t('audit.title')}
            </button>
          ) : null}
        </div>
      </nav>
    </aside>
  )
}
