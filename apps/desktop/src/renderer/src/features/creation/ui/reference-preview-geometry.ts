export interface PreviewAnchorRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly width: number
  readonly height: number
}

export interface PreviewSize {
  readonly width: number
  readonly height: number
}

export interface HoverPreviewRect extends PreviewSize {
  readonly left: number
  readonly top: number
  readonly side: 'above' | 'below'
}

const margin = 12
const gap = 12

/** Places an aspect-preserving image preview around its mention chip. */
export function hoverPreviewRect(
  anchor: PreviewAnchorRect,
  intrinsic: PreviewSize,
  viewport: PreviewSize
): HoverPreviewRect {
  let width = Math.min(180, Math.max(1, viewport.width - margin * 2))
  let height = width * (intrinsic.height / intrinsic.width)
  const above = Math.max(0, anchor.top - gap - margin)
  const below = Math.max(0, viewport.height - anchor.bottom - gap - margin)
  const side = height <= above ? 'above' : height <= below || below > above ? 'below' : 'above'
  const available = side === 'above' ? above : below
  if (height > available) {
    width *= available / height
    height = available
  }
  const center = anchor.left + anchor.width / 2
  const left = Math.min(viewport.width - margin - width, Math.max(margin, center - width / 2))
  const top = side === 'above' ? anchor.top - gap - height : anchor.bottom + gap
  return { left, top, width, height, side }
}
