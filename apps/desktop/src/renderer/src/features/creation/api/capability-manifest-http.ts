/**
 * The Capability Manifest client (contracts/creation.yaml, issue #158): the
 * Workbench's only source of submittable values. An unavailable media carries
 * the server's stable reason and action verbatim — the caller keeps any stale
 * draft values and blocks submission instead of guessing provider state.
 */

import { request, type CreationApiFailure, type CreationApiResult } from './go-creation-http'

export type CapabilityMediaMode =
  | 'text-to-image'
  | 'reference-image'
  | 'text-to-video'
  | 'first-frame'
  | 'first-last-frame'
  | 'omni-reference'

/** Stable instance-connection unavailability causes. */
export type CapabilityReason =
  | 'not_configured'
  | 'checking'
  | 'credential_invalid'
  | 'credential_unavailable'
  | 'connection_paused'
  | 'model_unavailable'

/** Stable action advice paired with each reason. */
export type CapabilityAction = 'wait' | 'contact_admin'

/** Inclusive min..max count. */
export interface CapabilityCountRange {
  readonly min: number
  readonly max: number
}

/** Ordered-image reference envelope (spec 图片合同). */
export interface ImageReferenceEnvelope {
  readonly count: CapabilityCountRange
  readonly formats: readonly string[]
  readonly maxBytes: number
  readonly minPx: number
  readonly maxPx: number
  readonly maxPixels: number
  readonly minAspect: number
  readonly maxAspect: number
}

/** Input-video reference envelope (spec 视频合同). */
export interface VideoReferenceEnvelope {
  readonly count: CapabilityCountRange
  readonly formats: readonly string[]
  readonly maxBytes: number
  readonly minSeconds: number
  readonly maxSeconds: number
}

/** Input-audio reference envelope (spec 视频合同). */
export interface AudioReferenceEnvelope {
  readonly count: CapabilityCountRange
  readonly formats: readonly string[]
  readonly maxBytes: number
  readonly minSeconds: number
  readonly maxSeconds: number
}

/** One submittable mode with its reference-material bounds. */
export interface CapabilityMode {
  readonly id: CapabilityMediaMode
  readonly referenceMaterial: {
    readonly total: CapabilityCountRange
    readonly image?: ImageReferenceEnvelope
    readonly video?: VideoReferenceEnvelope
    readonly audio?: AudioReferenceEnvelope
  }
}

/** The vendor pixel size of one (resolution tier, ratio) combination. */
export interface CapabilitySize {
  readonly resolution: string
  readonly ratio: string
  readonly width: number
  readonly height: number
}

/** One allowlisted model with its own resolution tiers. */
export interface CapabilityModel {
  readonly model: string
  readonly resolutions: readonly string[]
  readonly defaultResolution: string
  readonly sizes?: readonly CapabilitySize[]
}

/** The media-level recommended defaults; always inside published sets. */
export interface CapabilityDefaults {
  readonly ratio?: string
  readonly quantity?: number
  readonly duration?: number
}

/** Prompt length envelope in Unicode characters. */
export interface PromptEnvelope {
  readonly minChars: number
  readonly maxChars: number
}

/**
 * One media's submittable capability set, or the structured unavailability
 * (reason/action) with every value field absent. Resolution tiers are
 * model-scoped: each published model carries its own tiers.
 */
export interface CapabilityMedia {
  readonly available: boolean
  readonly reason: CapabilityReason | null
  readonly action: CapabilityAction | null
  readonly models?: readonly CapabilityModel[]
  readonly modes?: readonly CapabilityMode[]
  readonly ratios?: readonly string[]
  readonly quantities?: readonly number[]
  readonly durations?: readonly number[]
  readonly defaults?: CapabilityDefaults
  readonly prompt?: PromptEnvelope
}

/** The manifest payload; versions let draft consumers detect staleness. */
export interface CapabilityManifest {
  readonly schemaVersion: number
  readonly manifestVersion: number
  readonly image: CapabilityMedia
  readonly video: CapabilityMedia
}

const CAPABILITY_MODES: readonly CapabilityMediaMode[] = [
  'text-to-image',
  'reference-image',
  'text-to-video',
  'first-frame',
  'first-last-frame',
  'omni-reference'
]

