import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { Field, FieldGroup, FieldLabel } from '../../../components/ui/field'
import { Input } from '../../../components/ui/input'
import type { ServerConnectionEditorState } from '../model/use-server-connection-editor'

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
        <p role="status" className="text-sm" data-testid="connection-probe-reachable">
          {t('probe.reachable')}
        </p>
      ) : null}
      {state.kind === 'failed' ? (
        <p role="alert" className="text-destructive text-sm">
          {t(state.error === 'invalid-url' ? 'probe.invalidUrl' : 'probe.unreachable')}
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
