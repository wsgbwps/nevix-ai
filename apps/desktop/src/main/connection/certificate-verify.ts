import type { Session } from 'electron'
import { electronCertificateFingerprint } from './certificate-pins'
import { currentCertificatePins } from './connection-store'

/**
 * The renderer-fetch half of TOFU: a pinned host whose presented certificate
 * still matches its pin is accepted despite Chromium's untrusted-chain
 * verdict; everything else keeps Chromium's own result — valid CA chains pass,
 * unpinned or changed certificates stay rejected. Pinning is keyed by hostname
 * because the Electron verification request exposes no port.
 */
export function registerPinnedCertificateVerification(session: Session): void {
  session.setCertificateVerifyProc((request, callback) => {
    const pin = currentCertificatePins().get(request.hostname)
    if (pin === undefined) {
      callback(-3)
      return
    }

    callback(electronCertificateFingerprint(request.certificate.data) === pin ? 0 : -3)
  })
}
