import { useTranslation } from 'react-i18next'
import { Link, useLocation } from '@tanstack/react-router'
import { ChevronsUpDownIcon, HomeIcon, LogOutIcon, SettingsIcon } from 'lucide-react'
import { useActiveOrganization } from '../../features/organization'
import { useAuthenticationState } from '../authentication-state'
import { Avatar, AvatarFallback } from '../../components/ui/avatar'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage
} from '../../components/ui/breadcrumb'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../../components/ui/dropdown-menu'
import { Separator } from '../../components/ui/separator'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger
} from '../../components/ui/sidebar'
import { TooltipProvider } from '../../components/ui/tooltip'

function BrandMark({
  children = 'N',
  className = 'size-8 rounded-lg text-sm'
}: {
  readonly children?: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={`bg-primary text-primary-foreground grid shrink-0 place-items-center font-bold ${className}`}
    >
      {children}
    </div>
  )
}

function initialOf(email: string | undefined): string {
  return email?.charAt(0).toUpperCase() ?? ''
}

export function AppShell({
  children
}: {
  readonly children: React.ReactNode
}): React.JSX.Element | null {
  const { t } = useTranslation('app')
  const { t: authenticationT } = useTranslation('authentication')
  const { t: organizationT } = useTranslation('organization')
  const authentication = useAuthenticationState()
  const location = useLocation()
  const organization = useActiveOrganization()

  if (authentication.status !== 'authenticated') {
    // The root route is already navigating to the authentication view; render nothing on the
    // transient frame so the App Shell never shows for a signed-out user.
    return null
  }

  if (!organization.activeOrganization) {
    // No entered Organization context: the root route is navigating to the startup branches, so
    // the App Shell never renders Organization data the Session is not entitled to.
    return null
  }

  const activeOrganization = organization.activeOrganization

  const userInitial = initialOf(authentication.userEmail)
  // The App Shell currently hosts a single real entry; future business Features gain routes in
  // the content area and extend this mapping from the current pathname.
  const breadcrumbLabel = location.pathname === '/' ? t('shell.home') : undefined

  return (
    <TooltipProvider delayDuration={0}>
      <SidebarProvider>
        <Sidebar collapsible="icon">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                {/* Organization context card: the entered Organization with the User's role; it
                  links to the Organization picker so the User can switch or create. */}
                <SidebarMenuButton size="lg" asChild aria-label={t('shell.organizationSwitcher')}>
                  <Link to="/select-organization">
                    <BrandMark>
                      {activeOrganization.organizationName.charAt(0).toUpperCase()}
                    </BrandMark>
                    <div className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
                      <span className="truncate font-medium">
                        {activeOrganization.organizationName}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {organizationT(`roles.${activeOrganization.role}`)}
                      </span>
                    </div>
                    <ChevronsUpDownIcon className="ml-auto size-4" />
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={location.pathname === '/'}
                      tooltip={t('shell.home')}
                    >
                      <Link to="/">
                        <HomeIcon />
                        <span className="group-data-[collapsible=icon]:hidden">
                          {t('shell.home')}
                        </span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <SidebarMenuButton
                      size="lg"
                      aria-label={t('shell.userMenu')}
                      className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                    >
                      <Avatar className="size-8 rounded-lg">
                        <AvatarFallback className="rounded-lg">{userInitial}</AvatarFallback>
                      </Avatar>
                      <div className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
                        <span className="truncate font-medium">{authentication.userEmail}</span>
                      </div>
                      <ChevronsUpDownIcon className="ml-auto size-4" />
                    </SidebarMenuButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    side="top"
                    align="end"
                    className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
                  >
                    <DropdownMenuLabel className="p-0 font-normal">
                      <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                        <Avatar className="size-8 rounded-lg">
                          <AvatarFallback className="rounded-lg">{userInitial}</AvatarFallback>
                        </Avatar>
                        <div className="grid flex-1 text-left text-sm leading-tight">
                          <span className="truncate font-medium">{authentication.userEmail}</span>
                        </div>
                      </div>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <Link to="/settings">
                        <SettingsIcon />
                        {t('shell.settings')}
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={authentication.isSubmitting}
                      onClick={() => void authentication.signOut()}
                    >
                      <LogOutIcon />
                      {authenticationT(
                        authentication.isSubmitting ? 'logout.submitting' : 'logout.submit'
                      )}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
          <SidebarRail aria-label={t('shell.toggleSidebar')} title={t('shell.toggleSidebar')} />
        </Sidebar>
        <SidebarInset>
          <header className="flex h-16 shrink-0 items-center gap-2 px-4">
            <SidebarTrigger aria-label={t('shell.toggleSidebar')} className="-ml-1" />
            <Separator
              orientation="vertical"
              className="mr-2 data-horizontal:hidden data-vertical:h-4 data-vertical:self-auto"
            />
            {breadcrumbLabel ? (
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbPage className="text-muted-foreground">
                      {breadcrumbLabel}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            ) : null}
          </header>
          <div className="flex flex-1 flex-col overflow-auto">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
