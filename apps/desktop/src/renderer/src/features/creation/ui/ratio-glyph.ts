function parseRatio(ratio: string): { width: number; height: number } | null {
  const [width, height] = ratio.split(':').map(Number)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }
  return { width, height }
}

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
  const parsed = parseRatio(ratio)
  if (parsed === null) return null
  const scale = maxDimension / Math.max(parsed.width, parsed.height)
  return { width: parsed.width * scale, height: parsed.height * scale }
}

/**
 * Glyph box for one published ratio ("w:h") scaled by constant diagonal, so
 * every ratio previews at the same perceived size (the reference design's
 * square reads ~12px while 21:9 reads ~15x7). `null` for a non-positive
 * "w:h" pair.
 */
export function ratioGlyphDiagonalSize(
  ratio: string,
  diagonal = 16
): { width: number; height: number } | null {
  const parsed = parseRatio(ratio)
  if (parsed === null) return null
  const scale = diagonal / Math.hypot(parsed.width, parsed.height)
  return { width: parsed.width * scale, height: parsed.height * scale }
}
