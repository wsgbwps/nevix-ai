import { useTranslation } from 'react-i18next'
import { Link, useLocation } from '@tanstack/react-router'
import {
  ChevronsUpDownIcon,
  HomeIcon,
  LogOutIcon,
  MoonIcon,
  SettingsIcon,
  SunIcon
} from 'lucide-react'
import { useCurrentSession } from '../../features/authentication'
import { type Theme, useTheme } from '../../hooks/use-theme'
import { createSettingsEntry } from '../settings'
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
  className = 'size-8 rounded-lg text-sm'
}: {
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={`bg-primary text-primary-foreground grid shrink-0 place-items-center font-bold ${className}`}
    >
      N
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
  const session = useCurrentSession()
  const location = useLocation()
  const { theme, setTheme } = useTheme()

  if (session.status !== 'available') {
    // The root route is already navigating to the authentication view; render nothing on the
    // transient frame so the App Shell never shows for a signed-out user.
    return null
  }

  const userInitial = initialOf(session.user.email)
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
                {/* Brand slot: the product mark placeholder stays until a workspace
                  identity lands. */}
                <SidebarMenuButton
                  size="lg"
                  disabled
                  aria-label={t('shell.brand')}
                  className="disabled:opacity-100"
                >
                  <BrandMark />
                  <div className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
                    <span className="truncate font-medium">Nevix AI</span>
                  </div>
                  <ChevronsUpDownIcon className="ml-auto size-4" />
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
                        <span className="truncate font-medium">{session.user.email}</span>
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
                          <span className="truncate font-medium">{session.user.email}</span>
                        </div>
                      </div>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className="cursor-pointer">
                        {theme === 'dark' ? <MoonIcon /> : <SunIcon />}
                        {t(theme === 'dark' ? 'shell.theme.dark' : 'shell.theme.light')}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="min-w-40">
                        <DropdownMenuRadioGroup
                          value={theme}
                          onValueChange={(value) => setTheme(value as Theme)}
                        >
                          <DropdownMenuRadioItem value="light" className="cursor-pointer">
                            <SunIcon />
                            {t('shell.theme.light')}
                          </DropdownMenuRadioItem>
                          <DropdownMenuRadioItem value="dark" className="cursor-pointer">
                            <MoonIcon />
                            {t('shell.theme.dark')}
                          </DropdownMenuRadioItem>
                        </DropdownMenuRadioGroup>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuItem asChild className="cursor-pointer">
                      <Link
                        to="/settings"
                        state={(state) => ({
                          ...state,
                          settings: createSettingsEntry(location)
                        })}
                      >
                        <SettingsIcon />
                        {t('shell.settings')}
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="cursor-pointer"
                      disabled={session.isSigningOut}
                      onClick={() => void session.signOut()}
                    >
                      <LogOutIcon />
                      {authenticationT(
                        session.isSigningOut ? 'logout.submitting' : 'logout.submit'
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
