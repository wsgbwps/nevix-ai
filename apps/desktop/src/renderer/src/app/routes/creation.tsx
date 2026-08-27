import { createFileRoute } from '@tanstack/react-router'
import { CreationPage } from '../pages/creation-page'

export const Route = createFileRoute('/creation')({
  component: CreationPage
})
