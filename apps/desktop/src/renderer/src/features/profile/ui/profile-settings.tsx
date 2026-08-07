import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { UserRoundIcon } from 'lucide-react'
import { Avatar, AvatarFallback } from '../../../components/ui/avatar'
import { Button } from '../../../components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '../../../components/ui/field'
import { Input } from '../../../components/ui/input'
import {
  validateDisplayName,
  type DisplayNameValidation
} from '../../../lib/display-name-validation'
import { readProfile, saveProfile, type AuthenticatedProfileSession } from '../api/profile'

type GetSession = () => Promise<AuthenticatedProfileSession | undefined>

export function ProfileSettings({
  getSession
}: {
  readonly getSession: GetSession
}): React.JSX.Element {
  const { t } = useTranslation('profile')
  const [savedDisplayName, setSavedDisplayName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [validation, setValidation] = useState<DisplayNameValidation>()
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [didSave, setDidSave] = useState(false)

  useEffect(() => {
    let isMounted = true

    void (async () => {
      try {
        const session = await getSession()
        if (!session) throw new Error('Profile Session is unavailable.')

        const profile = await readProfile(session)
        if (!isMounted) return
        const nextDisplayName = profile?.displayName ?? ''
        setSavedDisplayName(nextDisplayName)
        setDisplayName(nextDisplayName)
      } catch {
        if (isMounted) {
          setSavedDisplayName('')
          setDisplayName('')
        }
      } finally {
        if (isMounted) setIsLoading(false)
      }
    })()

    return () => {
      isMounted = false
    }
  }, [getSession])

  const isDirty = !isLoading && displayName !== savedDisplayName
  const validationMessage =
    validation === 'required'
      ? t('validation.displayNameRequired')
      : validation === 'too-long'
        ? t('validation.displayNameTooLong')
        : undefined

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (isLoading || isSaving) return

    const nextValidation = validateDisplayName(displayName)
    setValidation(nextValidation)
    if (nextValidation) return

    setIsSaving(true)
    setDidSave(false)
    try {
      const session = await getSession()
      if (!session) throw new Error('Profile Session is unavailable.')

      const profile = await saveProfile(session, displayName.trim())
      setSavedDisplayName(profile.displayName)
      setDisplayName(profile.displayName)
      setDidSave(true)
    } catch {
      // Keep the draft untouched so the User can retry after a transient request failure.
    } finally {
      setIsSaving(false)
    }
  }

  function changeDisplayName(value: string): void {
    setDisplayName(value)
    setValidation(undefined)
    setDidSave(false)
  }

  function cancel(): void {
    setDisplayName(savedDisplayName)
    setValidation(undefined)
    setDidSave(false)
  }

  return (
    <section aria-labelledby="profile-heading" className="grid gap-5 px-5 py-5">
      <div className="flex items-start gap-4">
        <Avatar size="lg" aria-label={t('navLabel')}>
          <AvatarFallback>
            <UserRoundIcon aria-hidden="true" />
          </AvatarFallback>
        </Avatar>
        <div className="grid gap-1">
          <h2 id="profile-heading" className="text-base font-semibold">
            {t('title')}
          </h2>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </div>
      </div>
      <form onSubmit={(event) => void submit(event)}>
        <FieldGroup>
          <Field data-invalid={validationMessage !== undefined || undefined}>
            <FieldLabel htmlFor="profile-display-name">{t('displayName')}</FieldLabel>
            <Input
              id="profile-display-name"
              value={displayName}
              placeholder={t('displayNamePlaceholder')}
              disabled={isLoading || isSaving}
              aria-invalid={validationMessage !== undefined || undefined}
              onChange={(event) => changeDisplayName(event.target.value)}
            />
            <FieldError>{validationMessage}</FieldError>
          </Field>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!isDirty || isSaving}>
              {t('save')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!isDirty || isSaving}
              onClick={cancel}
            >
              {t('cancel')}
            </Button>
            {didSave ? (
              <p role="status" className="text-muted-foreground text-sm">
                {t('saved')}
              </p>
            ) : null}
          </div>
        </FieldGroup>
      </form>
    </section>
  )
}
