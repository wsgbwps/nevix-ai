import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import gsap from 'gsap'
import { PlusIcon, XIcon } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type {
  DraftReferenceView,
  MaterialKind,
  ReferenceMaterialView
} from '../api/go-creation-http'
import {
  RESULT_DRAG_MIME,
  currentResultDrag,
  decodeResultDrag,
  dropWouldAdmit,
  type ResultDragPayload
} from '../model/reference-drop'

/**
 * The Composer's inline reference deck (issue #177): 48x64 photo cards
 * collapsed into a stacked pile that fans out on hover or keyboard focus.
 * One persistent tree animates between the two poses via transforms, so the
 * expansion never reflows the prompt beside it. ArrowLeft/ArrowRight move
 * focus; Delete removes the focused card.
 *
 * The deck is also the drop surface for reference materials: file and
 * slot-result drops append, or swap a card in place (ADR-0018).
 */

/** Per-depth pose of the fan (expanded) and the pile (collapsed). */
const fanRotations = [-4, 4, -6, 3]
const pileRotations = [2, -4, 5, -5]

/** The live drag verdict that gates the dropEffect and the fan spread. */
type DragState = {
  readonly verdict: 'idle' | 'invite' | 'deny'
  /** The card a single admissible payload would replace; null means append. */
  readonly targetId: string | null
  /** True while a single payload hovers the add entry (the append target). */
  readonly appendAim: boolean
}

const idleDrag: DragState = { verdict: 'idle', targetId: null, appendAim: false }

/** A drag hovering the deck, as readable during dragover (files expose only
 * item types; the internal result drag is identified by its module record). */
