import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, EyeOff } from 'lucide-react'
import { Input } from '../../../components/ui/input'
import { cn } from '../../../lib/utils'

/**
 * The Authentication-owned password field with show/hide toggling. Visible
 * input auto-hides when the window loses focus so a shared screen never
 * keeps a credential exposed. Reused by every password form in the Feature,
 * including the Reauthentication confirmation surface.
 */
export function PasswordInput({
  className,
  disabled,
  ...props
}: Omit<React.ComponentProps<'input'>, 'type'>): React.JSX.Element {
  const { t } = useTranslation('authentication')
  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    if (!isVisible) return

    const hide = (): void => setIsVisible(false)
    const stopListeningForWindowDeactivation = window.api.on('window:deactivated', hide)
    window.addEventListener('blur', hide)
    document.addEventListener('visibilitychange', hide)
    return () => {
      stopListeningForWindowDeactivation()
      window.removeEventListener('blur', hide)
      document.removeEventListener('visibilitychange', hide)
    }
  }, [isVisible])

  return (
    <div className="relative">
      <Input
        {...props}
        type={isVisible ? 'text' : 'password'}
        disabled={disabled}
        className={cn('pr-10', className)}
      />
      <button
        type="button"
        disabled={disabled}
        aria-label={t(isVisible ? 'passwordVisibility.hide' : 'passwordVisibility.show')}
        aria-pressed={isVisible}
        onClick={() => setIsVisible((visible) => !visible)}
        className="focus-visible:border-ring focus-visible:ring-ring/50 hover:bg-muted hover:text-foreground dark:hover:bg-muted/50 absolute top-1/2 right-0.5 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-[min(var(--radius-md),10px)] outline-none focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
      >
        {isVisible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </button>
    </div>
  )
}
