import assert from 'node:assert/strict'
import test from 'node:test'
import { File } from 'node:buffer'
import { registerHooks } from 'node:module'
import type {
  CreationApiResult,
  ReferenceMaterialView
} from '../../src/renderer/src/features/creation/api/go-creation-http.ts'
import type {
  GenerationIntent,
  GenerationTaskDetail
} from '../../src/renderer/src/features/creation/api/generation-task-http.ts'
import type { CreationWorkspacePorts } from '../../src/renderer/src/features/creation/model/ports.ts'

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

const { createCreationRuntime } =
  await import('../../src/renderer/src/features/creation/model/workbench-runtime.ts')
const { readLocalDraft, writeLocalDraft } =
  await import('../../src/renderer/src/features/creation/model/draft-store.ts')

const sessionA = 'aaaaaaaa-0000-4000-8000-000000000001'
const localMaterial = 'local-material-1'
const realMaterial = 'cccccccc-0000-4000-8000-000000000003'

function fakeStorage(): Storage {
  const entries = new Map<string, string>()
  return {
    get length() {
      return entries.size
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => void entries.delete(key),
    setItem: (key, value) => void entries.set(key, value)
  } as Storage
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function uploadedMaterial(): ReferenceMaterialView {
  return {
    id: realMaterial,
    kind: 'image' as const,
    fileName: 'shoe.png',
    mimeType: 'image/png',
    byteSize: 4,
    widthPx: 10,
    heightPx: 10,
    pixelCount: 100,
    durationMs: null,
    checksumSha256: 'aa'.repeat(32),
    claimsVersion: 1,
    createdAt: '2026-09-05T00:00:00Z'
  }
}

function acceptedTask(sessionId: string, id: string): CreationApiResult<GenerationTaskDetail> {
  return {
    outcome: 'succeeded' as const,
    value: {
      task: {
        id,
        sessionId,
        status: 'queued' as const,
        mediaType: 'image' as const,
        slotCount: 1,
        cancelRequested: false,
        terminalCause: null,
        createdAt: '2026-09-05T00:00:00Z',
        updatedAt: '2026-09-05T00:00:00Z',
        terminalAt: null
      },
      slots: [],
      specification: null
    }
  }
}

const plainIntent = (prompt: string): GenerationIntent => ({
  prompt,
  mediaType: 'image' as const,
  manifestVersion: 5,
  model: 'doubao-seedream-5.0-pro',
  mode: 'text-to-image',
  ratio: '1:1',
  resolution: '2K',
  quantity: 1,
  durationSeconds: null,
  references: []
})

test('submission freezes intent before upload and resumes an unconfirmed write verbatim', async () => {
  const upload = deferred<unknown>()
  const submitResults = [{ outcome: 'network-failure' as const }, acceptedTask(sessionA, 'task-1')]
  const submitCalls: unknown[] = []
  const ports = {
    uploadMaterial: async () => upload.promise,
    submitTask: async (sessionId: string, input: unknown) => {
      submitCalls.push({ sessionId, input: structuredClone(input) })
      return submitResults.shift()
    }
  }
  let idCalls = 0
  const runtime = createCreationRuntime(ports, 'user-1', {
    createId: () => {
      idCalls += 1
      return 'submission-key-1'
    }
  })
  const file = new File(['shoe'], 'shoe.png', { type: 'image/png' })
  void runtime.actions.stageMaterial(sessionA, localMaterial, file)

  const mutableIntent = {
    prompt: 'Image 1 beside the original product',
    mediaType: 'image' as const,
    manifestVersion: 5,
    model: 'doubao-seedream-5.0-pro',
    mode: 'reference-image',
    ratio: '4:3',
    resolution: '2K',
    quantity: 1,
    durationSeconds: null,
    references: [{ materialId: localMaterial, role: 'reference' as const }]
  }
  const first = runtime.actions.submit(sessionA, mutableIntent)
  assert.equal(idCalls, 1)

  mutableIntent.prompt = '后来编辑的中文提示词'
  mutableIntent.references.reverse()
  upload.resolve({ outcome: 'succeeded', value: uploadedMaterial() })

  assert.equal(await first, 'unconfirmed')
  assert.deepEqual(runtime.actions.snapshot(sessionA), {
    status: 'submission-unconfirmed'
  })
  assert.equal(await runtime.actions.resumeSubmission(sessionA), 'accepted')
  assert.equal(runtime.actions.snapshot(sessionA).status, 'idle')
  assert.equal(submitCalls.length, 2)
  assert.deepEqual(submitCalls[1], submitCalls[0])
  assert.deepEqual(submitCalls[0], {
    sessionId: sessionA,
    input: {
      idempotencyKey: 'submission-key-1',
      intent: {
        prompt: 'Image 1 beside the original product',
        mediaType: 'image',
        manifestVersion: 5,
        model: 'doubao-seedream-5.0-pro',
        mode: 'reference-image',
        ratio: '4:3',
        resolution: '2K',
        quantity: 1,
        durationSeconds: null,
        references: [{ materialId: realMaterial, role: 'reference' }]
      }
    }
  })
})

test('one chain per context does not prevent another context from submitting', async () => {
  const sessionB = 'bbbbbbbb-0000-4000-8000-000000000002'
  const firstA = deferred<unknown>()
  const calls: string[] = []
  const ports = {
    submitTask: async (sessionId: string) => {
      calls.push(sessionId)
      return sessionId === sessionA ? firstA.promise : acceptedTask(sessionId, 'task-b')
    }
  }
  let nextId = 0
  const runtime = createCreationRuntime(ports, 'user-1', {
    createId: () => `submission-key-${++nextId}`
  })

  const a = runtime.actions.submit(sessionA, plainIntent('A'))
  assert.equal(await runtime.actions.submit(sessionA, plainIntent('duplicate A')), 'busy')
  assert.equal(await runtime.actions.submit(sessionB, plainIntent('B')), 'accepted')
  assert.deepEqual(calls, [sessionA, sessionB])

  firstA.resolve(acceptedTask(sessionA, 'task-a'))
  assert.equal(await a, 'accepted')
  assert.equal(runtime.actions.snapshot(sessionA).status, 'idle')
  assert.equal(await runtime.actions.submit(sessionA, plainIntent('next A')), 'accepted')
  assert.deepEqual(calls, [sessionA, sessionB, sessionA])
})

test('a confirmed rejection releases the chain while keeping its failure visible', async () => {
  const calls: string[] = []
  const runtime = createCreationRuntime(
    {
      submitTask: async (_sessionId: string, input: { intent: { prompt: string } }) => {
        calls.push(input.intent.prompt)
        return calls.length === 1
          ? { outcome: 'request-rejected' as const, code: 'invalid_input' }
          : acceptedTask(sessionA, 'task-a')
      }
    },
    'user-1'
  )

  assert.equal(await runtime.actions.submit(sessionA, plainIntent('rejected')), 'failed')
  assert.deepEqual(runtime.actions.snapshot(sessionA), {
    status: 'failed',
    code: 'invalid_input'
  })
  assert.equal(await runtime.actions.submit(sessionA, plainIntent('new action')), 'accepted')
  assert.deepEqual(calls, ['rejected', 'new action'])
})

test('retirement and stop-tracking prevent an old chain from issuing its next request', async () => {
  for (const end of ['retire', 'stop'] as const) {
    const upload = deferred<unknown>()
    let submitCalls = 0
    const runtime = createCreationRuntime(
      {
        uploadMaterial: async () => upload.promise,
        submitTask: async () => {
          submitCalls += 1
          return acceptedTask(sessionA, 'task-a')
        }
      },
      'user-1'
    )
    const staged = runtime.actions.stageMaterial(
      sessionA,
      localMaterial,
      new File(['shoe'], 'shoe.png', { type: 'image/png' })
    )
    const submission = runtime.actions.submit(sessionA, {
      ...plainIntent('A'),
      references: [{ materialId: localMaterial, role: 'reference' }]
    })

    assert.deepEqual(
      runtime.actions.stagedMaterials(sessionA).map((entry) => entry.localId),
      [localMaterial]
    )

    if (end === 'retire') runtime.retire()
    else runtime.actions.stopTracking(sessionA)
    assert.deepEqual(runtime.actions.stagedMaterials(sessionA), [])
    upload.resolve({ outcome: 'succeeded', value: uploadedMaterial() })

    assert.notEqual((await staged).outcome, 'succeeded')
    assert.equal(await submission, 'retired')
    assert.equal(submitCalls, 0)
  }
})

test('retirement preserves minimal warnings for every sent write and discards late success', async () => {
  const storage = fakeStorage()
  writeLocalDraft(storage, 'user-1', sessionA, {
    ...plainIntent('editable draft'),
    promptDocument: { version: 1, nodes: [{ type: 'text', text: 'editable draft' }] },
    prompt: 'editable draft'
  })
  const upload = deferred<unknown>()
  const submit = deferred<unknown>()
  const runtime = createCreationRuntime(
    {
      uploadMaterial: async () => upload.promise,
      submitTask: async () => submit.promise
    },
    'user-1',
    { storage, createId: () => 'sent-before-retirement' }
  )

  const staged = runtime.actions.stageMaterial(
    sessionA,
    localMaterial,
    new File(['shoe'], 'shoe.png', { type: 'image/png' })
  )
  const submission = runtime.actions.submit(sessionA, plainIntent('sent submission'))
  await Promise.resolve()
  runtime.retire()

  assert.deepEqual(readLocalDraft(storage, 'user-1', sessionA)?.operationNotice, {
    submissionUnconfirmed: true,
    materialFileNames: ['shoe.png']
  })

  upload.resolve({ outcome: 'succeeded', value: uploadedMaterial() })
  submit.resolve(acceptedTask(sessionA, 'late-task'))
  assert.notEqual((await staged).outcome, 'succeeded')
  assert.equal(await submission, 'retired')
  assert.deepEqual(readLocalDraft(storage, 'user-1', sessionA)?.operationNotice, {
    submissionUnconfirmed: true,
    materialFileNames: ['shoe.png']
  })
})

test('parallel uploads keep every ambiguous material until tracking explicitly stops', async () => {
  const storage = fakeStorage()
  writeLocalDraft(storage, 'user-1', sessionA, {
    ...plainIntent('editable draft'),
    promptDocument: { version: 1, nodes: [{ type: 'text', text: 'editable draft' }] },
    prompt: 'editable draft'
  })
  const first = deferred<unknown>()
  const second = deferred<unknown>()
  let calls = 0
  const runtime = createCreationRuntime(
    {
      uploadMaterial: async () => (++calls === 1 ? first.promise : second.promise)
    },
    'user-1',
    { storage }
  )

  const firstUpload = runtime.actions.stageMaterial(
    sessionA,
    'local-first',
    new File(['first'], 'first.png', { type: 'image/png' })
  )
  const secondUpload = runtime.actions.stageMaterial(
    sessionA,
    'local-second',
    new File(['second'], 'second.png', { type: 'image/png' })
  )
  first.resolve({ outcome: 'network-failure' })
  assert.equal((await firstUpload).outcome, 'network-failure')
  second.resolve({ outcome: 'succeeded', value: uploadedMaterial() })
  assert.equal((await secondUpload).outcome, 'succeeded')

  assert.deepEqual(runtime.actions.snapshot(sessionA), { status: 'material-unconfirmed' })
  assert.deepEqual(readLocalDraft(storage, 'user-1', sessionA)?.operationNotice, {
    submissionUnconfirmed: false,
    materialFileNames: ['first.png']
  })

  runtime.actions.stopTracking(sessionA)
  assert.equal(readLocalDraft(storage, 'user-1', sessionA)?.operationNotice, undefined)
})

test('a sibling upload success does not hide another material confirmed failure', async () => {
  const first = deferred<unknown>()
  const second = deferred<unknown>()
  let calls = 0
  const runtime = createCreationRuntime(
    {
      uploadMaterial: async () => (++calls === 1 ? first.promise : second.promise)
    },
    'user-1'
  )

  const rejectedUpload = runtime.actions.stageMaterial(
    sessionA,
    'local-rejected',
    new File(['bad'], 'rejected.png', { type: 'image/png' })
  )
  const acceptedUpload = runtime.actions.stageMaterial(
    sessionA,
    'local-accepted',
    new File(['good'], 'accepted.png', { type: 'image/png' })
  )

  first.resolve({ outcome: 'request-rejected', code: 'material_too_large' })
  assert.equal((await rejectedUpload).outcome, 'request-rejected')
  assert.deepEqual(runtime.actions.snapshot(sessionA), {
    status: 'failed',
    code: 'material_too_large'
  })

  second.resolve({ outcome: 'succeeded', value: uploadedMaterial() })
  assert.equal((await acceptedUpload).outcome, 'succeeded')
  assert.deepEqual(runtime.actions.snapshot(sessionA), {
    status: 'failed',
    code: 'material_too_large'
  })
})

test('acknowledging a confirmed failure keeps it dismissed across later reconciles', async () => {
  let calls = 0
  const runtime = createCreationRuntime(
    {
      uploadMaterial: async () => {
        calls += 1
        return calls === 1
          ? { outcome: 'request-rejected' as const, code: 'material_too_large' }
          : { outcome: 'succeeded' as const, value: uploadedMaterial() }
      }
    },
    'user-1'
  )

  await runtime.actions.stageMaterial(
    sessionA,
    'local-rejected',
    new File(['bad'], 'rejected.png', { type: 'image/png' })
  )
  assert.deepEqual(runtime.actions.snapshot(sessionA), {
    status: 'failed',
    code: 'material_too_large'
  })

  runtime.actions.acknowledgeFailure(sessionA)
  assert.deepEqual(runtime.actions.snapshot(sessionA), { status: 'idle' })

  await runtime.actions.stageMaterial(
    sessionA,
    'local-accepted',
    new File(['good'], 'accepted.png', { type: 'image/png' })
  )
  assert.deepEqual(runtime.actions.snapshot(sessionA), { status: 'idle' })
})

test('a confirmed invalid session on any Creation read retires the pending action chain', async () => {
  const upload = deferred<unknown>()
  let submitCalls = 0
  let laterReadCalls = 0
  let blobCalls = 0
  let subscriptionCalls = 0
  let unsubscribeCalls = 0
  const runtime = createCreationRuntime(
    {
      listSessions: async () => ({ outcome: 'unauthorized' as const }),
      listTasks: async () => {
        laterReadCalls += 1
        return { outcome: 'network-failure' as const }
      },
      loadMaterialBlob: async () => {
        blobCalls += 1
        return { outcome: 'succeeded' as const, value: new Blob() }
      },
      subscribeEvents: () => {
        subscriptionCalls += 1
        return () => {
          unsubscribeCalls += 1
        }
      },
      uploadMaterial: async () => upload.promise,
      submitTask: async () => {
        submitCalls += 1
        return acceptedTask(sessionA, 'task-a')
      }
    },
    'user-1'
  )
  runtime.subscribeEvents({
    onInvalidation: () => undefined,
    onStateChange: () => undefined,
    onUnauthorized: () => undefined
  })
  void runtime.actions.stageMaterial(
    sessionA,
    localMaterial,
    new File(['shoe'], 'shoe.png', { type: 'image/png' })
  )
  const submission = runtime.actions.submit(sessionA, {
    ...plainIntent('A'),
    references: [{ materialId: localMaterial, role: 'reference' }]
  })

  assert.equal((await runtime.listSessions()).outcome, 'unauthorized')
  upload.resolve({ outcome: 'succeeded', value: uploadedMaterial() })

  assert.equal(await submission, 'retired')
  assert.equal(runtime.actions.snapshot(sessionA).status, 'retired')
  assert.equal(submitCalls, 0)
  assert.equal(unsubscribeCalls, 1)

  assert.equal((await runtime.listTasks(sessionA)).outcome, 'unauthorized')
  assert.equal((await runtime.loadMaterialBlob(realMaterial)).outcome, 'unauthorized')
  runtime.subscribeEvents({
    onInvalidation: () => undefined,
    onStateChange: () => undefined,
    onUnauthorized: () => undefined
  })
  assert.equal(laterReadCalls, 0)
  assert.equal(blobCalls, 0)
  assert.equal(subscriptionCalls, 1)
})

test('a confirmed invalid session from a blob read retires every later Creation call', async () => {
  let laterReadCalls = 0
  let unsubscribeCalls = 0
  const runtime = createCreationRuntime(
    {
      loadMaterialBlob: async () => ({ outcome: 'unauthorized' as const }),
      listTasks: async () => {
        laterReadCalls += 1
        return { outcome: 'network-failure' as const }
      },
      subscribeEvents: () => () => {
        unsubscribeCalls += 1
      }
    },
    'user-1'
  )
  runtime.subscribeEvents({
    onInvalidation: () => undefined,
    onStateChange: () => undefined,
    onUnauthorized: () => undefined
  })

  assert.equal((await runtime.loadMaterialBlob(realMaterial)).outcome, 'unauthorized')

  assert.deepEqual(runtime.actions.snapshot(sessionA), { status: 'retired' })
  assert.equal(unsubscribeCalls, 1)
  assert.equal((await runtime.listTasks(sessionA)).outcome, 'unauthorized')
  assert.equal(laterReadCalls, 0)
})

test('a confirmed invalid session from SSE retires the authenticated use period', async () => {
  let streamHandlers: Parameters<CreationWorkspacePorts['subscribeEvents']>[0] | null = null
  let unsubscribeCalls = 0
  let laterReadCalls = 0
  let reportedUnauthorized = 0
  const runtime = createCreationRuntime(
    {
      listTasks: async () => {
        laterReadCalls += 1
        return { outcome: 'network-failure' as const }
      },
      subscribeEvents: (handlers) => {
        streamHandlers = handlers
        return () => {
          unsubscribeCalls += 1
        }
      }
    },
    'user-1'
  )
  runtime.subscribeEvents({
    onInvalidation: () => undefined,
    onStateChange: () => undefined,
    onUnauthorized: () => {
      reportedUnauthorized += 1
    }
  })

  assert.ok(streamHandlers)
  streamHandlers.onUnauthorized()

  assert.deepEqual(runtime.actions.snapshot(sessionA), { status: 'retired' })
  assert.equal(unsubscribeCalls, 1)
  assert.equal(reportedUnauthorized, 1)
  assert.equal((await runtime.listTasks(sessionA)).outcome, 'unauthorized')
  assert.equal(laterReadCalls, 0)
})

test('stopping tracking lets an explicit restart replace the old upload action', async () => {
  const firstUpload = deferred<unknown>()
  let uploadCalls = 0
  const runtime = createCreationRuntime(
    {
      uploadMaterial: async () => {
        uploadCalls += 1
        return uploadCalls === 1
          ? firstUpload.promise
          : { outcome: 'succeeded', value: uploadedMaterial() }
      },
      submitTask: async (sessionId: string) => acceptedTask(sessionId, 'task-a')
    },
    'user-1'
  )
  void runtime.actions.stageMaterial(
    sessionA,
    localMaterial,
    new File(['old'], 'old.png', { type: 'image/png' })
  )
  const oldSubmission = runtime.actions.submit(sessionA, {
    ...plainIntent('old'),
    references: [{ materialId: localMaterial, role: 'reference' }]
  })

  runtime.actions.stopTracking(sessionA)
  const restarted = runtime.actions.stageMaterial(
    sessionA,
    localMaterial,
    new File(['new'], 'new.png', { type: 'image/png' })
  )

  assert.equal((await restarted).outcome, 'succeeded')
  assert.equal(uploadCalls, 2)
  firstUpload.resolve({ outcome: 'succeeded', value: uploadedMaterial() })
  assert.equal(await oldSubmission, 'retired')
})

test('an ambiguous upload stays recoverable while confirmed unauthorized retires the runtime', async () => {
  const uploadResults = [
    { outcome: 'network-failure' as const },
    { outcome: 'unauthorized' as const }
  ]
  const runtime = createCreationRuntime(
    {
      uploadMaterial: async () => uploadResults.shift(),
      submitTask: async (sessionId: string) => acceptedTask(sessionId, 'task')
    },
    'user-1'
  )

  await runtime.actions.stageMaterial(
    sessionA,
    'local-network',
    new File(['a'], 'network.png', { type: 'image/png' })
  )
  assert.deepEqual(runtime.actions.snapshot(sessionA), { status: 'material-unconfirmed' })
  assert.equal(
    await runtime.actions.submit(
      'bbbbbbbb-0000-4000-8000-000000000002',
      plainIntent('still authenticated')
    ),
    'accepted'
  )

  await runtime.actions.stageMaterial(
    sessionA,
    'local-unauthorized',
    new File(['b'], 'unauthorized.png', { type: 'image/png' })
  )
  assert.equal(runtime.actions.snapshot(sessionA).status, 'retired')
  assert.equal(
    await runtime.actions.submit(
      'bbbbbbbb-0000-4000-8000-000000000002',
      plainIntent('must not borrow a later session')
    ),
    'retired'
  )
})

test('material and session deletion wait for the submission that retains them', async (t) => {
  await t.test('material', async () => {
    const accepted = deferred<unknown>()
    const deletedResult = deferred<unknown>()
    const deleted: string[] = []
    const reconciled: string[] = []
    const runtime = createCreationRuntime(
      {
        submitTask: async () => accepted.promise,
        deleteMaterial: async (materialId: string) => {
          deleted.push(materialId)
          return deletedResult.promise
        }
      },
      'user-1'
    )
    runtime.actions.subscribe((event) => {
      if (event.type === 'reconcile') reconciled.push(event.sessionId)
    })
    const submission = runtime.actions.submit(sessionA, {
      ...plainIntent('retain material'),
      references: [{ materialId: realMaterial, role: 'reference' }]
    })
    const removal = runtime.actions.deleteMaterial(sessionA, realMaterial)

    await Promise.resolve()
    assert.deepEqual(deleted, [])
    accepted.resolve(acceptedTask(sessionA, 'task-a'))
    assert.equal(await submission, 'accepted')
    assert.deepEqual(reconciled, [sessionA])
    deletedResult.resolve({ outcome: 'succeeded', value: undefined })
    assert.equal((await removal).outcome, 'succeeded')
    assert.deepEqual(deleted, [realMaterial])
    assert.deepEqual(reconciled, [sessionA, sessionA])
  })

  await t.test('material selected before its upload received a real identity', async () => {
    const upload = deferred<unknown>()
    const accepted = deferred<unknown>()
    const deleted: string[] = []
    const runtime = createCreationRuntime(
      {
        uploadMaterial: async () => upload.promise,
        submitTask: async () => accepted.promise,
        deleteMaterial: async (materialId: string) => {
          deleted.push(materialId)
          return { outcome: 'succeeded', value: undefined }
        }
      },
      'user-1'
    )
    void runtime.actions.stageMaterial(
      sessionA,
      localMaterial,
      new File(['shoe'], 'shoe.png', { type: 'image/png' })
    )
    const submission = runtime.actions.submit(sessionA, {
      ...plainIntent('retain pending material'),
      references: [{ materialId: localMaterial, role: 'reference' }]
    })
    const removal = runtime.actions.deleteMaterial(sessionA, localMaterial)

    upload.resolve({ outcome: 'succeeded', value: uploadedMaterial() })
    await Promise.resolve()
    assert.deepEqual(deleted, [])
    accepted.resolve(acceptedTask(sessionA, 'task-a'))
    assert.equal(await submission, 'accepted')
    assert.equal((await removal).outcome, 'succeeded')
    assert.deepEqual(deleted, [realMaterial])
  })

  await t.test(
    'stopping tracking still deletes a retained upload after it gains identity',
    async () => {
      const upload = deferred<unknown>()
      const deleted: string[] = []
      const reconciled: string[] = []
      const runtime = createCreationRuntime(
        {
          uploadMaterial: async () => upload.promise,
          deleteMaterial: async (materialId: string) => {
            deleted.push(materialId)
            return { outcome: 'succeeded', value: undefined }
          }
        },
        'user-1'
      )
      runtime.actions.subscribe((event) => {
        if (event.type === 'reconcile') reconciled.push(event.sessionId)
      })
      const staged = runtime.actions.stageMaterial(
        sessionA,
        localMaterial,
        new File(['shoe'], 'shoe.png', { type: 'image/png' })
      )
      const submission = runtime.actions.submit(sessionA, {
        ...plainIntent('retain pending material'),
        references: [{ materialId: localMaterial, role: 'reference' }]
      })
      const removal = runtime.actions.deleteMaterial(sessionA, localMaterial)

      runtime.actions.stopTracking(sessionA)
      upload.resolve({ outcome: 'succeeded', value: uploadedMaterial() })

      assert.notEqual((await staged).outcome, 'succeeded')
      assert.equal(await submission, 'retired')
      assert.equal((await removal).outcome, 'succeeded')
      assert.deepEqual(deleted, [realMaterial])
      assert.ok(reconciled.includes(sessionA))
    }
  )

  await t.test('material removed while its upload is pending reconciles after DELETE', async () => {
    const upload = deferred<unknown>()
    const deletedResult = deferred<unknown>()
    const deleted: string[] = []
    const reconciled: string[] = []
    const runtime = createCreationRuntime(
      {
        uploadMaterial: async () => upload.promise,
        deleteMaterial: async (materialId: string) => {
          deleted.push(materialId)
          return deletedResult.promise
        }
      },
      'user-1'
    )
    runtime.actions.subscribe((event) => {
      if (event.type === 'reconcile') reconciled.push(event.sessionId)
    })
    const staged = runtime.actions.stageMaterial(
      sessionA,
      localMaterial,
      new File(['shoe'], 'shoe.png', { type: 'image/png' })
    )
    const removal = runtime.actions.deleteMaterial(sessionA, localMaterial)

    upload.resolve({ outcome: 'succeeded', value: uploadedMaterial() })
    assert.equal((await staged).outcome, 'succeeded')
    await Promise.resolve()
    assert.deepEqual(deleted, [realMaterial])
    assert.deepEqual(reconciled, [sessionA])

    deletedResult.resolve({ outcome: 'succeeded', value: undefined })
    assert.equal((await removal).outcome, 'succeeded')
    assert.deepEqual(reconciled, [sessionA, sessionA])
  })

  await t.test('material addressed by its resolved identity', async () => {
    const accepted = deferred<unknown>()
    const deleted: string[] = []
    const runtime = createCreationRuntime(
      {
        uploadMaterial: async () => ({ outcome: 'succeeded', value: uploadedMaterial() }),
        submitTask: async () => accepted.promise,
        deleteMaterial: async (materialId: string) => {
          deleted.push(materialId)
          return { outcome: 'succeeded', value: undefined }
        }
      },
      'user-1'
    )
    await runtime.actions.stageMaterial(
      sessionA,
      localMaterial,
      new File(['shoe'], 'shoe.png', { type: 'image/png' })
    )
    const submission = runtime.actions.submit(sessionA, {
      ...plainIntent('retain resolved material'),
      references: [{ materialId: localMaterial, role: 'reference' }]
    })
    const removal = runtime.actions.deleteMaterial(sessionA, realMaterial)

    await Promise.resolve()
    assert.deepEqual(deleted, [])
    accepted.resolve(acceptedTask(sessionA, 'task-a'))
    assert.equal(await submission, 'accepted')
    assert.equal((await removal).outcome, 'succeeded')
    assert.deepEqual(deleted, [realMaterial])
  })

  await t.test('session', async () => {
    const accepted = deferred<unknown>()
    const deleted: string[] = []
    const reconciled: string[] = []
    const runtime = createCreationRuntime(
      {
        submitTask: async () => accepted.promise,
        deleteSession: async (sessionId: string) => {
          deleted.push(sessionId)
          return { outcome: 'succeeded', value: undefined }
        }
      },
      'user-1'
    )
    runtime.actions.subscribe((event) => {
      if (event.type === 'sessions-reconcile') reconciled.push(event.sessionId)
    })
    const submission = runtime.actions.submit(sessionA, plainIntent('retain session'))
    const removal = runtime.actions.deleteSession(sessionA)

    await Promise.resolve()
    assert.deepEqual(deleted, [])
    accepted.resolve(acceptedTask(sessionA, 'task-a'))
    assert.equal(await submission, 'accepted')
    assert.equal((await removal).outcome, 'succeeded')
    assert.deepEqual(deleted, [sessionA])
    assert.deepEqual(reconciled, [sessionA])
  })
})

test('a runtime-owned replacement commits to its original context after display navigation', async () => {
  const storage = fakeStorage()
  writeLocalDraft(storage, 'user-1', sessionA, {
    ...plainIntent('replace the first material'),
    promptDocument: { version: 1, nodes: [{ type: 'text', text: 'replace the first material' }] },
    prompt: 'replace the first material',
    references: [{ materialId: 'old-material', role: 'reference' }]
  })
  const upload = deferred<unknown>()
  const deleted: string[] = []
  const reconciled: string[] = []
  const runtime = createCreationRuntime(
    {
      uploadMaterial: async () => upload.promise,
      deleteMaterial: async (materialId: string) => {
        deleted.push(materialId)
        return { outcome: 'succeeded', value: undefined }
      }
    },
    'user-1',
    { storage }
  )
  runtime.actions.subscribe((event) => {
    if (event.type === 'reconcile') reconciled.push(event.sessionId)
  })

  const replacement = runtime.actions.replaceMaterial(
    sessionA,
    'old-material',
    localMaterial,
    new File(['shoe'], 'shoe.png', { type: 'image/png' }),
    'reference'
  )
  assert.deepEqual(readLocalDraft(storage, 'user-1', sessionA)?.references, [
    { materialId: 'old-material', role: 'reference' }
  ])

  upload.resolve({ outcome: 'succeeded', value: uploadedMaterial() })
  assert.equal((await replacement).outcome, 'succeeded')
  assert.deepEqual(readLocalDraft(storage, 'user-1', sessionA)?.references, [
    { materialId: realMaterial, role: 'reference' }
  ])
  assert.deepEqual(deleted, ['old-material'])
  assert.deepEqual(reconciled, [sessionA])
})

test('a replacement merges into the latest draft after a slow material delete', async () => {
  const storage = fakeStorage()
  const original = {
    ...plainIntent('original prompt'),
    promptDocument: {
      version: 1 as const,
      nodes: [{ type: 'text' as const, text: 'original prompt' }]
    },
    prompt: 'original prompt',
    references: [{ materialId: 'old-material', role: 'reference' as const }]
  }
  writeLocalDraft(storage, 'user-1', sessionA, original)
  const upload = deferred<unknown>()
  const deletedResult = deferred<unknown>()
  let deleteCalls = 0
  const runtime = createCreationRuntime(
    {
      uploadMaterial: async () => upload.promise,
      deleteMaterial: async () => {
        deleteCalls += 1
        return deletedResult.promise
      }
    },
    'user-1',
    { storage }
  )

  const replacement = runtime.actions.replaceMaterial(
    sessionA,
    'old-material',
    localMaterial,
    new File(['shoe'], 'shoe.png', { type: 'image/png' }),
    'reference'
  )
  upload.resolve({ outcome: 'succeeded', value: uploadedMaterial() })
  for (let attempt = 0; attempt < 5 && deleteCalls === 0; attempt += 1) {
    await Promise.resolve()
  }
  assert.equal(deleteCalls, 1)

  writeLocalDraft(storage, 'user-1', sessionA, {
    ...original,
    prompt: 'edited while delete was pending',
    promptDocument: {
      version: 1,
      nodes: [{ type: 'text', text: 'edited while delete was pending' }]
    }
  })
  deletedResult.resolve({ outcome: 'succeeded', value: undefined })
  assert.equal((await replacement).outcome, 'succeeded')

  const latest = readLocalDraft(storage, 'user-1', sessionA)
  assert.equal(latest?.prompt, 'edited while delete was pending')
  assert.deepEqual(latest?.references, [{ materialId: realMaterial, role: 'reference' }])
})

test('unconfirmed warnings survive reload but replay context and files do not', async () => {
  const storage = fakeStorage()
  writeLocalDraft(storage, 'user-1', sessionA, {
    ...plainIntent('editable draft'),
    promptDocument: { version: 1, nodes: [{ type: 'text', text: 'editable draft' }] },
    prompt: 'editable draft'
  })
  const submitResults = [{ outcome: 'network-failure' as const }, acceptedTask(sessionA, 'task-a')]
  const runtime = createCreationRuntime(
    {
      uploadMaterial: async () => ({ outcome: 'network-failure' as const }),
      submitTask: async () => submitResults.shift(),
      deleteSession: async () => ({ outcome: 'succeeded' as const, value: undefined })
    },
    'user-1',
    { storage, createId: () => 'submission-key' }
  )

  assert.equal(await runtime.actions.submit(sessionA, plainIntent('frozen intent')), 'unconfirmed')
  assert.deepEqual(readLocalDraft(storage, 'user-1', sessionA)?.operationNotice, {
    submissionUnconfirmed: true,
    materialFileNames: []
  })
  const persisted = storage.getItem(`nevix:creation:draft:user-1:${sessionA}`) ?? ''
  assert.equal(persisted.includes('submission-key'), false)
  assert.equal(persisted.includes('frozen intent'), false)

  assert.equal(await runtime.actions.resumeSubmission(sessionA), 'accepted')
  assert.equal(readLocalDraft(storage, 'user-1', sessionA)?.operationNotice, undefined)

  await runtime.actions.stageMaterial(
    sessionA,
    localMaterial,
    new File(['shoe'], 'shoe.png', { type: 'image/png' })
  )
  assert.deepEqual(readLocalDraft(storage, 'user-1', sessionA)?.operationNotice, {
    submissionUnconfirmed: false,
    materialFileNames: ['shoe.png']
  })
  runtime.actions.stopTracking(sessionA)
  assert.equal(readLocalDraft(storage, 'user-1', sessionA)?.operationNotice, undefined)

  assert.equal((await runtime.actions.deleteSession(sessionA)).outcome, 'succeeded')
  assert.equal(readLocalDraft(storage, 'user-1', sessionA), null)
})

test('a reloaded runtime cannot resume an old write and creates a fresh submission', async () => {
  const storage = fakeStorage()
  writeLocalDraft(storage, 'user-1', sessionA, {
    ...plainIntent('editable draft'),
    promptDocument: { version: 1, nodes: [{ type: 'text', text: 'editable draft' }] },
    prompt: 'editable draft',
    operationNotice: { submissionUnconfirmed: true, materialFileNames: [] }
  })
  const calls: Array<{ idempotencyKey: string }> = []
  const runtime = createCreationRuntime(
    {
      submitTask: async (_sessionId: string, input: { idempotencyKey: string }) => {
        calls.push(input)
        return acceptedTask(sessionA, 'task-after-reload')
      }
    },
    'user-1',
    { storage, createId: () => 'new-submission-key' }
  )

  assert.equal(await runtime.actions.resumeSubmission(sessionA), 'failed')
  assert.deepEqual(calls, [])
  assert.equal(await runtime.actions.submit(sessionA, plainIntent('new action')), 'accepted')
  assert.equal(calls[0]?.idempotencyKey, 'new-submission-key')
})

test('a late material identity remaps the persisted draft without touching later edits', async () => {
  const storage = fakeStorage()
  writeLocalDraft(storage, 'user-1', sessionA, {
    ...plainIntent('Image 1 with later edits'),
    prompt: 'Image 1 with later edits',
    promptDocument: {
      version: 1,
      nodes: [
        { type: 'mention', materialId: localMaterial },
        { type: 'text', text: ' with later edits' }
      ]
    },
    references: [{ materialId: localMaterial, role: 'reference' }]
  })
  const runtime = createCreationRuntime(
    {
      uploadMaterial: async () => ({ outcome: 'succeeded', value: uploadedMaterial() })
    },
    'user-1',
    { storage }
  )

  await runtime.actions.stageMaterial(
    sessionA,
    localMaterial,
    new File(['shoe'], 'shoe.png', { type: 'image/png' })
  )

  const restored = readLocalDraft(storage, 'user-1', sessionA)
  assert.deepEqual(restored?.references, [{ materialId: realMaterial, role: 'reference' }])
  assert.deepEqual(restored?.promptDocument, {
    version: 1,
    nodes: [
      { type: 'mention', materialId: realMaterial },
      { type: 'text', text: ' with later edits' }
    ]
  })
  assert.equal(restored?.prompt, 'Image 1 with later edits')
})
