/**
 * Pure Capability-Manifest derivations for the Composer (issue #177): the
 * manifest is the only source of submittable candidates, and a draft value
 * the current manifest has removed is reported as stale while the value
 * itself is preserved verbatim — the composer never rewrites the creator's
 * intent. These functions stay framework-free so component tests can drive
 * them through the rendered UI only.
 */

import type {
  CapabilityManifest,
  CapabilityMedia,
  CapabilityMediaMode,
  CapabilityModel
} from '../api/capability-manifest-http'
import type { DraftReferenceRole, LocalDraftRecord, MaterialKind } from '../api/go-creation-http'

export type DraftMediaType = 'image' | 'video'

/**
 * The material kinds a draft role structurally accepts — the client twin of
 * the server's role/kind rule, used to gate the deck's add entry and to keep
 * re-roling kind-compatible bindings only.
 */
export function roleAcceptsKind(role: DraftReferenceRole, kind: MaterialKind): boolean {
  switch (role) {
    case 'reference':
    case 'first_frame':
    case 'last_frame':
      return kind === 'image'
    case 'omni':
      return true
  }
}

/**
 * The material kinds the add entry may bind under the current manifest,
 * media, and mode. Video takes the published mode's own per-media envelopes
 * (video modes are explicitly chosen). Image modes derive from the deck —
 * the composer offers no image mode picker — so any available image
 * capability accepts images; adding the first one derives the mode. While no
 * manifest is present every kind stays addable so drafting never depends on
 * provider state; with the media itself unavailable nothing new can be bound.
 */
export function allowedReferenceKinds(
  manifest: CapabilityManifest | null,
  media: DraftMediaType | null,
  mode: string | null
): readonly MaterialKind[] {
  const everyKind: readonly MaterialKind[] = ['image', 'video', 'audio']
  if (manifest === null || media === null) return everyKind
  const capability = mediaCapability(manifest, media)
  if (capability === null || !capability.available) return []
  if (media === 'image') return ['image']
  const published = (capability.modes ?? []).find((entry) => entry.id === mode)
  if (!published) return everyKind
  const kinds: MaterialKind[] = []
  if (published.referenceMaterial.image) kinds.push('image')
  if (published.referenceMaterial.video) kinds.push('video')
  if (published.referenceMaterial.audio) kinds.push('audio')
  return kinds
}

/** Defensive deck cap used only while no manifest has ever been seen. */
export const fallbackReferenceCap = 4

/** The fields of a draft the manifest can individually validate. */
export type DraftStaleField =
  | 'mediaType'
  | 'model'
  | 'mode'
  | 'ratio'
  | 'resolution'
  | 'quantity'
  | 'durationSeconds'
  | 'references'

/**
 * The composer's view of one media capability: `null` when the manifest is
 * entirely absent (never loaded / failed closed), otherwise the media entry
 * with its `available` verdict.
 */
export function mediaCapability(
  manifest: CapabilityManifest | null,
  media: DraftMediaType
): CapabilityMedia | null {
  if (manifest === null) return null
  return media === 'image' ? manifest.image : manifest.video
}

/** Candidate models for one media, in manifest order; empty when unavailable. */
export function modelCandidates(
  manifest: CapabilityManifest | null,
  media: DraftMediaType
): readonly string[] {
  const capability = mediaCapability(manifest, media)
  if (capability === null || !capability.available) return []
  return (capability.models ?? []).map((model) => model.model)
}

/** The published model entry for one model ID; null when not submittable. */
export function publishedModel(
  manifest: CapabilityManifest | null,
  media: DraftMediaType,
  model: string
): CapabilityModel | null {
  const capability = mediaCapability(manifest, media)
  if (capability === null || !capability.available) return null
  return (capability.models ?? []).find((entry) => entry.model === model) ?? null
}

/**
 * Resolution tiers of the selected model; empty while no (published) model
 * is selected — the tiers are model-scoped, so a stale model legitimately
 * publishes none.
 */
export function resolutionCandidates(
  manifest: CapabilityManifest | null,
  media: DraftMediaType,
  model: string | null
): readonly string[] {
  if (model === null) return []
  return publishedModel(manifest, media, model)?.resolutions ?? []
}

/**
 * The vendor pixel size the server submits for this exact (model, ratio,
 * resolution) selection — the manifest publishes the same table the adapter
 * resolves, so the composer can show the exact output size. `null` while any
 * dimension is stale or the combination is unpublished (display only: it
 * never gates submission).
 */
export function publishedSize(
  manifest: CapabilityManifest | null,
  media: DraftMediaType,
  model: string | null,
  ratio: string | null,
  resolution: string | null
): { width: number; height: number } | null {
  if (model === null || ratio === null || resolution === null) return null
  const size = publishedModel(manifest, media, model)?.sizes?.find(
    (entry) => entry.ratio === ratio && entry.resolution === resolution
  )
  return size ? { width: size.width, height: size.height } : null
}

