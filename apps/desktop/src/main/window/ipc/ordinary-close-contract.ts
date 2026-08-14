import type { DecideOrdinaryCloseRequest } from '../../../shared/ipc/window/types'

export function parseOrdinaryCloseDecision(request: unknown): DecideOrdinaryCloseRequest {
  const keys = typeof request === 'object' && request !== null ? Object.keys(request) : []
  const value = request as { requestId?: unknown; decision?: unknown }
  if (
    keys.length !== 2 ||
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0 ||
    (value.decision !== 'allow' && value.decision !== 'cancel')
  ) {
    throw new Error('Ordinary close received an invalid decision payload')
  }
  return { requestId: value.requestId, decision: value.decision }
}
