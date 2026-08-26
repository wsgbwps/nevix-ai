import { app } from 'electron'
import http from 'node:http'
import https from 'node:https'
import { checkServerIdentity, type PeerCertificate } from 'node:tls'
import { URL } from 'node:url'
import { certificateFingerprint, isTrustworthyPin } from './certificate-pins'
import { allowsPlainHttpServerUrl, parseServerUrl } from '../../shared/config/server-url'
import type {
  CertificateFingerprintView,
  ServerConnectionProbe
} from '../../shared/ipc/connection/types'

const PROBE_TIMEOUT_MS = 10_000
const MAXIMUM_HEALTH_BODY_BYTES = 64 * 1024

/**
 * Node treats these verification failures as "the chain is not trusted" — the
 * only class eligible for TOFU. Hostname mismatches and every other TLS defect
 * stay a hard failure: pinning never overrides them.
 */
const UNTRUSTED_CHAIN_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
])

interface HealthOutcome {
  readonly kind: 'succeeded' | 'incompatible' | 'network-failure' | 'failed'
  /** The TLS error code that failed the request; `failed` outcomes only. */
  readonly error?: string
  /** The certificate the successful connection actually presented. */
  readonly certificate?: PresentableCertificate
}

type PinnedHealthOutcome =
  | { readonly kind: 'succeeded'; readonly certificateValidTo: string }
  | { readonly kind: 'incompatible' }
  | { readonly kind: 'pin-changed'; readonly view: CertificateFingerprintView }
  | { readonly kind: 'network-failure' }
interface PresentableCertificate extends PeerCertificate {}

/**
 * Tests a server URL exactly the way a saved connection would use it: the
 * plain-http destination policy first (https anywhere; http only for loopback
 * on an unpackaged runtime, #153), then a standard-verification HTTPS probe,
 * and only for an untrusted chain the pinned-fingerprint comparison — never a
 * global skip of verification. A reachable verdict additionally demands the
 * Nevix /health identity (contracts/openapi.yaml /health) on every path,
 * including the pinned one.
 */
export async function probeServerConnection(
  url: string,
  certificatePins: ReadonlyMap<string, string>
): Promise<ServerConnectionProbe> {
  const canonicalUrl = parseServerUrl(url)
  if (!canonicalUrl) return { outcome: 'invalid-url' }

  const target = new URL(canonicalUrl)
  if (target.protocol === 'http:' && !allowsPlainHttpServerUrl(target.hostname, !app.isPackaged)) {
    return { outcome: 'invalid-url' }
  }

  const healthUrl = new URL('/health', target)
  const health = await requestHealth(healthUrl, {
    rejectUnauthorized: target.protocol === 'https:'
  })

  if (health.kind === 'network-failure') return { outcome: 'unreachable' }
  if (health.kind === 'incompatible') return { outcome: 'incompatible-server' }
  if (health.kind === 'succeeded') {
    // Standard verification passed. An existing pin still binds: the
    // certificate actually presented must be the pinned one, so rotating to a
    // different CA-valid certificate demands reconfirmation instead of a
    // silent pass (#153).
    const pin = certificatePins.get(target.hostname)
    if (pin !== undefined) {
      if (health.certificate === undefined) return { outcome: 'unreachable' }
      const fingerprint = certificateFingerprint(health.certificate.raw)
      if (fingerprint !== pin) {
        return {
          outcome: 'certificate-changed',
          ...certificateView(health.certificate, fingerprint)
        }
      }
    }
    return { outcome: 'reachable', certificateValidTo: health.certificate?.valid_to }
  }
  if (
    health.error !== 'CERT_HAS_EXPIRED' &&
    (health.error === undefined || !UNTRUSTED_CHAIN_ERROR_CODES.has(health.error))
  ) {
    return { outcome: 'unreachable' }
  }

  // The chain is untrusted or expired: capture the presented certificate
  // without acting on it, then decide by hostname, validity, and pin alone.
  const presented = await capturePresentedCertificate(healthUrl)
  if (presented === undefined) return { outcome: 'unreachable' }

  try {
    checkServerIdentity(target.hostname, presented)
  } catch {
    return { outcome: 'unreachable' }
  }

  const fingerprint = certificateFingerprint(presented.raw)
  const view = certificateView(presented, fingerprint)
  const validTo = validityEnd(presented)

  // Expiry is decided by the validity dates, not by whichever TLS error code
  // OpenSSL surfaced first (a self-signed certificate can mask its expiry),
  // and an unreadable validity fails closed: TOFU never overrides either.
  if (
    health.error === 'CERT_HAS_EXPIRED' ||
    validTo === undefined ||
    validTo.getTime() <= Date.now()
  ) {
    return { outcome: 'certificate-expired', ...view }
  }

  const pin = certificatePins.get(target.hostname)
  if (pin !== undefined && isTrustworthyPin({ pin, fingerprint, validTo })) {
    // The pin accepts this certificate; reachability still demands the Nevix
    // /health identity, read over a fresh one-shot connection that itself
    // verifies the pinned fingerprint (#153: a pinned foreign HTTPS service
    // is not a reachable Nevix deployment).
    const pinned = await requestHealthOverPinnedCertificate(healthUrl, pin)
    if (pinned.kind === 'succeeded') {
      return { outcome: 'reachable', certificateValidTo: pinned.certificateValidTo }
    }
    if (pinned.kind === 'incompatible') return { outcome: 'incompatible-server' }
    if (pinned.kind === 'pin-changed') {
      return { outcome: 'certificate-changed', ...pinned.view }
    }
    return { outcome: 'unreachable' }
  }
  return pin === undefined
    ? { outcome: 'certificate-confirmation-required', ...view }
    : { outcome: 'certificate-changed', ...view }
}

