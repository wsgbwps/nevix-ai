import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import type { ReferenceMaterialUploadDependencies } from '../../src/main/creation/reference-material-upload.ts'

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

const {
  abortReferenceMaterialUploadRecovery,
  recoverReferenceMaterialUpload,
  runReferenceMaterialUpload
} = await import('../../src/main/creation/reference-material-upload.ts')

const material = {
  id: '00000000-0000-4000-8000-000000000003',
  kind: 'image' as const,
  fileName: 'photo.png',
  mimeType: 'image/png',
  byteSize: 3,
  widthPx: 1,
  heightPx: 1,
  pixelCount: 1,
  durationMs: null,
  checksumSha256: 'aa'.repeat(32),
  claimsVersion: 1,
  createdAt: '2026-09-09T08:00:00Z'
}

const upload = {
  id: '00000000-0000-4000-8000-000000000002',
  status: 'pending' as const,
  connectionRevision: 7,
  putExpiresAt: '2026-09-09T09:00:00Z',
  finalizeExpiresAt: '2026-09-09T09:30:00Z'
}

function baseDependencies(overrides: Partial<ReferenceMaterialUploadDependencies> = {}): {
  readonly calls: string[]
  readonly dependencies: ReferenceMaterialUploadDependencies
} {
  const calls: string[] = []
  return {
    calls,
    dependencies: {
      serverUrl: () => 'https://server.example',
      sessionToken: async () => 'session-token',
      developmentMode: () => false,
      inspectFile: async () => ({ regular: true, byteSize: 3 }),
      createUpload: async () => {
        calls.push('create')
        return {
          outcome: 'succeeded' as const,
          value: {
            upload,
            uploadRequest: {
              method: 'PUT' as const,
              url: 'https://bucket.oss-cn-hangzhou.aliyuncs.com/reference-materials/object',
              headers: {
                'Content-Type': 'image/png',
                'x-oss-meta-upload-id': upload.id,
                'x-oss-forbid-overwrite': 'true'
              },
              expiresAt: upload.putExpiresAt
            }
          }
        }
      },
      readCapability: async () => {
        calls.push('capability')
        return {
          outcome: 'succeeded' as const,
          value: {
            available: true as const,
            provider: 'oss' as const,
            uploadOrigin: 'https://bucket.oss-cn-hangzhou.aliyuncs.com',
            connectionRevision: 7
          }
        }
      },
      putFile: async () => {
        calls.push('put')
        return { outcome: 'completed' as const }
      },
      readUpload: async () => {
        calls.push('status')
        return { outcome: 'succeeded' as const, value: { upload } }
      },
      finalizeUpload: async () => {
        calls.push('finalize')
        return {
          outcome: 'succeeded' as const,
          value: { upload: { ...upload, status: 'finalized' as const }, material }
        }
      },
      abortUpload: async () => {
        calls.push('abort')
        return {
          outcome: 'succeeded' as const,
          value: { upload: { ...upload, status: 'terminal' as const } }
        }
      },
      ...overrides
    }
  }
}

const input = {
  idempotencyKey: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000010',
  localPath: '/private/tmp/photo.png',
  fileName: 'photo.png',
  declaredKind: 'image' as const,
  declaredMimeType: 'image/png',
  declaredByteSize: 3
}

test('a native upload validates the local file and signed PUT capability before finalizing', async () => {
  const { calls, dependencies } = baseDependencies()
  const leases: unknown[] = []
  const result = await runReferenceMaterialUpload(input, dependencies, (lease) =>
    leases.push(lease)
  )

  assert.deepEqual(result, { outcome: 'succeeded', value: material })
  assert.deepEqual(calls, ['create', 'capability', 'put', 'finalize'])
  assert.deepEqual(leases, [
    {
      uploadId: upload.id,
      idempotencyKey: input.idempotencyKey,
      sessionId: input.sessionId,
      fileName: input.fileName,
      declaredKind: input.declaredKind,
      declaredMimeType: input.declaredMimeType,
      declaredByteSize: input.declaredByteSize,
      putExpiresAt: upload.putExpiresAt,
      finalizeExpiresAt: upload.finalizeExpiresAt
    }
  ])
})

