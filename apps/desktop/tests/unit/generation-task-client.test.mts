import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    const isDesktopSource = context.parentURL?.includes('/apps/desktop/src/') === true
    const resolvedSpecifier =
      isDesktopSource && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)
        ? `${specifier}.ts`
        : specifier
    return nextResolve(resolvedSpecifier, context)
  }
})

const { createGenerationTaskClient } =
  await import('../../src/renderer/src/features/creation/api/generation-task-http.ts')

const serverUrl = 'https://server.example'

async function withFetch<T>(responseBody: unknown, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

function failedTask(diagnostic: unknown): unknown {
  return {
    task: {
      id: 'dddddddd-0000-4000-8000-00000000diag',
      session_id: 'aaaaaaaa-0000-4000-8000-000000000001',
      status: 'failed',
      media_type: 'image',
      slot_count: 1,
      cancel_requested: false,
      terminal_cause: null,
      created_at: '2026-09-01T02:59:32Z',
      updated_at: '2026-09-01T03:00:00Z',
      terminal_at: '2026-09-01T03:00:00Z'
    },
    slots: [
      {
        index: 0,
        status: 'failed',
        failure_reason: 'temporarily_unavailable',
        failure_diagnostic: diagnostic,
        result: null
      }
    ],
    specification: null
  }
}

test('task detail preserves a bounded concrete failure diagnostic', async () => {
  const client = createGenerationTaskClient(serverUrl)
  const result = await withFetch(
    failedTask({
      source: 'output_transfer',
      code: 'provider_output_http_status',
      message: 'Provider output download returned HTTP 403',
      http_status: 403,
      provider_type: null,
      request_id: null
    }),
    () => client.getTask('token', 'dddddddd-0000-4000-8000-00000000diag')
  )

  assert.equal(result.outcome, 'succeeded')
  if (result.outcome !== 'succeeded') return
  assert.deepEqual(result.value.slots[0].failureDiagnostic, {
    source: 'output_transfer',
    code: 'provider_output_http_status',
    message: 'Provider output download returned HTTP 403',
    httpStatus: 403,
    providerType: null,
    requestId: null
  })
})

test('malformed failure diagnostics fail closed instead of being displayed', async () => {
  const client = createGenerationTaskClient(serverUrl)
  const result = await withFetch(
    failedTask({
      source: 'output_transfer',
      code: '',
      message: 'unsafe malformed shape',
      http_status: 999,
      provider_type: null,
      request_id: null
    }),
    () => client.getTask('token', 'dddddddd-0000-4000-8000-00000000diag')
  )

  assert.equal(result.outcome, 'network-failure')
})

test('diagnostic limits count Unicode code points like Server and PostgreSQL', async () => {
  const client = createGenerationTaskClient(serverUrl)
  const message = '😀'.repeat(2000)
  const result = await withFetch(
    failedTask({
      source: 'provider',
      code: 'invalid_request_error',
      message,
      http_status: 400,
      provider_type: 'invalid_request_error',
      request_id: 'unicode-boundary'
    }),
    () => client.getTask('token', 'dddddddd-0000-4000-8000-00000000diag')
  )

  assert.equal(result.outcome, 'succeeded')
  if (result.outcome !== 'succeeded') return
  assert.equal(result.value.slots[0].failureDiagnostic?.message, message)
})
