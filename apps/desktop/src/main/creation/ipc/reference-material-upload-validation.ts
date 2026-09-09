const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && canonicalUuid.test(value)
}
