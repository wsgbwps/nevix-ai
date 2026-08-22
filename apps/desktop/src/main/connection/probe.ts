import http from 'node:http'
import https from 'node:https'
import { checkServerIdentity, type PeerCertificate } from 'node:tls'
import { URL } from 'node:url'
import { certificateFingerprint } from './certificate-pins'
import { parseServerUrl } from '../../shared/config/server-url'
import type {
  CertificateFingerprintView,
  ServerConnectionProbe
} from '../../shared/ipc/connection/types'

const PROBE_TIMEOUT_MS = 10_000

/**
 * Node treats these verification failures as "the chain is not trusted" — the
 * only class eligible for TOFU. Hostname mismatches, expiry, and every other
 * TLS defect stays a hard failure: pinning never overrides them.
 */
const UNTRUSTED_CHAIN_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
])

/**
 * Tests a server URL exactly the way a saved connection would use it: a
 * standard-verification HTTPS probe first, and only for an untrusted chain the
 * pinned-fingerprint comparison — never a global skip of verification.
 */
export async function probeServerConnection(
  url: string,
  certificatePins: ReadonlyMap<string, string>
): Promise<ServerConnectionProbe> {
  const canonicalUrl = parseServerUrl(url)
  if (!canonicalUrl) return { outcome: 'invalid-url' }

  const target = new URL(canonicalUrl)
  const healthUrl = new URL('/health', target)

  if (target.protocol === 'http:') {
    const plain = await requestHealth(healthUrl, { rejectUnauthorized: false })
    return plain === 'succeeded' ? { outcome: 'reachable' } : { outcome: 'unreachable' }
  }

  const verified = await requestHealth(healthUrl, { rejectUnauthorized: true })
  if (verified === 'succeeded') return { outcome: 'reachable' }
  if (verified === 'network-failure') return { outcome: 'unreachable' }
  if (verified.error === undefined || !UNTRUSTED_CHAIN_ERROR_CODES.has(verified.error)) {
    return { outcome: 'unreachable' }
  }

  // The chain is untrusted: capture the presented certificate without acting
  // on it, then decide by hostname and pinned fingerprint alone.
  const presented = await capturePresentedCertificate(healthUrl)
  if (presented === undefined) return { outcome: 'unreachable' }

  try {
    checkServerIdentity(target.hostname, presented)
  } catch {
    return { outcome: 'unreachable' }
  }

  const fingerprint = certificateFingerprint(presented.raw)
  const view = certificateView(presented, fingerprint)
  const pin = certificatePins.get(target.hostname)
  if (pin === undefined) {
    return { outcome: 'certificate-confirmation-required', ...view }
  }
  if (pin !== fingerprint) {
    return { outcome: 'certificate-changed', ...view }
  }
  return { outcome: 'reachable' }
}

type HealthProbeResult = 'succeeded' | 'network-failure' | { readonly error: string }

interface PresentableCertificate extends PeerCertificate {}

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

function requestHealth(
  url: URL,
  options: { readonly rejectUnauthorized: boolean }
): Promise<HealthProbeResult> {
  // A one-shot agent per probe: keep-alive would pin the verdict to whichever
  // certificate an earlier TLS session negotiated, hiding a rotation.
  const transport = url.protocol === 'https:' ? https : http
  const agent = new transport.Agent({ keepAlive: false })
  return new Promise((resolve) => {
    const request = transport.request(
      url,
      {
        method: 'GET',
        rejectUnauthorized: options.rejectUnauthorized,
        agent,
        headers: { Accept: 'application/json', Connection: 'close' }
      },
      (response) => {
        response.resume()
        response.on('end', () => {
          agent.destroy()
          resolve(
            response.statusCode !== undefined &&
              response.statusCode >= 200 &&
              response.statusCode < 500
              ? 'succeeded'
              : 'network-failure'
          )
        })
      }
    )
    request.setTimeout(PROBE_TIMEOUT_MS, () => {
      request.destroy(new Error('probe timeout'))
    })
    request.on('error', (error: NodeJS.ErrnoException) => {
      agent.destroy()
      resolve(error.code === undefined ? 'network-failure' : { error: error.code })
    })
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
        response.resume()
        response.on('end', () => finish())
        response.on('error', () => finish())
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

    function finish(): void {
      const socket = request.socket as typeof request.socket & {
        getPeerCertificate?: () => PeerCertificate | undefined
      }
      const certificate = socket.getPeerCertificate?.()
      agent.destroy()
      resolve(
        certificate && typeof certificate === 'object' && Buffer.isBuffer(certificate.raw)
          ? certificate
          : undefined
      )
    }
  })
}
