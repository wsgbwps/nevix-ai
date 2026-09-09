import { useAuthenticationRuntimeContext } from './runtime-context'

/** One in-memory fact published only by a successful Instance Claim. */
export interface InstanceClaimAcquisition {
  readonly pending: boolean
  readonly consume: () => void
}

export function useInstanceClaimAcquisition(): InstanceClaimAcquisition {
  const runtime = useAuthenticationRuntimeContext()
  return {
    pending: runtime.instanceClaimAcquisitionPending,
    consume: runtime.consumeInstanceClaimAcquisition
  }
}
