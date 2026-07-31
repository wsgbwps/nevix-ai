import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

// The runtime allowlist must stay in lockstep with the Channel keys declared by
// declaration merging in src/shared/ipc/<domain>/types.ts. The keys are parsed
// from the source text because the compile-time interfaces do not exist at runtime.
const { INVOKE_CHANNEL_ALLOWLIST, EVENT_CHANNEL_ALLOWLIST } =
  await import('../../src/shared/ipc/channel-allowlist.ts')

const sharedIpcRoot = join(import.meta.dirname, '../../src/shared/ipc')

function interfaceKeys(source: string, interfaceName: string): string[] {
  const keys: string[] = []
  for (const declaration of source.matchAll(new RegExp(`interface ${interfaceName}\\s*\\{`, 'g'))) {
    const openIndex = declaration.index + declaration[0].length - 1
    let depth = 0
    let closeIndex = source.length
    for (let index = openIndex; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') {
        depth -= 1
        if (depth === 0) {
          closeIndex = index
          break
        }
      }
    }
    const body = source.slice(openIndex + 1, closeIndex)
    for (const key of body.matchAll(/'([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)'\s*:/g)) {
      keys.push(key[1])
    }
  }
  return keys
}

async function declaredChannelKeys(): Promise<{ invoke: string[]; event: string[] }> {
  const invoke: string[] = []
  const event: string[] = []
  for (const entry of await readdir(sharedIpcRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const source = await readFile(join(sharedIpcRoot, entry.name, 'types.ts'), 'utf8').catch(
      () => null
    )
    if (source === null) continue
    invoke.push(...interfaceKeys(source, 'IpcChannelMap'))
    event.push(...interfaceKeys(source, 'IpcEventMap'))
  }
  return { invoke, event }
}

test('the invoke allowlist matches the declared IpcChannelMap keys exactly', async () => {
  const declared = await declaredChannelKeys()
  assert.ok(declared.invoke.length > 0, 'no declared invoke Channels were parsed')
  assert.deepEqual([...INVOKE_CHANNEL_ALLOWLIST].sort(), declared.invoke.sort())
})

test('the event allowlist matches the declared IpcEventMap keys exactly', async () => {
  const declared = await declaredChannelKeys()
  assert.ok(declared.event.length > 0, 'no declared event Channels were parsed')
  assert.deepEqual([...EVENT_CHANNEL_ALLOWLIST].sort(), declared.event.sort())
})
