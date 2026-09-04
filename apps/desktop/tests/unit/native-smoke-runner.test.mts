import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { resolvePackagedExecutable } from '../../scripts/run-native-smoke.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nevix-native-smoke-runner-'))
  roots.push(root)
  return root
}

async function createFile(root: string, path: string): Promise<string> {
  const absolutePath = join(root, path)
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, '')
  return absolutePath
}

test('resolves the unique macOS application executable', async () => {
  const root = await createRoot()
  const executable = await createFile(root, 'dist/mac-arm64/Nevix AI.app/Contents/MacOS/Nevix AI')
  await createFile(root, 'dist/mac-arm64/Nevix AI.app/Contents/Resources/Nevix AI')

  assert.equal(await resolvePackagedExecutable(root, 'darwin'), executable)
})

test('resolves the unique Windows unpacked executable', async () => {
  const root = await createRoot()
  const executable = await createFile(root, 'dist/win-unpacked/Nevix AI.exe')
  await createFile(root, 'dist/Nevix AI.exe')

  assert.equal(await resolvePackagedExecutable(root, 'win32'), executable)
})

test('fails when no packaged executable exists', async () => {
  const root = await createRoot()

  await assert.rejects(resolvePackagedExecutable(root, 'darwin'), /found 0: none/)
})

test('fails when more than one packaged executable matches', async () => {
  const root = await createRoot()
  await createFile(root, 'dist/mac/Nevix AI.app/Contents/MacOS/Nevix AI')
  await createFile(root, 'dist/mac-universal/Nevix AI.app/Contents/MacOS/Nevix AI')

  await assert.rejects(resolvePackagedExecutable(root, 'darwin'), /found 2:/)
})