test('restart recovery resolves a provisional idempotency record then checks status before finalize', async () => {
  const { calls, dependencies } = baseDependencies()
  const result = await recoverReferenceMaterialUpload(
    {
      idempotencyKey: input.idempotencyKey,
      sessionId: input.sessionId,
      fileName: input.fileName,
      declaredKind: input.declaredKind,
      declaredMimeType: input.declaredMimeType,
      declaredByteSize: input.declaredByteSize
    },
    dependencies
  )

  assert.deepEqual(result, { outcome: 'succeeded', value: material })
  assert.deepEqual(calls, ['create', 'status', 'finalize'])
})

test('restart recovery checks finalized and terminal status without PUT or finalize', async () => {
  for (const status of ['finalized', 'terminal'] as const) {
    const { calls, dependencies } = baseDependencies({
      readUpload: async () => {
        calls.push('status')
        return {
          outcome: 'succeeded' as const,
          value: {
            upload: { ...upload, status },
            ...(status === 'finalized' ? { material } : {})
          }
        }
      }
    })
    const result = await recoverReferenceMaterialUpload(
      {
        uploadId: upload.id,
        idempotencyKey: input.idempotencyKey,
        sessionId: input.sessionId,
        fileName: input.fileName,
        declaredKind: input.declaredKind,
        declaredMimeType: input.declaredMimeType,
        declaredByteSize: input.declaredByteSize,
        putExpiresAt: upload.putExpiresAt,
        finalizeExpiresAt: upload.finalizeExpiresAt
      },
      dependencies
    )
    assert.deepEqual(
      result,
      status === 'finalized'
        ? { outcome: 'succeeded', value: material }
        : { outcome: 'request-rejected', code: 'upload_terminal' }
    )
    assert.deepEqual(calls, ['status'])
  }
})

test('restart recovery retires a finalized upload whose material was already deleted', async () => {
  const { calls, dependencies } = baseDependencies({
    readUpload: async () => {
      calls.push('status')
      return { outcome: 'request-rejected' as const, code: 'not_found' }
    }
  })

  assert.deepEqual(
    await recoverReferenceMaterialUpload(
      {
        uploadId: upload.id,
        idempotencyKey: input.idempotencyKey,
        sessionId: input.sessionId,
        fileName: input.fileName,
        declaredKind: input.declaredKind,
        declaredMimeType: input.declaredMimeType,
        declaredByteSize: input.declaredByteSize,
        putExpiresAt: upload.putExpiresAt,
        finalizeExpiresAt: upload.finalizeExpiresAt
      },
      dependencies
    ),
    { outcome: 'request-rejected', code: 'upload_terminal' }
  )
  assert.deepEqual(calls, ['status'])
})

test('durable abort resolves a provisional upload and reports a concurrent finalized material', async () => {
  for (const finalized of [false, true]) {
    const { calls, dependencies } = baseDependencies({
      abortUpload: async () => {
        calls.push('abort')
        return {
          outcome: 'succeeded' as const,
          value: {
            upload: {
              ...upload,
              status: finalized ? ('finalized' as const) : ('terminal' as const)
            },
            ...(finalized ? { material } : {})
          }
        }
      }
    })

    assert.deepEqual(
      await abortReferenceMaterialUploadRecovery(
        {
          idempotencyKey: input.idempotencyKey,
          sessionId: input.sessionId,
          fileName: input.fileName,
          declaredKind: input.declaredKind,
          declaredMimeType: input.declaredMimeType,
          declaredByteSize: input.declaredByteSize
        },
        dependencies
      ),
      { outcome: 'succeeded', value: finalized ? material : null }
    )
    assert.deepEqual(calls, ['create', 'abort'])
  }
})

test('durable abort treats an already terminal or expired provisional upload as removed', async () => {
  for (const code of [
    'reference_material_upload_terminal',
    'reference_material_upload_expired'
  ] as const) {
    const { calls, dependencies } = baseDependencies({
      createUpload: async () => {
        calls.push('create')
        return { outcome: 'request-rejected' as const, code }
      }
    })

    assert.deepEqual(
      await abortReferenceMaterialUploadRecovery(
        {
          idempotencyKey: input.idempotencyKey,
          sessionId: input.sessionId,
          fileName: input.fileName,
          declaredKind: input.declaredKind,
          declaredMimeType: input.declaredMimeType,
          declaredByteSize: input.declaredByteSize
        },
        dependencies
      ),
      { outcome: 'succeeded', value: null }
    )
    assert.deepEqual(calls, ['create'])
  }
})

