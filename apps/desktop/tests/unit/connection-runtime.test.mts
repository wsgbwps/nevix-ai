import assert from 'node:assert/strict'
import test from 'node:test'
import { rendererConnectSourceCsp } from '../../src/main/connection/renderer-csp.ts'
import {
  electronCertificateFingerprint,
  isTrustworthyPin,
  sanitizeCertificatePins
} from '../../src/main/connection/certificate-pins.ts'
import { createHash } from 'node:crypto'

const VALID_TO = new Date('2031-01-01T00:00:00Z')
const NOW = new Date('2026-01-01T00:00:00Z')

test('a pin trusts exactly its fingerprint on a not-yet-expired certificate', () => {
  const fingerprint = 'a'.repeat(64)
  assert.equal(
    isTrustworthyPin({ pin: fingerprint, fingerprint, validTo: VALID_TO, now: NOW }),
    true
  )
})

test('a pin never overrides a changed fingerprint or an expired certificate', () => {
  const fingerprint = 'a'.repeat(64)
  // Changed fingerprint.
  assert.equal(
    isTrustworthyPin({
      pin: fingerprint,
      fingerprint: 'b'.repeat(64),
      validTo: VALID_TO,
      now: NOW
    }),
    false
  )
  // Expired exactly now or earlier.
  assert.equal(isTrustworthyPin({ pin: fingerprint, fingerprint, validTo: NOW, now: NOW }), false)
  assert.equal(
    isTrustworthyPin({
      pin: fingerprint,
      fingerprint,
      validTo: new Date('2025-12-31T23:59:59Z'),
      now: NOW
    }),
    false
  )
})

test('an absent pin or unknown validity fails closed', () => {
  const fingerprint = 'a'.repeat(64)
  assert.equal(
    isTrustworthyPin({ pin: undefined, fingerprint, validTo: VALID_TO, now: NOW }),
    false
  )
  assert.equal(
    isTrustworthyPin({ pin: fingerprint, fingerprint, validTo: new Date('nonsense'), now: NOW }),
    false
  )
  assert.equal(
    isTrustworthyPin({ pin: fingerprint, fingerprint, validTo: undefined, now: NOW }),
    false
  )
})

test('connect-src CSP names exactly the persisted origin, or none at all', () => {
  assert.equal(
    rendererConnectSourceCsp('http://127.0.0.1:8080', false),
    'connect-src http://127.0.0.1:8080'
  )
  assert.equal(
    rendererConnectSourceCsp('https://nevix.example', false),
    'connect-src https://nevix.example'
  )
  assert.equal(rendererConnectSourceCsp(undefined, false), "connect-src 'none'")
  assert.equal(rendererConnectSourceCsp(undefined, true), "connect-src 'self'")
  assert.equal(
    rendererConnectSourceCsp('http://10.0.0.7', true),
    "connect-src http://10.0.0.7 'self'"
  )
})

test('electron certificate fingerprints hash the DER body exactly like the probe side', () => {
  const der = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x2a])
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64')}\n-----END CERTIFICATE-----\n`

  assert.equal(electronCertificateFingerprint(pem), createHash('sha256').update(der).digest('hex'))
})

test('certificate pin sanitization keeps only hostname keys with sha256 hex values', () => {
  const pins = sanitizeCertificatePins({
    'nevix.example': 'a'.repeat(64),
    '10.0.0.5': 'b'.repeat(64),
    'space host': 'c'.repeat(64),
    'other.example': 'NOT-HEX',
    'third.example': 42,
    'fourth.example': 'd'.repeat(63)
  })

  assert.equal(pins.size, 2)
  assert.equal(pins.get('nevix.example'), 'a'.repeat(64))
  assert.equal(pins.get('10.0.0.5'), 'b'.repeat(64))
  assert.deepEqual(sanitizeCertificatePins('nonsense'), new Map())
  assert.deepEqual(sanitizeCertificatePins(null), new Map())
})