/** Candidate modes for one media in manifest order. */
export function modeCandidates(
  manifest: CapabilityManifest | null,
  media: DraftMediaType
): readonly CapabilityMediaMode[] {
  const capability = mediaCapability(manifest, media)
  if (capability === null || !capability.available) return []
  return (capability.modes ?? []).map((mode) => mode.id)
}

/** Reference-count bounds of one mode; null when the mode is not published. */
export function modeReferenceBounds(
  manifest: CapabilityManifest | null,
  media: DraftMediaType,
  mode: string
): { min: number; max: number } | null {
  const capability = mediaCapability(manifest, media)
  if (capability === null || !capability.available) return null
  const match = (capability.modes ?? []).find((entry) => entry.id === mode)
  return match ? { ...match.referenceMaterial.total } : null
}

/**
 * The deck cap for one (model, mode) selection. Image modes derive from the
 * deck, so the cap is the selected model's own reference ceiling — the mode
 * total only backs it up when the model is absent or stale (and the zero of
 * a not-yet-derived text-to-image never caps the deck). Video takes the
 * published mode's max.
 */
export function referenceCap(
  manifest: CapabilityManifest | null,
  media: DraftMediaType,
  model: string | null,
  mode: string | null
): number {
  if (media === 'image') {
    const ceiling =
      model === null ? null : (publishedModel(manifest, media, model)?.maxReferenceImages ?? null)
    if (ceiling !== null) return ceiling
    const bounds = mode === null ? null : modeReferenceBounds(manifest, media, mode)
    if (bounds !== null && bounds.max > 0) return bounds.max
    return fallbackReferenceCap
  }
  if (mode === null) return fallbackReferenceCap
  const bounds = modeReferenceBounds(manifest, media, mode)
  return bounds === null ? fallbackReferenceCap : bounds.max
}

/**
 * The role a material binding carries at a deck position for one known mode.
 * Unknown (stale) modes return null so existing bindings keep their roles —
 * a stale draft is never silently re-roled.
 */
export function roleForPosition(
  media: DraftMediaType,
  mode: string | null,
  position: number
): DraftReferenceRole | null {
  if (mode === null) return null
  if (media === 'image') {
    return mode === 'reference-image' ? 'reference' : null
  }
  switch (mode) {
    case 'first-frame':
      return position === 0 ? 'first_frame' : null
    case 'first-last-frame':
      if (position === 0) return 'first_frame'
      if (position === 1) return 'last_frame'
      return null
    case 'omni-reference':
      return 'omni'
    default:
      return null
  }
}

/**
 * Validates one draft against the current manifest and reports the
 * stale fields. Values stay untouched; the caller surfaces each stale field
 * with its stable reason and keeps submission blocked. A missing manifest
 * reports nothing stale — without a verdict there is no claim to preserve or
 * reject, only the offline editing state.
 */
export function staleDraftFields(
  manifest: CapabilityManifest | null,
  draft: LocalDraftRecord
): ReadonlySet<DraftStaleField> {
  const stale = new Set<DraftStaleField>()
  if (manifest === null) return stale

  const media = draft.mediaType
  if (media === null) {
    stale.add('mediaType')
    return stale
  }
  const capability = mediaCapability(manifest, media)
  if (capability === null || !capability.available) {
    stale.add('mediaType')
    return stale
  }

  if (draft.model === null || !modelCandidates(manifest, media).includes(draft.model)) {
    stale.add('model')
  }
  const publishedModes = new Set(modeCandidates(manifest, media))
  if (draft.mode === null || !publishedModes.has(draft.mode as CapabilityMediaMode)) {
    stale.add('mode')
    // Without a published mode the reference bounds cannot be judged either.
    stale.add('references')
    return stale
  }
  if (media === 'image') {
    if (draft.ratio !== null && !(capability.ratios ?? []).includes(draft.ratio)) {
      stale.add('ratio')
    }
    if (draft.quantity === null || !(capability.quantities ?? []).includes(draft.quantity)) {
      stale.add('quantity')
    }
  } else if (
    draft.durationSeconds === null ||
    !(capability.durations ?? []).includes(draft.durationSeconds)
  ) {
    stale.add('durationSeconds')
  }
  if (
    draft.resolution === null ||
    !resolutionCandidates(manifest, media, draft.model).includes(draft.resolution)
  ) {
    stale.add('resolution')
  }

  const bounds = modeReferenceBounds(manifest, media, draft.mode)
  if (bounds === null) {
    stale.add('references')
  } else {
    // The mode total is the widest cross-model bound; a published model's
    // reference ceiling is the binding one.
    const ceiling =
      draft.model === null
        ? null
        : (publishedModel(manifest, media, draft.model)?.maxReferenceImages ?? null)
    const max = ceiling !== null && ceiling < bounds.max ? ceiling : bounds.max
    if (draft.references.length < bounds.min || draft.references.length > max) {
      stale.add('references')
    }
  }
  return stale
}
