import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { requestReleaseStatus, type ReleaseStatus } from '../api/client'

export function ServerReleaseSettings({
  getSession,
  serverUrl
}: {
  readonly getSession: () => Promise<{ readonly token: string } | undefined>
  readonly serverUrl: string
}): React.JSX.Element {
  const { t } = useTranslation('release')
  const [view, setView] = useState<{
    serverUrl: string
    getSession: typeof getSession
    status?: ReleaseStatus
    busy: boolean
    failed: boolean
  }>({ serverUrl, getSession, busy: true, failed: false })
  const { status, busy, failed } =
    view.serverUrl === serverUrl && view.getSession === getSession
      ? view
      : { status: undefined, busy: true, failed: false }
  const lifetime = useRef<AbortController | undefined>(undefined)

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    void (async () => {
      const session = await getSession()
      if (controller.signal.aborted) return
      const result = session
        ? await requestReleaseStatus(session.token, serverUrl, false, controller.signal)
        : undefined
      if (controller.signal.aborted) return
      setView({ serverUrl, getSession, status: result, failed: !result, busy: false })
    })().catch(() => {
      if (!controller.signal.aborted) setView({ serverUrl, getSession, failed: true, busy: false })
    })
    return () => controller.abort()
  }, [getSession, serverUrl])

  async function check(): Promise<void> {
    const controller = lifetime.current
    if (busy || !controller || controller.signal.aborted) return
    setView({ serverUrl, getSession, busy: true, failed: false })
    try {
      const session = await getSession()
      if (controller.signal.aborted) return
      const result = session
        ? await requestReleaseStatus(session.token, serverUrl, true, controller.signal)
        : undefined
      if (!controller.signal.aborted)
        setView({ serverUrl, getSession, status: result, failed: !result, busy: false })
    } catch {
      if (!controller.signal.aborted) setView({ serverUrl, getSession, failed: true, busy: false })
    }
  }

  return (
    <section className="grid gap-5 p-6">
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </div>
      {status ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <dt>{t('current')}</dt>
          <dd>{status.version}</dd>
          <dt>{t('currentMinimum')}</dt>
          <dd>{status.min_desktop_version}</dd>
          {status.candidate ? (
            <>
              <dt>{t('candidate')}</dt>
              <dd>{status.candidate.version}</dd>
              <dt>{t('minimumServer')}</dt>
              <dd>{status.candidate.min_server_version}</dd>
              <dt>{t('minimumDesktop')}</dt>
              <dd>{status.candidate.min_desktop_version}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      <p role="status" aria-live="polite" className="text-sm">
        {busy
          ? t('checking')
          : failed
            ? t('unavailable')
            : status
              ? t(`outcomes.${status.outcome}`)
              : ''}
      </p>
      <Button
        type="button"
        className="justify-self-start"
        disabled={busy}
        onClick={() => void check()}
      >
        {t('check')}
      </Button>
    </section>
  )
}
