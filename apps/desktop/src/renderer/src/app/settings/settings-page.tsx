import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation } from '@tanstack/react-router'
import {
  ArrowLeftIcon,
  LanguagesIcon,
  ScrollTextIcon,
  ServerIcon,
  UserRoundIcon,
  UsersIcon
} from 'lucide-react'
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
import { ProfileSettings } from '../../features/profile'
import { ServerConnectionSettings } from '../../features/connection'
import {
  AuditLogSettings,
  JoinCodesSettings,
  UserManagementSettings
} from '../../features/user-management'
import { useCurrentSession } from '../../features/authentication'
import { useServerConnectionState } from '../connection-state'
import { useSettingsCoordinator, type SettingsContribution } from './settings-coordinator'
import {
  readSettingsEntry,
  resolveSettingsSection,
  type SettingsSection
} from './settings-navigation'
import { CLEAN_LEAVE_SEMANTICS, reduceLeaveSemantics } from './settings-leave-semantics'

// The Record makes missing default semantics for a Settings Section a compile error.
const SETTINGS_SECTION_REGISTRY: Record<SettingsSection, SettingsContribution> = {
  profile: CLEAN_LEAVE_SEMANTICS,
  language: CLEAN_LEAVE_SEMANTICS,
  connection: CLEAN_LEAVE_SEMANTICS,
  users: CLEAN_LEAVE_SEMANTICS,
  audit: CLEAN_LEAVE_SEMANTICS
}

/** One governance card inside the Users section; each reports its own leave semantics. */
type UsersSectionSlot = 'userManagement' | 'joinCodes'

