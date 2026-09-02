/**
 * Generation Task half of the trusted data plane (contracts/creation.yaml,
 * issue #159). Shares the request helper and failure mapping with the
 * session/material client so a rejection can never be read as a success; the
 * SSE stream is a fetch-stream with the bearer in the header (never the URL)
 * and no Last-Event-ID semantics — a lost stream is answered by a refetch.
 */
import type { CreationApiResult } from './go-creation-http'
import { request } from './go-creation-http'

/** One generation task's one-way status (contracts GenerationTask.status). */
export type GenerationTaskStatus =
  | 'queued'
  | 'submitting'
  | 'processing'
  | 'persisting'
  | 'cancelling'
  | 'succeeded'
  | 'partially_succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'

const TERMINAL_TASK_STATUSES: ReadonlySet<GenerationTaskStatus> = new Set<GenerationTaskStatus>([
  'succeeded',
  'partially_succeeded',
  'failed',
  'cancelled',
  'timed_out'
])

export function isTerminalTaskStatus(status: GenerationTaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status)
}

/** Stable failure taxonomy attached to a settled slot. */
export type SlotFailureReason =
  | 'invalid_input'
  | 'rights_confirmation_required'
  | 'input_policy_rejected'
  | 'output_policy_rejected'
  | 'action_required'
  | 'temporarily_unavailable'
  | 'provider_route_unavailable'
  | 'processing_indeterminate'
  | 'internal_error'

export type SlotFailureDiagnosticSource = 'provider' | 'output_transfer' | 'storage' | 'media_probe'

/** Concrete creator-private explanation for one stable slot verdict. */
export interface SlotFailureDiagnostic {
  readonly source: SlotFailureDiagnosticSource
  readonly code: string
  readonly message: string
  readonly httpStatus: number | null
  readonly providerType: string | null
  readonly requestId: string | null
}

/** One result slot: a derived projection until a terminal verdict lands. */
export interface GenerationSlotView {
  readonly index: number
  readonly status: string
  readonly failureReason: SlotFailureReason | null
  readonly failureDiagnostic?: SlotFailureDiagnostic | null
  readonly result: SlotResultView | null
}

export interface SlotResultView {
  readonly mimeType: string
  readonly byteSize: number
  readonly checksumSha256: string
  readonly widthPx: number | null
  readonly heightPx: number | null
  readonly durationMs: number | null
}

export interface GenerationTaskView {
  readonly id: string
  readonly sessionId: string
  readonly status: GenerationTaskStatus
  readonly mediaType: 'image' | 'video'
  readonly slotCount: number
  readonly cancelRequested: boolean
  readonly terminalCause: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly terminalAt: string | null
}

export interface GenerationTaskDetail {
  readonly task: GenerationTaskView
  readonly slots: readonly GenerationSlotView[]
}

export interface TaskPage {
  readonly tasks: readonly GenerationTaskView[]
  readonly nextCursor: string | null
}

/** TaskSubmitInput on the wire: key + the draft revision the submitter saw. */
export interface TaskSubmitInput {
  readonly idempotencyKey: string
  readonly draftRevision: string
}

// --- parsing (fail closed, mirroring the sibling clients) --------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function str(source: unknown, field: string): string | null {
  if (isRecord(source)) {
    const value = source[field]
    if (typeof value === 'string') return value
  }
  return null
}

function nullableStr(source: unknown, field: string): string | null | undefined {
  if (!isRecord(source) || !(field in source)) return undefined
  const value = source[field]
  if (value === null) return null
  return typeof value === 'string' ? value : undefined
}

function nullableNum(source: unknown, field: string): number | null | undefined {
  if (!isRecord(source) || !(field in source)) return undefined
  const value = source[field]
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const TASK_STATUSES: readonly GenerationTaskStatus[] = [
  'queued',
  'submitting',
  'processing',
  'persisting',
  'cancelling',
  'succeeded',
  'partially_succeeded',
  'failed',
  'cancelled',
  'timed_out'
]

function parseTask(payload: unknown): GenerationTaskView | null {
  const id = str(payload, 'id')
  const sessionId = str(payload, 'session_id')
  const statusRaw = str(payload, 'status')
  const mediaType = str(payload, 'media_type')
  const createdAt = str(payload, 'created_at')
  const updatedAt = str(payload, 'updated_at')
  if (!id || !sessionId || !createdAt || !updatedAt) return null
  if (statusRaw === null || !TASK_STATUSES.includes(statusRaw as GenerationTaskStatus)) return null
  if (mediaType !== 'image' && mediaType !== 'video') return null
  const slotCountRaw = nullableNum(payload, 'slot_count')
  if (slotCountRaw === undefined || slotCountRaw === null || slotCountRaw < 1) return null
  const cancelRaw = isRecord(payload) ? payload['cancel_requested'] : undefined
  if (typeof cancelRaw !== 'boolean') return null
  return {
    id,
    sessionId,
    status: statusRaw as GenerationTaskStatus,
    mediaType,
    slotCount: slotCountRaw,
    cancelRequested: cancelRaw,
    terminalCause: nullableStr(payload, 'terminal_cause') ?? null,
    createdAt,
    updatedAt,
    terminalAt: nullableStr(payload, 'terminal_at') ?? null
  }
}

const SLOT_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'invalid_input',
  'rights_confirmation_required',
  'input_policy_rejected',
  'output_policy_rejected',
  'action_required',
  'temporarily_unavailable',
  'provider_route_unavailable',
  'processing_indeterminate',
  'internal_error'
])

