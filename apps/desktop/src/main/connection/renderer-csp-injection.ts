import { app, type Session } from 'electron'
import { currentServerConnectionUrl } from './connection-store'
import { rendererConnectSourceCsp } from './renderer-csp'

/**
 * Injects the runtime `connect-src` header onto the window's main document.
 * Every top-level document in this application is Nevix AI's own renderer
 * (window-open is denied and navigation is prevented), so filtering on the
 * main-frame resource type is the complete scope.
 */
export function registerRendererCspInjection(session: Session): void {
  session.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'mainFrame') {
      callback({})
      return
    }

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          rendererConnectSourceCsp(currentServerConnectionUrl(), !app.isPackaged)
        ]
      }
    })
  })
}