export function SettingsPage(): React.JSX.Element | null {
  const { t } = useTranslation('app')
  const session = useCurrentSession()
  const connection = useServerConnectionState()
  const location = useLocation()
  const entry = readSettingsEntry(location.state)
  // The governance sections exist only for an Admin session; a stale history entry
  // for them falls back to Profile instead of mounting an admin surface. The
  // session role is the last server-validated snapshot for visibility only —
  // the Go server stays the authorization truth.
  const isAdmin = session.status === 'available' && session.user.role === 'admin'
  const section = resolveSettingsSection(entry, isAdmin)
  const [contributions, setContributions] = useState<
    Partial<Record<SettingsSection, SettingsContribution>>
  >({})
  const contributionReporters = useMemo(() => {
    const reporters: Record<SettingsSection, (next: SettingsContribution) => void> = {} as Record<
      SettingsSection,
      (next: SettingsContribution) => void
    >
    for (const section of Object.keys(SETTINGS_SECTION_REGISTRY) as SettingsSection[]) {
      reporters[section] = (next) =>
        setContributions((previous) => ({ ...previous, [section]: next }))
    }
    return reporters
  }, [])
  const contribution = contributions[section] ?? SETTINGS_SECTION_REGISTRY[section]
  // The Users section mounts two governance cards; the section's reported
  // semantics are the reduction of the two slots' independent reports, so a
  // command in flight on either card blocks leaving (and an ordinary close)
  // no matter which card reported last.
  const [usersSlotContributions, setUsersSlotContributions] = useState<
    Partial<Record<UsersSectionSlot, SettingsContribution>>
  >({})
  const usersSlotReporters = useMemo(
    () => ({
      userManagement: (next: SettingsContribution): void =>
        setUsersSlotContributions((previous) => ({ ...previous, userManagement: next })),
      joinCodes: (next: SettingsContribution): void =>
        setUsersSlotContributions((previous) => ({ ...previous, joinCodes: next }))
    }),
    []
  )
  useEffect(() => {
    contributionReporters.users(
      reduceLeaveSemantics(
        usersSlotContributions.userManagement ?? CLEAN_LEAVE_SEMANTICS,
        usersSlotContributions.joinCodes ?? CLEAN_LEAVE_SEMANTICS
      )
    )
  }, [contributionReporters, usersSlotContributions])
  const coordinator = useSettingsCoordinator({ entry: { ...entry, section }, contribution })
  const handleServerConnectionSaved = useCallback(async (): Promise<void> => {
    // A new URL becomes the renderer's runtime connect-src only after a
    // document reload; the previous server's session cannot carry over, so it
    // is cleared locally and the boot restarts at the login boundary.
    await window.api.invoke('authentication:clear-session').catch(() => undefined)
    window.location.reload()
  }, [])
  if (session.status !== 'available') {
    // The root route is already navigating to the authentication view; render nothing on the
    // transient frame so the Settings Page never shows for a signed-out user.
    return null
  }
  const sectionRenderers: Record<SettingsSection, () => React.JSX.Element | null> = {
    profile: () => (
      <div className="bg-card rounded-lg border">
        <ProfileSettings
          getSession={session.acquireSession}
          serverUrl={connection.url ?? ''}
          onContributionChange={contributionReporters.profile}
        />
      </div>
    ),
    language: () => (
      <section aria-labelledby="settings-language-heading" className="grid gap-3">
        <h2 id="settings-language-heading" className="text-base font-semibold">
          {t('settings.language')}
        </h2>
        <div className="bg-card rounded-lg border">
          <LanguageModeSettings />
        </div>
      </section>
    ),
    connection: () => (
      <section aria-labelledby="settings-connection-heading" className="grid gap-3">
        <h2 id="settings-connection-heading" className="text-base font-semibold">
          {t('settings.connection')}
        </h2>
        <div className="bg-card rounded-lg border p-4">
          <ServerConnectionSettings
            serverUrl={connection.url}
            onSaved={handleServerConnectionSaved}
            onContributionChange={contributionReporters.connection}
          />
        </div>
      </section>
    ),
    users: () => (
      <>
        <div className="bg-card rounded-lg border">
          <UserManagementSettings
            getSession={session.acquireSession}
            serverUrl={connection.url ?? ''}
            currentUserId={session.user.id}
            onContributionChange={usersSlotReporters.userManagement}
          />
        </div>
        <div className="bg-card rounded-lg border">
          <JoinCodesSettings
            getSession={session.acquireSession}
            serverUrl={connection.url ?? ''}
            onContributionChange={usersSlotReporters.joinCodes}
          />
        </div>
      </>
    ),
    audit: () => (
      <div className="bg-card rounded-lg border">
        <AuditLogSettings
          getSession={session.acquireSession}
          serverUrl={connection.url ?? ''}
          onContributionChange={contributionReporters.audit}
        />
      </div>
    )
  }

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
            <div className="grid gap-1">
              <p className="text-muted-foreground px-2.5 text-xs font-medium tracking-wide uppercase">
                {t('settings.server')}
              </p>
              <button
                type="button"
                aria-pressed={coordinator.section === 'connection'}
                disabled={coordinator.navigationDisabled}
                onClick={() => coordinator.switchSection('connection')}
                className="text-sidebar-foreground hover:bg-sidebar-accent aria-pressed:bg-sidebar-accent flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium"
              >
                <ServerIcon className="size-4" />
                {t('settings.connection')}
              </button>
            </div>
            {isAdmin ? (
              <div className="grid gap-1">
                <p className="text-muted-foreground px-2.5 text-xs font-medium tracking-wide uppercase">
                  {t('settings.administration')}
                </p>
                <button
                  type="button"
                  aria-pressed={coordinator.section === 'users'}
                  disabled={coordinator.navigationDisabled}
                  onClick={() => coordinator.switchSection('users')}
                  className="text-sidebar-foreground hover:bg-sidebar-accent aria-pressed:bg-sidebar-accent flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium"
                >
                  <UsersIcon className="size-4" />
                  {t('settings.users')}
                </button>
                <button
                  type="button"
                  aria-pressed={coordinator.section === 'audit'}
                  disabled={coordinator.navigationDisabled}
                  onClick={() => coordinator.switchSection('audit')}
                  className="text-sidebar-foreground hover:bg-sidebar-accent aria-pressed:bg-sidebar-accent flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium"
                >
                  <ScrollTextIcon className="size-4" />
                  {t('settings.audit')}
                </button>
              </div>
            ) : null}
          </nav>
        </aside>
        <main className="max-h-svh flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-8 py-10">
            {sectionRenderers[section]()}
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
