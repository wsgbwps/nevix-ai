import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import {
  ChevronsUpDownIcon,
  HomeIcon,
  ImagesIcon,
  LogOutIcon,
  MoonIcon,
  SettingsIcon,
  SunIcon
} from 'lucide-react'
import { useCurrentSession } from '../../features/authentication'
import { CreationSessionNavigationSidebar } from '../../features/creation'
import { type Theme, useTheme } from '../../hooks/use-theme'
import { createSettingsEntry } from '../settings'
import { SidebarBrand } from './sidebar-brand'
import { Avatar, AvatarFallback } from '../../components/ui/avatar'
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
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator
} from '../../components/ui/sidebar'
import { TooltipProvider } from '../../components/ui/tooltip'

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
  const navigate = useNavigate()
  const { theme, setTheme } = useTheme()

  if (session.status !== 'available') {
    // The root route is already navigating to the authentication view; render nothing on the
    // transient frame so the App Shell never shows for a signed-out user.
    return null
  }

  const userInitial = initialOf(session.user.email)
  return (
    <TooltipProvider delayDuration={0}>
      {/* h-svh makes the shell's height definite: the wrapper's own min-h-svh
          only sets a floor, so without it every descendant height resolves to
          content height, the inset's overflow-auto content area never bounds,
          and wheel events over page-managed scrollers chain to the document —
          scrolling the whole shell (header, nav, and page) as one block. */}
      <SidebarProvider className="h-svh">
        <Sidebar collapsible="icon">
          <SidebarBrand />
          <SidebarContent className="overflow-hidden">
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
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={location.pathname === '/assets'}
                      tooltip={t('shell.assets')}
                    >
                      <Link to="/assets">
                        <ImagesIcon />
                        <span className="group-data-[collapsible=icon]:hidden">
                          {t('shell.assets')}
                        </span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarSeparator />
            <CreationSessionNavigationSidebar
              onOpenCreation={() => {
                void navigate({ to: '/creation' })
              }}
            />
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
          <div className="flex flex-1 flex-col overflow-auto">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
