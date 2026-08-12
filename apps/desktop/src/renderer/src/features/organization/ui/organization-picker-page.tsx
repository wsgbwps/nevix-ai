import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PlusIcon } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '../../../components/ui/field'
import { Input } from '../../../components/ui/input'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle
} from '../../../components/ui/sheet'
import { InvitationAcceptanceError, type PendingInvitation } from '../api/invitations'
import { useActiveOrganization } from '../model/active-organization-state'
import { useOrganizationOnboarding } from '../model/onboarding-state'
import type { ActiveMembership } from '../api/memberships'

interface OrganizationPickerPageProps {
  readonly userEmail: string | undefined
  readonly isSigningOut: boolean
  readonly onSignOut: () => void
}

/**
 * The finalized variant A Organization picker: a centered Organization list with pending
 * invitations surfaced above it. Invitees enter their emailed code in the focused sheet rather
 * than discovering a separate, manual invitation path.
 */
export function OrganizationPickerPage({
  userEmail,
  isSigningOut,
  onSignOut
}: OrganizationPickerPageProps): React.JSX.Element {
  const { t } = useTranslation('organization')
  const {
    availableOrganizations,
    pendingInvitations,
    rememberedOrganizationId,
    enterOrganization,
    acceptInvitation,
    reconcileStartupAfterInvitationChange
  } = useActiveOrganization()
  const onboarding = useOrganizationOnboarding()
  const [selectedInvitation, setSelectedInvitation] = useState<PendingInvitation>()
  const [code, setCode] = useState('')
  const [acceptanceError, setAcceptanceError] = useState<string>()
  const [isAccepting, setIsAccepting] = useState(false)
  const [shouldResolveStartupOnClose, setShouldResolveStartupOnClose] = useState(false)

  function openInvitation(invitation: PendingInvitation): void {
    setSelectedInvitation(invitation)
    setCode('')
    setAcceptanceError(undefined)
    setShouldResolveStartupOnClose(false)
  }

  function closeInvitation(): void {
    if (isAccepting) return
    const shouldResolveStartup = shouldResolveStartupOnClose
    setSelectedInvitation(undefined)
    setCode('')
    setAcceptanceError(undefined)
    setShouldResolveStartupOnClose(false)

    if (!shouldResolveStartup) return

    reconcileStartupAfterInvitationChange()
  }

  async function submitInvitation(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!selectedInvitation || code.length !== 6) return

    setIsAccepting(true)
    setAcceptanceError(undefined)
    try {
      await acceptInvitation(selectedInvitation, code)
    } catch (error) {
      setAcceptanceError(messageForInvitationError(error))
      if (error instanceof InvitationAcceptanceError && error.code === 'invitation_revoked') {
        setShouldResolveStartupOnClose(true)
      }
    } finally {
      setIsAccepting(false)
    }
  }

  function messageForInvitationError(error: unknown): string {
    if (!(error instanceof InvitationAcceptanceError)) return t('picker.codeUnavailable')

    switch (error.code) {
      case 'invalid_invitation_code':
        return error.attemptsRemaining === undefined
          ? t('picker.codeInvalidRetry')
          : t('picker.codeInvalid', { count: error.attemptsRemaining })
      case 'code_attempts_exhausted':
        return error.attemptsRemaining === undefined
          ? t('picker.codeAttemptsExhausted')
          : t('picker.codeInvalid', { count: error.attemptsRemaining })
      case 'invitation_expired':
        return t('picker.codeExpired')
      case 'invitation_revoked':
        return t('picker.codeRevoked')
      case 'invitation_code_invalidated':
        return t('picker.codeInvalidated')
      default:
        return t('picker.codeUnavailable')
    }
  }

  return (
    <main className="bg-muted/30 flex min-h-svh items-center justify-center px-6 py-10">
      <section className="bg-card w-full max-w-md rounded-xl border p-6 shadow-sm">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('picker.heading')}</h1>
          <p className="text-muted-foreground text-sm">{t('picker.subheading')}</p>
        </div>
        {pendingInvitations.length > 0 ? (
          <section className="mt-6 grid gap-2" aria-labelledby="pending-invitations-heading">
            <h2 id="pending-invitations-heading" className="text-sm font-medium">
              {t('picker.inviteSection')}
            </h2>
            <ul className="grid gap-2">
              {pendingInvitations.map((invitation) => (
                <li
                  key={invitation.id}
                  className="bg-muted/40 flex items-center gap-3 rounded-lg border px-4 py-3 text-sm"
                >
                  <span className="min-w-0 flex-1">
                    {t('picker.inviteLine', {
                      inviter: invitation.inviterDisplayName ?? t('picker.unknownInviter'),
                      org: invitation.organizationName ?? t('picker.unknownOrganization')
                    })}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    className="shrink-0"
                    onClick={() => openInvitation(invitation)}
                  >
                    {t('picker.accept')}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
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
      <Sheet
        open={selectedInvitation !== undefined}
        onOpenChange={(open) => {
          if (!open) closeInvitation()
        }}
      >
        <SheetContent showCloseButton={false}>
          <SheetHeader>
            <SheetTitle>{t('picker.codeLabel')}</SheetTitle>
            <SheetDescription>{t('picker.codeHint')}</SheetDescription>
          </SheetHeader>
          <form className="px-4" onSubmit={(event) => void submitInvitation(event)}>
            <FieldGroup>
              <Field data-invalid={acceptanceError !== undefined || undefined}>
                <FieldLabel htmlFor="invitation-code">{t('picker.codeLabel')}</FieldLabel>
                <Input
                  id="invitation-code"
                  value={code}
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  maxLength={6}
                  pattern="[0-9]{6}"
                  disabled={isAccepting}
                  aria-invalid={acceptanceError !== undefined || undefined}
                  onChange={(event) => {
                    setCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                    setAcceptanceError(undefined)
                  }}
                />
                <FieldError>{acceptanceError}</FieldError>
              </Field>
              <Button type="submit" disabled={isAccepting || code.length !== 6}>
                {t('picker.codeSubmit')}
              </Button>
            </FieldGroup>
          </form>
          <SheetFooter>
            <SheetClose asChild>
              <Button type="button" variant="outline" disabled={isAccepting}>
                {t('picker.cancel')}
              </Button>
            </SheetClose>
          </SheetFooter>
        </SheetContent>
      </Sheet>
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
