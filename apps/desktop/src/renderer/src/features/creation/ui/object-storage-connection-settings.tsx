import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import { Field, FieldGroup, FieldLabel } from '../../../components/ui/field'
import { Input } from '../../../components/ui/input'
import type { CreationApiFailure } from '../api/go-creation-http'
import {
  createObjectStorageConnectionClient,
  type ObjectStorageConnectionView,
  type ObjectStorageProvider
} from '../api/object-storage-connection-http'

type GetSession = () => Promise<{ readonly token: string } | undefined>
type SettingsNavigateSemantics = 'navigable' | 'confirm-discard' | 'blocked'
type SettingsCloseSemantics = 'allow' | 'confirm' | 'defer' | 'deny'

export type ObjectStorageConnectionSettingsContribution = {
  readonly navigate: SettingsNavigateSemantics
  readonly close: SettingsCloseSemantics
  readonly discard?: () => void
}

export type ObjectStorageConnectionProofAction = 'create'

export interface ObjectStorageConnectionSettingsProps {
  readonly isAdmin: boolean
  readonly getSession: GetSession
  readonly serverUrl: string
  readonly acquireProof: (
    action: ObjectStorageConnectionProofAction
  ) => Promise<{ readonly proof: string } | undefined>
  readonly onContributionChange?: (
    contribution: ObjectStorageConnectionSettingsContribution
  ) => void
}

interface ConnectionDraft {
  readonly provider: ObjectStorageProvider
  readonly region: string
  readonly bucket: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
}

const EMPTY_DRAFT: ConnectionDraft = {
  provider: 'oss',
  region: '',
  bucket: '',
  accessKeyId: '',
  secretAccessKey: ''
}

const CLEAN_CONTRIBUTION: ObjectStorageConnectionSettingsContribution = {
  navigate: 'navigable',
  close: 'allow'
}

const SAVING_CONTRIBUTION: ObjectStorageConnectionSettingsContribution = {
  navigate: 'blocked',
  close: 'deny'
}

const ERROR_CODE_KEYS = {
  invalid_request: 'objectStorage.errors.invalidRequest',
  secure_transport_required: 'objectStorage.errors.secureTransportRequired',
  reauth_proof_invalid: 'objectStorage.errors.reauthInvalid',
  reauth_proof_expired: 'objectStorage.errors.reauthExpired',
  reauth_proof_action_mismatch: 'objectStorage.errors.reauthMismatch',
  reauth_proof_already_consumed: 'objectStorage.errors.reauthConsumed',
  object_storage_connection_exists: 'objectStorage.errors.exists',
  object_storage_unavailable: 'objectStorage.errors.unavailable',
  internal_error: 'objectStorage.errors.internal'
} as const

function failureMessage(failure: CreationApiFailure, t: TFunction<'creation'>): string {
  if (failure.outcome === 'network-failure') return t('objectStorage.errors.network')
  if (failure.outcome === 'unauthorized') return t('objectStorage.errors.unauthorized')
  if (failure.outcome === 'forbidden') return t('objectStorage.errors.forbidden')
  const key = Object.hasOwn(ERROR_CODE_KEYS, failure.code)
    ? ERROR_CODE_KEYS[failure.code as keyof typeof ERROR_CODE_KEYS]
    : 'objectStorage.errors.internal'
  return t(key)
}

export function ObjectStorageConnectionSettings({
  isAdmin,
  getSession,
  serverUrl,
  acquireProof,
  onContributionChange
}: ObjectStorageConnectionSettingsProps): React.JSX.Element {
  const { t } = useTranslation('creation')
  const client = useMemo(() => createObjectStorageConnectionClient(serverUrl), [serverUrl])
  const [connection, setConnection] = useState<ObjectStorageConnectionView>()
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'failed'>('loading')
  const [draft, setDraft] = useState<ConnectionDraft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  const clearDraft = useCallback((): void => {
    setDraft(EMPTY_DRAFT)
    setError(undefined)
  }, [])
  const draftDirty =
    draft.provider !== EMPTY_DRAFT.provider ||
    draft.region !== '' ||
    draft.bucket !== '' ||
    draft.accessKeyId !== '' ||
    draft.secretAccessKey !== ''

  useEffect(() => {
    onContributionChange?.(
      saving
        ? SAVING_CONTRIBUTION
        : draftDirty
          ? { navigate: 'confirm-discard', close: 'confirm', discard: clearDraft }
          : CLEAN_CONTRIBUTION
    )
  }, [clearDraft, draftDirty, onContributionChange, saving])

  useEffect(() => {
    if (!isAdmin) return
    let mounted = true
    void (async () => {
      const session = await getSession()
      if (!mounted) return
      if (!session) {
        setLoadState('failed')
        return
      }
      const result = await client.getAdminConnection(session.token)
      if (!mounted) return
      if (result.outcome !== 'succeeded') {
        setLoadState('failed')
        return
      }
      setConnection(result.value)
      setLoadState('loaded')
    })()
    return () => {
      mounted = false
    }
  }, [client, getSession, isAdmin])

  const updateDraft = useCallback(
    <Key extends keyof ConnectionDraft>(key: Key, value: ConnectionDraft[Key]): void => {
      setDraft((current) => ({ ...current, [key]: value }))
    },
    []
  )

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault()
      if (saving) return
      setSaving(true)
      setError(undefined)
      try {
        const session = await getSession()
        if (!session) {
          setError(t('objectStorage.errors.unauthorized'))
          return
        }
        const proof = await acquireProof('create')
        if (!proof) return
        const result = await client.create(session.token, {
          proof: proof.proof,
          provider: draft.provider,
          region: draft.region.trim(),
          bucket: draft.bucket.trim(),
          accessKeyId: draft.accessKeyId,
          secretAccessKey: draft.secretAccessKey
        })
        if (result.outcome !== 'succeeded') {
          setError(failureMessage(result, t))
          return
        }
        setDraft(EMPTY_DRAFT)
        setConnection(result.value)
      } finally {
        setSaving(false)
      }
    },
    [acquireProof, client, draft, getSession, saving, t]
  )

  return (
    <section aria-labelledby="object-storage-heading" className="grid gap-4 p-4">
      <header className="flex items-center justify-between gap-3">
        <h3 id="object-storage-heading" className="text-base font-semibold">
          {t('objectStorage.title')}
        </h3>
        {isAdmin && connection?.state === 'ready' ? (
          <Badge>{t('objectStorage.state.ready')}</Badge>
        ) : isAdmin && connection?.state === 'credential_unavailable' ? (
          <Badge variant="secondary">{t('objectStorage.state.credentialUnavailable')}</Badge>
        ) : null}
      </header>
      {isAdmin ? (
        <p className="text-muted-foreground text-sm">{t('objectStorage.description')}</p>
      ) : null}

      {!isAdmin ? (
        <p className="text-sm">{t('objectStorage.memberUnavailable')}</p>
      ) : loadState === 'loading' ? (
        <p role="status">{t('objectStorage.state.loading')}</p>
      ) : loadState === 'failed' ? (
        <p role="alert" className="text-destructive text-sm">
          {t('objectStorage.state.loadFailed')}
        </p>
      ) : connection?.state === 'unconfigured' ? (
        <ConnectionForm
          draft={draft}
          saving={saving}
          error={error}
          onChange={updateDraft}
          onSubmit={submit}
        />
      ) : connection ? (
        <MaskedConnection connection={connection} />
      ) : null}
    </section>
  )
}

