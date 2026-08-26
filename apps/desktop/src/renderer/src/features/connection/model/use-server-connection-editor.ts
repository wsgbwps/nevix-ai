import { useCallback, useRef, useState } from 'react'
import { saveServerConnection, testServerConnection, trustServerCertificate } from '../api/client'
import type {
  CertificateFingerprintView,
  ServerConnectionProbe
} from '../../../../../shared/ipc/connection/types'
import { parseServerUrl } from '../../../../../shared/config/server-url'

export type ServerConnectionEditorState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'testing' }
  | { readonly kind: 'reachable'; readonly url: string; readonly certificateValidTo?: string }
  | {
      readonly kind: 'failed'
      readonly error: 'invalid-url' | 'unreachable' | 'incompatible-server' | 'certificate-expired'
      /** The expired certificate's validity end; `certificate-expired` only. */
      readonly validTo?: string
    }
  | {
      readonly kind: 'certificate'
      readonly decision: 'confirm' | 'changed'
      readonly url: string
      readonly view: CertificateFingerprintView
    }
  | { readonly kind: 'trusting' }
  | { readonly kind: 'saving' }

export interface ServerConnectionEditor {
  readonly draft: string
  readonly state: ServerConnectionEditorState
  readonly isDirty: boolean
  readonly setUrl: (value: string) => void
  readonly reset: () => void
  readonly test: () => Promise<void>
  readonly trustPresentedCertificate: () => Promise<void>
  readonly save: () => Promise<'saved' | 'failed'>
}

/**
 * The shared Connection Screen / Settings editor flow: a draft URL must pass a
 * live probe before it can be saved, an untrusted certificate must be
 * explicitly confirmed by fingerprint (TOFU), and a changed fingerprint is a
 * warning that needs a fresh decision — never a silent override.
 */
export function useServerConnectionEditor(initialUrl: string | undefined): ServerConnectionEditor {
  const [draft, setDraft] = useState(initialUrl ?? '')
  const [state, setState] = useState<ServerConnectionEditorState>({ kind: 'idle' })
  const submissionRef = useRef(false)
  // Dirty is derived, not stored: the draft differs from the saved URL exactly
  // when their canonical origins do.
  const savedCanonicalUrl = initialUrl === undefined ? undefined : parseServerUrl(initialUrl)
  const isDirty = parseServerUrl(draft) !== savedCanonicalUrl

  const setUrl = useCallback((value: string): void => {
    setDraft(value)
    setState({ kind: 'idle' })
  }, [])

  const reset = useCallback((): void => {
    setDraft(initialUrl ?? '')
    setState({ kind: 'idle' })
  }, [initialUrl])

  const settleProbe = useCallback((probe: ServerConnectionProbe, canonicalUrl: string): void => {
    switch (probe.outcome) {
      case 'reachable':
        setState({
          kind: 'reachable',
          url: canonicalUrl,
          certificateValidTo: probe.certificateValidTo
        })
        return
      case 'invalid-url':
        setState({ kind: 'failed', error: 'invalid-url' })
        return
      case 'unreachable':
        setState({ kind: 'failed', error: 'unreachable' })
        return
      case 'incompatible-server':
        setState({ kind: 'failed', error: 'incompatible-server' })
        return
      case 'certificate-expired':
        setState({ kind: 'failed', error: 'certificate-expired', validTo: probe.validTo })
        return
      case 'certificate-confirmation-required':
        setState({ kind: 'certificate', decision: 'confirm', url: canonicalUrl, view: probe })
        return
      case 'certificate-changed':
        setState({ kind: 'certificate', decision: 'changed', url: canonicalUrl, view: probe })
        return
    }
  }, [])

  const test = useCallback(async (): Promise<void> => {
    if (submissionRef.current) return
    const canonicalUrl = parseServerUrl(draft)
    if (!canonicalUrl) {
      setState({ kind: 'failed', error: 'invalid-url' })
      return
    }

    submissionRef.current = true
    setState({ kind: 'testing' })
    try {
      const probe = await testServerConnection(draft)
      settleProbe(probe, canonicalUrl)
    } catch {
      setState({ kind: 'failed', error: 'unreachable' })
    } finally {
      submissionRef.current = false
    }
  }, [draft, settleProbe])

  const trustPresentedCertificate = useCallback(async (): Promise<void> => {
    if (submissionRef.current || state.kind !== 'certificate') return

    submissionRef.current = true
    const { url, view } = state
    setState({ kind: 'trusting' })
    try {
      const trust = await trustServerCertificate(url, view.fingerprint)
      if (trust.outcome !== 'trusted') {
        setState({ kind: 'failed', error: 'unreachable' })
        return
      }

      // Confirm-then-verify: the immediate re-probe proves the pin now
      // matches the certificate the server actually presents.
      const probe = await testServerConnection(url)
      settleProbe(probe, url)
    } catch {
      setState({ kind: 'failed', error: 'unreachable' })
    } finally {
      submissionRef.current = false
    }
  }, [settleProbe, state])

  const save = useCallback(async (): Promise<'saved' | 'failed'> => {
    if (submissionRef.current || state.kind !== 'reachable') return 'failed'
    if (parseServerUrl(draft) !== state.url) return 'failed'

    submissionRef.current = true
    setState({ kind: 'saving' })
    try {
      const result = await saveServerConnection(draft)
      if (result.outcome === 'saved') return 'saved'
      setState({ kind: 'failed', error: 'unreachable' })
      return 'failed'
    } catch {
      setState({ kind: 'failed', error: 'unreachable' })
      return 'failed'
    } finally {
      submissionRef.current = false
    }
  }, [draft, state])

  return { draft, state, isDirty, setUrl, reset, test, trustPresentedCertificate, save }
}
