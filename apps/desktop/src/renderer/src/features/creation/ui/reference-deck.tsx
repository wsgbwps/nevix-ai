import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PlusIcon, XIcon } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type {
  DraftReferenceView,
  MaterialKind,
  ReferenceMaterialView
} from '../api/go-creation-http'

/**
 * The Composer's inline reference deck (issue #177, prototype 6e465e8):
 * 48x64 photo cards collapsed into a small stacked pile that expands in place
 * rightward on hover or keyboard focus. One persistent tree animates between
 * the collapsed offsets and the expanded 40px-pitch fan via transforms, so
 * the expansion never reflows the prompt beside it — the prototype overlays
 * the workspace exactly like this. ArrowLeft/ArrowRight move focus, Delete
 * removes the focused card, and the round add entry sits at the pile corner
 * (collapsed) or the fan's end tile (expanded). While the composer is
 * compact, every face scales to 0.625 of the expanded geometry (25px fan
 * pitch). Actual bytes still flow only
 * through the Go trusted data plane — this component renders object URLs the
 * ports layer streamed.
 */

/** Per-depth pose of the fan (expanded) and the pile (collapsed). */
const fanRotations = [-4, 4, -6, 3]
const pileRotations = [2, -4, 5, -5]

export function ReferenceDeck({
  compact = false,
  bindings,
  materials,
  thumbnails,
  cap,
  allowedKinds,
  onAdd,
  onRemove
}: {
  /** True while the composer sits in its compact form (紧凑态). */
  readonly compact?: boolean
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
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [pileHovered, setPileHovered] = useState(false)

  const expanded = pileHovered || focusedId !== null
  const fanPitch = compact ? 25 : 40

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

  // Opening on pointerdown (click then covers only keyboard activation,
  // detail 0): a press pins the composer's expanded form, whose re-render
  // and spring move these entries mid-press — a release-time click can miss.
  function openPickerOnPointerDown(event: React.PointerEvent<HTMLButtonElement>): void {
    if (event.button === 0) fileInputRef.current?.click()
  }

  function openPickerOnKeyboardClick(event: React.MouseEvent<HTMLButtonElement>): void {
    if (event.detail === 0) fileInputRef.current?.click()
  }

  const cardFace = 'size-full overflow-hidden border border-foreground/20 bg-muted shadow-sm'

  return (
    <section
      aria-label={t('composer.deck.label')}
      data-testid="reference-deck"
      className="shrink-0"
    >
      {visible.length === 0 ? (
        <button
          type="button"
          aria-label={t('composer.deck.add')}
          onPointerDown={openPickerOnPointerDown}
          onClick={openPickerOnKeyboardClick}
          className={
            'text-muted-foreground bg-accent hover:border-foreground/10 hover:bg-input hover:text-foreground flex items-center justify-center rounded-lg border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-sky-400/45 ' +
            (compact
              ? 'h-10 w-[30px] transition-[width,height,color,background-color,border-color] duration-[360ms] ease-[cubic-bezier(0.34,1.56,0.64,1)]'
              : 'h-16 w-12 flex-col gap-1 transition-colors duration-[180ms] ease-out')
          }
        >
          <PlusIcon
            className={cn('shrink-0 stroke-[1.5]', compact ? 'size-2.5' : 'size-4')}
            aria-hidden
          />
          {!compact && <span className="text-[8px] leading-3">{t('composer.deck.tile')}</span>}
        </button>
      ) : (
        <div
          role="group"
          aria-label={t('composer.deck.count', { n: visible.length })}
          data-testid="deck-strip"
          className={cn(
            // Rides the composer's 0.36s spring so the deck and bar move as one.
            'relative transition-[width,height] duration-[360ms] ease-[cubic-bezier(0.34,1.56,0.64,1)]',
            compact ? 'h-10 w-[30px]' : 'h-16 w-12'
          )}
          onMouseEnter={() => setPileHovered(true)}
          onMouseLeave={(event) => {
            setPileHovered(false)
            setHoveredId(null)
            if (event.currentTarget.querySelector(':focus-visible') === null) {
              setFocusedId(null)
            }
          }}
          onFocus={() => setPileHovered(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setPileHovered(false)
              setFocusedId(null)
            }
          }}
        >
          {visible.map((binding, position) => {
            const material = byId.get(binding.materialId)
            if (material === undefined) return null
            const depth = visible.length - position - 1
            const isTop = depth === 0
            const isFocused = focusedId === material.id
            // Keyboard equivalence: the remove entry is reachable exactly when
            // its card holds focus; the pointer equivalent is card hover.
            const showRemove = expanded && (hoveredId === material.id || isFocused)
            return (
              <div
                key={material.id}
                role="listitem"
                className="absolute inset-0 transition-[transform,opacity] duration-200 ease-out"
                style={{
                  zIndex: hoveredId === material.id ? 40 : 20 - depth,
                  opacity: expanded ? 1 : 1 - depth * 0.16,
                  transform: expanded
                    ? `translate(${depth * fanPitch}px, 0) rotate(${fanRotations[depth]}deg)`
                    : `translate(${depth * 3}px, ${depth * -2}px) rotate(${pileRotations[depth]}deg) scale(${1 - depth * 0.025})`
                }}
                onMouseEnter={() => setHoveredId(material.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <button
                  type="button"
                  tabIndex={isTop || isFocused ? 0 : -1}
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
                  className={cn(
                    cardFace,
                    compact ? 'rounded-[5px]' : 'rounded-lg',
                    'relative outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50',
                    isTop && 'animate-in fade-in-0 zoom-in-95'
                  )}
                >
                  {thumbnails[material.id] ? (
                    <img src={thumbnails[material.id]} alt="" className="size-full object-cover" />
                  ) : (
                    <span className="text-muted-foreground text-[10px] uppercase">
                      {kindLabel[material.kind]}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  aria-label={t('composer.deck.remove', { name: material.fileName })}
                  title={t('composer.deck.remove', { name: material.fileName })}
                  tabIndex={isFocused ? 0 : -1}
                  onFocus={() => setFocusedId(material.id)}
                  onClick={() => onRemove(material.id)}
                  className={cn(
                    'border-foreground/10 bg-input text-foreground absolute grid place-items-center rounded-full border shadow-md transition-[opacity,transform] duration-[180ms] ease-out outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50',
                    compact ? '-top-[5px] -right-[5px] size-[17.5px]' : '-top-2 -right-2 size-7',
                    showRemove
                      ? 'translate-y-0 scale-100 opacity-100'
                      : 'pointer-events-none translate-y-[3px] scale-[0.98] opacity-0'
                  )}
                >
                  <XIcon className={compact ? 'size-2.5' : 'size-3.5'} aria-hidden />
                </button>
              </div>
            )
          })}
          {!atCap && (
            <button
              type="button"
              aria-label={t('composer.deck.add')}
              onPointerDown={openPickerOnPointerDown}
              onClick={openPickerOnKeyboardClick}
              className={cn(
                'border-foreground/10 bg-input text-foreground absolute inset-0 z-30 flex items-center justify-center border shadow-md transition-[transform,background-color] duration-200 ease-out outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50',
                expanded
                  ? compact
                    ? 'text-muted-foreground hover:bg-accent hover:text-foreground h-10 w-[30px] rounded-lg'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground h-16 w-12 flex-col gap-1 rounded-lg'
                  : compact
                    ? 'hover:bg-accent size-[17.5px] rounded-full'
                    : 'hover:bg-accent size-7 rounded-full'
              )}
              style={{
                // The collapsed circle rides the pile's bottom-right corner.
                transform: expanded
                  ? `translate(${visible.length * fanPitch}px, 0) rotate(-4deg)`
                  : compact
                    ? 'translate(17.5px, 22.5px)'
                    : 'translate(28px, 36px)'
              }}
            >
              <PlusIcon
                className={cn('shrink-0 stroke-[1.5]', compact ? 'size-2.5' : 'size-4')}
                aria-hidden
              />
              {expanded && !compact ? (
                <span className="text-[8px] leading-3">{t('composer.deck.tile')}</span>
              ) : null}
            </button>
          )}
        </div>
      )}
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
