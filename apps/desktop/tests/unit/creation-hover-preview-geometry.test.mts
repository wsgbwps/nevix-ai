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

const { hoverPreviewRect } =
  await import('../../src/renderer/src/features/creation/ui/reference-preview-geometry.ts')

test('image hover keeps 180px width, centers above, and preserves ratio', () => {
  assert.deepEqual(
    hoverPreviewRect(
      { left: 500, top: 500, right: 560, bottom: 524, width: 60, height: 24 },
      { width: 720, height: 360 },
      { width: 1200, height: 800 }
    ),
    { left: 440, top: 398, width: 180, height: 90, side: 'above' }
  )
})

test('image hover flips below near the top and scales the whole preview into the viewport', () => {
  assert.deepEqual(
    hoverPreviewRect(
      { left: 100, top: 30, right: 140, bottom: 54, width: 40, height: 24 },
      { width: 360, height: 720 },
      { width: 300, height: 220 }
    ),
    { left: 84.5, top: 66, width: 71, height: 142, side: 'below' }
  )
})

test('image hover chooses the side with room when neither side fits at full size', () => {
  assert.deepEqual(
    hoverPreviewRect(
      { left: 500, top: 600, right: 560, bottom: 624, width: 60, height: 24 },
      { width: 360, height: 1080 },
      { width: 1200, height: 700 }
    ),
    { left: 440, top: 48, width: 180, height: 540, side: 'above' }
  )
})
