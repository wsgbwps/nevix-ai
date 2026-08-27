import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { KeyRoundIcon, RefreshCwIcon } from 'lucide-react'
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
  createProviderConnectionClient,
  type MediaCapabilitiesView,
  type ProviderConnectionView
} from '../api/provider-connection-http'

type GetSession = () => Promise<{ readonly token: string } | undefined>

type SettingsNavigateSemantics = 'navigable' | 'confirm-discard' | 'blocked'
type SettingsCloseSemantics = 'allow' | 'confirm' | 'defer' | 'deny'

// Structurally mirrors the Settings Flow's SettingsLeaveSemantics contract
// (app/settings); Features do not import across that seam.
export type ProviderConnectionSettingsContribution = {
  readonly navigate: SettingsNavigateSemantics
  readonly close: SettingsCloseSemantics
  readonly discard?: () => void
}

const CLEAN_CONTRIBUTION: ProviderConnectionSettingsContribution = {
  navigate: 'navigable',
  close: 'allow'
}

const COMMAND_UNRESOLVED_CONTRIBUTION: ProviderConnectionSettingsContribution = {
  navigate: 'blocked',
  close: 'deny'
}

/** The three exact-action proof commands this surface can need. */
export type ProviderConnectionProofAction = 'create' | 'replace' | 'delete'

export interface ProviderConnectionSettingsProps {
  /** Admin surfaces manage the connection; members see the status-only card. */
  readonly isAdmin: boolean
  readonly getSession: GetSession
  readonly serverUrl: string
  /**
   * Acquires one exact-action Reauthentication Proof through the
   * Authentication-owned confirmation surface (composed in app/settings);
   * resolves undefined when the admin abandons the confirmation.
   */
  readonly acquireProof: (
    action: ProviderConnectionProofAction
  ) => Promise<{ readonly proof: string } | undefined>
  readonly onContributionChange?: (contribution: ProviderConnectionSettingsContribution) => void
}

// Literal-key maps so typed i18n keeps whole-key checking; unknown codes fall back.
const ERROR_CODE_KEYS = {
  invalid_request: 'provider.errors.codes.invalid_request',
  secure_transport_required: 'provider.errors.codes.secure_transport_required',
  reauth_proof_invalid: 'provider.errors.codes.reauth_proof_invalid',
  reauth_proof_expired: 'provider.errors.codes.reauth_proof_expired',
  reauth_proof_action_mismatch: 'provider.errors.codes.reauth_proof_action_mismatch',
  reauth_proof_already_consumed: 'provider.errors.codes.reauth_proof_already_consumed',
  provider_connection_exists: 'provider.errors.codes.provider_connection_exists',
  provider_connection_not_configured: 'provider.errors.codes.provider_connection_not_configured',
  provider_credential_invalid: 'provider.errors.codes.provider_credential_invalid',
  provider_check_temporarily_unavailable:
    'provider.errors.codes.provider_check_temporarily_unavailable',
  internal_error: 'provider.errors.codes.internal_error'
} as const

function failureMessage(failure: CreationApiFailure, t: TFunction<'creation'>): string {
  switch (failure.outcome) {
    case 'network-failure':
      return t('provider.errors.networkFailure')
    case 'unauthorized':
      return t('provider.errors.unauthorized')
    case 'forbidden':
      return t('provider.errors.forbidden')
    case 'request-rejected': {
      const key = Object.hasOwn(ERROR_CODE_KEYS, failure.code)
        ? ERROR_CODE_KEYS[failure.code as keyof typeof ERROR_CODE_KEYS]
        : undefined
      return key !== undefined ? t(key) : t('provider.errors.codeFallback', { code: failure.code })
    }
  }
}

/**
 * The AI Creation Settings card (issue #157): Admins configure, replace,
 * recheck, pause/resume, and delete the instance's single Kapon connection
 * behind exact-action reauthentication; Members see only per-media status
 * and stable advice. The Provider Key exists in component state only for
 * the duration of one submit and never persists.
 */
