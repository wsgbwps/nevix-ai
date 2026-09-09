import { createRootRoute } from '@tanstack/react-router'
import { StartupCoordinator } from '../startup-coordinator'

export const Route = createRootRoute({
  component: StartupCoordinator
})
