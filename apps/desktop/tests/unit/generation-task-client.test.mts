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

/** A minimal detail whose specification varies per case; `undefined` omits the key. */
function specDetail(specification: unknown): unknown {
  return {
    task: {
      id: 'dddddddd-0000-4000-8000-000000000004',
      session_id: 'aaaaaaaa-0000-4000-8000-000000000001',
      status: 'succeeded',
      media_type: 'image',
      slot_count: 1,
      cancel_requested: false,
      terminal_cause: null,
      created_at: '2026-09-01T02:59:32Z',
      updated_at: '2026-09-01T03:00:00Z',
      terminal_at: '2026-09-01T03:00:00Z'
    },
    slots: [{ index: 0, status: 'succeeded', failure_reason: null, result: null }],
    ...(specification === undefined ? {} : { specification })
  }
}

const frozenSpecification = {
  schema_version: 1,
  media_type: 'image',
  prompt: '夏季跑鞋主图，暖光背景',
  model: 'doubao-seedream-5.0-pro',
  mode: 'reference-image',
  manifest_version: 3,
  ratio: '7:3',
  resolution: '2K',
  quantity: 2,
  duration_seconds: null,
  references: [
    {
      material_id: 'cccccccc-0000-4000-8000-000000000003',
      role: 'reference',
      kind: 'image',
      claims_version: 1
    }
  ]
}

test('the frozen specification rides the detail into the gallery view', async () => {
  const client = createGenerationTaskClient(serverUrl)
  const result = await withFetch(specDetail(frozenSpecification), () =>
    client.getTask('token', 'dddddddd-0000-4000-8000-000000000004')
  )

  assert.equal(result.outcome, 'succeeded')
  if (result.outcome !== 'succeeded') return
  assert.deepEqual(result.value.specification, {
    prompt: '夏季跑鞋主图，暖光背景',
    model: 'doubao-seedream-5.0-pro',
    mode: 'reference-image',
    ratio: '7:3',
    resolution: '2K',
    quantity: 2,
    durationSeconds: null,
    references: [
      { materialId: 'cccccccc-0000-4000-8000-000000000003', role: 'reference', kind: 'image' }
    ]
  })
})

test('a detail without a specification keeps parsing with a null freeze', async () => {
  const client = createGenerationTaskClient(serverUrl)
  for (const payload of [specDetail(undefined), specDetail(null)]) {
    const result = await withFetch(payload, () =>
      client.getTask('token', 'dddddddd-0000-4000-8000-000000000004')
    )
    assert.equal(result.outcome, 'succeeded')
    if (result.outcome !== 'succeeded') return
    assert.equal(result.value.specification, null)
  }
})

test('a malformed specification fails the whole detail closed', async () => {
  const client = createGenerationTaskClient(serverUrl)
  for (const malformed of [
    { ...frozenSpecification, prompt: undefined },
    {
      ...frozenSpecification,
      references: [
        {
          material_id: 'cccccccc-0000-4000-8000-000000000003',
          role: 'reference',
          kind: 'vibration',
          claims_version: 1
        }
      ]
    }
  ]) {
    const result = await withFetch(specDetail(malformed), () =>
      client.getTask('token', 'dddddddd-0000-4000-8000-000000000004')
    )
    assert.equal(result.outcome, 'network-failure')
  }
})

test('submitTask posts the idempotency key with the full generation intent', async () => {
  const calls: Array<{ method: string; url: string; bearer: string | null; body: string | null }> =
    []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (rawInput, init) => {
    const request = new Request(rawInput as RequestInfo | URL, init)
    const url = new URL(request.url)
    calls.push({
      method: request.method,
      url: url.pathname,
      bearer: request.headers.get('Authorization'),
      body: init?.body == null ? null : String(init.body)
    })
    return new Response(JSON.stringify(failedTask(null)), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    })
  }
  try {
    const client = createGenerationTaskClient(serverUrl)
    const result = await client.submitTask('token-1', 'aaaaaaaa-0000-4000-8000-000000000001', {
      idempotencyKey: 'key-1',
      intent: {
        prompt: '暖光跑鞋',
        mediaType: 'image',
        manifestVersion: 5,
        model: 'doubao-seedream-5.0-pro',
        mode: 'reference-image',
        ratio: '4:5',
        resolution: '2K',
        quantity: 2,
        durationSeconds: null,
        references: [
          { materialId: 'cccccccc-0000-4000-8000-000000000003', role: 'reference' },
          { materialId: 'dddddddd-0000-4000-8000-000000000004', role: 'first_frame' }
        ]
      }
    })
    assert.equal(result.outcome, 'succeeded')
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].url, '/creation/sessions/aaaaaaaa-0000-4000-8000-000000000001/tasks')
  assert.equal(calls[0].bearer, 'Bearer token-1')
  assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), {
    idempotency_key: 'key-1',
    prompt: '暖光跑鞋',
    media_type: 'image',
    manifest_version: 5,
    model: 'doubao-seedream-5.0-pro',
    mode: 'reference-image',
    ratio: '4:5',
    resolution: '2K',
    quantity: 2,
    duration_seconds: null,
    references: [
      { material_id: 'cccccccc-0000-4000-8000-000000000003', role: 'reference' },
      { material_id: 'dddddddd-0000-4000-8000-000000000004', role: 'first_frame' }
    ]
  })
})