/** The one identity a reachable target must present: the Nevix Go server. */
function isNevixHealthPayload(body: string): boolean {
  try {
    const payload: unknown = JSON.parse(body)
    if (typeof payload !== 'object' || payload === null) return false
    const record = payload as { status?: unknown; service?: unknown }
    return record.status === 'ok' && record.service === 'nevix-server'
  } catch {
    return false
  }
}

function validityEnd(certificate: PresentableCertificate): Date | undefined {
  const parsed = new Date(certificate.valid_to)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function certificateView(
  certificate: PresentableCertificate,
  fingerprint: string
): CertificateFingerprintView {
  return {
    fingerprint,
    subjectName: commonName(certificate.subject.CN),
    issuerName: commonName(certificate.issuer.CN),
    validTo: certificate.valid_to
  }
}

function commonName(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : ''
}

type BoundedBodyOutcome =
  | { readonly kind: 'complete'; readonly text: string }
  | { readonly kind: 'overflow' }
  | { readonly kind: 'failed' }

/**
 * Reads one small health response with explicit response-stream termination.
 * Overflow is an incompatible server verdict, while abort/error is a network
 * failure; every event converges through one settle guard so destroying an
 * oversized response cannot emit an unhandled IncomingMessage error.
 */
function readBoundedBody(response: http.IncomingMessage): Promise<BoundedBodyOutcome> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let settled = false

    function settle(outcome: BoundedBodyOutcome): void {
      if (settled) return
      settled = true
      resolve(outcome)
    }

    response.on('data', (chunk: Buffer) => {
      if (settled) return
      totalBytes += chunk.length
      if (totalBytes > MAXIMUM_HEALTH_BODY_BYTES) {
        settle({ kind: 'overflow' })
        response.destroy()
        return
      }
      chunks.push(chunk)
    })
    response.on('end', () =>
      settle({ kind: 'complete', text: Buffer.concat(chunks).toString('utf8') })
    )
    response.on('aborted', () => settle({ kind: 'failed' }))
    response.on('error', () => settle({ kind: 'failed' }))
  })
}

function peerCertificate(request: http.ClientRequest): PresentableCertificate | undefined {
  const socket = request.socket as typeof request.socket & {
    getPeerCertificate?: () => PeerCertificate | undefined
  }
  const certificate = socket.getPeerCertificate?.()
  return certificate && typeof certificate === 'object' && Buffer.isBuffer(certificate.raw)
    ? certificate
    : undefined
}

