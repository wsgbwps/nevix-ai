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

/** The facts one TOFU verdict needs, shared by the probe and the fetch side. */
export interface PinVerdictInput {
  /** The persisted pin for the connected hostname, when one exists. */
  readonly pin: string | undefined
  readonly fingerprint: string
  /** The presented certificate's validity end; unknown fails closed. */
  readonly validTo: Date | undefined
  readonly now?: Date
}

/**
 * The one TOFU verdict shared by the Node probe and the Electron verify proc:
 * exactly the pinned fingerprint on a certificate that has not expired. Expiry
 * is decided here rather than by whichever TLS error code surfaces first, so a
 * self-signed certificate whose untrusted-chain error masks its expiry can
 * never be pinned, and pinning can never override an expiry rejection.
 */
export function isTrustworthyPin(input: PinVerdictInput): boolean {
  if (input.pin === undefined || input.pin !== input.fingerprint) return false
  if (input.validTo === undefined || Number.isNaN(input.validTo.getTime())) return false
  return input.validTo.getTime() > (input.now ?? new Date()).getTime()
}

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
