import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AssetDisplayPurpose,
  AssetLibraryPorts,
  MediaAssetView
} from '../api/asset-library-http'

/** The one read a card needs; the Asset Library's own ports already satisfy it. */
export type AssetDisplayPort = Pick<AssetLibraryPorts, 'loadAssetDisplay'>

/** The one wall-wide ceiling on display authorizations in flight. */
const WALL_AUTHORIZATION_CONCURRENCY = 4

interface AuthorizationJob {
  readonly signal: AbortSignal
  readonly run: () => Promise<void>
}

let activeAuthorizations = 0
const pendingAuthorizations: AuthorizationJob[] = []

function runAuthorizations(): void {
  while (activeAuthorizations < WALL_AUTHORIZATION_CONCURRENCY) {
    const job = pendingAuthorizations.shift()
    if (!job) return
    if (job.signal.aborted) continue
    activeAuthorizations += 1
    void job.run().finally(() => {
      activeAuthorizations -= 1
      runAuthorizations()
    })
  }
}

function queueAuthorization(job: AuthorizationJob): void {
  pendingAuthorizations.push(job)
  runAuthorizations()
}

/**
 * Why a card paints nothing. Both are terminal until the viewer acts.
 * `unavailable` is a fact about the resource; `retryable` is a transient
 * fault the viewer may choose to retry.
 */
export type AssetDisplayFailure = 'unavailable' | 'retryable'

export interface AssetDisplayState {
  readonly url: string | null
  readonly failure: AssetDisplayFailure | null
  /** The viewer's explicit retry after the automatic one was spent. */
  readonly retry: () => void
  /** Report the media element's own `error` event. */
  readonly reportElementError: () => void
}

/**
 * Paints one Asset from a short-lived display grant instead of waiting for a
 * complete Blob (ADR-0014). The grant is fetched when the card enters the
 * near-visible range and handed straight to the element.
 *
 * A failure buys exactly one automatic re-authorization — a grant that expired
 * between issue and load, or a dropped connection, often recovers unwatched —
 * and then stops at `retryable`, so a card can never spin forever. A resource
 * that answers gone or forbidden is `unavailable` immediately: re-asking would
 * only repeat an answer the server has already given.
 */
export function useAssetDisplay(
  ports: AssetDisplayPort,
  asset: Pick<MediaAssetView, 'id'>,
  {
    enabled,
    queued,
    purpose,
    onUnavailable
  }: {
    /** The card is near-visible, or this is an opened detail. */
    readonly enabled: boolean
    /** Wall authorizations share the four-slot queue; details bypass it. */
    readonly queued: boolean
    readonly purpose: AssetDisplayPurpose
    /** The resource answered gone or forbidden: the list's facts are stale. */
    readonly onUnavailable?: () => void
  }
): AssetDisplayState {
  const [state, setState] = useState<{
    readonly assetId: string
    readonly url: string | null
    readonly failure: AssetDisplayFailure | null
  }>({ assetId: asset.id, url: null, failure: null })
  // The automatic re-authorization already spent. One per mount, and the
  // viewer's own retry clears it — that is the whole difference between a
  // bounded recovery and a loop.
  const spentAutomaticRetry = useRef(false)
  const [generation, setGeneration] = useState(0)
  // Held by ref because the page's own refresh identity changes as it loads
  // pages, and re-running this read for that would re-authorize the whole wall.
  const onUnavailableRef = useRef(onUnavailable)
  useEffect(() => {
    onUnavailableRef.current = onUnavailable
  }, [onUnavailable])

  const beginReload = useCallback((): void => {
    setState({ assetId: asset.id, url: null, failure: null })
    setGeneration((current) => current + 1)
  }, [asset.id])

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let objectUrl: string | null = null
    const settle = (failure: AssetDisplayFailure | null, url: string | null): void => {
      if (controller.signal.aborted) return
      setState({ assetId: asset.id, url, failure })
    }

    const load = async (): Promise<void> => {
      const result = await ports.loadAssetDisplay(asset.id, purpose, {
        signal: controller.signal
      })
      if (controller.signal.aborted) return
      if (result.outcome !== 'succeeded') {
        // A 401 already retired the session in the ports layer; a gone or
        // forbidden resource will answer the same way to any number of asks.
        const settled =
          result.outcome === 'unauthorized' ||
          result.outcome === 'forbidden' ||
          (result.outcome === 'request-rejected' && result.code === 'not_found')
        if (settled) {
          settle('unavailable', null)
          onUnavailableRef.current?.()
          return
        }
        if (!spentAutomaticRetry.current) {
          spentAutomaticRetry.current = true
          beginReload()
          return
        }
        settle('retryable', null)
        return
      }
      if (result.value.kind === 'blob') {
        objectUrl = URL.createObjectURL(result.value.blob)
        settle(null, objectUrl)
        return
      }
      settle(null, result.value.url)
    }

    if (queued) queueAuthorization({ signal: controller.signal, run: load })
    else void load()
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [asset.id, beginReload, enabled, ports, purpose, queued, generation])

  // The element rejected a grant the server considered live: the bytes are the
  // problem, so invalidate the URL and ask Go for one fresh grant before
  // conceding. The same single automatic retry covers this case, which is why
  // an authorization failure and a decode failure can never each claim one.
  const reportElementError = useCallback((): void => {
    if (spentAutomaticRetry.current) {
      setState({ assetId: asset.id, url: null, failure: 'retryable' })
      return
    }
    spentAutomaticRetry.current = true
    beginReload()
  }, [asset.id, beginReload])

  const retry = useCallback((): void => {
    spentAutomaticRetry.current = false
    beginReload()
  }, [beginReload])

  return state.assetId === asset.id
    ? { url: state.url, failure: state.failure, retry, reportElementError }
    : { url: null, failure: null, retry, reportElementError }
}
