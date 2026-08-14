import { useCallback, useState } from 'react'
import { useLocation } from '@tanstack/react-router'
import { ArrowLeftIcon, LanguagesIcon, UserRoundIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../components/ui/dialog'
import { LanguageModeSettings } from '../../features/language'
import {
  ActiveOrganizationSettingsContext,
  AuditLogSettings,
  MembersSettings,
  OrganizationSettingsNavigation,
  useActiveOrganization,
  type OrganizationSettingsSection
} from '../../features/organization'
import { ProfileSettings, type ProfileSettingsContribution } from '../../features/profile'
import { useAuthenticationState } from '../authentication-state'
import { useSettingsCoordinator, type SettingsContribution } from './settings-coordinator'
import { readSettingsEntry, type SettingsSourceDescriptor } from './settings-navigation'

function canEnterBusinessSource(source: SettingsSourceDescriptor): boolean {
  return source.pathname === '/'
}

export function SettingsPage(): React.JSX.Element | null {
  const { t } = useTranslation('app')
  const authentication = useAuthenticationState()
  const organization = useActiveOrganization()
  const location = useLocation()
  const entry = readSettingsEntry(location.state)
  const [profileContribution, setProfileContribution] = useState<SettingsContribution>({
    status: 'clean'
  })
  const reportProfileContribution = useCallback(
    (next: ProfileSettingsContribution): void => setProfileContribution(next),
    []
  )
  const contribution: SettingsContribution =
    entry.section === 'profile' ? profileContribution : { status: 'clean' }
  const coordinator = useSettingsCoordinator({
    entry,
    contribution,
    organizationId: organization.activeOrganization?.organizationId,
    canEnterSource: canEnterBusinessSource,
    openOrganizationPicker: organization.openOrganizationPicker
  })
  if (authentication.status !== 'authenticated') {
    // The root route is already navigating to the authentication view; render nothing on the
    // transient frame so the Settings Page never shows for a signed-out user.
    return null
  }

  const organizationSection: OrganizationSettingsSection | undefined =
    coordinator.section === 'members' || coordinator.section === 'audit-log'
      ? coordinator.section
      : undefined

  return (
    <>
      <div className="flex min-h-svh w-full">
        <aside className="bg-sidebar text-sidebar-foreground flex w-64 shrink-0 flex-col gap-5 border-r p-4">
          <button
            type="button"
            disabled={coordinator.navigationDisabled}
            onClick={coordinator.returnToSource}
            className="text-muted-foreground hover:text-foreground flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors"
          >
            <ArrowLeftIcon className="size-4" />
            {t('settings.back')}
          </button>

          <ActiveOrganizationSettingsContext
            switchDisabled={coordinator.navigationDisabled}
            onOpenOrganizationPicker={coordinator.openOrganizationPicker}
          />

          <nav aria-label={t('settings.title')} className="grid gap-4">
            <div className="grid gap-1">
              <p className="text-muted-foreground px-2.5 text-xs font-medium tracking-wide uppercase">
                {t('settings.account')}
              </p>
              <button
                type="button"
                aria-pressed={coordinator.section === 'profile'}
                disabled={coordinator.navigationDisabled}
                onClick={() => coordinator.switchSection('profile')}
                className="text-sidebar-foreground hover:bg-sidebar-accent aria-pressed:bg-sidebar-accent flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium"
              >
                <UserRoundIcon className="size-4" />
                {t('settings.profile')}
              </button>
              <button
                type="button"
                aria-pressed={coordinator.section === 'language'}
                disabled={coordinator.navigationDisabled}
                onClick={() => coordinator.switchSection('language')}
                className="text-sidebar-foreground hover:bg-sidebar-accent aria-pressed:bg-sidebar-accent flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium"
              >
                <LanguagesIcon className="size-4" />
                {t('settings.language')}
              </button>
            </div>

            <OrganizationSettingsNavigation
              activeSection={organizationSection}
              disabled={coordinator.navigationDisabled}
              onSelectSection={coordinator.switchSection}
            />
          </nav>
        </aside>
        <main className="max-h-svh flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-8 py-10">
            <h1 className="text-2xl font-semibold tracking-tight">{t('settings.title')}</h1>
            {coordinator.section === 'profile' ? (
              <div className="bg-card rounded-lg border">
                <ProfileSettings
                  getSession={authentication.getSession}
                  onContributionChange={reportProfileContribution}
                />
              </div>
            ) : null}
            {coordinator.section === 'language' ? (
              <section aria-labelledby="settings-language-heading" className="grid gap-3">
                <h2 id="settings-language-heading" className="text-base font-semibold">
                  {t('settings.language')}
                </h2>
                <div className="bg-card rounded-lg border">
                  <LanguageModeSettings />
                </div>
              </section>
            ) : null}
            {coordinator.section === 'members' ? (
              <MembersSettings getSession={authentication.getSession} />
            ) : null}
            {coordinator.section === 'audit-log' ? (
              <AuditLogSettings getSession={authentication.getSession} />
            ) : null}
          </div>
        </main>
      </div>

      <Dialog open={coordinator.discardPromptOpen}>
        <DialogContent
          showCloseButton={false}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>{t('settings.discard.title')}</DialogTitle>
            <DialogDescription>{t('settings.discard.description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={coordinator.continueEditing}>
              {t('settings.discard.continueEditing')}
            </Button>
            <Button type="button" variant="destructive" onClick={coordinator.discardChanges}>
              {t('settings.discard.discardChanges')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