export function ProviderConnectionSettings({
  isAdmin,
  getSession,
  serverUrl,
  acquireProof,
  onContributionChange
}: ProviderConnectionSettingsProps): React.JSX.Element {
  const { t } = useTranslation('creation')
  const client = useMemo(() => createProviderConnectionClient(serverUrl), [serverUrl])
  const [connection, setConnection] = useState<ProviderConnectionView | null>(null)
  const [memberCapabilities, setMemberCapabilities] = useState<MediaCapabilitiesView | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'failed'>('loading')
  const [commandError, setCommandError] = useState<string | undefined>(undefined)
  const [commandInFlight, setCommandInFlight] = useState(false)
  const [keyDialogOpen, setKeyDialogOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [heldProof, setHeldProof] = useState<{ readonly proof: string } | undefined>()

  useEffect(() => {
    onContributionChange?.(
      commandInFlight || keyDialogOpen || deleteDialogOpen
        ? COMMAND_UNRESOLVED_CONTRIBUTION
        : CLEAN_CONTRIBUTION
    )
  }, [onContributionChange, commandInFlight, keyDialogOpen, deleteDialogOpen])

  // The initial load (and every manual reload) runs as the established
  // mounted-guarded async effect; setState only lands after its awaits.
  const [reloadToken, setReloadToken] = useState(0)
  useEffect(() => {
    let isMounted = true
    void (async () => {
      const session = await getSession()
      if (!isMounted) return
      if (!session) {
        setLoadState('failed')
        return
      }
      if (isAdmin) {
        const lookup = await client.lookup(session.token)
        if (!isMounted) return
        if (lookup.outcome === 'configured') {
          setConnection(lookup.connection)
          setLoadState('loaded')
          return
        }
        if (lookup.outcome === 'not-configured') {
          setConnection(null)
          setLoadState('loaded')
          return
        }
        setLoadState('failed')
        return
      }
      const capabilities = await client.listMediaCapabilities(session.token)
      if (!isMounted) return
      if (capabilities.outcome === 'succeeded') {
        setMemberCapabilities(capabilities.value)
        setLoadState('loaded')
        return
      }
      setLoadState('failed')
    })()
    return () => {
      isMounted = false
    }
  }, [client, getSession, isAdmin, reloadToken])

  const refresh = useCallback(async (): Promise<void> => {
    setReloadToken((token) => token + 1)
  }, [])

  const runCommand = useCallback(
    async (
      run: (token: string) => Promise<CreationApiFailure | { outcome: 'succeeded' }>
    ): Promise<void> => {
      const session = await getSession()
      if (!session) {
        setCommandError(t('provider.errors.unauthorized'))
        return
      }
      setCommandInFlight(true)
      setCommandError(undefined)
      const result = await run(session.token)
      setCommandInFlight(false)
      if (result.outcome !== 'succeeded') {
        setCommandError(failureMessage(result, t))
        return
      }
      await refresh()
    },
    [getSession, refresh, t]
  )

  const submitCredential = useCallback(
    async (providerKey: string): Promise<boolean> => {
      if (heldProof === undefined) return false
      const submit = connection === null ? client.configure : client.replaceCredential
      const session = await getSession()
      if (!session) {
        setCommandError(t('provider.errors.unauthorized'))
        return false
      }
      setCommandInFlight(true)
      setCommandError(undefined)
      const result = await submit(session.token, heldProof.proof, providerKey)
      setCommandInFlight(false)
      if (result.outcome !== 'succeeded') {
        setCommandError(failureMessage(result, t))
        return false
      }
      setConnection(result.value)
      return true
    },
    [client, connection, getSession, heldProof, t]
  )

  // The exact-action proof is acquired before the credential dialog opens:
  // the confirmation dialog and the key dialog are never open together
  // (stacked modal focus traps froze the packaged Electron renderer when
  // they fought, and one-modal-at-a-time matches the command's real
  // dependency order — identity first, then the secret).
  const openCredentialDialog = useCallback(async (): Promise<void> => {
    const action: ProviderConnectionProofAction = connection === null ? 'create' : 'replace'
    const proof = await acquireProof(action)
    if (proof === undefined) return
    setHeldProof(proof)
    setKeyDialogOpen(true)
  }, [acquireProof, connection])

  const closeCredentialDialog = useCallback((): void => {
    setKeyDialogOpen(false)
    setHeldProof(undefined)
  }, [])

  const confirmDelete = useCallback(async (): Promise<void> => {
    const proof = await acquireProof('delete')
    if (proof === undefined) return
    setDeleteDialogOpen(false)
    await runCommand((token) => client.deleteConnection(token, proof.proof))
  }, [acquireProof, client, runCommand])

  return (
    <section aria-labelledby="provider-connection-heading" className="grid gap-4 p-4">
      <header className="flex items-center justify-between gap-3">
        <h3 id="provider-connection-heading" className="text-base font-semibold">
          {t('provider.title')}
        </h3>
        {isAdmin && connection !== null ? (
          <Badge variant={connection.adminState === 'enabled' ? 'default' : 'secondary'}>
            {t(`provider.adminState.${connection.adminState}`)}
          </Badge>
        ) : null}
      </header>
      <p className="text-muted-foreground text-sm">{t('provider.description')}</p>

      {loadState === 'loading' ? (
        <p role="status">{t('provider.state.loading')}</p>
      ) : loadState === 'failed' ? (
        <div className="grid gap-2">
          <p role="alert" className="text-destructive text-sm">
            {t('provider.state.loadFailed')}
          </p>
          <Button type="button" variant="outline" className="w-fit" onClick={() => void refresh()}>
            {t('provider.state.retry')}
          </Button>
        </div>
      ) : isAdmin ? (
        <AdminSurface
          connection={connection}
          commandInFlight={commandInFlight}
          commandError={commandError}
          keyDialogOpen={keyDialogOpen}
          deleteDialogOpen={deleteDialogOpen}
          onOpenKeyDialog={() => void openCredentialDialog()}
          onCloseKeyDialog={closeCredentialDialog}
          onSubmitCredential={submitCredential}
          onRecheck={() => runCommand((token) => client.recheck(token))}
          onTogglePause={() =>
            runCommand((token) =>
              connection?.adminState === 'paused'
                ? client.setAdminState(token, 'enabled')
                : client.setAdminState(token, 'paused')
            )
          }
          onOpenDeleteDialog={() => setDeleteDialogOpen(true)}
          onCloseDeleteDialog={() => setDeleteDialogOpen(false)}
          onConfirmDelete={confirmDelete}
        />
      ) : (
        <MemberSurface capabilities={memberCapabilities} />
      )}
    </section>
  )
}

function AdminSurface({
  connection,
  commandInFlight,
  commandError,
  keyDialogOpen,
  deleteDialogOpen,
  onOpenKeyDialog,
  onCloseKeyDialog,
  onSubmitCredential,
  onRecheck,
  onTogglePause,
  onOpenDeleteDialog,
  onCloseDeleteDialog,
  onConfirmDelete
}: {
  readonly connection: ProviderConnectionView | null
  readonly commandInFlight: boolean
  readonly commandError: string | undefined
  readonly keyDialogOpen: boolean
  readonly deleteDialogOpen: boolean
  readonly onOpenKeyDialog: () => void
  readonly onCloseKeyDialog: () => void
  readonly onSubmitCredential: (providerKey: string) => Promise<boolean>
  readonly onRecheck: () => void
  readonly onTogglePause: () => void
  readonly onOpenDeleteDialog: () => void
  readonly onCloseDeleteDialog: () => void
  readonly onConfirmDelete: () => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  if (connection === null) {
    return (
      <div className="grid gap-3">
        <p className="text-sm">{t('provider.empty')}</p>
        <Button
          type="button"
          className="w-fit"
          disabled={commandInFlight}
          onClick={onOpenKeyDialog}
        >
          <KeyRoundIcon className="size-4" aria-hidden />
          {t('provider.configure')}
        </Button>
        {commandError !== undefined ? (
          <p role="alert" className="text-destructive text-sm">
            {commandError}
          </p>
        ) : null}
        <CredentialDialog
          open={keyDialogOpen}
          mode="create"
          commandInFlight={commandInFlight}
          onClose={onCloseKeyDialog}
          onSubmit={onSubmitCredential}
        />
      </div>
    )
  }
  return (
    <div className="grid gap-4">
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <StatusField
          label={t('provider.fields.credential')}
          value={t(`provider.credential.${connection.credentialState}`)}
        />
        <StatusField
          label={t('provider.fields.image')}
          value={t(`provider.media.${connection.imageCapability}`)}
        />
        <StatusField
          label={t('provider.fields.video')}
          value={t(`provider.media.${connection.videoCapability}`)}
        />
      </dl>
      {connection.needsAttention ? (
        <p role="alert" className="text-sm">
          {connection.credentialState === 'credential_unavailable'
            ? t('provider.attention.credentialUnavailable')
            : connection.credentialState === 'invalid'
              ? t('provider.attention.credentialInvalid')
              : t('provider.attention.generic')}
        </p>
      ) : null}
      {commandError !== undefined ? (
        <p role="alert" className="text-destructive text-sm">
          {commandError}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={commandInFlight}
          onClick={onRecheck}
        >
          <RefreshCwIcon className="size-4" aria-hidden />
          {t('provider.recheck')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={commandInFlight}
          onClick={onOpenKeyDialog}
        >
          <KeyRoundIcon className="size-4" aria-hidden />
          {t('provider.replace')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={commandInFlight}
          onClick={onTogglePause}
        >
          {connection.adminState === 'paused' ? t('provider.resume') : t('provider.pause')}
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={commandInFlight}
          onClick={onOpenDeleteDialog}
        >
          {t('provider.delete')}
        </Button>
      </div>
      <CredentialDialog
        open={keyDialogOpen}
        mode="replace"
        commandInFlight={commandInFlight}
        onClose={onCloseKeyDialog}
        onSubmit={onSubmitCredential}
      />
      <DeleteConfirmDialog
        open={deleteDialogOpen}
        commandInFlight={commandInFlight}
        onClose={onCloseDeleteDialog}
        onConfirm={onConfirmDelete}
      />
    </div>
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
      <dd className="text-sm font-medium">{value}</dd>
    </div>
  )
}

function CredentialDialog({
  open,
  mode,
  commandInFlight,
  onClose,
  onSubmit
}: {
  readonly open: boolean
  readonly mode: 'create' | 'replace'
  readonly commandInFlight: boolean
  readonly onClose: () => void
  readonly onSubmit: (providerKey: string) => Promise<boolean>
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const [providerKey, setProviderKey] = useState('')
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setProviderKey('')
  }
  const canSubmit = providerKey !== '' && !commandInFlight

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!canSubmit) return
    const succeeded = await onSubmit(providerKey)
    if (succeeded) {
      setProviderKey('')
      onClose()
    }
  }

  return (
    <Dialog
      open={open}
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
          <DialogTitle>
            {mode === 'create'
              ? t('provider.dialog.createTitle')
              : t('provider.dialog.replaceTitle')}
          </DialogTitle>
          <DialogDescription>{t('provider.dialog.description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="provider-connection-key">
                {t('provider.dialog.keyLabel')}
              </FieldLabel>
              <Input
                id="provider-connection-key"
                type="password"
                autoComplete="off"
                value={providerKey}
                onChange={(event) => setProviderKey(event.target.value)}
                disabled={commandInFlight}
                required
              />
            </Field>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={commandInFlight}>
                  {t('provider.dialog.cancel')}
                </Button>
              </DialogClose>
              <Button type="submit" disabled={!canSubmit}>
                {commandInFlight ? t('provider.dialog.submitting') : t('provider.dialog.submit')}
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
          <DialogTitle>{t('provider.deleteDialog.title')}</DialogTitle>
          <DialogDescription>{t('provider.deleteDialog.description')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={commandInFlight}>
              {t('provider.deleteDialog.cancel')}
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={commandInFlight}
            onClick={onConfirm}
          >
            {t('provider.deleteDialog.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MemberSurface({
  capabilities
}: {
  readonly capabilities: MediaCapabilitiesView | null
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  if (capabilities === null) {
    return <p className="text-sm">{t('provider.member.unavailable')}</p>
  }
  return (
    <dl className="grid grid-cols-2 gap-3 text-sm">
      {(
        [
          ['image', capabilities.image],
          ['video', capabilities.video]
        ] as const
      ).map(([media, status]) => (
        <div key={media} className="grid gap-1">
          <dt className="text-muted-foreground text-xs">{t(`provider.fields.${media}`)}</dt>
          <dd className="text-sm font-medium">{t(`provider.media.${status.status}`)}</dd>
          {status.status !== 'available' ? (
            <dd className="text-muted-foreground text-xs">
              {status.action === 'wait'
                ? t('provider.member.wait')
                : t('provider.member.contactAdmin')}
            </dd>
          ) : null}
        </div>
      ))}
    </dl>
  )
}