const CAPABILITY_REASONS: readonly CapabilityReason[] = [
  'not_configured',
  'checking',
  'credential_invalid',
  'credential_unavailable',
  'connection_paused',
  'model_unavailable'
]

const CAPABILITY_ACTIONS: readonly CapabilityAction[] = ['wait', 'contact_admin']

/** Every trust-command failure shape, for callers that need the union. */
export type ManifestFailure = CreationApiFailure

function readString(source: unknown, field: string): string | null {
  if (typeof source === 'object' && source !== null && field in source) {
    const value = (source as Record<string, unknown>)[field]
    if (typeof value === 'string') return value
  }
  return null
}

function readNumber(source: unknown, field: string): number | null {
  if (typeof source === 'object' && source !== null && field in source) {
    const value = (source as Record<string, unknown>)[field]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function readBoolean(source: unknown, field: string): boolean | null {
  if (typeof source === 'object' && source !== null && field in source) {
    const value = (source as Record<string, unknown>)[field]
    if (typeof value === 'boolean') return value
  }
  return null
}

function readEnum<T extends string>(
  source: unknown,
  field: string,
  allowed: readonly T[]
): T | null {
  const value = readString(source, field)
  return allowed.includes(value as T) ? (value as T) : null
}

/**
 * Parses the manifest payload, failing closed: any unknown reason, action,
 * mode, or missing field yields null so an unknown wire shape can never fake
 * an availability verdict.
 */
export function parseCapabilityManifest(payload: unknown): CapabilityManifest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const schemaVersion = readNumber(payload, 'schema_version')
  const manifestVersion = readNumber(payload, 'manifest_version')
  const image = parseMedia((payload as Record<string, unknown>).image)
  const video = parseMedia((payload as Record<string, unknown>).video)
  if (
    schemaVersion === null ||
    manifestVersion === null ||
    manifestVersion < 1 ||
    image === null ||
    video === null
  ) {
    return null
  }
  return { schemaVersion, manifestVersion, image, video }
}

function parseMedia(entry: unknown): CapabilityMedia | null {
  const available = readBoolean(entry, 'available')
  if (available === null) return null
  const reason = readEnum(entry, 'reason', CAPABILITY_REASONS)
  const action = readEnum(entry, 'action', CAPABILITY_ACTIONS)

  if (!available) {
    if (reason === null || action === null) return null
    return { available: false, reason, action }
  }

  // Optional list fields distinguish absent (skip) from malformed (reject):
  // a corrupted ratios array can never shrink into a smaller capability set.
  const ratios = readStringList(entry, 'ratios')
  if (ratios === MALFORMED_LIST) return null

  const models = parseModels(entry, ratios)
  if (models === null) return null

  const modes: CapabilityMode[] = []
  if (!Array.isArray(readObjectField(entry, 'modes'))) return null
  for (const raw of readObjectField(entry, 'modes') as unknown[]) {
    const id = readEnum(raw, 'id', CAPABILITY_MODES)
    if (id === null) return null
    const reference = readObjectField(raw, 'reference_material')
    const total = readCountRange(reference, 'total')
    if (total === null) return null
    // per_media appears exactly on the reference-bearing modes; an envelope
    // that is present but malformed fails the mode instead of shrinking it.
    const perMedia = readObjectField(reference, 'per_media')
    const image = parseImageEnvelope(perMedia, 'image')
    const video = parseVideoEnvelope(perMedia, 'video')
    const audio = parseAudioEnvelope(perMedia, 'audio')
    if (
      (hasField(perMedia, 'image') && image === null) ||
      (hasField(perMedia, 'video') && video === null) ||
      (hasField(perMedia, 'audio') && audio === null)
    ) {
      return null
    }
    modes.push({
      id,
      referenceMaterial: {
        total,
        ...(image ? { image } : {}),
        ...(video ? { video } : {}),
        ...(audio ? { audio } : {})
      }
    })
  }
  if (modes.length === 0) return null

  const defaults = parseDefaults(entry)
  if (defaults === null) return null

  const prompt = parsePrompt(entry)
  if (prompt === null) return null

  const quantities = readNumberList(entry, 'quantities')
  if (quantities === MALFORMED_LIST) return null
  const durations = readNumberList(entry, 'durations')
  if (durations === MALFORMED_LIST) return null

  return {
    available: true,
    reason: null,
    action: null,
    models,
    modes,
    defaults,
    prompt,
    ...(ratios !== undefined ? { ratios } : {}),
    ...(quantities !== undefined ? { quantities } : {}),
    ...(durations !== undefined ? { durations } : {})
  }
}

// parseModels reads the model list with its per-model resolution tiers. A
// default outside the entry's own tiers fails closed: the composer may only
// ever seed resolutions the model itself publishes.
function parseModels(
  entry: unknown,
  ratios: readonly string[] | undefined
): CapabilityModel[] | null {
  const raw = readObjectField(entry, 'models')
  if (!Array.isArray(raw)) return null
  const models: CapabilityModel[] = []
  for (const item of raw) {
    const model = readString(item, 'model')
    const resolutions = readStringList(item, 'resolutions')
    const defaultResolution = readString(item, 'default_resolution')
    if (
      model === null ||
      resolutions === undefined ||
      resolutions === MALFORMED_LIST ||
      resolutions.length === 0 ||
      defaultResolution === null ||
      !resolutions.includes(defaultResolution)
    ) {
      return null
    }
    const sizes = parseSizes(item, resolutions, ratios)
    if (sizes === MALFORMED_LIST) return null
    models.push({
      model,
      resolutions,
      defaultResolution,
      ...(sizes !== undefined ? { sizes } : {})
    })
  }
  if (models.length === 0) return null
  return models
}

// parseSizes reads one model's published pixel sizes — display metadata for
// the exact size the server submits. Every entry must sit inside the model's
// own tiers and the media's published ratios, so a malformed or out-of-set
// size can never impersonate a capability.
function parseSizes(
  item: unknown,
  resolutions: readonly string[],
  ratios: readonly string[] | undefined
): CapabilitySize[] | MalformedList | undefined {
  if (!hasField(item, 'sizes')) return undefined
  const value = (item as Record<string, unknown>)['sizes']
  if (!Array.isArray(value)) return MALFORMED_LIST
  const sizes: CapabilitySize[] = []
  for (const raw of value) {
    const resolution = readString(raw, 'resolution')
    const ratio = readString(raw, 'ratio')
    const width = readNumber(raw, 'width')
    const height = readNumber(raw, 'height')
    if (
      resolution === null ||
      !resolutions.includes(resolution) ||
      ratio === null ||
      (ratios !== undefined && !ratios.includes(ratio)) ||
      width === null ||
      !Number.isInteger(width) ||
      width < 1 ||
      height === null ||
      !Number.isInteger(height) ||
      height < 1
    ) {
      return MALFORMED_LIST
    }
    sizes.push({ resolution, ratio, width, height })
  }
  return sizes
}

// Sentinel for "the field is present but is not the documented list shape" —
// distinct from undefined ("the field is absent"), so a malformed optional
// field fails closed instead of reading as a smaller capability set.
const MALFORMED_LIST = Symbol('malformed-list')

type MalformedList = typeof MALFORMED_LIST

function hasField(source: unknown, field: string): boolean {
  return typeof source === 'object' && source !== null && field in source
}

function readObjectField(source: unknown, field: string): unknown {
  if (typeof source !== 'object' || source === null) return null
  return (source as Record<string, unknown>)[field] ?? null
}

function readCountRange(entry: unknown, field: string): { min: number; max: number } | null {
  const value = readObjectField(entry, field)
  const min = readNumber(value, 'min')
  const max = readNumber(value, 'max')
  if (min === null || max === null || min > max) return null
  return { min, max }
}

// List readers return undefined when the field is absent and MALFORMED_LIST
// when present but not a list of the documented item type.
function readStringList(source: unknown, field: string): string[] | MalformedList | undefined {
  if (!hasField(source, field)) return undefined
  const value = (source as Record<string, unknown>)[field]
  if (!Array.isArray(value)) return MALFORMED_LIST
  const list: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return MALFORMED_LIST
    list.push(item)
  }
  return list
}