test('restart recovery requires file reselection when finalize proves no object was PUT', async () => {
  const { calls, dependencies } = baseDependencies({
    finalizeUpload: async () => {
      calls.push('finalize')
      return { outcome: 'request-rejected' as const, code: 'upload_requires_reselection' }
    }
  })

  const result = await recoverReferenceMaterialUpload(
    {
      uploadId: upload.id,
      idempotencyKey: input.idempotencyKey,
      sessionId: input.sessionId,
      fileName: input.fileName,
      declaredKind: input.declaredKind,
      declaredMimeType: input.declaredMimeType,
      declaredByteSize: input.declaredByteSize,
      putExpiresAt: upload.putExpiresAt,
      finalizeExpiresAt: upload.finalizeExpiresAt
    },
    dependencies
  )

  assert.deepEqual(result, {
    outcome: 'request-rejected',
    code: 'upload_requires_reselection'
  })
  assert.deepEqual(calls, ['status', 'finalize'])
})

test('restart recovery retires the old key immediately on a deterministic finalize rejection', async () => {
  const { calls, dependencies } = baseDependencies({
    finalizeUpload: async () => {
      calls.push('finalize')
      return { outcome: 'request-rejected' as const, code: 'material_upload_metadata_mismatch' }
    }
  })

  const result = await recoverReferenceMaterialUpload(
    {
      uploadId: upload.id,
      idempotencyKey: input.idempotencyKey,
      sessionId: input.sessionId,
      fileName: input.fileName,
      declaredKind: input.declaredKind,
      declaredMimeType: input.declaredMimeType,
      declaredByteSize: input.declaredByteSize,
      putExpiresAt: upload.putExpiresAt,
      finalizeExpiresAt: upload.finalizeExpiresAt
    },
    dependencies
  )

  assert.deepEqual(result, { outcome: 'request-rejected', code: 'upload_terminal' })
  assert.deepEqual(calls, ['status', 'finalize'])
})

test('an active deterministic finalize rejection also retires the old key', async () => {
  const { calls, dependencies } = baseDependencies({
    finalizeUpload: async () => {
      calls.push('finalize')
      return { outcome: 'request-rejected' as const, code: 'material_upload_metadata_mismatch' }
    }
  })

  assert.deepEqual(await runReferenceMaterialUpload(input, dependencies), {
    outcome: 'request-rejected',
    code: 'upload_terminal'
  })
  assert.deepEqual(calls, ['create', 'capability', 'put', 'finalize'])
})

test('an uncertain PUT checks status then finalizes without retransmitting bytes', async () => {
  const { calls, dependencies } = baseDependencies({
    putFile: async () => {
      calls.push('put')
      return { outcome: 'uncertain' as const }
    }
  })

  const result = await runReferenceMaterialUpload(input, dependencies)

  assert.equal(result.outcome, 'succeeded')
  assert.deepEqual(calls, ['create', 'capability', 'put', 'status', 'finalize'])
  assert.equal(calls.filter((call) => call === 'put').length, 1)
})

test('an already-finalized uncertain PUT returns the status material without another finalize', async () => {
  const { calls, dependencies } = baseDependencies({
    putFile: async () => {
      calls.push('put')
      return { outcome: 'uncertain' as const }
    },
    readUpload: async () => {
      calls.push('status')
      return {
        outcome: 'succeeded' as const,
        value: { upload: { ...upload, status: 'finalized' as const }, material }
      }
    }
  })

  const result = await runReferenceMaterialUpload(input, dependencies)

  assert.deepEqual(result, { outcome: 'succeeded', value: material })
  assert.deepEqual(calls, ['create', 'capability', 'put', 'status'])
})

test('a PUT failure known to happen before sending bytes does not query status or retry', async () => {
  const { calls, dependencies } = baseDependencies({
    putFile: async () => {
      calls.push('put')
      return { outcome: 'not-sent' as const }
    }
  })

  const result = await runReferenceMaterialUpload(input, dependencies)

  assert.deepEqual(result, {
    outcome: 'request-rejected',
    code: 'upload_requires_reselection'
  })
  assert.deepEqual(calls, ['create', 'capability', 'put'])
})

test('a user-cancelled native transfer best-effort aborts the durable upload', async () => {
  const { calls, dependencies } = baseDependencies({
    putFile: async () => {
      calls.push('put')
      return { outcome: 'cancelled' as const }
    }
  })

  assert.deepEqual(await runReferenceMaterialUpload(input, dependencies), {
    outcome: 'request-rejected',
    code: 'upload_cancelled'
  })
  assert.deepEqual(calls, ['create', 'capability', 'put', 'abort'])
})

