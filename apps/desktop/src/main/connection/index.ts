import { session } from 'electron'
import { readServerConnection } from './connection-store'
import { registerPinnedCertificateVerification } from './certificate-verify'
import { registerRendererCspInjection } from './renderer-csp-injection'

/**
 * Public interface of the connection Domain: boots the persisted server
 * connection into memory and installs the two runtime guards — TOFU
 * certificate verification for renderer fetches and the runtime `connect-src`
 * for the renderer document — before the main window loads.
 */
export async function initializeConnectionRuntime(): Promise<void> {
  registerPinnedCertificateVerification(session.defaultSession)
  registerRendererCspInjection(session.defaultSession)
  await readServerConnection()
}