function readNumberList(source: unknown, field: string): number[] | MalformedList | undefined {
  if (!hasField(source, field)) return undefined
  const value = (source as Record<string, unknown>)[field]
  if (!Array.isArray(value)) return MALFORMED_LIST
  const list: number[] = []
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) return MALFORMED_LIST
    list.push(item)
  }
  return list
}

function parseImageEnvelope(source: unknown, field: string): ImageReferenceEnvelope | null {
  if (!hasField(source, field)) return null
  const raw = (source as Record<string, unknown>)[field]
  const count = readCountRange(raw, 'count')
  const formats = readStringList(raw, 'formats')
  const maxBytes = readNumber(raw, 'max_bytes')
  const minPx = readNumber(raw, 'min_px')
  const maxPx = readNumber(raw, 'max_px')
  const maxPixels = readNumber(raw, 'max_pixels')
  const minAspect = readNumber(raw, 'min_aspect')
  const maxAspect = readNumber(raw, 'max_aspect')
  if (
    count === null ||
    formats === undefined ||
    formats === MALFORMED_LIST ||
    formats.length === 0 ||
    maxBytes === null ||
    minPx === null ||
    maxPx === null ||
    maxPixels === null ||
    minAspect === null ||
    maxAspect === null
  ) {
    return null
  }
  return { count, formats, maxBytes, minPx, maxPx, maxPixels, minAspect, maxAspect }
}

