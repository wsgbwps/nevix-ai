import { createHash } from 'node:crypto'

/** SHA-256 of a DER-encoded certificate, lowercase hex — the TOFU pin value. */
export function certificateFingerprint(der: Buffer): string {
  return createHash('sha256').update(der).digest('hex')
}

/**
 * Fingerprint of an Electron `Certificate` (`data` is PEM-encoded): identical
 * to the main-process probe's Node-side fingerprint, so a pin saved through
 * one seam is the pin enforced by the other.
 */
export function electronCertificateFingerprint(pem: string): string {
  const base64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '')
  return certificateFingerprint(Buffer.from(base64, 'base64'))
}

const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/
const HOSTNAME_PATTERN = /^[a-z0-9.[\]-]+$/i

/** Keeps only structurally valid pins: a tampered store entry must fail closed, not poison verification. */
export function sanitizeCertificatePins(record: unknown): ReadonlyMap<string, string> {
  const pins = new Map<string, string>()
  if (typeof record !== 'object' || record === null) return pins

  for (const [hostname, fingerprint] of Object.entries(record as Record<string, unknown>)) {
    if (
      typeof fingerprint === 'string' &&
      FINGERPRINT_PATTERN.test(fingerprint) &&
      HOSTNAME_PATTERN.test(hostname)
    ) {
      pins.set(hostname, fingerprint)
    }
  }
  return pins
}
