import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { InspirationPage, useCreationRuntime } from '../../features/creation'
import { AppShell } from '../shell/app-shell'

export const Route = createFileRoute('/')({
  component: InspirationRoute
})

function InspirationRoute(): React.JSX.Element | null {
  const runtime = useCreationRuntime()
  const navigate = useNavigate()
  if (!runtime) return null
  return (
    <AppShell>
      <InspirationPage
        ports={runtime}
        onCreateSimilar={async (publicationId) => {
          const result = await runtime.actions.preparePublicationSimilar(publicationId)
          if (result === 'prepared') void navigate({ to: '/creation' })
          return result
        }}
      />
    </AppShell>
  )
}
