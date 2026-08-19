import { useCallback, useEffect, useMemo, useState } from 'react'
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

type SettingsNavigateSemantics = 'navigable' | 'confirm-discard' | 'blocked'
type SettingsCloseSemantics = 'allow' | 'confirm' | 'defer' | 'deny'

// Structurally mirrors the Settings Flow's SettingsLeaveSemantics contract
// (app/settings); Features do not import across that seam.
export type ProfileSettingsContribution = {
  readonly navigate: SettingsNavigateSemantics
  readonly close: SettingsCloseSemantics
  readonly discard?: () => void
}

const CLEAN_CONTRIBUTION: ProfileSettingsContribution = {
  navigate: 'navigable',
  close: 'allow'
}

const SAVING_CONTRIBUTION: ProfileSettingsContribution = {
  navigate: 'blocked',
  close: 'defer'
}
export function ProfileSettings({
  getSession,
  onContributionChange
}: {
  readonly getSession: GetSession
  readonly onContributionChange?: (contribution: ProfileSettingsContribution) => void
}): React.JSX.Element {
  const { t } = useTranslation('profile')
  const [savedDisplayName, setSavedDisplayName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [validation, setValidation] = useState<DisplayNameValidation>()
  const [isLoading, setIsLoading] = useState(true)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [loadFailed, setLoadFailed] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
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
        setSaveFailed(false)
      } catch {
        if (isMounted) {
          setSavedDisplayName('')
          setDisplayName('')
          setLoadFailed(true)
        }
      } finally {
        if (isMounted) setIsLoading(false)
      }
    })()

    return () => {
      isMounted = false
    }
  }, [getSession, loadAttempt])

  const isDirty = !isLoading && displayName !== savedDisplayName
  const validationMessage =
    validation === 'required'
      ? t('validation.displayNameRequired')
      : validation === 'too-long'
        ? t('validation.displayNameTooLong')
        : undefined

  const cancel = useCallback((): void => {
    setDisplayName(savedDisplayName)
    setValidation(undefined)
    setSaveFailed(false)
    setDidSave(false)
    onContributionChange?.(CLEAN_CONTRIBUTION)
  }, [onContributionChange, savedDisplayName])

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (isLoading || isSaving) return

    const nextValidation = validateDisplayName(displayName)
    setValidation(nextValidation)
    if (nextValidation) return

    onContributionChange?.(SAVING_CONTRIBUTION)
    setIsSaving(true)
    setSaveFailed(false)
    setDidSave(false)
    try {
      const session = await getSession()
      if (!session) throw new Error('Profile Session is unavailable.')

      const profile = await saveProfile(session, displayName.trim())
      setSavedDisplayName(profile.displayName)
      setDisplayName(profile.displayName)
      setDidSave(true)
      onContributionChange?.(CLEAN_CONTRIBUTION)
    } catch {
      // Keep the draft untouched so the User can retry after a transient request failure.
      setSaveFailed(true)
      onContributionChange?.({ navigate: 'confirm-discard', close: 'confirm', discard: cancel })
    } finally {
      setIsSaving(false)
    }
  }

  function changeDisplayName(value: string): void {
    setDisplayName(value)
    setValidation(undefined)
    setSaveFailed(false)
    setDidSave(false)
  }

  function retryLoad(): void {
    setIsLoading(true)
    setLoadFailed(false)
    setLoadAttempt((value) => value + 1)
  }

  const contribution = useMemo<ProfileSettingsContribution>(
    () =>
      isSaving
        ? SAVING_CONTRIBUTION
        : isDirty
          ? { navigate: 'confirm-discard', close: 'confirm', discard: cancel }
          : CLEAN_CONTRIBUTION,
    [cancel, isDirty, isSaving]
  )

  useEffect(() => {
    onContributionChange?.(contribution)
  }, [contribution, onContributionChange])

  useEffect(
    () => () => {
      onContributionChange?.(CLEAN_CONTRIBUTION)
    },
    [onContributionChange]
  )

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
      {loadFailed ? (
        <div role="alert" className="bg-destructive/10 grid gap-3 rounded-md p-3 text-sm">
          <p>{t('loadFailed')}</p>
          <Button type="button" variant="outline" onClick={retryLoad}>
            {t('retry')}
          </Button>
        </div>
      ) : null}
      <form onSubmit={(event) => void submit(event)}>
        <FieldGroup>
          <Field data-invalid={validationMessage !== undefined || undefined}>
            <FieldLabel htmlFor="profile-display-name">{t('displayName')}</FieldLabel>
            <Input
              id="profile-display-name"
              value={displayName}
              placeholder={t('displayNamePlaceholder')}
              disabled={isLoading || isSaving || loadFailed}
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
            {saveFailed ? (
              <p role="alert" className="text-destructive text-sm">
                {t('saveFailed')}
              </p>
            ) : null}
          </div>
        </FieldGroup>
      </form>
    </section>
  )
}
