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

/** Stable unavailability causes; `production_readiness_pending` is global. */
export type CapabilityReason =
  | 'production_readiness_pending'
  | 'not_configured'
  | 'checking'
  | 'credential_invalid'
  | 'credential_unavailable'
  | 'connection_paused'
  | 'model_unavailable'

/** Stable action advice paired with each reason. */
export type CapabilityAction = 'wait' | 'await_release' | 'contact_admin'

/** One submittable mode with its reference-material bounds. */
export interface CapabilityMode {
  readonly id: CapabilityMediaMode
  readonly referenceMaterial: {
    readonly total: { readonly min: number; readonly max: number }
  }
}

/** The per-dimension recommended defaults; always inside published sets. */
export interface CapabilityDefaults {
  readonly resolution: string
  readonly ratio?: string
  readonly quantity?: number
  readonly duration?: number
}

/**
 * One media's submittable capability set, or the structured unavailability
 * (reason/action) with every value field absent.
 */
export interface CapabilityMedia {
  readonly available: boolean
  readonly reason: CapabilityReason | null
  readonly action: CapabilityAction | null
  readonly model?: string
  readonly modes?: readonly CapabilityMode[]
  readonly ratios?: readonly string[]
  readonly resolutions?: readonly string[]
  readonly quantities?: readonly number[]
  readonly durations?: readonly number[]
  readonly defaults?: CapabilityDefaults
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
  'production_readiness_pending',
  'not_configured',
  'checking',
  'credential_invalid',
  'credential_unavailable',
  'connection_paused',
  'model_unavailable'
]

const CAPABILITY_ACTIONS: readonly CapabilityAction[] = ['wait', 'await_release', 'contact_admin']

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

  const model = readString(entry, 'model')
  if (model === null) return null

  const modes: CapabilityMode[] = []
  if (
    typeof (entry as Record<string, unknown>).modes !== 'object' ||
    (entry as Record<string, unknown>).modes === null
  ) {
    return null
  }
  for (const raw of (entry as Record<string, unknown>).modes as unknown[]) {
    const id = readEnum(raw, 'id', CAPABILITY_MODES)
    const total = readCountRange(readObjectField(raw, 'reference_material'), 'total')
    if (id === null || total === null) return null
    modes.push({ id, referenceMaterial: { total } })
  }
  if (modes.length === 0) return null

  const resolutions = readStringList(entry, 'resolutions')
  if (resolutions === null || resolutions.length === 0) return null

  const defaults = parseDefaults(entry)
  if (defaults === null) return null

  const media: {
    available: true
    reason: null
    action: null
    model: string
    modes: CapabilityMode[]
    resolutions: string[]
    defaults: CapabilityDefaults
    ratios?: string[]
    quantities?: number[]
    durations?: number[]
  } = { available: true, reason: null, action: null, model, modes, resolutions, defaults }

  const ratios = readStringList(entry, 'ratios')
  if (ratios !== null) media.ratios = ratios
  const quantities = readNumberList(entry, 'quantities')
  if (quantities !== null) media.quantities = quantities
  const durations = readNumberList(entry, 'durations')
  if (durations !== null) media.durations = durations
  return media
}

function readObjectField(source: unknown, field: string): unknown {
  if (typeof source !== 'object' || source === null) return null
  return (source as Record<string, unknown>)[field] ?? null
}

function readCountRange(entry: unknown, field: string): { min: number; max: number } | null {
  if (typeof entry !== 'object' || entry === null) return null
  const value = (entry as Record<string, unknown>)[field]
  const min = readNumber(value, 'min')
  const max = readNumber(value, 'max')
  if (min === null || max === null || min > max) return null
  return { min, max }
}

function readStringList(source: unknown, field: string): string[] | null {
  const value = (source as Record<string, unknown>)[field]
  if (value === undefined) return null
  if (!Array.isArray(value)) return null
  const list: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    list.push(item)
  }
  return list
}

function readNumberList(source: unknown, field: string): number[] | null {
  const value = (source as Record<string, unknown>)[field]
  if (value === undefined) return null
  if (!Array.isArray(value)) return null
  const list: number[] = []
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) return null
    list.push(item)
  }
  return list
}

function parseDefaults(entry: unknown): CapabilityDefaults | null {
  const raw = (entry as Record<string, unknown>).defaults
  if (typeof raw !== 'object' || raw === null) return null
  const resolution = readString(raw, 'resolution')
  if (resolution === null) return null
  const ratio = readString(raw, 'ratio') ?? undefined
  const quantity = readNumber(raw, 'quantity') ?? undefined
  const duration = readNumber(raw, 'duration') ?? undefined
  return { resolution, ratio, quantity, duration }
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
