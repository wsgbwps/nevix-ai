import { createFileRoute } from '@tanstack/react-router'
import { CreationWorkbenchPrototype } from '../../features/creation'
import { AppShell } from '../shell/app-shell'

function CreationWorkbenchPrototypePage(): React.JSX.Element {
  return (
    <AppShell>
      <CreationWorkbenchPrototype />
    </AppShell>
  )
}

export const Route = createFileRoute('/')({
  component: CreationWorkbenchPrototypePage
})