function requestHealth(
  url: URL,
  options: { readonly rejectUnauthorized: boolean }
): Promise<HealthOutcome> {
  // A one-shot agent per probe: keep-alive would pin the verdict to whichever
  // certificate an earlier TLS session negotiated, hiding a rotation.
  const transport = url.protocol === 'https:' ? https : http
  const agent = new transport.Agent({ keepAlive: false })
  return new Promise((resolve) => {
    let settled = false
    function finish(outcome: HealthOutcome): void {
      if (settled) return
      settled = true
      agent.destroy()
      resolve(outcome)
    }

    const request = transport.request(
      url,
      {
        method: 'GET',
        rejectUnauthorized: options.rejectUnauthorized,
        agent,
        headers: { Accept: 'application/json', Connection: 'close' }
      },
      (response) => {
        // The peer certificate must be read while the socket is alive: after
        // `Connection: close` teardown, getPeerCertificate returns an empty
        // object and the fingerprint would silently vanish.
        const certificate = peerCertificate(request)
        void readBoundedBody(response).then((body) => {
          if (body.kind === 'overflow') {
            finish({ kind: 'incompatible' })
            return
          }
          if (body.kind === 'failed') {
            finish({ kind: 'network-failure' })
            return
          }
          finish(
            response.statusCode === 200 && isNevixHealthPayload(body.text)
              ? { kind: 'succeeded', certificate }
              : { kind: 'incompatible' }
          )
        })
      }
    )
    request.setTimeout(PROBE_TIMEOUT_MS, () => {
      request.destroy(new Error('probe timeout'))
    })
    request.on('error', (error: NodeJS.ErrnoException) => {
      finish(
        error.code === undefined
          ? { kind: 'network-failure' }
          : { kind: 'failed', error: error.code }
      )
    })
    request.end()
  })
}

/**
 * The pinned request behind every TOFU `reachable`: a fresh one-shot
 * connection whose presented certificate must equal the pin — closing the
 * capture-to-request race — and whose /health answer must be the Nevix
 * identity payload.
 */
function requestHealthOverPinnedCertificate(url: URL, pin: string): Promise<PinnedHealthOutcome> {
  const agent = new https.Agent({ keepAlive: false })
  return new Promise((resolve) => {
    let settled = false
    function finish(outcome: PinnedHealthOutcome): void {
      if (settled) return
      settled = true
      agent.destroy()
      resolve(outcome)
    }

    const request = https.request(
      url,
      {
        method: 'GET',
        agent,
        // The pin itself is the verifier below, on this connection's
        // certificate; the identity payload decides reachability.
        rejectUnauthorized: false,
        headers: { Accept: 'application/json', Connection: 'close' }
      },
      (response) => {
        // Same liveness rule as requestHealth: read the certificate before
        // the close tears the socket down.
        const certificate = peerCertificate(request)
        if (certificate === undefined) {
          response.on('error', () => undefined)
          response.destroy()
          finish({ kind: 'network-failure' })
          return
        }
        const fingerprint = certificateFingerprint(certificate.raw)
        if (fingerprint !== pin) {
          response.on('error', () => undefined)
          response.destroy()
          finish({ kind: 'pin-changed', view: certificateView(certificate, fingerprint) })
          return
        }

        void readBoundedBody(response).then((body) => {
          if (body.kind === 'overflow') {
            finish({ kind: 'incompatible' })
            return
          }
          if (body.kind === 'failed') {
            finish({ kind: 'network-failure' })
            return
          }
          finish(
            response.statusCode === 200 && isNevixHealthPayload(body.text)
              ? { kind: 'succeeded', certificateValidTo: certificate.valid_to }
              : { kind: 'incompatible' }
          )
        })
      }
    )
    request.setTimeout(PROBE_TIMEOUT_MS, () => {
      request.destroy(new Error('probe timeout'))
    })
    request.on('error', () => finish({ kind: 'network-failure' }))
    request.end()
  })
}

async function capturePresentedCertificate(url: URL): Promise<PresentableCertificate | undefined> {
  const agent = new https.Agent({ keepAlive: false })
  return new Promise((resolve) => {
    const request = https.request(
      url,
      {
        method: 'GET',
        agent,
        // Capture only: the decision is made by checkServerIdentity plus the
        // pinned fingerprint below, never by this handshake alone.
        rejectUnauthorized: false,
        headers: { Connection: 'close' }
      },
      (response) => {
        // Same liveness rule as requestHealth: read the certificate before
        // the close tears the socket down.
        const certificate = peerCertificate(request)
        response.resume()
        response.on('end', () => finish(certificate))
        response.on('error', () => finish(certificate))
      }
    )
    request.setTimeout(PROBE_TIMEOUT_MS, () => {
      request.destroy(new Error('probe timeout'))
    })
    request.on('error', () => {
      agent.destroy()
      resolve(undefined)
    })
    request.end()

    function finish(certificate: PresentableCertificate | undefined): void {
      agent.destroy()
      resolve(certificate)
    }
  })
}
