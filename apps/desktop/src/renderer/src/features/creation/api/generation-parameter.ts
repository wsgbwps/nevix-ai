/** The Generation Parameter field inventory (Desktop ADR-0006). */

import type { CapabilityMedia } from './capability-manifest-http'

/** The composer's target media (the contracts media_type closed set). */
export type DraftMediaType = 'image' | 'video'

export interface GenerationParameterValues {
  readonly mediaType: DraftMediaType | null
  readonly model: string | null
  readonly mode: string | null
  readonly ratio: string | null
  readonly resolution: string | null
  readonly quantity: number | null
  readonly durationSeconds: number | null
}

export type GenerationParameterId = keyof GenerationParameterValues

export interface GenerationParameterField {
  readonly id: GenerationParameterId
  readonly wireKey: string
  readonly kind: 'string' | 'number'
  /** Absent means the media offers no menu and no stale verdict for the field. */
  readonly manifestKey?: 'ratios' | 'quantities' | 'durations'
  /** The CapabilityDefaults key adopting the manifest default. */
  readonly defaultKey?: 'ratio' | 'quantity' | 'duration'
  /** May stay unset within a publishing media; the vendor default applies. */
  readonly mayStayUnset?: true
}

const FIELD_INVENTORY = [
  { id: 'mediaType', wireKey: 'media_type', kind: 'string' },
  { id: 'model', wireKey: 'model', kind: 'string' },
  { id: 'mode', wireKey: 'mode', kind: 'string' },
  {
    id: 'ratio',
    wireKey: 'ratio',
    kind: 'string',
    manifestKey: 'ratios',
    defaultKey: 'ratio',
    mayStayUnset: true
  },
  { id: 'resolution', wireKey: 'resolution', kind: 'string' },
  {
    id: 'quantity',
    wireKey: 'quantity',
    kind: 'number',
    manifestKey: 'quantities',
    defaultKey: 'quantity'
  },
  {
    id: 'durationSeconds',
    wireKey: 'duration_seconds',
    kind: 'number',
    manifestKey: 'durations',
    defaultKey: 'duration'
  }
] as const satisfies readonly GenerationParameterField[]

// Compile-time reconciliation: the inventory names exactly the value
// interface's fields, in both directions.
type InventoryId = (typeof FIELD_INVENTORY)[number]['id']
type InventoryMismatch =
  | Exclude<InventoryId, GenerationParameterId>
  | Exclude<GenerationParameterId, InventoryId>
const reconciled: InventoryMismatch extends never ? true : never = true
void reconciled

/** The inventory in its widened per-field type, for the derivation helpers. */
export const GENERATION_PARAMETERS: readonly GenerationParameterField[] = FIELD_INVENTORY

export const GENERATION_PARAMETER_WIRE_KEYS = Object.fromEntries(
  GENERATION_PARAMETERS.map((field) => [field.id, field.wireKey])
) as { readonly [id in GenerationParameterId]: string }

export function generationParameterWireValues(values: GenerationParameterValues): {
  readonly [wireKey: string]: string | number | null
} {
  const wire: Record<string, string | number | null> = {}
  for (const field of GENERATION_PARAMETERS) {
    wire[field.wireKey] = values[field.id]
  }
  return wire
}

/** Missing fields read as null (ADR-0017's 2026-09-07 revision); malformed values reject the set. */
export function parseGenerationParameterValues(
  source: Record<string, unknown>
): GenerationParameterValues | null {
  const values = {} as Record<GenerationParameterId, string | number | null>
  for (const field of GENERATION_PARAMETERS) {
    if (!(field.wireKey in source)) {
      values[field.id] = null
      continue
    }
    const raw = source[field.wireKey]
    if (raw === null) {
      values[field.id] = null
      continue
    }
    if (field.kind === 'string') {
      if (typeof raw !== 'string') return null
    } else {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
    }
    if (field.id === 'mediaType' && raw !== 'image' && raw !== 'video') {
      return null
    }
    values[field.id] = raw
  }
  return values as GenerationParameterValues
}

/** Published defaults by parameter id; unpublished ones (or a null capability) read as null. */
export function manifestDefaultParameters(capability: CapabilityMedia | null): {
  readonly ratio: string | null
  readonly quantity: number | null
  readonly durationSeconds: number | null
} {
  const defaults = {
    ratio: null as string | null,
    quantity: null as number | null,
    durationSeconds: null as number | null
  }
  const sink = defaults as Record<GenerationParameterId, string | number | null>
  for (const field of GENERATION_PARAMETERS) {
    if (field.defaultKey === undefined) continue
    sink[field.id] = capability?.defaults?.[field.defaultKey] ?? null
  }
  return defaults
}

export function emptyGenerationParameters(): GenerationParameterValues {
  const values = {} as Record<GenerationParameterId, string | number | null>
  for (const field of GENERATION_PARAMETERS) {
    values[field.id] = null
  }
  return values as GenerationParameterValues
}

export interface PublishedParameterRule {
  readonly id: GenerationParameterId
  readonly candidates: readonly (string | number)[]
  readonly mayStayUnset: boolean
}

export function publishedParameterRules(
  capability: CapabilityMedia
): readonly PublishedParameterRule[] {
  const rules: PublishedParameterRule[] = []
  for (const field of GENERATION_PARAMETERS) {
    if (field.manifestKey === undefined) continue
    const candidates = capability[field.manifestKey]
    if (candidates === undefined) continue
    rules.push({ id: field.id, candidates, mayStayUnset: field.mayStayUnset === true })
  }
  return rules
}
