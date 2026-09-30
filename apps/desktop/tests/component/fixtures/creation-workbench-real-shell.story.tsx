import { HomeIcon, ImagesIcon } from 'lucide-react'
import { I18nextProvider } from 'react-i18next'
import '../../../src/renderer/src/app/globals.css'
import { SidebarBrand } from '../../../src/renderer/src/app/shell/sidebar-brand'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator
} from '../../../src/renderer/src/components/ui/sidebar'
import { TooltipProvider } from '../../../src/renderer/src/components/ui/tooltip'
import {
  CreationSessionNavigationSidebar,
  CreationWorkbenchPage
} from '../../../src/renderer/src/features/creation'
import { testI18n } from './creation-workbench-i18n'
import { RuntimeWorkbenchScope, type StoryOptions } from './creation-workbench.story'

/**
 * Scroll-contract story: the page under the real App Shell geometry and the real
 * stylesheet — it imports app/globals.css so Tailwind applies, so keep it out of specs
 * that must stay CSS-less (CT ships no CSS). The sidebar chrome below mirrors
 * app/shell/app-shell.tsx and must change with it (the AppShell is not CT-mountable: auth
 * providers). Footer and rail stay out — the footer needs the auth session, and a second
 * `Toggle sidebar` control would make the story's own toggle ambiguous by role and name.
 */
export function CreationWorkbenchRealShellStory(options: StoryOptions = {}): React.JSX.Element {
  return (
    <I18nextProvider i18n={testI18n}>
      <RuntimeWorkbenchScope options={options}>
        <TooltipProvider delayDuration={0}>
          <SidebarProvider className="h-svh">
            <Sidebar collapsible="icon">
              <SidebarBrand />
              <SidebarContent className="overflow-hidden">
                <SidebarGroup>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      <SidebarMenuItem>
                        <SidebarMenuButton aria-label="Inspiration" tooltip="Inspiration">
                          <HomeIcon />
                          <span className="group-data-[collapsible=icon]:hidden">Inspiration</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                      <SidebarMenuItem>
                        <SidebarMenuButton aria-label="Assets" tooltip="Assets">
                          <ImagesIcon />
                          <span className="group-data-[collapsible=icon]:hidden">Assets</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
                <SidebarSeparator />
                <CreationSessionNavigationSidebar onOpenCreation={() => undefined} />
              </SidebarContent>
            </Sidebar>
            <SidebarInset>
              <div className="flex flex-1 flex-col overflow-auto" data-testid="shell-content">
                <CreationWorkbenchPage />
              </div>
            </SidebarInset>
          </SidebarProvider>
        </TooltipProvider>
      </RuntimeWorkbenchScope>
    </I18nextProvider>
  )
}
