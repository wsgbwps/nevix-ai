import { createFileRoute } from '@tanstack/react-router'
import {
  InspirationPrototypePage,
  PROTOTYPE_VARIANTS,
  type PrototypeVariant
} from '../../features/creation'
import { AppShell } from '../shell/app-shell'

export const Route = createFileRoute('/inspiration-prototype')({
  validateSearch: (search: Record<string, unknown>): { variant: PrototypeVariant } => ({
    variant: PROTOTYPE_VARIANTS.includes(search.variant as PrototypeVariant)
      ? (search.variant as PrototypeVariant)
      : 'A'
  }),
  component: InspirationPrototypeRoute
})

function InspirationPrototypeRoute(): React.JSX.Element {
  const { variant } = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <AppShell>
      <InspirationPrototypePage
        variant={variant}
        onVariantChange={(nextVariant) =>
          void navigate({ search: { variant: nextVariant }, replace: true })
        }
      />
    </AppShell>
  )
}
