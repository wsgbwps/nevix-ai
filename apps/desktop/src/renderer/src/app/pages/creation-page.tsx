import { CreationWorkbenchPage, useCreationRuntime } from '../../features/creation'
import { AppShell } from '../shell/app-shell'

/**
 * App-layer composition for the AI Creation route. The runtime lives above
 * routing so ordinary navigation cannot retire business actions.
 */
export function CreationPage(): React.JSX.Element | null {
  const runtime = useCreationRuntime()
  if (runtime === null) {
    // The root route navigates to the matching boundary surface; render nothing here.
    return null
  }

  return (
    <AppShell>
      <CreationWorkbenchPage />
    </AppShell>
  )
}
