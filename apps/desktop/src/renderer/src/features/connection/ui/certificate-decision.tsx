import { useTranslation } from 'react-i18next'
import { AlertTriangleIcon, ShieldQuestionIcon } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import type { CertificateFingerprintView } from '../../../../../shared/ipc/connection/types'

/** Formats a SHA-256 fingerprint into the colon-separated hex groups users compare. */
function formatFingerprint(fingerprint: string): string {
  return fingerprint.replace(/(..)/g, '$1:').slice(0, -1).toUpperCase()
}

function CertificateFingerprintDetails({
  view
}: {
  readonly view: CertificateFingerprintView
}): React.JSX.Element {
  const { t } = useTranslation('connection')

  return (
    <dl className="text-muted-foreground grid gap-1 text-xs">
      {view.subjectName ? (
        <div className="grid grid-cols-[8rem_1fr] gap-2">
          <dt>{t('certificate.subject')}</dt>
          <dd className="font-mono break-all">{view.subjectName}</dd>
        </div>
      ) : null}
      {view.issuerName ? (
        <div className="grid grid-cols-[8rem_1fr] gap-2">
          <dt>{t('certificate.issuer')}</dt>
          <dd className="font-mono break-all">{view.issuerName}</dd>
        </div>
      ) : null}
      <div className="grid grid-cols-[8rem_1fr] gap-2">
        <dt>{t('certificate.validTo')}</dt>
        <dd className="font-mono break-all">{view.validTo}</dd>
      </div>
      <div className="grid grid-cols-[8rem_1fr] gap-2">
        <dt>{t('certificate.fingerprint')}</dt>
        <dd className="font-mono break-all select-all">{formatFingerprint(view.fingerprint)}</dd>
      </div>
    </dl>
  )
}

/**
 * The TOFU decision surface: an untrusted certificate asks for a first-use
 * confirmation; a changed fingerprint asks again, framed as the warning the
 * spec requires. Neither path ever skips verification globally.
 */
export function CertificateDecision({
  decision,
  view,
  isTrusting,
  onTrust
}: {
  readonly decision: 'confirm' | 'changed'
  readonly view: CertificateFingerprintView
  readonly isTrusting: boolean
  readonly onTrust: () => void
}): React.JSX.Element {
  const { t } = useTranslation('connection')

  return (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/5 rounded-md border p-3"
      data-testid="certificate-decision"
    >
      <div className="text-foreground flex items-center gap-2 text-sm font-medium">
        {decision === 'changed' ? (
          <AlertTriangleIcon className="text-destructive size-4" aria-hidden="true" />
        ) : (
          <ShieldQuestionIcon className="text-destructive size-4" aria-hidden="true" />
        )}
        {t(decision === 'changed' ? 'certificate.changedTitle' : 'certificate.confirmTitle')}
      </div>
      <p className="text-muted-foreground mt-2 text-xs">
        {t(
          decision === 'changed'
            ? 'certificate.changedDescription'
            : 'certificate.confirmDescription'
        )}
      </p>
      <div className="mt-3">
        <CertificateFingerprintDetails view={view} />
      </div>
      <Button
        type="button"
        variant="outline"
        className="mt-3"
        disabled={isTrusting}
        onClick={onTrust}
      >
        {t(isTrusting ? 'certificate.trusting' : 'certificate.trust')}
      </Button>
    </div>
  )
}
