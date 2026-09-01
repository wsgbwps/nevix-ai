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
import type { DraftReferenceRole, MaterialKind, SessionDraftView } from '../api/go-creation-http'

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
 * media, and mode: the published mode's own per-media envelopes. While no
 * manifest or only a stale mode is present, every kind stays addable so
 * drafting never depends on provider state; with the media itself
 * unavailable nothing new can be bound (the stable reason explains why).
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

/** The deck cap: the selected mode's max when published, else the fallback. */
export function referenceCap(
  manifest: CapabilityManifest | null,
  media: DraftMediaType,
  mode: string | null
): number {
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
 * Validates one stored draft against the current manifest and reports the
 * stale fields. Values stay untouched; the caller surfaces each stale field
 * with its stable reason and keeps submission blocked. A missing manifest
 * reports nothing stale — without a verdict there is no claim to preserve or
 * reject, only the offline editing state.
 */
export function staleDraftFields(
  manifest: CapabilityManifest | null,
  draft: SessionDraftView
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
  } else if (draft.references.length < bounds.min || draft.references.length > bounds.max) {
    stale.add('references')
  }
  return stale
}
