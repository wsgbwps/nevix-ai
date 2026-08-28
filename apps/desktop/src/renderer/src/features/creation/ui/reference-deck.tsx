import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PlusIcon } from 'lucide-react'
import type {
  DraftReferenceView,
  MaterialKind,
  ReferenceMaterialView
} from '../api/go-creation-http'

/**
 * The Composer's inline reference deck (issue #177, prototype 6e465e8):
 * 48x64 photo cards collapsed into a small stacked pile that expands in place
 * rightward on hover or keyboard focus. The expanded layer scrolls
 * horizontally with faded edges when it overflows; ArrowLeft/ArrowRight move
 * focus, Delete removes the focused card, and the add entry stays at the end.
 * Actual bytes still flow only through the Go trusted data plane — this
 * component renders object URLs the ports layer streamed.
 */

const expandRotations = ['-rotate-3', 'rotate-2', '-rotate-6', 'rotate-2']

export function ReferenceDeck({
  bindings,
  materials,
  thumbnails,
  cap,
  allowedKinds,
  onAdd,
  onRemove
}: {
  /** Ordered draft bindings; the deck order is exactly this order. */
  readonly bindings: readonly DraftReferenceView[]
  /** All session materials, for identity/kind lookups. */
  readonly materials: readonly ReferenceMaterialView[]
  /** material id -> object URL for image thumbs; absent ids show kind glyphs. */
  readonly thumbnails: Readonly<Record<string, string>>
  /** Maximum bound cards; the add entry disables at the cap. */
  readonly cap: number
  /** Kinds the current mode's manifest policy allows; empty disables add. */
  readonly allowedKinds: readonly MaterialKind[]
  readonly onAdd: (file: File) => void
  readonly onRemove: (materialId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cardRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [hovering, setHovering] = useState(false)

  const expanded = hovering || focusedId !== null

  // Collapsed and expanded render different trees, so the card a keyboard
  // user focused inside the collapsed pile is remounted on expansion; hand
  // focus back to the same card or the deck would immediately collapse again.
  // Re-focusing after an arrow move is a no-op on the already-focused card.
  useEffect(() => {
    if (expanded && focusedId !== null) {
      cardRefs.current.get(focusedId)?.focus()
    }
  }, [expanded, focusedId])

  const kindLabel: Record<ReferenceMaterialView['kind'], string> = {
    image: String(t('composer.deck.kind.image')),
    video: String(t('composer.deck.kind.video')),
    audio: String(t('composer.deck.kind.audio'))
  }
  const byId = new Map(materials.map((material) => [material.id, material] as const))
  const visible = bindings.filter((binding) => byId.has(binding.materialId))
  const atCap = visible.length >= cap || allowedKinds.length === 0
  // The picker only offers kinds the published mode's envelope accepts; the
  // server stays the authority and re-validates every binding on save.
  const acceptMimes = allowedKinds
    .flatMap((kind) =>
      kind === 'image'
        ? ['image/jpeg', 'image/png', 'image/webp']
        : kind === 'video'
          ? ['video/mp4']
          : ['audio/mpeg', 'audio/x-wav', 'audio/mp4']
    )
    .join(',')

  function moveFocus(current: string | null, direction: -1 | 1): void {
    if (visible.length === 0) return
    const index = current === null ? -1 : visible.findIndex((b) => b.materialId === current)
    const nextIndex =
      index < 0
        ? direction > 0
          ? 0
          : visible.length - 1
        : Math.min(visible.length - 1, Math.max(0, index + direction))
    const next = visible[nextIndex]
    setFocusedId(next.materialId)
    // Keyboard equivalence means real DOM focus moves with the arrows; a
    // state-only move would leave Delete acting on the previous card.
    cardRefs.current.get(next.materialId)?.focus()
  }

  const cardBase =
    'relative h-16 w-12 shrink-0 overflow-visible rounded-lg border border-white/10 bg-muted text-[10px] outline-none transition-transform duration-200 ease-out focus-visible:ring-2 focus-visible:ring-sky-400/50'

  return (
    <section
      aria-label={t('composer.deck.label')}
      data-testid="reference-deck"
      className="min-w-0 shrink-0"
    >
      <div
        className="flex min-h-16 items-center"
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        onFocus={() => setHovering(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setHovering(false)
            setFocusedId(null)
          }
        }}
      >
        {expanded ? (
          // Expanded in place rightward; the layer itself scrolls when the
          // row exceeds the composer width, with faded edges over the
          // scrollable overflow.
          <div
            data-testid="deck-strip"
            role="list"
            aria-label={t('composer.deck.label')}
            className="flex max-w-full items-center gap-2 overflow-x-auto [mask-image:linear-gradient(to_right,transparent,black_10px,black_calc(100%-10px),transparent)] py-2 pr-2"
          >
            {visible.map((binding, position) => {
              const material = byId.get(binding.materialId)
              if (material === undefined) return null
              const isFocused = focusedId === material.id
              return (
                <div
                  key={material.id}
                  role="listitem"
                  className={`relative h-16 w-12 shrink-0 ${expandRotations[position % expandRotations.length]}`}
                >
                  <button
                    type="button"
                    tabIndex={isFocused || position === 0 ? 0 : -1}
                    aria-label={material.fileName}
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
                          onRemove(material.id)
                          break
                        default:
                          return
                      }
                    }}
                    className={`${cardBase} size-full p-0`}
                  >
                    {thumbnails[material.id] ? (
                      <img
                        src={thumbnails[material.id]}
                        alt=""
                        className="size-full rounded-md object-cover"
                      />
                    ) : (
                      <span className="text-muted-foreground uppercase">
                        {kindLabel[material.kind]}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={t('composer.deck.remove', { name: material.fileName })}
                    tabIndex={isFocused ? 0 : -1}
                    onFocus={() => setFocusedId(material.id)}
                    onClick={() => onRemove(material.id)}
                    className="bg-background text-foreground absolute -top-2 -right-2 z-10 flex size-6 items-center justify-center rounded-full border shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50"
                  >
                    ✕
                  </button>
                </div>
              )
            })}
            <button
              type="button"
              disabled={atCap}
              aria-label={t('composer.deck.add')}
              onClick={() => fileInputRef.current?.click()}
              className="text-muted-foreground hover:bg-accent ml-1 flex h-16 w-12 shrink-0 items-center justify-center rounded-lg border border-dashed outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <PlusIcon className="size-4" />
            </button>
          </div>
        ) : (
          // Collapsed: the topmost few cards peek as a small stacked pile.
          <div className="relative h-16 w-12">
            {visible
              .slice(0, 3)
              .map((binding, depth) => {
                const material = byId.get(binding.materialId)
                if (material === undefined) return null
                return (
                  <button
                    key={material.id}
                    type="button"
                    tabIndex={depth === 0 ? 0 : -1}
                    aria-label={material.fileName}
                    ref={(node) => {
                      if (node) cardRefs.current.set(material.id, node)
                      else cardRefs.current.delete(material.id)
                    }}
                    onFocus={() => setFocusedId(material.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setHovering(true)
                      }
                    }}
                    style={{
                      transform: `translate(${depth * 3}px, ${depth * -2}px) rotate(${[2, -4, 5][depth]}deg)`,
                      opacity: 1 - depth * 0.16,
                      zIndex: 20 - depth
                    }}
                    className={`${cardBase} absolute inset-0`}
                  >
                    {thumbnails[material.id] ? (
                      <img
                        src={thumbnails[material.id]}
                        alt=""
                        className="size-full rounded-md object-cover"
                      />
                    ) : (
                      <span className="text-muted-foreground uppercase">
                        {kindLabel[material.kind]}
                      </span>
                    )}
                  </button>
                )
              })
              .reverse()}
            {visible.length === 0 && (
              <button
                type="button"
                aria-label={t('composer.deck.add')}
                onClick={() => fileInputRef.current?.click()}
                className="text-muted-foreground hover:bg-accent absolute inset-0 flex items-center justify-center rounded-lg border border-dashed outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50"
              >
                <PlusIcon className="size-4" />
              </button>
            )}
            {visible.length > 0 && !atCap && (
              <button
                type="button"
                aria-hidden="true"
                tabIndex={-1}
                onClick={() => fileInputRef.current?.click()}
                style={{ transform: 'translate(24px, 40px)', zIndex: 5 }}
                className="bg-background text-muted-foreground absolute -right-1 -bottom-1 flex size-6 items-center justify-center rounded-full border shadow-sm"
              >
                <PlusIcon className="size-3" />
              </button>
            )}
          </div>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept={acceptMimes}
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
