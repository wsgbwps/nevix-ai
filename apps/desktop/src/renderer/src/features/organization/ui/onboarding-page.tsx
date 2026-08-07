import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '../../../components/ui/field'
import { Input } from '../../../components/ui/input'
import {
  validateDisplayName,
  type DisplayNameValidation
} from '../../../lib/display-name-validation'
import { createOrganization } from '../api/create-organization'

type OnboardingStep = 1 | 2
type OrganizationNameValidation = 'required' | undefined

interface AuthenticatedSession {
  readonly accessToken: string
  readonly userId: string
}

interface OnboardingPageProps {
  readonly getSession: () => Promise<AuthenticatedSession | undefined>
  readonly saveDisplayName: (session: AuthenticatedSession, displayName: string) => Promise<unknown>
  readonly onComplete: () => void
}

export function OnboardingPage({
  getSession,
  saveDisplayName,
  onComplete
}: OnboardingPageProps): React.JSX.Element {
  const { t } = useTranslation('organization')
  const [step, setStep] = useState<OnboardingStep>(1)
  const [displayName, setDisplayName] = useState('')
  const [organizationName, setOrganizationName] = useState('')
  const [displayNameValidation, setDisplayNameValidation] = useState<DisplayNameValidation>()
  const [organizationNameValidation, setOrganizationNameValidation] =
    useState<OrganizationNameValidation>()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const organizationIdRef = useRef<string | undefined>(undefined)

  const validationMessage =
    step === 1
      ? displayNameValidation === 'required'
        ? t('onboarding.validation.displayNameRequired')
        : displayNameValidation === 'too-long'
          ? t('onboarding.validation.displayNameTooLong')
          : undefined
      : organizationNameValidation === 'required'
        ? t('onboarding.validation.orgNameRequired')
        : undefined

  async function continueToOrganization(): Promise<void> {
    const validation = validateDisplayName(displayName)
    setDisplayNameValidation(validation)
    if (validation) return

    setIsSubmitting(true)
    try {
      const session = await getSession()
      if (!session) throw new Error('Onboarding Session is unavailable.')

      await saveDisplayName(session, displayName.trim())
      setStep(2)
    } catch {
      // Keep the values untouched so the User can retry after a transient request failure.
    } finally {
      setIsSubmitting(false)
    }
  }

  async function createFirstOrganization(): Promise<void> {
    const validation = validateOrganizationName(organizationName)
    setOrganizationNameValidation(validation)
    if (validation) return

    setIsSubmitting(true)
    try {
      const session = await getSession()
      if (!session) throw new Error('Onboarding Session is unavailable.')

      const id = organizationIdRef.current ?? crypto.randomUUID()
      organizationIdRef.current = id
      await createOrganization({
        accessToken: session.accessToken,
        id,
        name: organizationName.trim()
      })
      onComplete()
    } catch {
      // Keep the values and generated client ID untouched so retry remains idempotent.
    } finally {
      setIsSubmitting(false)
    }
  }

  function changeDisplayName(value: string): void {
    setDisplayName(value)
    setDisplayNameValidation(undefined)
  }

  function changeOrganizationName(value: string): void {
    setOrganizationName(value)
    setOrganizationNameValidation(undefined)
  }

  return (
    <main className="bg-muted/30 flex min-h-svh items-center justify-center px-6 py-10">
      <section className="bg-card w-full max-w-md rounded-xl border p-6 shadow-sm">
        <div
          className="mb-8 flex items-center gap-3"
          aria-label={t('onboarding.stepLabel', { current: step, total: 2 })}
        >
          <div className="flex gap-2" aria-hidden="true">
            {[1, 2].map((index) => (
              <span
                key={index}
                className={`size-2 rounded-full ${index <= step ? 'bg-primary' : 'bg-muted-foreground/30'}`}
              />
            ))}
          </div>
          <p className="text-muted-foreground text-sm">
            {t('onboarding.stepLabel', { current: step, total: 2 })}
          </p>
        </div>
        {step === 1 ? (
          <form onSubmit={(event) => void (event.preventDefault(), continueToOrganization())}>
            <FieldGroup>
              <div className="grid gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">
                  {t('onboarding.profileHeading')}
                </h1>
                <p className="text-muted-foreground text-sm">
                  {t('onboarding.profileDescription')}
                </p>
              </div>
              <Field data-invalid={validationMessage !== undefined || undefined}>
                <FieldLabel htmlFor="onboarding-display-name">
                  {t('onboarding.displayName')}
                </FieldLabel>
                <Input
                  id="onboarding-display-name"
                  value={displayName}
                  placeholder={t('onboarding.displayNamePlaceholder')}
                  disabled={isSubmitting}
                  aria-invalid={validationMessage !== undefined || undefined}
                  onChange={(event) => changeDisplayName(event.target.value)}
                />
                <FieldError>{validationMessage}</FieldError>
              </Field>
              <Button type="submit" disabled={isSubmitting}>
                {t('onboarding.next')}
              </Button>
            </FieldGroup>
          </form>
        ) : (
          <form onSubmit={(event) => void (event.preventDefault(), createFirstOrganization())}>
            <FieldGroup>
              <div className="grid gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">
                  {t('onboarding.orgHeading')}
                </h1>
                <p className="text-muted-foreground text-sm">{t('onboarding.orgDescription')}</p>
              </div>
              <Field data-invalid={validationMessage !== undefined || undefined}>
                <FieldLabel htmlFor="onboarding-organization-name">
                  {t('onboarding.orgName')}
                </FieldLabel>
                <Input
                  id="onboarding-organization-name"
                  value={organizationName}
                  placeholder={t('onboarding.orgNamePlaceholder')}
                  disabled={isSubmitting}
                  aria-invalid={validationMessage !== undefined || undefined}
                  onChange={(event) => changeOrganizationName(event.target.value)}
                />
                <FieldError>{validationMessage}</FieldError>
              </Field>
              <div className="flex items-center justify-between gap-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={isSubmitting}
                  onClick={() => setStep(1)}
                >
                  {t('onboarding.back')}
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {t('onboarding.submit')}
                </Button>
              </div>
            </FieldGroup>
          </form>
        )}
      </section>
    </main>
  )
}

function validateOrganizationName(value: string): OrganizationNameValidation {
  return value.trim().length === 0 ? 'required' : undefined
}
