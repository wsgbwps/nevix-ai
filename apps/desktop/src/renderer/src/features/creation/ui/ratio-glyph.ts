/**
 * Glyph box for one published ratio ("w:h"): the longest edge scaled to
 * `maxDimension` px so a ratio cell previews the real proportions instead of
 * one uniform rectangle. `null` when the manifest value is not a positive
 * "w:h" pair.
 */
export function ratioGlyphSize(
  ratio: string,
  maxDimension = 20
): { width: number; height: number } | null {
  const [width, height] = ratio.split(':').map(Number)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }
  const scale = maxDimension / Math.max(width, height)
  return { width: width * scale, height: height * scale }
}
