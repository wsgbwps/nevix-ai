import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../../components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '../../../components/ui/field'
import {
  createReauthProofRequester,
  type IdentityApiFailure,
  type IssuedReauthProof,
  type ReauthAction,
  type ReauthProofRequester
} from '../api/reauth'
import { PasswordInput } from './password-input'

/** The explicit label keys per declared action — no key-path guessing from the action id. */
const ACTION_LABEL_KEYS = {
  'provider_connection.create': 'reauth.actionProviderConnectionCreate',
  'provider_connection.replace': 'reauth.actionProviderConnectionReplace',
  'provider_connection.delete': 'reauth.actionProviderConnectionDelete'
} as const satisfies Record<ReauthAction, string>

/** One observable submission verdict; every branch maps to a stable message. */
type ReauthDialogError =
  | 'invalid-credentials'
  | 'secure-transport-required'
  | 'rate-limited'
  | 'unauthorized'
  | 'service-unavailable'

export interface ReauthenticationDialogProps {
  /** Controlled visibility; the caller closes the dialog after receiving the proof. */
  readonly open: boolean
  /** The declared exact action this confirmation authorizes — the closed set's only members. */
  readonly action: ReauthAction
  /** The Go server base URL, exactly as the settings surfaces receive it. */
  readonly serverUrl: string
  /** Yields the current device's session token; production callers pass the current session's acquireSession. */
  readonly acquireSession: () => Promise<{ readonly token: string } | undefined>
  /** Receives the issued proof; the caller forwards it to the high-risk command and closes the dialog. */
  readonly onProof: (proof: IssuedReauthProof) => void
  /** The user abandoned the confirmation. */
  readonly onCancel: () => void
  /** Test seam: the proof requester. Production defaults to the HTTP client over serverUrl. */
  readonly issueProof?: ReauthProofRequester
}

/**
 * The Authentication-owned current-password confirmation surface (issue
 * #154): an admin re-verifies their password for one declared exact action
 * and the caller receives the opaque proof — never a session, never
 * Identity internals. The proof's five-minute single-use window is a server
 * fact; this surface only presents it.
 */
export function ReauthenticationDialog({
  open,
  action,
  serverUrl,
  acquireSession,
  onProof,
  onCancel,
  issueProof
}: ReauthenticationDialogProps): React.JSX.Element {
  const { t } = useTranslation('authentication')
  const [password, setPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<ReauthDialogError | undefined>(undefined)

  // Each opening starts from a clean slate; a closed dialog never retains
  // the typed password in component state. Resetting during render on the
  // closed→open transition is the sanctioned pattern (no effect, no cascade).
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setPassword('')
      setError(undefined)
      setIsSubmitting(false)
    }
  }

  const canSubmit = password !== '' && !isSubmitting

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!canSubmit) return

    const session = await acquireSession()
    if (!session) {
      setError('unauthorized')
      return
    }
    // The requester is captured at submit time: a prop change mid-flight
    // never swaps the adapter an in-flight verification uses.
    const requester = issueProof ?? createReauthProofRequester(serverUrl)

    setIsSubmitting(true)
    setError(undefined)
    const result = await requester.issue(session.token, action, password)

    setIsSubmitting(false)
    if (result.outcome === 'succeeded') {
      setPassword('')
      onProof(result.value)
      return
    }
    setError(mapFailure(result))
  }

  const cancel = (): void => {
    if (isSubmitting) return
    setPassword('')
    onCancel()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) cancel()
      }}
    >
      <DialogContent
        showCloseButton={!isSubmitting}
        onEscapeKeyDown={(event) => {
          if (isSubmitting) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (isSubmitting) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('reauth.title')}</DialogTitle>
          <DialogDescription>
            {t('reauth.description', {
              action: t(ACTION_LABEL_KEYS[action]),
              minutes: 5
            })}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate>
          <FieldGroup>
            <Field data-slot="reauth-action-field">
              <FieldLabel>{t('reauth.actionLabel')}</FieldLabel>
              <p className="text-foreground bg-muted rounded-md px-3 py-2 text-sm">
                {t(ACTION_LABEL_KEYS[action])}
              </p>
            </Field>
            <Field data-slot="reauth-password-field">
              <FieldLabel htmlFor="reauth-current-password">
                {t('reauth.currentPassword')}
              </FieldLabel>
              <PasswordInput
                id="reauth-current-password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value)
                }}
                disabled={isSubmitting}
                aria-invalid={error === 'invalid-credentials' || undefined}
                required
              />
              {error === 'invalid-credentials' && (
                <FieldError>{t('reauth.errors.invalidCredentials')}</FieldError>
              )}
            </Field>
            {error !== undefined && error !== 'invalid-credentials' && (
              <p role="alert" className="text-destructive text-sm">
                {t(ERROR_MESSAGE_KEYS[error])}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={cancel} disabled={isSubmitting}>
                {t('reauth.cancel')}
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {isSubmitting ? t('reauth.submitting') : t('reauth.submit')}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const ERROR_MESSAGE_KEYS = {
  'invalid-credentials': 'reauth.errors.invalidCredentials',
  'secure-transport-required': 'reauth.errors.secureTransportRequired',
  'rate-limited': 'reauth.errors.rateLimited',
  unauthorized: 'reauth.errors.sessionExpired',
  'service-unavailable': 'reauth.errors.serviceError'
} as const satisfies Record<ReauthDialogError, string>

function mapFailure(result: IdentityApiFailure): ReauthDialogError {
  if (result.outcome === 'network-failure') return 'service-unavailable'
  if (result.outcome === 'unauthorized') return 'unauthorized'
  if (result.outcome === 'rate-limited') return 'rate-limited'
  // request-rejected: only the documented stable codes map to specific
  // guidance; anything else stays generic so an unknown server answer
  // never fakes a specific verdict.
  if (result.code === 'invalid_credentials') return 'invalid-credentials'
  if (result.code === 'secure_transport_required') return 'secure-transport-required'
  return 'service-unavailable'
}
