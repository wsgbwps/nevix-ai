import { I18nextProvider } from 'react-i18next'
import '../../../src/renderer/src/app/globals.css'
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger
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
 * here meaningless. Keep this file out of specs that must stay CSS-less, and
 * keep the mirrored header-free shell structure in sync with
 * app/shell/app-shell.tsx; the real AppShell itself is not CT-mountable
 * because of its authentication providers.
 */
export function CreationWorkbenchRealShellStory(options: StoryOptions = {}): React.JSX.Element {
  return (
    <I18nextProvider i18n={testI18n}>
      <RuntimeWorkbenchScope options={options}>
        <TooltipProvider delayDuration={0}>
          <SidebarProvider className="h-svh">
            <Sidebar collapsible="icon">
              <SidebarHeader>
                <SidebarTrigger aria-label="Toggle sidebar" />
              </SidebarHeader>
              <SidebarContent className="overflow-hidden">
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
