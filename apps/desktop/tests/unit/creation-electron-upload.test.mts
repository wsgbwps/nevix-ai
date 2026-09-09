import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { registerHooks } from 'node:module'

const electronStub = `data:text/javascript,${encodeURIComponent(`
export const app = { isPackaged: true, getPath: () => '/tmp' }
export const session = { defaultSession: {} }
export const net = {
  request: (options) => globalThis.__nevixElectronRequest(options)
}
export const safeStorage = {
  isEncryptionAvailable: () => false,
  getSelectedStorageBackend: () => 'unavailable',
  setUsePlainTextEncryption: () => undefined,
  encryptString: () => { throw new Error('unavailable') },
  decryptString: () => { throw new Error('unavailable') }
}
`)}`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: electronStub, shortCircuit: true }
    if (specifier === '../connection') {
      return {
        url: `data:text/javascript,${encodeURIComponent(`export const currentServerConnectionUrl = () => undefined`)}`,
        shortCircuit: true
      }
    }
    if (specifier === '../authentication') {
      return {
        url: `data:text/javascript,${encodeURIComponent(`export const readCurrentSessionToken = async () => undefined`)}`,
        shortCircuit: true
      }
    }
    const isDesktopSource = context.parentURL?.includes('/apps/desktop/src/') === true
    const resolvedSpecifier =
      isDesktopSource && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)
        ? `${specifier}.ts`
        : specifier
    return nextResolve(resolvedSpecifier, context)
  }
})

class FakeResponse extends EventEmitter {
  statusCode = 200
}

class FakeRequest extends EventEmitter {
  readonly headers = new Map<string, string>()
  readonly writes: Buffer[] = []
  readonly callbacks: Array<() => void> = []
  chunkedEncoding = false
  aborted = false
  ended = false
  outstanding = 0
  maximumOutstanding = 0
  uploadProgressActive = true
  private readonly responds: boolean

  constructor(responds = true) {
    super()
    this.responds = responds
  }

  setHeader(name: string, value: string): void {
    this.headers.set(name, value)
  }

  write(chunk: Buffer, _encoding: undefined, callback: () => void): boolean {
    this.writes.push(Buffer.from(chunk))
    this.outstanding++
    this.maximumOutstanding = Math.max(this.maximumOutstanding, this.outstanding)
    this.callbacks.push(() => {
      this.outstanding--
      callback()
    })
    return true
  }

  end(): void {
    this.ended = true
    if (!this.responds) return
    const response = new FakeResponse()
    this.emit('response', response)
    queueMicrotask(() => response.emit('end'))
  }

  abort(): void {
    this.aborted = true
  }

  getUploadProgress(): { active: boolean; started: boolean; current: number; total: number } {
    const current = this.writes.reduce((total, chunk) => total + chunk.length, 0)
    return { active: this.uploadProgressActive, started: current > 0, current, total: current }
  }
}

interface ElectronRequestGlobal {
  __nevixElectronRequest?: (options: unknown) => FakeRequest
}

const { electronReferenceMaterialUploadDependencies, putFile } =
  await import('../../src/main/creation/electron-reference-material-upload.ts')