const SLOT_FAILURE_DIAGNOSTIC_SOURCES: ReadonlySet<string> = new Set([
  'provider',
  'output_transfer',
  'storage',
  'media_probe'
])

function codePointLength(value: string): number {
  return [...value].length
}

function parseFailureDiagnostic(payload: unknown): SlotFailureDiagnostic | null {
  if (!isRecord(payload)) return null
  const source = str(payload, 'source')
  const code = str(payload, 'code')
  const message = str(payload, 'message')
  if (
    source === null ||
    !SLOT_FAILURE_DIAGNOSTIC_SOURCES.has(source) ||
    code === null ||
    codePointLength(code) < 1 ||
    codePointLength(code) > 128 ||
    message === null ||
    codePointLength(message) < 1 ||
    codePointLength(message) > 2000
  ) {
    return null
  }
  const httpStatus = nullableNum(payload, 'http_status')
  const providerType = nullableStr(payload, 'provider_type')
  const requestId = nullableStr(payload, 'request_id')
  if (
    httpStatus === undefined ||
    (httpStatus !== null &&
      (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) ||
    providerType === undefined ||
    (providerType !== null &&
      (codePointLength(providerType) < 1 || codePointLength(providerType) > 128)) ||
    requestId === undefined ||
    (requestId !== null && (codePointLength(requestId) < 1 || codePointLength(requestId) > 256))
  ) {
    return null
  }
  return {
    source: source as SlotFailureDiagnosticSource,
    code,
    message,
    httpStatus,
    providerType,
    requestId
  }
}

function parseSlot(payload: unknown): GenerationSlotView | null {
  const indexRaw = nullableNum(payload, 'index')
  const status = str(payload, 'status')
  if (indexRaw === null || indexRaw === undefined || status === null) return null
  const reasonRaw = nullableStr(payload, 'failure_reason')
  if (reasonRaw === undefined) return null
  if (reasonRaw !== null && !SLOT_FAILURE_REASONS.has(reasonRaw)) return null
  const reason = reasonRaw as SlotFailureReason | null
  let failureDiagnostic: SlotFailureDiagnostic | null = null
  if (isRecord(payload) && 'failure_diagnostic' in payload) {
    const rawDiagnostic = payload['failure_diagnostic']
    if (rawDiagnostic !== null) {
      failureDiagnostic = parseFailureDiagnostic(rawDiagnostic)
      if (failureDiagnostic === null) return null
    }
  }
  let result: SlotResultView | null = null
  const rawResult = isRecord(payload) && 'result' in payload ? payload['result'] : undefined
  if (rawResult !== undefined && rawResult !== null) {
    const mimeType = str(rawResult, 'mime_type')
    const checksum = str(rawResult, 'checksum_sha256')
    const byteSize = nullableNum(rawResult, 'byte_size')
    if (!mimeType || !checksum || byteSize === null || byteSize === undefined) return null
    result = {
      mimeType,
      checksumSha256: checksum,
      byteSize,
      widthPx: nullableNum(rawResult, 'width_px') ?? null,
      heightPx: nullableNum(rawResult, 'height_px') ?? null,
      durationMs: nullableNum(rawResult, 'duration_ms') ?? null
    }
  }
  return { index: indexRaw, status, failureReason: reason, failureDiagnostic, result }
}

function parseTaskDetail(payload: unknown): GenerationTaskDetail | null {
  if (!isRecord(payload) || !('task' in payload) || !('slots' in payload)) return null
  const task = parseTask(payload['task'])
  if (task === null) return null
  const rawSlots = payload['slots']
  if (!Array.isArray(rawSlots)) return null
  const slots: GenerationSlotView[] = []
  for (const entry of rawSlots) {
    const slot = parseSlot(entry)
    if (slot === null) return null
    slots.push(slot)
  }
  return { task, slots }
}

function parseTaskPage(payload: unknown): TaskPage | null {
  if (!isRecord(payload) || !Array.isArray(payload['tasks'])) return null
  const tasks: GenerationTaskView[] = []
  for (const entry of payload['tasks']) {
    const task = parseTask(entry)
    if (task === null) return null
    tasks.push(task)
  }
  const nextCursor = payload['next_cursor']
  return { tasks, nextCursor: typeof nextCursor === 'string' ? nextCursor : null }
}

/**
 * Creates the generation-task client over one configured server URL. Paths
 * mirror contracts/creation.yaml exactly; parsing fails closed.
 */
export function createGenerationTaskClient(serverUrl: string): {
  submitTask(
    token: string,
    sessionId: string,
    input: TaskSubmitInput
  ): Promise<CreationApiResult<GenerationTaskDetail>>
  listTasks(token: string, sessionId: string): Promise<CreationApiResult<TaskPage>>
  getTask(token: string, taskId: string): Promise<CreationApiResult<GenerationTaskDetail>>
  cancelTask(token: string, taskId: string): Promise<CreationApiResult<GenerationTaskDetail>>
  retryTask(
    token: string,
    taskId: string,
    idempotencyKey: string
  ): Promise<CreationApiResult<GenerationTaskDetail>>
  loadResultBlobUrl(token: string, taskId: string, slotIndex: number): Promise<string | null>
} {
  async function detailOf(
    result: Awaited<ReturnType<typeof request>>
  ): Promise<CreationApiResult<GenerationTaskDetail>> {
    if (result.outcome !== 'succeeded') return result
    const detail = parseTaskDetail(result.payload)
    return detail ? { outcome: 'succeeded', value: detail } : { outcome: 'network-failure' }
  }

  return {
    submitTask: (token, sessionId, input) =>
      request(serverUrl, {
        method: 'POST',
        path: `/creation/sessions/${sessionId}/tasks`,
        body: { idempotency_key: input.idempotencyKey, draft_revision: input.draftRevision },
        token
      }).then(detailOf),
    listTasks: async (token, sessionId) => {
      const result = await request(serverUrl, {
        method: 'GET',
        path: `/creation/sessions/${sessionId}/tasks`,
        query: { limit: '50' },
        token
      })
      if (result.outcome !== 'succeeded') return result
      const page = parseTaskPage(result.payload)
      return page ? { outcome: 'succeeded', value: page } : { outcome: 'network-failure' }
    },
    getTask: async (token, taskId) =>
      detailOf(
        await request(serverUrl, { method: 'GET', path: `/creation/tasks/${taskId}`, token })
      ),
    cancelTask: async (token, taskId) =>
      detailOf(
        await request(serverUrl, {
          method: 'POST',
          path: `/creation/tasks/${taskId}/cancel`,
          token
        })
      ),
    retryTask: async (token, taskId, idempotencyKey) =>
      detailOf(
        await request(serverUrl, {
          method: 'POST',
          path: `/creation/tasks/${taskId}/retry`,
          body: { idempotency_key: idempotencyKey },
          token
        })
      ),
    loadResultBlobUrl: async (token, taskId, slotIndex) => {
      const url = new URL(`/creation/tasks/${taskId}/slots/${slotIndex}/result`, serverUrl)
      let response: Response
      try {
        response = await fetch(url, {
          redirect: 'error',
          headers: { Authorization: `Bearer ${token}` }
        })
      } catch {
        return null
      }
      if (!response.ok) return null
      const blob = await response.blob().catch(() => null)
      return blob ? URL.createObjectURL(blob) : null
    }
  }
}

/**
 * Opens the creator-scoped SSE invalidation stream. The bearer rides the
 * Authorization header; there is no Last-Event-ID — the hook answers a lost
 * stream with a refetch and polling convergence. `onInvalidation` fires on
 * each invalidation block; `onStateChange` mirrors liveness so the caller can
 * fall back to polling while the stream is down.
 */
export function openCreationEventStream(
  serverUrl: string,
  acquireToken: () => Promise<string | null>,
  handlers: { onInvalidation: () => void; onStateChange: (live: boolean) => void }
): () => void {
  let disposed = false
  let controller: AbortController | null = null

  void (async () => {
    while (!disposed) {
      const token = await acquireToken()
      if (disposed) return
      if (token === null) {
        handlers.onStateChange(false)
        await new Promise((resolve) => setTimeout(resolve, 2000))
        continue
      }
      controller = new AbortController()
      try {
        const response = await fetch(new URL('/creation/events', serverUrl), {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          signal: controller.signal
        })
        if (!response.ok || !response.body) {
          handlers.onStateChange(false)
          await new Promise((resolve) => setTimeout(resolve, 2000))
          continue
        }
        handlers.onStateChange(true)
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffered = ''
        let sawInvalidation = false
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffered += decoder.decode(value, { stream: true })
          let newline = buffered.indexOf('\n')
          while (newline !== -1) {
            const line = buffered.slice(0, newline).trimEnd()
            buffered = buffered.slice(newline + 1)
            if (line === '') {
              // A blank line terminates one SSE block.
              if (sawInvalidation) {
                sawInvalidation = false
                handlers.onInvalidation()
              }
            } else if (line.startsWith('event: creation-invalidation')) {
              sawInvalidation = true
            }
            newline = buffered.indexOf('\n')
          }
        }
        handlers.onStateChange(false)
      } catch {
        if (disposed) return
        handlers.onStateChange(false)
      }
      if (disposed) return
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  })()

  return () => {
    disposed = true
    controller?.abort()
  }
}
