import { createContext, useContext } from 'react'
import type { CreationRuntime as ActiveCreationRuntime } from './workbench-runtime'

/**
 * The renderer-document Creation runtime context. Only the Creation-owned
 * reader touches it; app composition mounts `CreationRuntimeProvider` above
 * the router so route unmounts cannot retire business
 * actions. `null` means no connected session — the page renders nothing while
 * the root route navigates.
 *
 * `userId` scopes the device-local Draft store to the connected account
 * (ADR-0017): drafts are per-device AND per-account, never shared across
 * sign-ins on one machine.
 */
export type CreationRuntime = ActiveCreationRuntime | null

export const CreationRuntimeContext = createContext<CreationRuntime>(null)

export function useCreationRuntime(): CreationRuntime {
  return useContext(CreationRuntimeContext)
}
