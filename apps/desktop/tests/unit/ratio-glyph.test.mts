import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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

const { ratioGlyphSize } =
  await import('../../src/renderer/src/features/creation/ui/ratio-glyph.ts')

/**
 * Unit coverage for the composer's ratio glyph sizing: a published "w:h"
 * string becomes a preview box whose longest edge is the given dimension and
 * whose proportions match the ratio, while anything the manifest could not
 * publish as a positive pair stays null.
 */

function assertClose(
  actual: { width: number; height: number } | null,
  expected: { width: number; height: number }
): void {
  assert.ok(actual !== null)
  assert.ok(Math.abs(actual.width - expected.width) < 1e-9)
  assert.ok(Math.abs(actual.height - expected.height) < 1e-9)
}

describe('ratioGlyphSize', () => {
  it('scales the longest edge and keeps the published proportions', () => {
    assertClose(ratioGlyphSize('1:1', 20)!, { width: 20, height: 20 })
    assertClose(ratioGlyphSize('16:9', 20)!, { width: 20, height: 11.25 })
    assertClose(ratioGlyphSize('9:16', 20)!, { width: 11.25, height: 20 })
    assertClose(ratioGlyphSize('4:3', 20)!, { width: 20, height: 15 })
    assertClose(ratioGlyphSize('3:4', 20)!, { width: 15, height: 20 })
  })

  it('honors a custom max dimension', () => {
    assertClose(ratioGlyphSize('21:9', 21)!, { width: 21, height: 9 })
  })

  it('rejects values outside a positive w:h pair', () => {
    assert.equal(ratioGlyphSize('abc', 20), null)
    assert.equal(ratioGlyphSize('0:9', 20), null)
    assert.equal(ratioGlyphSize('3:0', 20), null)
    assert.equal(ratioGlyphSize('3:-3', 20), null)
    assert.equal(ratioGlyphSize('', 20), null)
  })
})
