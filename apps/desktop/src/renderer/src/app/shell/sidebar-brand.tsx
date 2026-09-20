import { useTranslation } from 'react-i18next'
import { SidebarHeader, SidebarTrigger } from '../../components/ui/sidebar'

function BrandMark({
  className = 'size-8 rounded-lg text-sm'
}: {
  className?: string
}): React.JSX.Element {
  return (
    <div
      data-testid="sidebar-brand"
      className={`bg-primary text-primary-foreground grid shrink-0 place-items-center font-bold ${className}`}
    >
      N
    </div>
  )
}

/**
 * The App Shell's sidebar brand slot: the product mark, its name, and the sidebar toggle.
 * In the icon rail the mark centres on the rail and the toggle takes its place — hidden
 * until the pointer reaches the mark, then fading in over it, so the rail keeps a single
 * 32px target in the header instead of stacking two controls side by side.
 */
export function SidebarBrand(): React.JSX.Element {
  const { t } = useTranslation('app')
  // pt-6 + h-9 mirror the page header bar: the brand mark lands on the same
  // centre line as the header's control row.
  return (
    <SidebarHeader className="pt-6 pb-2">
      <div className="group/brand relative flex h-9 items-center gap-2 px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
        <BrandMark className="size-7 rounded-md text-xs transition-opacity group-data-[collapsible=icon]:group-hover/brand:opacity-0" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium group-data-[collapsible=icon]:hidden">
          Nevix AI
        </span>
        <SidebarTrigger
          aria-label={t('shell.toggleSidebar')}
          className="group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:inset-y-0 group-data-[collapsible=icon]:left-1/2 group-data-[collapsible=icon]:my-auto group-data-[collapsible=icon]:-translate-x-1/2 group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:transition-opacity group-data-[collapsible=icon]:duration-200 group-data-[collapsible=icon]:group-hover/brand:opacity-100 group-data-[collapsible=icon]:focus-visible:opacity-100"
        />
      </div>
    </SidebarHeader>
  )
}
