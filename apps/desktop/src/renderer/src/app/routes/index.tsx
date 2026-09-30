import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  InspirationPage,
  useCreationRuntime,
  useOpenCreationSession
} from '../../features/creation'
import { AppShell } from '../shell/app-shell'

export const Route = createFileRoute('/')({
  component: InspirationRoute
})

function InspirationRoute(): React.JSX.Element | null {
  const runtime = useCreationRuntime()
  const openSession = useOpenCreationSession()
  const navigate = useNavigate()
  if (!runtime) return null
  return (
    <AppShell>
      <InspirationPage
        ports={runtime}
        ownAssetPorts={runtime}
        currentUserId={runtime.userId}
        onOpenSource={
          openSession
            ? (origin) => {
                void openSession(origin.sessionId).then((opened) => {
                  if (opened) void navigate({ to: '/creation', hash: `task-${origin.taskId}` })
                })
              }
            : undefined
        }
        onCreateSimilar={async (publicationId) => {
          const result = await runtime.actions.preparePublicationSimilar(publicationId)
          if (result === 'prepared') void navigate({ to: '/creation' })
          return result
        }}
      />
    </AppShell>
  )
}