test('cancellation after the lease always best-effort aborts the durable upload', async () => {
  for (const phase of ['capability', 'finalize'] as const) {
    const { calls, dependencies } = baseDependencies({
      ...(phase === 'capability'
        ? {
            readCapability: async () => {
              calls.push('capability')
              return { outcome: 'request-rejected' as const, code: 'upload_cancelled' }
            }
          }
        : {
            finalizeUpload: async () => {
              calls.push('finalize')
              return { outcome: 'request-rejected' as const, code: 'upload_cancelled' }
            }
          })
    })

    assert.deepEqual(await runReferenceMaterialUpload(input, dependencies), {
      outcome: 'request-rejected',
      code: 'upload_cancelled'
    })
    assert.deepEqual(
      calls,
      phase === 'capability'
        ? ['create', 'capability', 'abort']
        : ['create', 'capability', 'put', 'finalize', 'abort']
    )
  }
})

test('credential rotation does not invalidate a signed request from the unchanged location', async () => {
  const { calls, dependencies } = baseDependencies({
    readCapability: async () => {
      calls.push('capability')
      return {
        outcome: 'succeeded' as const,
        value: {
          available: true as const,
          provider: 'oss' as const,
          uploadOrigin: 'https://bucket.oss-cn-hangzhou.aliyuncs.com',
          connectionRevision: 8
        }
      }
    }
  })

  assert.equal((await runReferenceMaterialUpload(input, dependencies)).outcome, 'succeeded')
  assert.deepEqual(calls, ['create', 'capability', 'put', 'finalize'])
})

test('a pending replay without a PUT grant finalizes the existing object without sending bytes', async () => {
  const { calls, dependencies } = baseDependencies({
    createUpload: async () => {
      calls.push('create')
      return { outcome: 'succeeded' as const, value: { upload } }
    }
  })

  const result = await runReferenceMaterialUpload(input, dependencies)

  assert.deepEqual(result, { outcome: 'succeeded', value: material })
  assert.deepEqual(calls, ['create', 'status', 'finalize'])
})

test('a pending replay without an object retires the expired upload key', async () => {
  const { calls, dependencies } = baseDependencies({
    createUpload: async () => {
      calls.push('create')
      return { outcome: 'succeeded' as const, value: { upload } }
    },
    finalizeUpload: async () => {
      calls.push('finalize')
      return {
        outcome: 'request-rejected' as const,
        code: 'reference_material_upload_terminal'
      }
    }
  })

  assert.deepEqual(await runReferenceMaterialUpload(input, dependencies), {
    outcome: 'request-rejected',
    code: 'upload_terminal'
  })
  assert.deepEqual(calls, ['create', 'status', 'finalize'])
})

test('a finalized replay reads its authoritative material instead of requesting reselection', async () => {
  const finalizedUpload = { ...upload, status: 'finalized' as const }
  const { calls, dependencies } = baseDependencies({
    createUpload: async () => {
      calls.push('create')
      return { outcome: 'succeeded' as const, value: { upload: finalizedUpload } }
    },
    readUpload: async () => {
      calls.push('status')
      return {
        outcome: 'succeeded' as const,
        value: { upload: finalizedUpload, material }
      }
    }
  })

  assert.deepEqual(await runReferenceMaterialUpload(input, dependencies), {
    outcome: 'succeeded',
    value: material
  })
  assert.deepEqual(calls, ['create', 'status'])
})

test('a terminal replay retires the upload key instead of requesting reselection', async () => {
  const { calls, dependencies } = baseDependencies({
    createUpload: async () => {
      calls.push('create')
      return {
        outcome: 'succeeded' as const,
        value: { upload: { ...upload, status: 'terminal' as const } }
      }
    }
  })

  assert.deepEqual(await runReferenceMaterialUpload(input, dependencies), {
    outcome: 'request-rejected',
    code: 'upload_terminal'
  })
  assert.deepEqual(calls, ['create'])
})

test('create replay errors normalize only terminal upload states', async () => {
  for (const [code, expected] of [
    ['reference_material_upload_terminal', 'upload_terminal'],
    ['reference_material_upload_expired', 'upload_terminal'],
    ['material_too_large', 'material_too_large']
  ] as const) {
    const { dependencies } = baseDependencies({
      createUpload: async () => ({ outcome: 'request-rejected' as const, code })
    })

    assert.deepEqual(await runReferenceMaterialUpload(input, dependencies), {
      outcome: 'request-rejected',
      code: expected
    })
  }
})

