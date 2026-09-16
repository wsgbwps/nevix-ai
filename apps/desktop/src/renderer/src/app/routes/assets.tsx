import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { AssetLibraryPage, useCreationRuntime } from '../../features/creation'
import { AppShell } from '../shell/app-shell'

export const Route = createFileRoute('/assets')({
  component: AssetsRoute
})

function AssetsRoute(): React.JSX.Element | null {
  const runtime = useCreationRuntime()
  const navigate = useNavigate()
  if (runtime === null) return null
  return (
    <AppShell>
      <AssetLibraryPage
        ports={runtime}
        onCreateSimilar={(origin, replaceExisting) => {
          const result = runtime.actions.prepareSimilarDraft(origin, replaceExisting)
          if (result === 'prepared') void navigate({ to: '/creation' })
          return result
        }}
      />
    </AppShell>
  )
}