const signed = {
  method: 'PUT' as const,
  url: 'https://bucket.example/reference-materials/object',
  headers: {
    'Content-Type': 'image/png',
    'X-Oss-Meta-Upload-Id': 'upload-1',
    'X-Oss-Forbid-Overwrite': 'true'
  },
  expiresAt: '2026-09-10T00:00:00Z'
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function withFixture(body: Buffer, run: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'nevix-electron-upload-'))
  const path = join(root, 'fixture.png')
  await writeFile(path, body)
  try {
    await run(path)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('Electron PUT uses chunked bounded backpressure and reports progress', async () => {
  await withFixture(Buffer.alloc(192 * 1024, 7), async (path) => {
    let request: FakeRequest | undefined
    ;(globalThis as typeof globalThis & ElectronRequestGlobal).__nevixElectronRequest = () =>
      (request = new FakeRequest())
    const progress: number[] = []
    const completion = putFile(path, signed, 192 * 1024, (sent) => progress.push(sent))

    await waitFor(() => request?.callbacks.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(request?.writes.length, 1, 'the source must pause until the request callback')
    assert.equal(request?.chunkedEncoding, true)
    assert.ok(progress.some((sent) => sent > 0))

    while (!request?.ended) {
      const release = request?.callbacks.shift()
      if (release) release()
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.deepEqual(await completion, { outcome: 'completed' })
    assert.equal(request.maximumOutstanding, 1)
    assert.equal(Buffer.concat(request.writes).length, 192 * 1024)
  })
})

test('inactive Electron upload progress is ignored', async () => {
  await withFixture(Buffer.alloc(128 * 1024, 9), async (path) => {
    let request: FakeRequest | undefined
    ;(globalThis as typeof globalThis & ElectronRequestGlobal).__nevixElectronRequest = () => {
      request = new FakeRequest()
      request.uploadProgressActive = false
      return request
    }
    const progress: number[] = []
    const completion = putFile(path, signed, 128 * 1024, (sent) => progress.push(sent))

    await waitFor(() => request?.callbacks.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.deepEqual(progress, [])

    while (!request?.ended) {
      const release = request?.callbacks.shift()
      if (release) release()
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.deepEqual(await completion, { outcome: 'completed' })
    assert.deepEqual(progress, [128 * 1024])
  })
})

test('redirect after the first streamed chunk is an uncertain transfer', async () => {
  await withFixture(Buffer.alloc(128 * 1024, 3), async (path) => {
    let request: FakeRequest | undefined
    ;(globalThis as typeof globalThis & ElectronRequestGlobal).__nevixElectronRequest = () =>
      (request = new FakeRequest())
    const completion = putFile(path, signed, 128 * 1024)
    await waitFor(() => request?.writes.length === 1)
    request?.emit('redirect')

    assert.deepEqual(await completion, { outcome: 'uncertain' })
    assert.equal(request?.aborted, true)
  })
})

test('AbortSignal cancels an active native request', async () => {
  await withFixture(Buffer.alloc(128 * 1024, 5), async (path) => {
    let request: FakeRequest | undefined
    ;(globalThis as typeof globalThis & ElectronRequestGlobal).__nevixElectronRequest = () =>
      (request = new FakeRequest())
    const controller = new AbortController()
    const completion = putFile(path, signed, 128 * 1024, undefined, controller.signal)
    await waitFor(() => request?.writes.length === 1)
    controller.abort()

    assert.deepEqual(await completion, { outcome: 'cancelled' })
    assert.equal(request?.aborted, true)
  })
})

test('AbortSignal also cancels a stalled Server control-plane request', async () => {
  let request: FakeRequest | undefined
  ;(globalThis as typeof globalThis & ElectronRequestGlobal).__nevixElectronRequest = () =>
    (request = new FakeRequest(false))
  const controller = new AbortController()
  const completion = electronReferenceMaterialUploadDependencies.createUpload(
    'https://server.example',
    'session-token',
    'session-1',
    {
      idempotencyKey: 'operation-1',
      fileName: 'photo.png',
      declaredKind: 'image',
      declaredMimeType: 'image/png',
      declaredByteSize: 3
    },
    controller.signal
  )
  await waitFor(() => request?.ended === true)
  controller.abort()

  assert.deepEqual(await completion, {
    outcome: 'request-rejected',
    code: 'upload_cancelled'
  })
  assert.equal(request?.aborted, true)
})

test('a growing file is bounded and rejected before request completion', async () => {
  await withFixture(Buffer.alloc(64 * 1024, 9), async (path) => {
    let request: FakeRequest | undefined
    ;(globalThis as typeof globalThis & ElectronRequestGlobal).__nevixElectronRequest = () =>
      (request = new FakeRequest())
    const completion = putFile(path, signed, 64 * 1024)
    await waitFor(() => request?.callbacks.length === 1)
    await appendFile(path, Buffer.alloc(16, 1))
    request?.callbacks.shift()?.()

    assert.deepEqual(await completion, { outcome: 'uncertain' })
    assert.equal(Buffer.concat(request?.writes ?? []).length, 64 * 1024)
    assert.equal(request?.aborted, true)
  })
})

test('an unreadable local path is known not to have sent bytes', async () => {
  assert.deepEqual(await putFile('/path/that/does/not/exist.png', signed, 1), {
    outcome: 'not-sent'
  })
})
