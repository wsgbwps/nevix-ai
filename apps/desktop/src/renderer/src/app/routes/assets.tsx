import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  AssetLibraryPage,
  useCreationRuntime,
  useOpenCreationSession
} from '../../features/creation'
import { AppShell } from '../shell/app-shell'

export const Route = createFileRoute('/assets')({
  component: AssetsRoute
})

function AssetsRoute(): React.JSX.Element | null {
  const runtime = useCreationRuntime()
  const openSession = useOpenCreationSession()
  const navigate = useNavigate()
  if (runtime === null) return null
  return (
    <AppShell>
      <AssetLibraryPage
        ports={runtime}
        loadReferencePreview={async (materialId) => {
          const result = await runtime.loadPreviewUrl(materialId)
          return result.outcome === 'succeeded' ? result.value : null
        }}
        onOpenOrigin={
          openSession
            ? (origin) => {
                void openSession(origin.sessionId).then((opened) => {
                  if (opened) void navigate({ to: '/creation', hash: `task-${origin.taskId}` })
                })
              }
            : undefined
        }
        onCreateSimilar={(origin, replaceExisting) => {
          const result = runtime.actions.prepareSimilarDraft(origin, replaceExisting)
          if (result === 'prepared') void navigate({ to: '/creation' })
          return result
        }}
      />
    </AppShell>
  )
}
