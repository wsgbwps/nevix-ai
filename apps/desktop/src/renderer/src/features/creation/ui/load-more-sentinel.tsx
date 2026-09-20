import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { useLoadMore } from '../../../hooks/use-load-more'
import type { MoreStatus } from '../../../hooks/use-cursor-pages'
import { cn } from '../../../lib/utils'

/**
 * The tail control of an appended list: reaching it loads the next page. Render
 * it whenever the list has more to read, an empty list included — a page with no
 * cards can still carry a cursor.
 */
export function LoadMoreSentinel({
  more,
  label,
  onLoadMore,
  root,
  className
}: {
  readonly more: MoreStatus
  /** Names the region for assistive tech; each list words this its own way. */
  readonly label: string
  readonly onLoadMore: () => void
  readonly root: React.RefObject<Element | null>
  readonly className?: string
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  // Only the idle state auto-loads: a failed page waits for the retry this same
  // control offers, so a broken server cannot spin on every scroll.
  const reachRef = useLoadMore({ onReach: onLoadMore, disabled: more !== 'idle', root })
  return (
    <nav
      ref={reachRef}
      className={cn('flex justify-center', className)}
      aria-busy={more === 'loading'}
      aria-label={label}
    >
      <Button type="button" variant="outline" disabled={more === 'loading'} onClick={onLoadMore}>
        {more === 'failed' ? t('state.retry') : t('assets.loadMore')}
      </Button>
    </nav>
  )
}
