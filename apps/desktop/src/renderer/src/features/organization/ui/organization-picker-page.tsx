import { useTranslation } from 'react-i18next'
import { PlusIcon } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { useActiveOrganization } from '../model/active-organization-state'
import { useOrganizationOnboarding } from '../model/onboarding-state'
import type { ActiveMembership } from '../api/memberships'

interface OrganizationPickerPageProps {
  readonly userEmail: string | undefined
  readonly isSigningOut: boolean
  readonly onSignOut: () => void
}

/**
 * The finalized variant A Organization picker: a centered Organization list with a
 * "Create new organization" entry into onboarding. The invitation section above the list lands
 * with a later ticket.
 */
export function OrganizationPickerPage({
  userEmail,
  isSigningOut,
  onSignOut
}: OrganizationPickerPageProps): React.JSX.Element {
  const { t } = useTranslation('organization')
  const { availableOrganizations, rememberedOrganizationId, enterOrganization } =
    useActiveOrganization()
  const onboarding = useOrganizationOnboarding()

  return (
    <main className="bg-muted/30 flex min-h-svh items-center justify-center px-6 py-10">
      <section className="bg-card w-full max-w-md rounded-xl border p-6 shadow-sm">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('picker.heading')}</h1>
          <p className="text-muted-foreground text-sm">{t('picker.subheading')}</p>
        </div>
        <ul className="mt-6 grid gap-2">
          {availableOrganizations.map((membership) => (
            <OrganizationPickerRow
              key={membership.organizationId}
              membership={membership}
              isRemembered={membership.organizationId === rememberedOrganizationId}
              onEnter={enterOrganization}
            />
          ))}
        </ul>
        <Button
          type="button"
          variant="outline"
          className="mt-4 w-full justify-start"
          onClick={onboarding.beginOnboarding}
        >
          <PlusIcon />
          {t('picker.createOrg')}
        </Button>
        <div className="text-muted-foreground mt-6 flex items-center justify-between gap-3 text-sm">
          <span className="truncate">{t('picker.signedInAs', { email: userEmail ?? '' })}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground shrink-0"
            disabled={isSigningOut}
            onClick={onSignOut}
          >
            {t('picker.signOut')}
          </Button>
        </div>
      </section>
    </main>
  )
}

function OrganizationPickerRow({
  membership,
  isRemembered,
  onEnter
}: {
  readonly membership: ActiveMembership
  readonly isRemembered: boolean
  readonly onEnter: (membership: ActiveMembership) => void
}): React.JSX.Element {
  const { t } = useTranslation('organization')

  return (
    <li>
      <button
        type="button"
        className="hover:bg-accent flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm transition-colors"
        onClick={() => onEnter(membership)}
      >
        <span className="bg-primary text-primary-foreground grid size-8 shrink-0 place-items-center rounded-lg font-bold">
          {membership.organizationName.charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{membership.organizationName}</span>
        {isRemembered ? (
          <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-xs">
            {t('picker.lastUsed')}
          </span>
        ) : null}
      </button>
    </li>
  )
}