function parseTimedEnvelope(
  source: unknown,
  field: string
): {
  count: CapabilityCountRange
  formats: string[]
  maxBytes: number
  minSeconds: number
  maxSeconds: number
} | null {
  if (!hasField(source, field)) return null
  const raw = (source as Record<string, unknown>)[field]
  const count = readCountRange(raw, 'count')
  const formats = readStringList(raw, 'formats')
  const maxBytes = readNumber(raw, 'max_bytes')
  const minSeconds = readNumber(raw, 'min_seconds')
  const maxSeconds = readNumber(raw, 'max_seconds')
  if (
    count === null ||
    formats === undefined ||
    formats === MALFORMED_LIST ||
    formats.length === 0 ||
    maxBytes === null ||
    minSeconds === null ||
    maxSeconds === null
  ) {
    return null
  }
  return { count, formats, maxBytes, minSeconds, maxSeconds }
}

function parseVideoEnvelope(source: unknown, field: string): VideoReferenceEnvelope | null {
  return parseTimedEnvelope(source, field)
}

function parseAudioEnvelope(source: unknown, field: string): AudioReferenceEnvelope | null {
  return parseTimedEnvelope(source, field)
}

function parsePrompt(entry: unknown): PromptEnvelope | null {
  const raw = readObjectField(entry, 'prompt')
  const minChars = readNumber(raw, 'min_chars')
  const maxChars = readNumber(raw, 'max_chars')
  if (minChars === null || maxChars === null || minChars > maxChars) return null
  return { minChars, maxChars }
}

function parseDefaults(entry: unknown): CapabilityDefaults | null {
  const raw = (entry as Record<string, unknown>).defaults
  if (typeof raw !== 'object' || raw === null) return null
  const ratio = readString(raw, 'ratio') ?? undefined
  const quantity = readNumber(raw, 'quantity') ?? undefined
  const duration = readNumber(raw, 'duration') ?? undefined
  return { ratio, quantity, duration }
}

/**
 * Creates the typed manifest client over one configured server URL. The path
 * mirrors contracts/creation.yaml; parsing fails closed rather than guessing
 * shapes.
 */
export function createCapabilityManifestClient(serverUrl: string): {
  lookup(token: string): Promise<CreationApiResult<CapabilityManifest>>
} {
  return {
    lookup: async (token) => {
      const result = await request(serverUrl, {
        method: 'GET',
        path: '/creation/capability-manifest',
        token
      })
      if (result.outcome !== 'succeeded') return result
      const manifest = parseCapabilityManifest(result.payload)
      return manifest ? { outcome: 'succeeded', value: manifest } : { outcome: 'network-failure' }
    }
  }
}
