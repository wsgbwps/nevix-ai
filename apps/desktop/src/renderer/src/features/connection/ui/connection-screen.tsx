import { useTranslation } from 'react-i18next'
import { ModeToggle } from '../../../components/mode-toggle'
import { useTheme } from '../../../hooks/use-theme'
import { useServerConnectionEditor } from '../model/use-server-connection-editor'
import { CertificateDecision } from './certificate-decision'
import { ServerConnectionEditorFields } from './server-connection-editor-fields'

/**
 * The first-launch surface (ADR-0014): no persisted server connection exists,
 * so the User enters the deployment's server URL, proves it reachable, and
 * saves it — after which the document reloads into the login boundary.
 */
export function ConnectionScreen(): React.JSX.Element {
  const { t } = useTranslation('connection')
  const { theme } = useTheme()
  const editor = useServerConnectionEditor(undefined)

  async function save(): Promise<void> {
    if ((await editor.save()) !== 'saved') return
    // The saved URL becomes the renderer's runtime connect-src, which is fixed
    // per document: reloading applies it before the login boundary opens.
    window.location.reload()
  }

  return (
    <main className="bg-card relative grid h-svh lg:grid-cols-2">
      <div className="flex flex-col gap-4 overflow-y-auto p-6 md:p-10">
        <div className="flex justify-center md:justify-start">
          <div className="flex items-center gap-2 font-medium">
            <div className="bg-primary text-primary-foreground grid size-6 place-items-center rounded-md text-xs font-bold">
              N
            </div>
            Nevix AI
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-xs">
            <header className="mb-7 text-center">
              <h1 className="text-2xl font-bold">{t('screen.heading')}</h1>
              <p className="text-muted-foreground mt-2 text-sm">{t('screen.description')}</p>
            </header>
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
        </div>
      </div>
      <aside
        aria-hidden="true"
        className="from-primary/70 via-primary/30 to-background relative hidden bg-linear-to-br lg:block"
      >
        <div className="absolute inset-x-10 bottom-10 flex items-center gap-2 text-lg font-medium">
          <div className="bg-primary-foreground text-primary grid size-7 place-items-center rounded-md text-sm font-bold">
            N
          </div>
          Nevix AI
        </div>
      </aside>
      <div className="absolute top-4 right-4 z-10">
        <ModeToggle label={t(theme === 'dark' ? 'theme.switchToLight' : 'theme.switchToDark')} />
      </div>
    </main>
  )
}
