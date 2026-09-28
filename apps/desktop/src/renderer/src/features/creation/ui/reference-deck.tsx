import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import gsap from 'gsap'
import { PlusIcon, XIcon } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type {
  DraftReferenceView,
  MaterialKind,
  ReferenceMaterialView
} from '../api/go-creation-http'
import type { MaterialThumbnailState } from '../model/use-workbench'
import {
  RESULT_DRAG_MIME,
  currentResultDrag,
  decodeResultDrag,
  dropWouldAdmit,
  type ResultDragPayload
} from '../model/reference-drop'
import { ImageWithSkeleton } from './media-with-skeleton'

/**
 * The Composer's inline reference deck (issue #177): 48x64 photo cards in a stacked pile that fans
 * out on hover or keyboard focus. One persistent tree animates between the poses, so expansion
 * never reflows the prompt beside it; ArrowLeft/ArrowRight move focus, Delete removes the focused
 * card. It is also the drop surface for reference materials — drops append or swap a card in place
 * (ADR-0018).
 */

/** Decorative pose tables: the fan indexes by deck position (leftmost card
 * first), the pile by depth (top card first); both repeat past four cards. */
const fanRotations = [-4, 4, -6, 3]
const pileRotations = [2, -4, 5, -5]

/** The live drag verdict that gates the dropEffect and the fan spread. */
type DragState = {
  readonly verdict: 'idle' | 'invite' | 'deny'
  /** The card a single admissible payload would replace; null means append. */
  readonly targetPosition: number | null
  /** True while a single payload hovers the add entry (the append target). */
  readonly appendAim: boolean
}

