import type { SlotFailureDiagnosticSource, SlotFailureReason } from '../api/generation-task-http'

// Dynamic verdict vocabularies resolve through explicit key maps — the same
// shape the composer uses for wire codes.
const statusKeys = {
  queued: 'gallery.status.queued',
  generating: 'gallery.status.generating',
  persisting: 'gallery.status.persisting',
  cancelling: 'gallery.status.cancelling',
  succeeded: 'gallery.status.succeeded',
  partially_succeeded: 'gallery.status.partially_succeeded',
  failed: 'gallery.status.failed',
  cancelled: 'gallery.status.cancelled',
  timed_out: 'gallery.status.timed_out',
  indeterminate: 'gallery.status.indeterminate'
} as const

const reasonKeys = {
  invalid_input: 'gallery.reasons.invalid_input',
  rights_confirmation_required: 'gallery.reasons.rights_confirmation_required',
  input_policy_rejected: 'gallery.reasons.input_policy_rejected',
  output_policy_rejected: 'gallery.reasons.output_policy_rejected',
  action_required: 'gallery.reasons.action_required',
  temporarily_unavailable: 'gallery.reasons.temporarily_unavailable',
  provider_route_unavailable: 'gallery.reasons.provider_route_unavailable',
  processing_indeterminate: 'gallery.reasons.processing_indeterminate',
  internal_error: 'gallery.reasons.internal_error'
} as const

export function statusKey(status: string): (typeof statusKeys)[keyof typeof statusKeys] {
  return status in statusKeys ? statusKeys[status as keyof typeof statusKeys] : statusKeys.failed
}

export function reasonKey(reason: SlotFailureReason): (typeof reasonKeys)[keyof typeof reasonKeys] {
  return reason in reasonKeys ? reasonKeys[reason] : reasonKeys.internal_error
}

const diagnosticSourceKeys = {
  provider: 'gallery.diagnostic.sources.provider',
  output_transfer: 'gallery.diagnostic.sources.output_transfer',
  storage: 'gallery.diagnostic.sources.storage',
  media_probe: 'gallery.diagnostic.sources.media_probe'
} as const

export function diagnosticSourceKey(
  source: SlotFailureDiagnosticSource
): (typeof diagnosticSourceKeys)[keyof typeof diagnosticSourceKeys] {
  return diagnosticSourceKeys[source]
}
