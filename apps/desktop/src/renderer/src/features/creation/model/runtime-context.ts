import { createContext, useContext } from 'react'
import type { CreationWorkspacePorts } from './ports'

/**
 * The renderer-document Creation runtime context. Only the Creation-owned
 * reader touches it; app composition supplies the provider around the
 * Workbench page (`CreationRuntimeContext.Provider`). `null` means no
 * connected session — the page renders nothing while the root route
 * navigates.
 *
 * `userId` scopes the device-local Draft store to the connected account
 * (ADR-0017): drafts are per-device AND per-account, never shared across
 * sign-ins on one machine.
 */
export type CreationRuntime = (CreationWorkspacePorts & { readonly userId: string }) | null

export const CreationRuntimeContext = createContext<CreationRuntime>(null)

export function useCreationRuntime(): CreationRuntime {
  return useContext(CreationRuntimeContext)
}
