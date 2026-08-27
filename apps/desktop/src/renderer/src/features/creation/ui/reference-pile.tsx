import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PlusIcon } from 'lucide-react'
import type { ReferenceMaterialView } from '../api/go-creation-http'

/**
 * The Reference Material pile: 48x64 collapsed thumbnails that expand in
 * place on hover or keyboard focus, scroll horizontally when the expanded
 * layer overflows, move focus with the arrow keys, and delete with the
 * Delete key — the hover interaction always has a keyboard equivalent.
 */
export function ReferencePile({
  materials,
  thumbnails,
  onAdd,
  onDelete
}: {
  readonly materials: readonly ReferenceMaterialView[]
  /** material id -> object URL for image thumbs; absent ids show kind glyph. */
  readonly thumbnails: Readonly<Record<string, string>>
  readonly onAdd: (file: File) => void
  readonly onDelete: (materialId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const kindLabel: Record<ReferenceMaterialView['kind'], string> = {
    image: String(t('pile.kind.image')),
    video: String(t('pile.kind.video')),
    audio: String(t('pile.kind.audio'))
  }
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cardRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [hovering, setHovering] = useState(false)

  const expanded = hovering || focusedId !== null

  function moveFocus(current: string | null, direction: -1 | 1): void {
    if (materials.length === 0) return
    const index = current === null ? null : materials.findIndex((m) => m.id === current)
    const nextIndex =
      index === null || index < 0
        ? direction > 0
          ? 0
          : materials.length - 1
        : Math.min(materials.length - 1, Math.max(0, index + direction))
    const next = materials[nextIndex]
    setFocusedId(next.id)
    // Keyboard equivalence means real DOM focus moves with the arrows; a
    // state-only move would leave Delete acting on the previous card.
    cardRefs.current.get(next.id)?.focus()
  }

  return (
    <section aria-label={t('pile.label')} data-testid="reference-pile" className="min-w-0">
      <div
        className="group/pile relative flex h-16 items-center"
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        onFocus={() => setHovering(true)}
        onBlur={() => setHovering(false)}
      >
        {/* Collapsed stack: the topmost few cards peek; expands in place. */}
        <div
          className={
            expanded
              ? 'bg-background/95 absolute inset-y-0 left-0 z-10 flex max-w-full items-center gap-1 overflow-x-auto rounded-md border px-1 shadow-sm'
              : 'flex max-w-56 items-center gap-1 overflow-hidden'
          }
          data-testid="pile-strip"
          role="list"
          aria-label={t('pile.label')}
        >
          {materials.map((material) => {
            const isFocused = focusedId === material.id
            return (
              <button
                key={material.id}
                type="button"
                role="listitem"
                tabIndex={isFocused ? 0 : expanded ? -1 : 0}
                aria-label={material.fileName}
                className="bg-muted focus-visible:ring-ring relative h-12 w-16 shrink-0 rounded border text-xs outline-none focus-visible:ring-2"
                ref={(node) => {
                  if (node) cardRefs.current.set(material.id, node)
                  else cardRefs.current.delete(material.id)
                }}
                onFocus={() => setFocusedId(material.id)}
                onKeyDown={(event) => {
                  switch (event.key) {
                    case 'ArrowRight':
                      event.preventDefault()
                      moveFocus(material.id, 1)
                      break
                    case 'ArrowLeft':
                      event.preventDefault()
                      moveFocus(material.id, -1)
                      break
                    case 'Delete':
                    case 'Backspace':
                      event.preventDefault()
                      onDelete(material.id)
                      break
                    default:
                      return
                  }
                }}
              >
                {thumbnails[material.id] ? (
                  <img
                    src={thumbnails[material.id]}
                    alt=""
                    className="h-full w-full rounded object-cover"
                  />
                ) : (
                  <span className="text-muted-foreground uppercase">
                    {kindLabel[material.kind]}
                  </span>
                )}
              </button>
            )
          })}
          <button
            type="button"
            className="text-muted-foreground ml-1 flex size-8 shrink-0 items-center justify-center rounded border border-dashed"
            aria-label={t('pile.add')}
            onClick={() => fileInputRef.current?.click()}
          >
            <PlusIcon className="size-4" />
          </button>
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,video/mp4,audio/mpeg,audio/x-wav,audio/mp4"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) onAdd(file)
        }}
      />
    </section>
  )
}
