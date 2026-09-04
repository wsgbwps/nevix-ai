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

const referenceDrop =
  await import('../../src/renderer/src/features/creation/model/reference-drop.ts')
const { resultFilename } =
  await import('../../src/renderer/src/features/creation/lib/result-filename.ts')

test('mime types map onto the material kind vocabulary', () => {
  const { materialKindOfMimeType } = referenceDrop
  assert.equal(materialKindOfMimeType('image/png'), 'image')
  assert.equal(materialKindOfMimeType('image/webp'), 'image')
  assert.equal(materialKindOfMimeType('video/mp4'), 'video')
  assert.equal(materialKindOfMimeType('audio/mpeg'), 'audio')
  assert.equal(materialKindOfMimeType('application/pdf'), null)
  assert.equal(materialKindOfMimeType(''), null)
})

test('a drop plan admits in order until capacity, rejecting foreign kinds outright', () => {
  const { planFileDrop } = referenceDrop
  const image = { type: 'image/png' }
  const video = { type: 'video/mp4' }
  const pdf = { type: 'application/pdf' }

  const imageOnly = planFileDrop([image, pdf, image], ['image'], 4)
  assert.deepEqual(imageOnly.accepted, [image, image])
  assert.equal(imageOnly.rejectedKind, 1)
  assert.equal(imageOnly.rejectedCap, 0)

  // A valid file behind an invalid one still takes a remaining slot.
  const capped = planFileDrop([pdf, image, video, image], ['image', 'video'], 2)
  assert.deepEqual(capped.accepted, [image, video])
  assert.equal(capped.rejectedKind, 1)
  assert.equal(capped.rejectedCap, 1)

  assert.deepEqual(planFileDrop([image], ['image'], 0).accepted, [])
  assert.equal(planFileDrop([image], ['image'], 0).rejectedCap, 1)
  assert.equal(planFileDrop([image], [], 4).rejectedKind, 1)
})

test('hover admission follows the same rules from item types alone', () => {
  const { dropWouldAdmit } = referenceDrop
  assert.equal(dropWouldAdmit(['image/png', 'application/pdf'], ['image'], 1), true)
  assert.equal(dropWouldAdmit(['application/pdf'], ['image'], 1), false)
  assert.equal(dropWouldAdmit(['image/png'], ['image'], 0), false)
  assert.equal(dropWouldAdmit(['video/mp4'], ['image'], 1), false)
})

test('the internal result drag encodes, decodes, and rejects malformed payloads', () => {
  const { encodeResultDrag, decodeResultDrag } = referenceDrop
  const payload = {
    taskId: 'eeeeeeee-0000-4000-8000-000000000001',
    slotIndex: 2,
    mediaType: 'video'
  }
  assert.deepEqual(decodeResultDrag(encodeResultDrag(payload)), payload)
  assert.equal(decodeResultDrag(null), null)
  assert.equal(decodeResultDrag('not json'), null)
  assert.equal(decodeResultDrag('{"taskId":"t"}'), null)
  assert.equal(
    decodeResultDrag(JSON.stringify({ taskId: 't', slotIndex: 0, mediaType: 'audio' })),
    null
  )
})

test('the live result drag is recorded between dragstart and dragend', () => {
  const { beginResultDrag, currentResultDrag, endResultDrag } = referenceDrop
  assert.equal(currentResultDrag(), null)
  const payload = { taskId: 't', slotIndex: 0, mediaType: 'image' }
  beginResultDrag(payload)
  assert.deepEqual(currentResultDrag(), payload)
  endResultDrag()
  assert.equal(currentResultDrag(), null)
})

test('result filenames keep the download convention across mimes and fallbacks', () => {
  assert.equal(
    resultFilename('eeeeeeee-0000-4000-8000-000000000001', 0, 'image', 'image/jpeg'),
    'nevix-eeeeeeee-1.jpg'
  )
  assert.equal(resultFilename('t', 2, 'video', 'video/mp4'), 'nevix-t-3.mp4')
  assert.equal(resultFilename('t', 0, 'image', null), 'nevix-t-1.png')
  assert.equal(resultFilename('t', 0, 'video', null), 'nevix-t-1.mp4')
  assert.equal(resultFilename('t', 0, 'image', 'image/avif'), 'nevix-t-1.png')
})