type HoverPayload =
  | { readonly kind: 'files'; readonly itemTypes: readonly string[] }
  | { readonly kind: 'result'; readonly payload: ResultDragPayload }

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function ReferenceDeck({
  compact = false,
  bindings,
  materials,
  thumbnails,
  cap,
  allowedKinds,
  onAddFiles,
  onReplace,
  onDropResult,
  mentionedMaterialIds,
  onDragHover,
  onRemove
}: {
  readonly compact?: boolean
  /** Ordered draft bindings; the deck order is exactly this order. */
  readonly bindings: readonly DraftReferenceView[]
  readonly materials: readonly ReferenceMaterialView[]
  /** material id -> object URL for image thumbs; absent ids show kind glyphs. */
  readonly thumbnails: Readonly<Record<string, string>>
  /** Maximum bound cards; the add entry disables at the cap. */
  readonly cap: number
  /** Kinds the current mode's manifest policy allows; empty disables add. */
  readonly allowedKinds: readonly MaterialKind[]
  /** External file drop: appends every admitted file in drop order. */
  readonly onAddFiles: (files: readonly File[]) => void
  /** Single-payload drop on one card: swaps that material, keeping position. */
  readonly onReplace: (materialId: string, file: File) => void
  /** Result-card drop: re-uploads the slot output as a new material. */
  readonly onDropResult: (payload: ResultDragPayload, targetMaterialId: string | null) => void
  /** Materials the prompt's mentions still name; they are never replace targets. */
  readonly mentionedMaterialIds: ReadonlySet<string>
  /** Fires when a drag enters the deck, so the composer can pin its full form. */
  readonly onDragHover: () => void
  readonly onRemove: (materialId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cardRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const sectionRef = useRef<HTMLElement>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [pileHovered, setPileHovered] = useState(false)
  const [drag, setDrag] = useState<DragState>(idleDrag)

  const dragInvite = drag.verdict === 'invite'
  // Any recognized drag hover spreads the fan — a denied payload sees the
  // same geometry, with the cursor and the still add entry as its signals.
  const expanded = pileHovered || focusedId !== null || drag.verdict !== 'idle'
  const fanPitch = compact ? 25 : 40
  const isAppendAim = drag.appendAim

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

  // ---- Drop surface -----------------------------------------------------

  /** The card a drop would replace, when the pointer sits on one that is
   * eligible (single payload, not named by a prompt mention). */
  function replaceTargetFrom(event: React.DragEvent<HTMLElement>): string | null {
    const card = (event.target as Element | null)?.closest?.('[data-material-id]')
    if (!(card instanceof Element) || !event.currentTarget.contains(card)) return null
    const materialId = card.getAttribute('data-material-id')
    return materialId !== null && !mentionedMaterialIds.has(materialId) ? materialId : null
  }

  /** Whether the pointer sits on the add entry — the append drop target. */
  function overAppendEntry(event: React.DragEvent<HTMLElement>): boolean {
    const node = (event.target as Element | null)?.closest?.('[data-drop-aim="append"]')
    return node instanceof Element && event.currentTarget.contains(node)
  }

  function hoverPayloadOf(dataTransfer: DataTransfer): HoverPayload | null {
    if (dataTransfer.types.includes(RESULT_DRAG_MIME)) {
      const active = currentResultDrag()
      return active === null ? null : { kind: 'result', payload: active }
    }
    if (dataTransfer.types.includes('Files')) {
      // Item types are readable during dragover, unlike payload data.
      const itemTypes = Array.from(dataTransfer.items)
        .filter((item) => item.kind === 'file' && item.type !== '')
        .map((item) => item.type)
      return { kind: 'files', itemTypes }
    }
    return null
  }

  function dragOverVerdict(payload: HoverPayload, targetId: string | null): 'invite' | 'deny' {
    const remaining = cap - visible.length
    if (payload.kind === 'result') {
      const kindOk = allowedKinds.includes(payload.payload.mediaType)
      return kindOk && (targetId !== null || remaining > 0) ? 'invite' : 'deny'
    }
    // For a replace aim the capacity is irrelevant (a swap never grows the
    // deck), so admission is judged with an unbounded remainder.
    if (targetId !== null) {
      return dropWouldAdmit(payload.itemTypes, allowedKinds, Number.MAX_SAFE_INTEGER)
        ? 'invite'
        : 'deny'
    }
    return dropWouldAdmit(payload.itemTypes, allowedKinds, remaining) ? 'invite' : 'deny'
  }

  function applyDragOver(event: React.DragEvent<HTMLElement>): void {
    const payload = hoverPayloadOf(event.dataTransfer)
    if (payload === null) return // Unrecognized drag: never droppable here.
    event.preventDefault()
    const single = payload.kind === 'result' || payload.itemTypes.length === 1
    const targetId = single ? replaceTargetFrom(event) : null
    const verdict = dragOverVerdict(payload, targetId)
    // Only an admitted payload pops the add entry; a denied one keeps it
    // still so the cursor stays the sole deny signal.
    const appendAim = single && verdict === 'invite' && targetId === null && overAppendEntry(event)
    event.dataTransfer.dropEffect = verdict === 'invite' ? 'copy' : 'none'
    setDrag((current) =>
      current.verdict === verdict &&
      current.targetId === targetId &&
      current.appendAim === appendAim
        ? current
        : { verdict, targetId, appendAim }
    )
  }

  function dragEnterFromOutside(event: React.DragEvent<HTMLElement>): boolean {
    const related = event.relatedTarget as Node | null
    return related === null || !event.currentTarget.contains(related)
  }

  function onDragEnter(event: React.DragEvent<HTMLElement>): void {
    // DnD suppresses pointerdown/focusin, so the composer's own presence
    // listeners never see a drag — pin its full form from here instead.
    if (dragEnterFromOutside(event)) onDragHover()
  }

  function onDragLeave(event: React.DragEvent<HTMLElement>): void {
    if (dragEnterFromOutside(event)) setDrag(idleDrag)
  }

  function onDrop(event: React.DragEvent<HTMLElement>): void {
    event.preventDefault()
    const wasDenied = drag.verdict === 'deny'
    const dataTransfer = event.dataTransfer
    setDrag(idleDrag)
    if (dataTransfer.types.includes(RESULT_DRAG_MIME)) {
      const payload =
        decodeResultDrag(dataTransfer.getData(RESULT_DRAG_MIME)) ?? currentResultDrag()
      if (payload === null) return
      // Admission is judged before any bytes move: a denied result must
      // not stream its whole blob just to be discarded (ADR-0018).
      const kindOk = allowedKinds.includes(payload.mediaType)
      const targetId = replaceTargetFrom(event)
      const replaceId = targetId !== null && kindOk ? targetId : null
      const appendOk = kindOk && cap - visible.length > 0
      if (replaceId === null && !appendOk) {
        shakeDeck()
        return
      }
      onDropResult(payload, replaceId)
      return
    }
    if (!dataTransfer.types.includes('Files')) return
    // Folder entries arrive as type-less, size-less files; they drop out
    // silently rather than counting as rejected materials.
    const files = Array.from(dataTransfer.files).filter((file) => file.type !== '' || file.size > 0)
    if (files.length === 0) return
    if (files.length === 1) {
      const targetId = replaceTargetFrom(event)
      if (
        targetId !== null &&
        dropWouldAdmit([files[0].type], allowedKinds, Number.MAX_SAFE_INTEGER)
      ) {
        onReplace(targetId, files[0])
        return
      }
    }
    onAddFiles(files)
    if (wasDenied) shakeDeck()
  }

  function shakeDeck(): void {
    if (sectionRef.current === null || prefersReducedMotion()) return
    gsap.to(sectionRef.current, {
      keyframes: { x: [0, -5, 4, -2, 0] },
      duration: 0.35,
      ease: 'power1.out'
    })
  }

  const cardFace = 'size-full overflow-hidden border border-foreground/20 bg-muted shadow-sm'
  const dropTileLabel =
    drag.targetId !== null
      ? String(t('composer.deck.dropReplace'))
      : String(t('composer.deck.dropInvite'))

  return (
    <section
      ref={sectionRef}
      aria-label={t('composer.deck.label')}
      data-testid="reference-deck"
      className="relative shrink-0"
      onDragEnter={onDragEnter}
      onDragOver={applyDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {visible.length === 0 ? (
        <button
          type="button"
          aria-label={t('composer.deck.add')}
          data-drop-aim="append"
          onPointerDown={openPickerOnPointerDown}
          onClick={openPickerOnKeyboardClick}
          className={
            'text-muted-foreground bg-accent hover:border-foreground/10 hover:bg-input hover:text-foreground flex items-center justify-center rounded-lg border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-sky-400/45 ' +
            (compact
              ? 'h-10 w-[30px] transition-[width,height,transform,color,background-color,border-color] duration-[360ms] ease-[cubic-bezier(0.34,1.56,0.64,1)]'
              : 'h-16 w-12 flex-col gap-1 transition-[transform,color,background-color] duration-200 ease-out')
          }
          style={isAppendAim ? { transform: 'scale(1.08)' } : undefined}
        >
          <PlusIcon
            className={cn('shrink-0 stroke-[1.5]', compact ? 'size-2.5' : 'size-4')}
            aria-hidden
          />
          {!compact && (
            <span className="text-[8px] leading-3">
              {dragInvite ? dropTileLabel : t('composer.deck.tile')}
            </span>
          )}
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
            const isDragTarget = drag.targetId === material.id
            return (
              <div
                key={material.id}
                role="listitem"
                data-material-id={material.id}
                className="absolute inset-0 transition-[transform,opacity] duration-200 ease-out"
                style={{
                  zIndex: hoveredId === material.id ? 40 : 20 - depth,
                  opacity: expanded ? 1 : 1 - depth * 0.16,
                  transform: expanded
                    ? `translate(${depth * fanPitch}px, 0) rotate(${fanRotations[depth]}deg)${isDragTarget ? ' translateY(-3px) scale(1.05)' : ''}`
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
                    isTop && 'animate-in fade-in-0 zoom-in-95',
                    isDragTarget && 'border-dashed border-sky-400/80'
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
              data-drop-aim="append"
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
                // The collapsed circle rides the pile's bottom-right corner;
                // an append-aimed drag pops the tile like a replace-aimed card.
                transform: expanded
                  ? `translate(${visible.length * fanPitch}px, 0) rotate(-4deg)${isAppendAim ? ' scale(1.12)' : ''}`
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
                <span className="text-[8px] leading-3">
                  {dragInvite ? dropTileLabel : t('composer.deck.tile')}
                </span>
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
          if (file) onAddFiles([file])
        }}
      />
    </section>
  )
}