test('an unsafe Server base URL is rejected before any network request', async () => {
  const { calls, dependencies } = baseDependencies({
    serverUrl: () => 'http://server.example'
  })

  const result = await runReferenceMaterialUpload(input, dependencies)

  assert.deepEqual(result, { outcome: 'network-failure' })
  assert.deepEqual(calls, [])
})

test('an unpackaged runtime accepts only canonical loopback HTTP Server URLs', async () => {
  const { calls, dependencies } = baseDependencies({
    serverUrl: () => 'http://127.0.0.1:8080',
    developmentMode: () => true
  })
  const result = await runReferenceMaterialUpload(input, dependencies)
  assert.equal(result.outcome, 'succeeded')
  assert.deepEqual(calls, ['create', 'capability', 'put', 'finalize'])
})

test('a Storage capability must expose a canonical HTTPS origin', async () => {
  for (const uploadOrigin of [
    'http://bucket.oss-cn-hangzhou.aliyuncs.com',
    'https://user@bucket.oss-cn-hangzhou.aliyuncs.com',
    'https://bucket.oss-cn-hangzhou.aliyuncs.com/path',
    'https://bucket.oss-cn-hangzhou.aliyuncs.com?query=1'
  ]) {
    const { calls, dependencies } = baseDependencies({
      readCapability: async () => {
        calls.push('capability')
        return {
          outcome: 'succeeded' as const,
          value: {
            available: true as const,
            provider: 'oss' as const,
            uploadOrigin,
            connectionRevision: 7
          }
        }
      }
    })

    const result = await runReferenceMaterialUpload(input, dependencies)

    assert.deepEqual(result, { outcome: 'network-failure' })
    assert.deepEqual(calls, ['create', 'capability'])
  }
})

test('a signed request with the wrong origin or an extra header fails closed before PUT', async () => {
  for (const uploadRequest of [
    {
      method: 'PUT' as const,
      url: 'https://attacker.example/reference-materials/object',
      headers: {
        'Content-Type': 'image/png',
        'x-oss-meta-upload-id': upload.id,
        'x-oss-forbid-overwrite': 'true'
      },
      expiresAt: upload.putExpiresAt
    },
    {
      method: 'PUT' as const,
      url: 'https://bucket.oss-cn-hangzhou.aliyuncs.com/reference-materials/object',
      headers: {
        'Content-Type': 'image/png',
        'x-oss-meta-upload-id': upload.id,
        'x-oss-forbid-overwrite': 'true',
        Authorization: 'Bearer leaked'
      },
      expiresAt: upload.putExpiresAt
    },
    {
      method: 'PUT' as const,
      url: 'https://bucket.oss-cn-hangzhou.aliyuncs.com/reference-materials/object#ignored',
      headers: {
        'Content-Type': 'image/png',
        'x-oss-meta-upload-id': upload.id,
        'x-oss-forbid-overwrite': 'true'
      },
      expiresAt: upload.putExpiresAt
    }
  ]) {
    const { calls, dependencies } = baseDependencies({
      createUpload: async () => {
        calls.push('create')
        return { outcome: 'succeeded' as const, value: { upload, uploadRequest } }
      }
    })
    const result = await runReferenceMaterialUpload(input, dependencies)
    assert.deepEqual(result, { outcome: 'network-failure' })
    assert.deepEqual(calls, ['create', 'capability'])
  }
})

test('signed headers must match the capability provider', async () => {
  const { calls, dependencies } = baseDependencies({
    readCapability: async () => {
      calls.push('capability')
      return {
        outcome: 'succeeded' as const,
        value: {
          available: true as const,
          provider: 'cos' as const,
          uploadOrigin: 'https://bucket.oss-cn-hangzhou.aliyuncs.com',
          connectionRevision: 7
        }
      }
    }
  })

  assert.deepEqual(await runReferenceMaterialUpload(input, dependencies), {
    outcome: 'network-failure'
  })
  assert.deepEqual(calls, ['create', 'capability'])
})

test('a non-file or changed byte size is rejected before requesting an upload lease', async () => {
  for (const file of [
    { regular: false, byteSize: 3 },
    { regular: true, byteSize: 4 }
  ]) {
    const { calls, dependencies } = baseDependencies({ inspectFile: async () => file })
    const result = await runReferenceMaterialUpload(input, dependencies)
    assert.deepEqual(result, { outcome: 'request-rejected', code: 'invalid_local_file' })
    assert.deepEqual(calls, [])
  }
})