const idleDrag: DragState = { verdict: 'idle', targetPosition: null, appendAim: false }

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
  frameMode = false,
  bindings,
  materials,
  thumbnails,
  thumbnailStates,
  uploadProgress,
  cardKeyAliases,
  onRetainThumbnail,
  onRequestThumbnail,
  onThumbnailError,
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
  readonly frameMode?: boolean
  /** Ordered draft bindings; the deck order is exactly this order. */
  readonly bindings: readonly DraftReferenceView[]
  readonly materials: readonly ReferenceMaterialView[]
  /** material id -> display URL for image thumbs; absent ids show kind glyphs. */
  readonly thumbnails: Readonly<Record<string, string>>
  readonly thumbnailStates: Readonly<Record<string, MaterialThumbnailState>>
  readonly uploadProgress: Readonly<
    Record<string, { readonly sentBytes: number; readonly totalBytes: number }>
  >
  /** Resolved server id -> staged local id, for a stable card key. */
  readonly cardKeyAliases: Readonly<Record<string, string>>
  readonly onRetainThumbnail: (materialId: string) => () => void
  readonly onRequestThumbnail: (materialId: string) => void
  readonly onThumbnailError: (materialId: string, source: string) => void
  /** Maximum bound cards; the add entry disables at the cap. */
  readonly cap: number
  /** Kinds the current mode's manifest policy allows; empty disables add. */
  readonly allowedKinds: readonly MaterialKind[]
  /** External file drop: appends every admitted file in drop order. */
  readonly onAddFiles: (files: readonly File[]) => void
  /** Single-payload drop on one card: swaps that material, keeping position. */
  readonly onReplace: (position: number, file: File) => void
  /** Result-card drop: promotes the slot output to a new material. */
  readonly onDropResult: (payload: ResultDragPayload, targetPosition: number | null) => void
  /** Mentioned materials can be replaced only while another binding keeps the mention valid. */
  readonly mentionedMaterialIds: ReadonlySet<string>
  /** Fires when a drag enters the deck, so the composer can pin its full form. */
  readonly onDragHover: () => void
  readonly onRemove: (position: number) => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cardRefs = useRef<Map<number, HTMLButtonElement>>(new Map())
  const sectionRef = useRef<HTMLElement>(null)
  const [focusedPosition, setFocusedPosition] = useState<number | null>(null)
  const [hoveredPosition, setHoveredPosition] = useState<number | null>(null)
  const [pileHovered, setPileHovered] = useState(false)
  const [drag, setDrag] = useState<DragState>(idleDrag)

  const dragInvite = drag.verdict === 'invite'
  // Any recognized drag hover spreads the fan — a denied payload sees the
  // same geometry, with the cursor and the still add entry as its signals.
  const expanded = pileHovered || focusedPosition !== null || drag.verdict !== 'idle'
  const fanPitch = compact ? 25 : 40
  const isAppendAim = drag.appendAim

  const kindLabel: Record<ReferenceMaterialView['kind'], string> = {
    image: String(t('composer.deck.kind.image')),
    video: String(t('composer.deck.kind.video')),
    audio: String(t('composer.deck.kind.audio'))
  }
  const byId = useMemo(
    () => new Map(materials.map((material) => [material.id, material] as const)),
    [materials]
  )
  const visible = useMemo(
    () => bindings.filter((binding) => byId.has(binding.materialId)),
    [bindings, byId]
  )
  const visibleIndexes = useMemo(
    () => bindings.flatMap((binding, index) => (byId.has(binding.materialId) ? [index] : [])),
    [bindings, byId]
  )
  const thumbnailMaterialIdsKey = JSON.stringify(
    [
      ...new Set(
        visible.flatMap((binding) => {
          const material = byId.get(binding.materialId)
          return material?.kind === 'image' ? [material.id] : []
        })
      )
    ].sort()
  )
  // Draft restoration can rebuild equivalent binding arrays. Keying the
  // lease by ID content keeps those renders from revoking and re-reading it.
  const thumbnailMaterialIds = useMemo<readonly string[]>(
    () => JSON.parse(thumbnailMaterialIdsKey) as string[],
    [thumbnailMaterialIdsKey]
  )
  // Delta-managed per id: releasing the whole set on any membership change
  // would revoke and reload every painted thumbnail, flashing every card.
  const thumbnailLeasesRef = useRef(new Map<string, () => void>())
  const appliedRetainRef = useRef(onRetainThumbnail)
  useEffect(() => {
    const leases = thumbnailLeasesRef.current
    if (appliedRetainRef.current !== onRetainThumbnail) {
      for (const release of leases.values()) release()
      leases.clear()
      appliedRetainRef.current = onRetainThumbnail
    }
    for (const id of [...leases.keys()]) {
      if (!thumbnailMaterialIds.includes(id)) {
        leases.get(id)?.()
        leases.delete(id)
      }
    }
    for (const id of thumbnailMaterialIds) {
      if (!leases.has(id)) leases.set(id, onRetainThumbnail(id))
    }
  }, [onRetainThumbnail, thumbnailMaterialIds])
  useEffect(
    () => () => {
      for (const release of thumbnailLeasesRef.current.values()) release()
      // StrictMode's effect replay must re-acquire, never skip.
      thumbnailLeasesRef.current.clear()
    },
    []
  )
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

  function moveFocus(current: number | null, direction: -1 | 1): void {
    if (visible.length === 0) return
    const index = current === null ? -1 : visibleIndexes.indexOf(current)
    const nextIndex =
      index < 0
        ? direction > 0
          ? 0
          : visible.length - 1
        : Math.min(visible.length - 1, Math.max(0, index + direction))
    const next = visibleIndexes[nextIndex]
    setFocusedPosition(next)
    // Keyboard equivalence means real DOM focus moves with the arrows; a
    // state-only move would leave Delete acting on the previous card.
    cardRefs.current.get(next)?.focus()
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
   * eligible (single payload, with any prompt mention still bound). */
  function replaceTargetFrom(event: React.DragEvent<HTMLElement>): number | null {
    const card = (event.target as Element | null)?.closest?.('[data-binding-position]')
    if (!(card instanceof Element) || !event.currentTarget.contains(card)) return null
    const position = Number(card.getAttribute('data-binding-position'))
    const materialId = bindings[position]?.materialId
    const stillBound = bindings.some(
      (binding, index) => index !== position && binding.materialId === materialId
    )
    return Number.isInteger(position) &&
      materialId &&
      (stillBound || !mentionedMaterialIds.has(materialId))
      ? position
      : null
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

  function dragOverVerdict(
    payload: HoverPayload,
    targetPosition: number | null
  ): 'invite' | 'deny' {
    const remaining = cap - visible.length
    if (payload.kind === 'result') {
      const kindOk = allowedKinds.includes(payload.payload.mediaType)
      return kindOk && (targetPosition !== null || remaining > 0) ? 'invite' : 'deny'
    }
    // For a replace aim the capacity is irrelevant (a swap never grows the
    // deck), so admission is judged with an unbounded remainder.
    if (targetPosition !== null) {
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
    const targetPosition = single ? replaceTargetFrom(event) : null
    const verdict = dragOverVerdict(payload, targetPosition)
    // Only an admitted payload pops the add entry; a denied one keeps it
    // still so the cursor stays the sole deny signal.
    const appendAim =
      single && verdict === 'invite' && targetPosition === null && overAppendEntry(event)
    event.dataTransfer.dropEffect = verdict === 'invite' ? 'copy' : 'none'
    setDrag((current) =>
      current.verdict === verdict &&
      current.targetPosition === targetPosition &&
      current.appendAim === appendAim
        ? current
        : { verdict, targetPosition, appendAim }
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
      // Admission is judged before requesting server-side promotion, so a
      // denied result never starts a mutation (ADR-0018).
      const kindOk = allowedKinds.includes(payload.mediaType)
      const targetPosition = replaceTargetFrom(event)
      const replacePosition = targetPosition !== null && kindOk ? targetPosition : null
      const appendOk = kindOk && cap - visible.length > 0
      if (replacePosition === null && !appendOk) {
        shakeDeck()
        return
      }
      onDropResult(payload, replacePosition)
      return
    }
    if (!dataTransfer.types.includes('Files')) return
    // Folder entries arrive as type-less, size-less files; they drop out
    // silently rather than counting as rejected materials.
    const files = Array.from(dataTransfer.files).filter((file) => file.type !== '' || file.size > 0)
    if (files.length === 0) return
    if (files.length === 1) {
      const targetPosition = replaceTargetFrom(event)
      if (
        targetPosition !== null &&
        dropWouldAdmit([files[0].type], allowedKinds, Number.MAX_SAFE_INTEGER)
      ) {
        onReplace(targetPosition, files[0])
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
    drag.targetPosition !== null
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
            'text-muted-foreground bg-accent hover:border-foreground/10 hover:bg-input hover:text-foreground flex items-center justify-center border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-sky-400/45 ' +
            (compact
              ? 'h-10 w-[30px] rounded-md transition-[width,height,transform,color,background-color,border-color] duration-[360ms] ease-[cubic-bezier(0.34,1.56,0.64,1)]'
              : 'h-16 w-12 flex-col gap-1 rounded-lg transition-[transform,color,background-color] duration-200 ease-out')
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
            setHoveredPosition(null)
            if (event.currentTarget.querySelector(':focus-visible') === null) {
              setFocusedPosition(null)
            }
          }}
          onFocus={() => setPileHovered(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setPileHovered(false)
              setFocusedPosition(null)
            }
          }}
        >
          {visible.map((binding, position) => {
            const material = byId.get(binding.materialId)
            if (material === undefined) return null
            const bindingPosition = visibleIndexes[position]
            const depth = visible.length - position - 1
            const isTop = depth === 0
            const isFocused = focusedPosition === bindingPosition
            // Keyboard equivalence: the remove entry is reachable exactly when
            // its card holds focus; the pointer equivalent is card hover.
            const showRemove = expanded && (hoveredPosition === bindingPosition || isFocused)
            const isDragTarget = drag.targetPosition === bindingPosition
            const progress = uploadProgress[material.id]
            return (
              <div
                key={`${cardKeyAliases[material.id] ?? material.id}:${position}`}
                role="listitem"
                data-material-id={material.id}
                data-binding-position={bindingPosition}
                data-thumbnail-state={
                  material.kind === 'image'
                    ? (thumbnailStates[material.id] ?? 'unloaded')
                    : undefined
                }
                className="absolute inset-0 transition-[transform,opacity] duration-200 ease-out"
                style={{
                  zIndex: hoveredPosition === bindingPosition ? 40 : 20 - depth,
                  opacity: expanded ? 1 : 1 - depth * 0.16,
                  // Fan x follows deck position (oldest left, newest beside
                  // the add entry); depth still keys the pile pose and z-order.
                  transform: expanded
                    ? `translate(${position * fanPitch}px, 0) rotate(${fanRotations[position % fanRotations.length]}deg)${isDragTarget ? ' translateY(-3px) scale(1.05)' : ''}`
                    : `translate(${depth * 3}px, ${depth * -2}px) rotate(${pileRotations[depth % pileRotations.length]}deg) scale(${1 - depth * 0.025})`
                }}
                onMouseEnter={() => {
                  setHoveredPosition(bindingPosition)
                  if (material.kind === 'image' && thumbnails[material.id] === undefined) {
                    onRequestThumbnail(material.id)
                  }
                }}
                onMouseLeave={() => setHoveredPosition(null)}
              >
                <button
                  type="button"
                  tabIndex={isTop || isFocused ? 0 : -1}
                  aria-label={
                    frameMode && (binding.role === 'first_frame' || binding.role === 'last_frame')
                      ? `${t(binding.role === 'first_frame' ? 'gallery.role.firstFrame' : 'gallery.role.lastFrame')} · ${material.fileName}`
                      : material.fileName
                  }
                  ref={(node) => {
                    if (node) cardRefs.current.set(bindingPosition, node)
                    else cardRefs.current.delete(bindingPosition)
                  }}
                  onFocus={() => {
                    setFocusedPosition(bindingPosition)
                    if (material.kind === 'image' && thumbnails[material.id] === undefined) {
                      onRequestThumbnail(material.id)
                    }
                  }}
                  onKeyDown={(event) => {
                    switch (event.key) {
                      case 'ArrowRight':
                        event.preventDefault()
                        moveFocus(bindingPosition, 1)
                        break
                      case 'ArrowLeft':
                        event.preventDefault()
                        moveFocus(bindingPosition, -1)
                        break
                      case 'Delete':
                      case 'Backspace':
                        event.preventDefault()
                        onRemove(bindingPosition)
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
                  {material.kind === 'image' && thumbnailStates[material.id] !== 'failed' ? (
                    <ImageWithSkeleton
                      src={thumbnails[material.id] ?? null}
                      alt=""
                      loadingLabel={String(t('composer.deck.thumbnailLoading'))}
                      className="size-full object-cover"
                      onError={() => {
                        const source = thumbnails[material.id]
                        if (source !== undefined) onThumbnailError(material.id, source)
                      }}
                    />
                  ) : (
                    <span className="text-muted-foreground grid justify-items-center gap-0.5 text-[10px] uppercase">
                      <span>{kindLabel[material.kind]}</span>
                      {material.kind === 'image' && thumbnailStates[material.id] === 'failed' && (
                        <span className="text-[8px] normal-case" role="alert">
                          {t('composer.deck.thumbnailFailed')}
                        </span>
                      )}
                    </span>
                  )}
                  {progress !== undefined && (
                    <span
                      data-testid="material-upload-progress"
                      role="status"
                      aria-label={t('composer.deck.uploadProgress', {
                        percent: Math.round((progress.sentBytes / progress.totalBytes) * 100)
                      })}
                      className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[8px] text-white"
                    >
                      {Math.round((progress.sentBytes / progress.totalBytes) * 100)}%
                    </span>
                  )}
                  {frameMode &&
                    !compact &&
                    (binding.role === 'first_frame' || binding.role === 'last_frame') &&
                    progress === undefined && (
                      <span className="absolute inset-x-0 bottom-0 bg-black/70 py-0.5 text-[8px] text-white">
                        {t(
                          binding.role === 'first_frame'
                            ? 'gallery.role.firstFrame'
                            : 'gallery.role.lastFrame'
                        )}
                      </span>
                    )}
                </button>
                <button
                  type="button"
                  aria-label={t('composer.deck.remove', { name: material.fileName })}
                  title={t('composer.deck.remove', { name: material.fileName })}
                  tabIndex={isFocused ? 0 : -1}
                  onFocus={() => setFocusedPosition(bindingPosition)}
                  onClick={() => onRemove(bindingPosition)}
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
