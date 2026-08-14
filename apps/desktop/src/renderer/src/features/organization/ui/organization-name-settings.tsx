import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '../../../components/ui/field'
import { Input } from '../../../components/ui/input'
import type { ActiveMembership } from '../api/memberships'

export function OrganizationNameSettings({
  organization,
  updateName
}: {
  readonly organization: ActiveMembership
  readonly updateName: (name: string) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('organization')
  const [draftName, setDraftName] = useState<string>()
  const [validationMessage, setValidationMessage] = useState<string>()
  const [isSaving, setIsSaving] = useState(false)

  const name = draftName ?? organization.organizationName
  const isDirty = draftName !== undefined && draftName !== organization.organizationName

  if (organization.role !== 'owner') {
    return (
      <div className="bg-card grid gap-2 rounded-lg border p-5">
        <p className="text-sm font-medium">{t('common.orgName')}</p>
        <p className="text-sm">{organization.organizationName}</p>
      </div>
    )
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (isSaving) return

    const nextName = name.trim()
    if (nextName.length === 0) {
      setValidationMessage(t('common.validation.orgNameRequired'))
      return
    }

    setIsSaving(true)
    setValidationMessage(undefined)
    try {
      await updateName(nextName)
      setDraftName(undefined)
    } catch {
      setValidationMessage(t('members.actionFailed'))
    } finally {
      setIsSaving(false)
    }
  }

  function cancel(): void {
    setDraftName(undefined)
    setValidationMessage(undefined)
  }

  return (
    <form className="bg-card rounded-lg border p-5" onSubmit={(event) => void submit(event)}>
      <FieldGroup>
        <Field data-invalid={validationMessage !== undefined || undefined}>
          <FieldLabel htmlFor="organization-settings-name">{t('common.orgName')}</FieldLabel>
          <Input
            id="organization-settings-name"
            value={name}
            placeholder={t('common.orgNamePlaceholder')}
            disabled={isSaving}
            aria-invalid={validationMessage !== undefined || undefined}
            onChange={(event) => {
              setDraftName(event.target.value)
              setValidationMessage(undefined)
            }}
          />
          <FieldError>{validationMessage}</FieldError>
        </Field>
        <div className="flex items-center gap-3">
          <Button
            type="submit"
            aria-label={t('settingsChrome.updateOrganizationName')}
            disabled={!isDirty || isSaving}
          >
            {t('common.save')}
          </Button>
          <Button
            type="button"
            variant="outline"
            aria-label={t('settingsChrome.discardOrganizationName')}
            disabled={!isDirty || isSaving}
            onClick={cancel}
          >
            {t('common.cancel')}
          </Button>
        </div>
      </FieldGroup>
    </form>
  )
}
