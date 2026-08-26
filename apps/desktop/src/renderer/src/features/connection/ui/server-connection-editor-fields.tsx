import { useTranslation } from 'react-i18next'
import { AlertTriangleIcon } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { Field, FieldGroup, FieldLabel } from '../../../components/ui/field'
import { Input } from '../../../components/ui/input'
import type { ServerConnectionEditorState } from '../model/use-server-connection-editor'

const FAILURE_MESSAGE_KEYS = {
  'invalid-url': 'probe.invalidUrl',
  unreachable: 'probe.unreachable',
  'incompatible-server': 'probe.incompatibleServer'
} as const

/** The Connection Screen / Settings shared form: URL in, probe verdict out, save gated on a passed probe. */
export function ServerConnectionEditorFields({
  draft,
  state,
  onUrlChange,
  onTest,
  onSave
}: {
  readonly draft: string
  readonly state: ServerConnectionEditorState
  readonly onUrlChange: (value: string) => void
  readonly onTest: () => void
  readonly onSave: () => void
}): React.JSX.Element {
  const { t } = useTranslation('connection')
  const isBusy = state.kind === 'testing' || state.kind === 'trusting' || state.kind === 'saving'
  const canSave = state.kind === 'reachable'

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="server-connection-url">{t('screen.urlLabel')}</FieldLabel>
        <Input
          id="server-connection-url"
          name="serverUrl"
          type="url"
          autoComplete="url"
          spellCheck={false}
          required
          disabled={isBusy}
          value={draft}
          onChange={(event) => onUrlChange(event.target.value)}
        />
      </Field>

      {state.kind === 'reachable' ? (
        <div className="grid gap-2">
          <p role="status" className="text-sm" data-testid="connection-probe-reachable">
            {t('probe.reachable')}
          </p>
          {state.warning?.kind === 'certificate-near-expiry' ? (
            <p
              role="status"
              className="text-foreground flex items-start gap-2 text-sm"
              data-testid="certificate-near-expiry"
            >
              <AlertTriangleIcon
                className="text-destructive mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              {t('probe.nearExpiry', { validTo: state.warning.validTo })}
            </p>
          ) : null}
        </div>
      ) : null}
      {state.kind === 'failed' ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error === 'certificate-expired'
            ? t('probe.certificateExpired', { validTo: state.validTo })
            : t(FAILURE_MESSAGE_KEYS[state.error])}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={isBusy || draft.trim() === ''}
          onClick={onTest}
        >
          {t(state.kind === 'testing' ? 'screen.testing' : 'screen.test')}
        </Button>
        <Button type="button" disabled={isBusy || !canSave} onClick={onSave}>
          {t(state.kind === 'saving' ? 'screen.saving' : 'screen.save')}
        </Button>
      </div>
    </FieldGroup>
  )
}
