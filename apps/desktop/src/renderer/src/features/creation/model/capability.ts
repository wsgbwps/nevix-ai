/**
 * Pure Capability-Manifest derivations for the Composer (issue #177): the manifest is the only
 * source of submittable candidates, and a draft value it removed is reported stale while the value
 * stays verbatim — the composer never rewrites the creator's intent. Framework-free for component
 * tests.
 */

import type {
  CapabilityManifest,
  CapabilityMedia,
  CapabilityMediaMode,
  CapabilityMode,
  CapabilityModel
} from '../api/capability-manifest-http'
import type {
  DraftReferenceRole,
  MaterialKind,
  ReferenceMaterialView
} from '../api/go-creation-http'
import {
  publishedParameterRules,
  type DraftMediaType,
  type GenerationParameterId,
  type GenerationParameterValues
} from '../api/generation-parameter'

export type { DraftMediaType }

const frameModes = new Set(['text-to-video', 'first-frame', 'first-last-frame'])

export function videoComposerMode(mode: string | null): string | null {
  return mode !== null && frameModes.has(mode) ? 'first-last-frame' : mode
}

export function normalizedVideoMode(mode: string | null, referenceCount: number): string | null {
  if (mode === null || (!frameModes.has(mode) && mode !== 'omni-reference')) return mode
  if (referenceCount === 0) return 'text-to-video'
  if (mode === 'omni-reference') return mode
  return referenceCount === 1 ? 'first-frame' : 'first-last-frame'
}

export function composerReferencePolicy(
  manifest: CapabilityManifest | null,
  media: DraftMediaType | null,
  mode: string | null
): CapabilityMode['referenceMaterial'] | null {
  if (media === null) return null
  const capability = mediaCapability(manifest, media)
  if (!capability?.available) return null
  const chosen = media === 'video' ? videoComposerMode(mode) : mode
  return capability.modes?.find((entry) => entry.id === chosen)?.referenceMaterial ?? null
}

export function materialFitsReferenceEnvelope(
  material: Pick<
    ReferenceMaterialView,
    'kind' | 'mimeType' | 'byteSize' | 'widthPx' | 'heightPx' | 'pixelCount' | 'durationMs'
  >,
  policy: NonNullable<ReturnType<typeof composerReferencePolicy>>
): boolean {
  const envelope = policy[material.kind]
  if (!envelope || material.byteSize > envelope.maxBytes) return false
  const formats: Record<string, string> = {
    'image/jpeg': 'jpeg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a'
  }
  const format = formats[material.mimeType]
  if (format === undefined || !envelope.formats.includes(format)) return false
  if (material.kind === 'image' && 'minPx' in envelope) {
    const { widthPx: width, heightPx: height, pixelCount } = material
    if (
      (width !== null && (width < envelope.minPx || width > envelope.maxPx)) ||
      (height !== null && (height < envelope.minPx || height > envelope.maxPx)) ||
      (pixelCount !== null && pixelCount > envelope.maxPixels)
    )
      return false
    if (width !== null && height !== null) {
      const aspect = width / height
      if (aspect < envelope.minAspect || aspect > envelope.maxAspect) return false
    }
  } else if ('minSeconds' in envelope && material.durationMs !== null) {
    if (
      material.durationMs < envelope.minSeconds * 1000 ||
      material.durationMs > envelope.maxSeconds * 1000
    )
      return false
  }
  return true
}

/**
 * The material kinds a draft role structurally accepts — the client twin of
 * the server's role/kind rule. It gates the deck's add entry and keeps
 * re-roling to kind-compatible bindings.
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

/** Returns the material kinds accepted by the composer's current manifest policy. */
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
  const published = (capability.modes ?? []).find((entry) => entry.id === videoComposerMode(mode))
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
export type DraftStaleField = GenerationParameterId | 'references'

interface DraftCapabilityState extends GenerationParameterValues {
  readonly references: readonly { readonly materialId: string; readonly role: DraftReferenceRole }[]
}

