import { createContext, useContext } from 'react'
import {
  type CreationSessionNavigationController,
  type CreationSessionNavigationSnapshot
} from './creation-session-navigation-controller'

export interface CreationSessionNavigation extends CreationSessionNavigationSnapshot {
  readonly reload: () => void
  readonly selectSession: CreationSessionNavigationController['selectSession']
  readonly adoptSession: CreationSessionNavigationController['adoptSession']
  readonly openPendingDraft: CreationSessionNavigationController['openPendingDraft']
  readonly startNewDraft: CreationSessionNavigationController['startNewDraft']
  readonly deleteSession: CreationSessionNavigationController['deleteSession']
  readonly renameSession: CreationSessionNavigationController['renameSession']
}

export const CreationSessionNavigationContext = createContext<CreationSessionNavigation | null>(
  null
)

export function useCreationSessionNavigation(): CreationSessionNavigation | null {
  return useContext(CreationSessionNavigationContext)
}
