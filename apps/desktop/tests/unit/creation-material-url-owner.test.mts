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

const { MaterialUrlOwner } =
  await import('../../src/renderer/src/features/creation/lib/material-url-owner.ts')

test('thumbnail URLs are replaced and released by one explicit owner', () => {
  const created: string[] = []
  const revoked: string[] = []
  const owner = new MaterialUrlOwner({
    createObjectURL: () => {
      const url = `blob:${created.length + 1}`
      created.push(url)
      return url
    },
    revokeObjectURL: (url) => revoked.push(url)
  })

  assert.equal(owner.replaceThumbnail('image-1', new Blob()), 'blob:1')
  assert.equal(owner.replaceThumbnail('image-1', new Blob()), 'blob:2')
  assert.deepEqual(revoked, ['blob:1'])
  assert.equal(owner.replaceThumbnail('image-2', new Blob()), 'blob:3')

  owner.releaseMaterial('image-1')
  owner.dispose()
  assert.deepEqual(revoked, ['blob:1', 'blob:2', 'blob:3'])
})
