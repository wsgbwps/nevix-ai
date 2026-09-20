import { createContext, useContext } from 'react'
import type { CreationRuntime as ActiveCreationRuntime } from './workbench-runtime'

/**
 * The renderer-document Creation runtime context, touched only by the Creation-owned reader.
 * `CreationRuntimeProvider` mounts above the router so route unmounts cannot retire business
 * actions; `null` means no connected session, and the page renders nothing while the root route
 * navigates. `userId` scopes the device-local Draft store to the connected account (ADR-0017):
 * per-device AND per-account, never shared across sign-ins.
 */
export type CreationRuntime = ActiveCreationRuntime | null

export const CreationRuntimeContext = createContext<CreationRuntime>(null)

export function useCreationRuntime(): CreationRuntime {
  return useContext(CreationRuntimeContext)
}