function ConnectionForm({
  draft,
  saving,
  error,
  onChange,
  onSubmit
}: {
  readonly draft: ConnectionDraft
  readonly saving: boolean
  readonly error: string | undefined
  readonly onChange: <Key extends keyof ConnectionDraft>(
    key: Key,
    value: ConnectionDraft[Key]
  ) => void
  readonly onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const canSubmit =
    !saving &&
    draft.region.trim() !== '' &&
    draft.bucket.trim() !== '' &&
    draft.accessKeyId !== '' &&
    draft.secretAccessKey !== ''

  return (
    <div className="grid gap-3">
      <p className="text-sm">{t('objectStorage.empty')}</p>
      <form onSubmit={onSubmit} noValidate>
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="object-storage-provider">
              {t('objectStorage.form.provider')}
            </FieldLabel>
            <select
              id="object-storage-provider"
              className="border-input dark:bg-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
              value={draft.provider}
              disabled={saving}
              onChange={(event) =>
                onChange('provider', event.target.value as ObjectStorageProvider)
              }
            >
              <option value="oss">{t('objectStorage.providers.oss')}</option>
              <option value="cos">{t('objectStorage.providers.cos')}</option>
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="object-storage-region">
              {t('objectStorage.form.region')}
            </FieldLabel>
            <Input
              id="object-storage-region"
              value={draft.region}
              disabled={saving}
              onChange={(event) => onChange('region', event.target.value)}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="object-storage-bucket">
              {t('objectStorage.form.bucket')}
            </FieldLabel>
            <Input
              id="object-storage-bucket"
              value={draft.bucket}
              disabled={saving}
              onChange={(event) => onChange('bucket', event.target.value)}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="object-storage-access-key-id">
              {t('objectStorage.form.accessKeyId')}
            </FieldLabel>
            <Input
              id="object-storage-access-key-id"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft.accessKeyId}
              disabled={saving}
              onChange={(event) => onChange('accessKeyId', event.target.value)}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="object-storage-secret-access-key">
              {t('objectStorage.form.secretAccessKey')}
            </FieldLabel>
            <Input
              id="object-storage-secret-access-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft.secretAccessKey}
              disabled={saving}
              onChange={(event) => onChange('secretAccessKey', event.target.value)}
              required
            />
          </Field>
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
          <Button type="submit" className="w-fit" disabled={!canSubmit}>
            {saving ? t('objectStorage.form.saving') : t('objectStorage.form.submit')}
          </Button>
        </FieldGroup>
      </form>
    </div>
  )
}

function MaskedConnection({
  connection
}: {
  readonly connection: Exclude<ObjectStorageConnectionView, { state: 'unconfigured' }>
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  return (
    <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
      <StatusField
        label={t('objectStorage.form.provider')}
        value={t(`objectStorage.providers.${connection.provider}`)}
      />
      <StatusField label={t('objectStorage.form.region')} value={connection.region} />
      <StatusField label={t('objectStorage.form.bucket')} value={connection.bucket} />
      <StatusField
        label={t('objectStorage.fields.revision')}
        value={t('objectStorage.revision', { revision: connection.revision })}
      />
      <StatusField
        label={t('objectStorage.form.accessKeyId')}
        value={connection.credential.accessKeyIdMasked}
      />
      <StatusField
        label={t('objectStorage.form.secretAccessKey')}
        value={
          connection.credential.secretAccessKeyConfigured
            ? t('objectStorage.fields.configured')
            : t('objectStorage.fields.notConfigured')
        }
      />
      {connection.observation ? (
        <StatusField
          label={t('objectStorage.fields.lastCheck')}
          value={`${t('objectStorage.observation.completed')} · ${connection.observation.checkedAt}`}
        />
      ) : null}
    </dl>
  )
}

function StatusField({
  label,
  value
}: {
  readonly label: string
  readonly value: string
}): React.JSX.Element {
  return (
    <div className="grid gap-1">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  )
}
