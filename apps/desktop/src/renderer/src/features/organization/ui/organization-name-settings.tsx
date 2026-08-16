import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '../../../components/ui/field'
import { Input } from '../../../components/ui/input'
import {
  OrganizationSettingsAuthorityError,
  useActiveOrganization
} from '../model/active-organization-state'

export type OrganizationDetailsContribution =
  | { readonly status: 'clean' }
  | { readonly status: 'dirty'; readonly discard: () => void }
  | { readonly status: 'saving' }

export function OrganizationDetailsSettings({
  onContributionChange
}: {
  readonly onContributionChange?: (contribution: OrganizationDetailsContribution) => void
}): React.JSX.Element | null {
  const { t } = useTranslation('organization')
  const {
    activeOrganization,
    membershipVerification,
    updateActiveOrganizationName,
    verifyActiveMembership
  } = useActiveOrganization()
  const organizationId = activeOrganization?.organizationId
  const [hasAuthoritativeDetails, setHasAuthoritativeDetails] = useState(false)
  const [editorEstablished, setEditorEstablished] = useState(false)
  const [verificationPending, setVerificationPending] = useState(true)
  const [draftName, setDraftName] = useState<string>()
  const [validationMessage, setValidationMessage] = useState<string>()
  const [saveFailed, setSaveFailed] = useState(false)
  const [didSave, setDidSave] = useState(false)
  const [permissionChanged, setPermissionChanged] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const verificationGenerationRef = useRef(0)
  const editorEstablishedRef = useRef(false)

  const verifiedMembership =
    membershipVerification?.status === 'verified' &&
    membershipVerification.membership.organizationId === organizationId
      ? membershipVerification.membership
      : undefined
  const verificationUnknown =
    membershipVerification?.status === 'unknown' &&
    membershipVerification.organizationId === organizationId
  const authorityFresh = hasAuthoritativeDetails && verifiedMembership !== undefined
  const canEdit = authorityFresh && verifiedMembership.role === 'owner'
  const name = draftName ?? activeOrganization?.organizationName ?? ''
  const isDirty =
    hasAuthoritativeDetails &&
    draftName !== undefined &&
    draftName !== activeOrganization?.organizationName

  if (
    hasAuthoritativeDetails &&
    editorEstablished &&
    verifiedMembership &&
    verifiedMembership.role !== 'owner'
  ) {
    setEditorEstablished(false)
    setDraftName(undefined)
    setValidationMessage(undefined)
    setSaveFailed(false)
    setDidSave(false)
    setPermissionChanged(true)
  }

  const discard = useCallback((): void => {
    setDraftName(undefined)
    setValidationMessage(undefined)
    setSaveFailed(false)
    setDidSave(false)
    onContributionChange?.({ status: 'clean' })
  }, [onContributionChange])

  const verifyDetails = useCallback(async () => {
    if (!organizationId) return

    const generation = ++verificationGenerationRef.current
    const verification = await verifyActiveMembership()
    if (generation !== verificationGenerationRef.current) return verification

    setVerificationPending(false)
    if (
      verification.status === 'verified' &&
      verification.membership.organizationId === organizationId
    ) {
      const nextEditorEstablished = verification.membership.role === 'owner'
      if (editorEstablishedRef.current && !nextEditorEstablished) {
        setDraftName(undefined)
        setValidationMessage(undefined)
        setSaveFailed(false)
        setDidSave(false)
        setPermissionChanged(true)
        onContributionChange?.({ status: 'clean' })
      }
      editorEstablishedRef.current = nextEditorEstablished
      setHasAuthoritativeDetails(true)
      setEditorEstablished(nextEditorEstablished)
    }
    return verification
  }, [onContributionChange, organizationId, verifyActiveMembership])

  const retryDetails = useCallback((): void => {
    setVerificationPending(true)
    void verifyDetails()
  }, [verifyDetails])

  useEffect(() => {
    if (!organizationId) return

    const generation = ++verificationGenerationRef.current
    void (async () => {
      const verification = await verifyActiveMembership()
      if (generation !== verificationGenerationRef.current) return

      setVerificationPending(false)
      if (
        verification.status === 'verified' &&
        verification.membership.organizationId === organizationId
      ) {
        const nextEditorEstablished = verification.membership.role === 'owner'
        editorEstablishedRef.current = nextEditorEstablished
        setHasAuthoritativeDetails(true)
        setEditorEstablished(nextEditorEstablished)
      }
    })()

    return () => {
      verificationGenerationRef.current += 1
    }
  }, [organizationId, verifyActiveMembership])

  const contribution = useMemo<OrganizationDetailsContribution>(
    () =>
      isSaving
        ? { status: 'saving' }
        : isDirty
          ? { status: 'dirty', discard }
          : { status: 'clean' },
    [discard, isDirty, isSaving]
  )

  useEffect(() => {
    onContributionChange?.(contribution)
  }, [contribution, onContributionChange])

  useEffect(
    () => () => {
      onContributionChange?.({ status: 'clean' })
    },
    [onContributionChange]
  )

  if (!activeOrganization) return null

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!canEdit || isSaving) return

    const nextName = name.trim()
    if (nextName.length === 0) {
      setValidationMessage(t('common.validation.orgNameRequired'))
      return
    }

    onContributionChange?.({ status: 'saving' })
    setIsSaving(true)
    setValidationMessage(undefined)
    setSaveFailed(false)
    setDidSave(false)
    try {
      await updateActiveOrganizationName(nextName)
      setDraftName(undefined)
      setDidSave(true)
      onContributionChange?.({ status: 'clean' })
    } catch (error) {
      if (error instanceof OrganizationSettingsAuthorityError) {
        const verification = error.verification
        if (verification.status === 'lost') return
        if (
          verification.status === 'verified' &&
          verification.membership.organizationId === organizationId &&
          verification.membership.role !== 'owner'
        ) {
          editorEstablishedRef.current = false
          setHasAuthoritativeDetails(true)
          setEditorEstablished(false)
          setDraftName(undefined)
          setValidationMessage(undefined)
          setSaveFailed(false)
          setDidSave(false)
          setPermissionChanged(true)
          onContributionChange?.({ status: 'clean' })
          return
        }
      }
      setSaveFailed(true)
      onContributionChange?.({ status: 'dirty', discard })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <section aria-labelledby="organization-details-heading" className="grid gap-5">
      <div className="grid gap-1">
        <h2 id="organization-details-heading" className="text-base font-semibold">
          {t('details.title')}
        </h2>
        <p className="text-muted-foreground text-sm">{t('details.description')}</p>
      </div>

      {!hasAuthoritativeDetails ? (
        verificationPending ? (
          <p className="text-muted-foreground text-sm">{t('details.loading')}</p>
        ) : (
          <div className="grid justify-items-start gap-3">
            <p role="alert" className="text-destructive text-sm">
              {t('details.verificationUnknown')}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={retryDetails}>
              {t('details.retry')}
            </Button>
          </div>
        )
      ) : (
        <>
          {verificationUnknown ? (
            <div className="grid justify-items-start gap-3">
              <p role="alert" className="text-destructive text-sm">
                {t('details.verificationUnknown')}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={verificationPending}
                onClick={retryDetails}
              >
                {t('details.retry')}
              </Button>
            </div>
          ) : null}

          {editorEstablished ? (
            <form
              className="bg-card rounded-lg border p-5"
              onSubmit={(event) => void submit(event)}
            >
              <FieldGroup>
                <Field data-invalid={validationMessage !== undefined || undefined}>
                  <FieldLabel htmlFor="organization-settings-name">
                    {t('common.orgName')}
                  </FieldLabel>
                  <Input
                    id="organization-settings-name"
                    value={name}
                    placeholder={t('common.orgNamePlaceholder')}
                    disabled={!canEdit || verificationPending || isSaving}
                    aria-invalid={validationMessage !== undefined || undefined}
                    onChange={(event) => {
                      setDraftName(event.target.value)
                      setValidationMessage(undefined)
                      setSaveFailed(false)
                      setDidSave(false)
                    }}
                  />
                  <FieldError>{validationMessage}</FieldError>
                </Field>
                <div className="flex items-center gap-3">
                  <Button
                    type="submit"
                    aria-label={t('settingsChrome.updateOrganizationName')}
                    disabled={!isDirty || !canEdit || verificationPending || isSaving}
                  >
                    {t('common.save')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    aria-label={t('settingsChrome.discardOrganizationName')}
                    disabled={!isDirty || isSaving}
                    onClick={discard}
                  >
                    {t('common.cancel')}
                  </Button>
                  {didSave ? (
                    <p role="status" className="text-muted-foreground text-sm">
                      {t('details.saved')}
                    </p>
                  ) : null}
                  {saveFailed ? (
                    <p role="alert" className="text-destructive text-sm">
                      {t('details.saveFailed')}
                    </p>
                  ) : null}
                </div>
              </FieldGroup>
            </form>
          ) : (
            <div className="bg-card grid gap-2 rounded-lg border p-5">
              <p className="text-sm font-medium">{t('common.orgName')}</p>
              <p className="text-sm">{activeOrganization.organizationName}</p>
              <p className="text-muted-foreground text-sm">{t('details.readOnly')}</p>
            </div>
          )}

          {permissionChanged ? (
            <p role="status" className="text-muted-foreground text-sm">
              {t('details.permissionChanged')}
            </p>
          ) : null}
        </>
      )}
    </section>
  )
}