/**
 * `null` when the manifest is entirely absent (never loaded / failed closed),
 * otherwise the media entry with its `available` verdict.
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
 * Resolution tiers of the selected model; empty while no published model is
 * selected — tiers are model-scoped, so a stale model legitimately has none.
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
 * The vendor pixel size the server submits for this exact (model, ratio, resolution) selection —
 * the manifest publishes the table the adapter resolves. `null` while any dimension is stale or
 * unpublished (display only: it never gates submission).
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
 * The deck cap for one (model, mode) selection. Image modes derive from the deck, so the cap is the
 * selected model's reference ceiling; the mode total only backs it up when the model is absent or
 * stale, whose zero must not cap the deck. Video takes the published mode's max.
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
  const policy = composerReferencePolicy(manifest, media, mode)
  return policy === null ? fallbackReferenceCap : policy.total.max
}

/**
 * The role a binding carries at a deck position for one known mode. Unknown
 * (stale) modes return null so bindings keep their roles — a stale draft is
 * never silently re-roled.
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
  switch (videoComposerMode(mode)) {
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
 * Reports a draft's stale fields against the current manifest. Values stay untouched; the caller
 * surfaces each stale field with its stable reason and keeps submission blocked. A missing manifest
 * reports nothing stale — without a verdict there is no claim to reject, only the offline state.
 */
export function staleDraftFields(
  manifest: CapabilityManifest | null,
  draft: DraftCapabilityState,
  materials?: readonly ReferenceMaterialView[]
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
  const mode =
    media === 'video' ? normalizedVideoMode(draft.mode, draft.references.length) : draft.mode
  if (
    mode === null ||
    !publishedModes.has(mode as CapabilityMediaMode) ||
    (media === 'video' &&
      draft.mode === 'first-last-frame' &&
      !publishedModes.has('first-last-frame')) ||
    (media === 'video' && draft.mode === 'omni-reference' && !publishedModes.has('omni-reference'))
  ) {
    stale.add('mode')
    // Without a published mode the reference bounds cannot be judged either.
    stale.add('references')
    return stale
  }
  // A field the media does not publish gets no verdict here — the admission
  // freeze judges its value server-side.
  for (const rule of publishedParameterRules(capability)) {
    const value = draft[rule.id]
    if (value === null ? !rule.mayStayUnset : !rule.candidates.includes(value)) {
      stale.add(rule.id)
    }
  }
  if (
    media === 'video' &&
    (draft.ratio === null ||
      ((mode === 'first-frame' || mode === 'first-last-frame') && draft.ratio !== 'adaptive'))
  )
    stale.add('ratio')
  if (
    draft.resolution === null ||
    !resolutionCandidates(manifest, media, draft.model).includes(draft.resolution)
  ) {
    stale.add('resolution')
  }

  const bounds = modeReferenceBounds(manifest, media, mode)
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
  if (media === 'video' && materials !== undefined) {
    const policy = capability.modes?.find((entry) => entry.id === mode)?.referenceMaterial
    const byId = new Map(materials.map((material) => [material.id, material]))
    const counts: Record<MaterialKind, number> = { image: 0, video: 0, audio: 0 }
    for (const [position, reference] of draft.references.entries()) {
      const material = byId.get(reference.materialId)
      if (
        material === undefined ||
        !policy ||
        reference.role !== roleForPosition('video', mode, position) ||
        !roleAcceptsKind(reference.role, material.kind) ||
        !materialFitsReferenceEnvelope(material, policy)
      ) {
        stale.add('references')
      }
      if (material) counts[material.kind] += 1
    }
    for (const kind of ['image', 'video', 'audio'] as const) {
      const limits = policy?.[kind]?.count
      if (limits ? counts[kind] < limits.min || counts[kind] > limits.max : counts[kind] > 0) {
        stale.add('references')
      }
    }
  }
  return stale
}
