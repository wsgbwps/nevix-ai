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

const { runReferenceMaterialUpload } =
  await import('../../src/main/creation/reference-material-upload.ts')

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
      createId: () => '00000000-0000-4000-8000-000000000001',
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
      ...overrides
    }
  }
}

const input = {
  sessionId: '00000000-0000-4000-8000-000000000010',
  localPath: '/private/tmp/photo.png',
  fileName: 'photo.png',
  declaredKind: 'image' as const,
  declaredMimeType: 'image/png',
  declaredByteSize: 3
}

test('a native upload validates the local file and signed PUT capability before finalizing', async () => {
  const { calls, dependencies } = baseDependencies()
  const result = await runReferenceMaterialUpload(input, dependencies)

  assert.deepEqual(result, { outcome: 'succeeded', value: material })
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

test('a replay without a PUT grant fails safely without sending bytes', async () => {
  const { calls, dependencies } = baseDependencies({
    createUpload: async () => {
      calls.push('create')
      return { outcome: 'succeeded' as const, value: { upload } }
    }
  })

  const result = await runReferenceMaterialUpload(input, dependencies)

  assert.deepEqual(result, {
    outcome: 'request-rejected',
    code: 'upload_requires_reselection'
  })
  assert.deepEqual(calls, ['create'])
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
