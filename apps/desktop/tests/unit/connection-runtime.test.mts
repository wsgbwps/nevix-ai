import assert from 'node:assert/strict'
import test from 'node:test'
import { rendererConnectSourceCsp } from '../../src/main/connection/renderer-csp.ts'
import {
  electronCertificateFingerprint,
  sanitizeCertificatePins
} from '../../src/main/connection/certificate-pins.ts'
import { createHash } from 'node:crypto'

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
