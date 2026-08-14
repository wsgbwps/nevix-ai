import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

type PersistenceNoticeSurface = 'login' | 'authenticated'

interface RememberedEmailPersistenceNoticeProps {
  readonly surface: PersistenceNoticeSurface
  readonly isSurfaceActive?: boolean
  readonly isPersistenceUnavailable: boolean
  readonly noticeSurface: PersistenceNoticeSurface | undefined
  readonly onShown: () => void
}

export function RememberedEmailPersistenceNotice({
  surface,
  isSurfaceActive = true,
  isPersistenceUnavailable,
  noticeSurface,
  onShown
}: RememberedEmailPersistenceNoticeProps): React.JSX.Element | null {
  const { t } = useTranslation('authentication')
  const isVisible = isSurfaceActive && isPersistenceUnavailable && noticeSurface === surface

  useEffect(() => {
    if (isVisible) onShown()
  }, [isVisible, onShown])

  if (!isVisible) return null

  return (
    <p
      role="status"
      className={
        surface === 'authenticated'
          ? 'bg-card text-muted-foreground fixed right-6 bottom-6 z-50 max-w-sm rounded-lg border px-4 py-3 text-sm shadow-sm'
          : 'text-muted-foreground text-sm'
      }
    >
      {t('rememberedEmailPersistence.unavailable')}
    </p>
  )
}
