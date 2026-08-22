import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useServerConnectionEditor } from '../model/use-server-connection-editor'
import { CertificateDecision } from './certificate-decision'
import { ServerConnectionEditorFields } from './server-connection-editor-fields'

type SettingsNavigateSemantics = 'navigable' | 'confirm-discard' | 'blocked'
type SettingsCloseSemantics = 'allow' | 'confirm' | 'defer' | 'deny'

// Structurally mirrors the Settings Flow's SettingsLeaveSemantics contract
// (app/settings); Features do not import across that seam.
export type ServerConnectionSettingsContribution = {
  readonly navigate: SettingsNavigateSemantics
  readonly close: SettingsCloseSemantics
  readonly discard?: () => void
}

const CLEAN_CONTRIBUTION: ServerConnectionSettingsContribution = {
  navigate: 'navigable',
  close: 'allow'
}

/**
 * The Settings view of the runtime server connection: shows the saved URL,
 * re-runs the probe-and-TOFU flow for edits, and hands the post-save side
 * effects (session teardown plus reload) to the app-level composition.
 */
export function ServerConnectionSettings({
  serverUrl,
  onSaved,
  onContributionChange
}: {
  readonly serverUrl: string | undefined
  readonly onSaved: () => void | Promise<void>
  readonly onContributionChange?: (contribution: ServerConnectionSettingsContribution) => void
}): React.JSX.Element {
  const { t } = useTranslation('connection')
  const editor = useServerConnectionEditor(serverUrl)
  const [hasSaved, setHasSaved] = useState(false)

  useEffect(() => {
    const isDirty = editor.isDirty || editor.state.kind === 'saving'
    onContributionChange?.(
      isDirty
        ? { navigate: 'confirm-discard', close: 'confirm', discard: editor.reset }
        : CLEAN_CONTRIBUTION
    )
  }, [editor.isDirty, editor.reset, editor.state.kind, onContributionChange])

  async function save(): Promise<void> {
    if ((await editor.save()) !== 'saved') return
    setHasSaved(true)
    await onSaved()
  }

  return (
    <div className="grid gap-4">
      <dl className="text-muted-foreground grid gap-1 text-xs">
        <div className="grid grid-cols-[8rem_1fr] gap-2">
          <dt>{t('settings.currentUrl')}</dt>
          <dd className="font-mono break-all">{serverUrl}</dd>
        </div>
      </dl>
      {hasSaved ? (
        <p role="status" className="text-sm">
          {t('settings.savedNotice')}
        </p>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <ServerConnectionEditorFields
          draft={editor.draft}
          state={editor.state}
          onUrlChange={editor.setUrl}
          onTest={() => void editor.test()}
          onSave={() => void save()}
        />
        {editor.state.kind === 'certificate' ? (
          <div className="mt-4">
            <CertificateDecision
              decision={editor.state.decision}
              view={editor.state.view}
              isTrusting={false}
              onTrust={() => void editor.trustPresentedCertificate()}
            />
          </div>
        ) : null}
      </form>
    </div>
  )
}
