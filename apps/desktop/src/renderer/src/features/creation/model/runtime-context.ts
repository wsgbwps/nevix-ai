import { createContext, useContext } from 'react'
import type { CreationWorkspacePorts } from './ports'

/**
 * The renderer-document Creation runtime context. Only the Creation-owned
 * reader touches it; app composition supplies the provider around the
 * Workbench page (`CreationRuntimeContext.Provider`). `null` means no
 * connected session — the page renders nothing while the root route
 * navigates.
 */
export type CreationRuntime = CreationWorkspacePorts | null

export const CreationRuntimeContext = createContext<CreationRuntime>(null)

export function useCreationRuntime(): CreationRuntime {
  return useContext(CreationRuntimeContext)
}
