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
 * Scroll-contract story: the page under the real App Shell geometry and the
 * REAL stylesheet. Unlike the other stories, this module imports
 * app/globals.css so Tailwind utilities actually apply — the default CT
 * environment ships no CSS at all, which would make every layout assertion
 * here meaningless. Keep this file out of specs that must stay CSS-less.
 *
 * The sidebar chrome below mirrors app/shell/app-shell.tsx: the real
 * SidebarBrand slot, the primary navigation group, and the Creation session
 * navigation. The real AppShell itself is not CT-mountable because of its
 * authentication providers, so anyone changing that shell's sidebar structure
 * has to change this mirror too. The shell's footer and rail stay out: the
 * footer needs the authentication session, and a second `Toggle sidebar`
 * control would make the story's own toggle ambiguous by role and name.
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
