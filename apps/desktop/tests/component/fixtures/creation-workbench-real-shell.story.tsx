import { I18nextProvider } from 'react-i18next'
import '../../../src/renderer/src/app/globals.css'
import { SidebarInset, SidebarProvider } from '../../../src/renderer/src/components/ui/sidebar'
import { testI18n } from './creation-workbench-i18n'
import { RuntimeWorkbenchPage, type StoryOptions } from './creation-workbench.story'

/**
 * Scroll-contract story: the page under the real App Shell geometry and the
 * REAL stylesheet. Unlike the other stories, this module imports
 * app/globals.css so Tailwind utilities actually apply — the default CT
 * environment ships no CSS at all, which would make every layout assertion
 * here meaningless. Keep this file out of specs that must stay CSS-less, and
 * keep the mirrored shell structure (provider `h-svh`, h-16 header, content
 * area) in sync with app/shell/app-shell.tsx; the real AppShell itself is
 * not CT-mountable because of its authentication providers.
 */
export function CreationWorkbenchRealShellStory(options: StoryOptions = {}): React.JSX.Element {
  return (
    <I18nextProvider i18n={testI18n}>
      <SidebarProvider className="h-svh">
        <SidebarInset>
          <div className="flex h-16 shrink-0" aria-hidden />
          <div className="flex flex-1 flex-col overflow-auto" data-testid="shell-content">
            <RuntimeWorkbenchPage options={options} />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </I18nextProvider>
  )
}
