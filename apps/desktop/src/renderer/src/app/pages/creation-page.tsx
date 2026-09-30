import { CreationWorkbenchPage, useCreationRuntime } from '../../features/creation'
import { useRouterState } from '@tanstack/react-router'
import { AppShell } from '../shell/app-shell'

/**
 * App-layer composition for the AI Creation route. The runtime lives above
 * routing so ordinary navigation cannot retire business actions.
 */
export function CreationPage(): React.JSX.Element | null {
  const runtime = useCreationRuntime()
  const hash = useRouterState({ select: (state) => state.location.hash })
  if (runtime === null) {
    // The root route navigates to the matching boundary surface; render nothing here.
    return null
  }

  return (
    <AppShell>
      <CreationWorkbenchPage initialTaskId={hash.startsWith('task-') ? hash.slice(5) : undefined} />
    </AppShell>
  )
}
