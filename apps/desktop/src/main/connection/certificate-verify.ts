import type { Session } from 'electron'
import { electronCertificateFingerprint, isTrustworthyPin } from './certificate-pins'
import { currentCertificatePins } from './connection-store'

/**
 * The Chromium verification results that mean "untrusted chain" — exactly the
 * defect class the Node probe pins for. Any other result (revocation,
 * hostname mismatch, weak key, …) keeps Chromium's own verdict so the fetch
 * half and the probe half of the runtime answer identically (#153 AC5).
 */
const UNTRUSTED_CHAIN_VERIFICATION_RESULTS = new Set(['net::ERR_CERT_AUTHORITY_INVALID'])

/**
 * The renderer-fetch half of TOFU, sharing the probe's one verdict
 * (isTrustworthyPin): a pinned host whose presented certificate still matches
 * its pin and has not expired is accepted despite Chromium's untrusted-chain
 * verdict; everything else keeps Chromium's own result — valid CA chains pass,
 * unpinned, changed, expired, or otherwise-defective certificates stay
 * rejected. No path here can skip verification globally. Pinning is keyed by
 * hostname because the Electron verification request exposes no port.
 */
export function registerPinnedCertificateVerification(session: Session): void {
  session.setCertificateVerifyProc((request, callback) => {
    const pin = currentCertificatePins().get(request.hostname)
    if (pin === undefined) {
      callback(-3)
      return
    }

    if (!UNTRUSTED_CHAIN_VERIFICATION_RESULTS.has(request.verificationResult)) {
      callback(-3)
      return
    }

    const validTo =
      request.certificate.validExpiry === undefined
        ? undefined
        : new Date(request.certificate.validExpiry * 1000)
    callback(
      isTrustworthyPin({
        pin,
        fingerprint: electronCertificateFingerprint(request.certificate.data),
        validTo
      })
        ? 0
        : -3
    )
  })
}
