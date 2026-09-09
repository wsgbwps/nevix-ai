import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TFunction } from 'i18next'
import { KeyRoundIcon, RefreshCwIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../../components/ui/dialog'
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

export type ObjectStorageConnectionProofAction =
  | 'create'
  | 'replace'
  | 'rotate'
  | 'delete'
  | 'recover'

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

type MaintenanceMode = 'replace' | 'rotate' | 'recover'

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

const COMMAND_UNRESOLVED_CONTRIBUTION: ObjectStorageConnectionSettingsContribution = {
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
  object_storage_connection_not_configured: 'objectStorage.errors.notConfigured',
  object_storage_connection_revision_conflict: 'objectStorage.errors.revisionConflict',
  object_storage_location_frozen: 'objectStorage.errors.locationFrozen',
  object_storage_connection_in_use: 'objectStorage.errors.inUse',
  object_storage_recovery_required: 'objectStorage.errors.recoveryRequired',
  object_storage_recovery_not_required: 'objectStorage.errors.recoveryNotRequired',
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
  const [maintenance, setMaintenance] = useState<MaintenanceMode>()
  const [heldProof, setHeldProof] = useState<string>()
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [proofPending, setProofPending] = useState(false)
  const [commandInFlight, setCommandInFlight] = useState(false)
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
  const unresolved =
    commandInFlight || proofPending || maintenance !== undefined || deleteDialogOpen

  useEffect(() => {
    onContributionChange?.(
      unresolved
        ? COMMAND_UNRESOLVED_CONTRIBUTION
        : draftDirty
          ? { navigate: 'confirm-discard', close: 'confirm', discard: clearDraft }
          : CLEAN_CONTRIBUTION
    )
  }, [clearDraft, draftDirty, onContributionChange, unresolved])

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

  const requestProof = useCallback(
    async (
      action: ObjectStorageConnectionProofAction
    ): Promise<{ readonly proof: string } | undefined> => {
      setProofPending(true)
      try {
        return await acquireProof(action)
      } finally {
        setProofPending(false)
      }
    },
    [acquireProof]
  )

  const createConnection = useCallback(
    async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault()
      if (unresolved) return
      setCommandInFlight(true)
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
        setCommandInFlight(false)
      }
    },
    [acquireProof, client, draft, getSession, t, unresolved]
  )

  const recheck = useCallback(async (): Promise<void> => {
    if (unresolved) return
    const session = await getSession()
    if (!session) {
      setError(t('objectStorage.errors.unauthorized'))
      return
    }
    setCommandInFlight(true)
    setError(undefined)
    const result = await client.recheck(session.token)
    setCommandInFlight(false)
    if (result.outcome !== 'succeeded') {
      setError(failureMessage(result, t))
      return
    }
    setConnection(result.value)
  }, [client, getSession, t, unresolved])

  const openMaintenance = useCallback(
    async (mode: MaintenanceMode): Promise<void> => {
      if (unresolved) return
      setError(undefined)
      const proof = await requestProof(mode)
      if (!proof) return
      setHeldProof(proof.proof)
      setMaintenance(mode)
    },
    [requestProof, unresolved]
  )

  const closeMaintenance = useCallback((): void => {
    if (commandInFlight) return
    setMaintenance(undefined)
    setHeldProof(undefined)
  }, [commandInFlight])

  const submitMaintenance = useCallback(
    async (candidate: ConnectionDraft): Promise<boolean> => {
      if (!maintenance || !heldProof || !connection || connection.state === 'unconfigured') {
        return false
      }
      const session = await getSession()
      if (!session) {
        setError(t('objectStorage.errors.unauthorized'))
        return false
      }
      setCommandInFlight(true)
      setError(undefined)
      const expectedRevision = connection.revision
      const credential = {
        proof: heldProof,
        expectedRevision,
        accessKeyId: candidate.accessKeyId,
        secretAccessKey: candidate.secretAccessKey
      }
      const result =
        maintenance === 'replace'
          ? await client.replace(session.token, {
              ...credential,
              provider: candidate.provider,
              region: candidate.region.trim(),
              bucket: candidate.bucket.trim()
            })
          : maintenance === 'rotate'
            ? await client.rotate(session.token, credential)
            : await client.recover(session.token, credential)
      setCommandInFlight(false)
      if (result.outcome !== 'succeeded') {
        setError(failureMessage(result, t))
        setMaintenance(undefined)
        setHeldProof(undefined)
        return false
      }
      setConnection(result.value)
      closeMaintenance()
      return true
    },
    [client, closeMaintenance, connection, getSession, heldProof, maintenance, t]
  )

  const deleteConnection = useCallback(async (): Promise<void> => {
    if (!connection || connection.state === 'unconfigured') return
    setDeleteDialogOpen(false)
    setError(undefined)
    const proof = await requestProof('delete')
    if (!proof) return
    const session = await getSession()
    if (!session) {
      setError(t('objectStorage.errors.unauthorized'))
      return
    }
    setCommandInFlight(true)
    const result = await client.deleteConnection(session.token, {
      proof: proof.proof,
      expectedRevision: connection.revision
    })
    setCommandInFlight(false)
    if (result.outcome !== 'succeeded') {
      setError(failureMessage(result, t))
      return
    }
    setConnection(result.value)
    setDraft(EMPTY_DRAFT)
  }, [client, connection, getSession, requestProof, t])

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
          saving={commandInFlight}
          error={error}
          onChange={updateDraft}
          onSubmit={createConnection}
        />
      ) : connection ? (
        <AdminConnection
          connection={connection}
          busy={commandInFlight || proofPending}
          error={error}
          maintenance={maintenance}
          deleteDialogOpen={deleteDialogOpen}
          onRecheck={() => void recheck()}
          onOpenMaintenance={(mode) => void openMaintenance(mode)}
          onCloseMaintenance={closeMaintenance}
          onSubmitMaintenance={submitMaintenance}
          onOpenDelete={() => setDeleteDialogOpen(true)}
          onCloseDelete={() => setDeleteDialogOpen(false)}
          onDelete={() => void deleteConnection()}
        />
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
          <LocationFields draft={draft} disabled={saving} onChange={onChange} />
          <CredentialFields draft={draft} disabled={saving} onChange={onChange} />
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

function AdminConnection({
  connection,
  busy,
  error,
  maintenance,
  deleteDialogOpen,
  onRecheck,
  onOpenMaintenance,
  onCloseMaintenance,
  onSubmitMaintenance,
  onOpenDelete,
  onCloseDelete,
  onDelete
}: {
  readonly connection: Exclude<ObjectStorageConnectionView, { state: 'unconfigured' }>
  readonly busy: boolean
  readonly error: string | undefined
  readonly maintenance: MaintenanceMode | undefined
  readonly deleteDialogOpen: boolean
  readonly onRecheck: () => void
  readonly onOpenMaintenance: (mode: MaintenanceMode) => void
  readonly onCloseMaintenance: () => void
  readonly onSubmitMaintenance: (candidate: ConnectionDraft) => Promise<boolean>
  readonly onOpenDelete: () => void
  readonly onCloseDelete: () => void
  readonly onDelete: () => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  return (
    <div className="grid gap-4">
      <MaskedConnection connection={connection} />
      {connection.state === 'credential_unavailable' ? (
        <p role="alert" className="text-destructive text-sm font-medium">
          {t('objectStorage.recovery.required')}
        </p>
      ) : null}
      {connection.locationFrozen ? (
        <p className="text-muted-foreground text-sm">{t('objectStorage.locationFrozen')}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRecheck}>
          <RefreshCwIcon className="size-4" aria-hidden />
          {t('objectStorage.actions.recheck')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || connection.locationFrozen}
          onClick={() => onOpenMaintenance('replace')}
        >
          {t('objectStorage.actions.replace')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => onOpenMaintenance('rotate')}
        >
          <KeyRoundIcon className="size-4" aria-hidden />
          {t('objectStorage.actions.rotate')}
        </Button>
        {connection.state === 'credential_unavailable' ? (
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => onOpenMaintenance('recover')}
          >
            {t('objectStorage.actions.recover')}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={busy || connection.locationFrozen}
          onClick={onOpenDelete}
        >
          {t('objectStorage.actions.delete')}
        </Button>
      </div>
      {maintenance ? (
        <MaintenanceDialog
          mode={maintenance}
          connection={connection}
          commandInFlight={busy}
          onClose={onCloseMaintenance}
          onSubmit={onSubmitMaintenance}
        />
      ) : null}
      <DeleteConfirmDialog
        open={deleteDialogOpen}
        commandInFlight={busy}
        onClose={onCloseDelete}
        onConfirm={onDelete}
      />
    </div>
  )
}

const MAINTENANCE_TITLE_KEYS = {
  replace: 'objectStorage.dialog.replaceTitle',
  rotate: 'objectStorage.dialog.rotateTitle',
  recover: 'objectStorage.dialog.recoverTitle'
} as const

const MAINTENANCE_DESCRIPTION_KEYS = {
  replace: 'objectStorage.dialog.replaceDescription',
  rotate: 'objectStorage.dialog.rotateDescription',
  recover: 'objectStorage.dialog.recoverDescription'
} as const

function MaintenanceDialog({
  mode,
  connection,
  commandInFlight,
  onClose,
  onSubmit
}: {
  readonly mode: MaintenanceMode
  readonly connection: Exclude<ObjectStorageConnectionView, { state: 'unconfigured' }>
  readonly commandInFlight: boolean
  readonly onClose: () => void
  readonly onSubmit: (candidate: ConnectionDraft) => Promise<boolean>
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const [draft, setDraft] = useState<ConnectionDraft>({
    provider: connection.provider,
    region: connection.region,
    bucket: connection.bucket,
    accessKeyId: '',
    secretAccessKey: ''
  })
  const updateDraft = <Key extends keyof ConnectionDraft>(
    key: Key,
    value: ConnectionDraft[Key]
  ): void => setDraft((current) => ({ ...current, [key]: value }))
  const canSubmit =
    !commandInFlight &&
    (mode !== 'replace' || (draft.region.trim() !== '' && draft.bucket.trim() !== '')) &&
    draft.accessKeyId !== '' &&
    draft.secretAccessKey !== ''
  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!canSubmit) return
    if (await onSubmit(draft)) onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !commandInFlight) onClose()
      }}
    >
      <DialogContent
        showCloseButton={!commandInFlight}
        onEscapeKeyDown={(event) => {
          if (commandInFlight) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (commandInFlight) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t(MAINTENANCE_TITLE_KEYS[mode])}</DialogTitle>
          <DialogDescription>{t(MAINTENANCE_DESCRIPTION_KEYS[mode])}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate>
          <FieldGroup>
            {mode === 'replace' ? (
              <LocationFields draft={draft} disabled={commandInFlight} onChange={updateDraft} />
            ) : null}
            <CredentialFields draft={draft} disabled={commandInFlight} onChange={updateDraft} />
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={commandInFlight}>
                  {t('objectStorage.dialog.cancel')}
                </Button>
              </DialogClose>
              <Button type="submit" disabled={!canSubmit}>
                {commandInFlight
                  ? t('objectStorage.dialog.submitting')
                  : t('objectStorage.dialog.submit')}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteConfirmDialog({
  open,
  commandInFlight,
  onClose,
  onConfirm
}: {
  readonly open: boolean
  readonly commandInFlight: boolean
  readonly onClose: () => void
  readonly onConfirm: () => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !commandInFlight) onClose()
      }}
    >
      <DialogContent showCloseButton={!commandInFlight}>
        <DialogHeader>
          <DialogTitle>{t('objectStorage.deleteDialog.title')}</DialogTitle>
          <DialogDescription>{t('objectStorage.deleteDialog.description')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={commandInFlight}>
              {t('objectStorage.dialog.cancel')}
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={commandInFlight}
            onClick={onConfirm}
          >
            {t('objectStorage.deleteDialog.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function LocationFields({
  draft,
  disabled,
  onChange
}: {
  readonly draft: ConnectionDraft
  readonly disabled: boolean
  readonly onChange: <Key extends keyof ConnectionDraft>(
    key: Key,
    value: ConnectionDraft[Key]
  ) => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  return (
    <>
      <Field>
        <FieldLabel htmlFor="object-storage-provider">
          {t('objectStorage.form.provider')}
        </FieldLabel>
        <select
          id="object-storage-provider"
          className="border-input dark:bg-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
          value={draft.provider}
          disabled={disabled}
          onChange={(event) => onChange('provider', event.target.value as ObjectStorageProvider)}
        >
          <option value="oss">{t('objectStorage.providers.oss')}</option>
          <option value="cos">{t('objectStorage.providers.cos')}</option>
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor="object-storage-region">{t('objectStorage.form.region')}</FieldLabel>
        <Input
          id="object-storage-region"
          value={draft.region}
          disabled={disabled}
          onChange={(event) => onChange('region', event.target.value)}
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="object-storage-bucket">{t('objectStorage.form.bucket')}</FieldLabel>
        <Input
          id="object-storage-bucket"
          value={draft.bucket}
          disabled={disabled}
          onChange={(event) => onChange('bucket', event.target.value)}
          required
        />
      </Field>
    </>
  )
}

function CredentialFields({
  draft,
  disabled,
  onChange
}: {
  readonly draft: ConnectionDraft
  readonly disabled: boolean
  readonly onChange: <Key extends keyof ConnectionDraft>(
    key: Key,
    value: ConnectionDraft[Key]
  ) => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  return (
    <>
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
          disabled={disabled}
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
          disabled={disabled}
          onChange={(event) => onChange('secretAccessKey', event.target.value)}
          required
        />
      </Field>
    </>
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
          value={`${t(`objectStorage.observation.${connection.observation.outcome}`)} · ${connection.observation.checkedAt}`}
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
