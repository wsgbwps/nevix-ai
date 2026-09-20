import { useEffect, useRef, useState } from 'react'
import type { CreationApiResult } from '../api/go-creation-http'
import type { AssetLibraryPorts, MediaAssetView } from '../api/asset-library-http'
import type { InspirationPorts } from '../api/inspiration-http'

type AssetBatchPorts = AssetLibraryPorts & Pick<InspirationPorts, 'publishAsset'>

/** Names the running action, and doubles as its `assets.batch.*` label key. */
export type AssetBatchAction = 'download' | 'remove' | 'publish'

export type AssetBatchStatus =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running' | 'cancelled' | 'failed'
      readonly action: AssetBatchAction
      readonly current: number
      readonly total: number
    }
  | {
      readonly kind: 'complete'
      readonly action: AssetBatchAction
      readonly total: number
      /** Selected assets the action could never run on, so never attempted. */
      readonly skipped?: number
    }

/**
 * Multi-select over the loaded page of an asset wall: the three batch actions
 * run one asset at a time through the single-asset ports, because the whole
 * stack (contract, server routes, preload) only ever grew single-asset
 * endpoints.
 */
export function useAssetSelectionActions(
  ports: AssetBatchPorts,
  assets: readonly MediaAssetView[],
  save: (asset: MediaAssetView, blob: Blob) => void,
  onAssetsChanged: () => void
): {
  readonly selecting: boolean
  readonly selection: ReadonlySet<string>
  /** Whether a selected asset could be published at all. */
  readonly publishable: boolean
  readonly status: AssetBatchStatus
  readonly begin: () => void
  readonly exit: () => void
  readonly resetPage: () => void
  readonly toggle: (assetId: string) => void
  readonly download: () => Promise<void>
  readonly remove: () => Promise<void>
  readonly publish: () => Promise<void>
  readonly cancel: () => void
} {
  const [selecting, setSelecting] = useState(false)
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set())
  const [status, setStatus] = useState<AssetBatchStatus>({ kind: 'idle' })
  const controllerRef = useRef<AbortController | null>(null)
  const publishKeys = useRef(new Map<string, string>())

  useEffect(
    () => () => {
      controllerRef.current?.abort()
    },
    []
  )

  /** The selected assets still on the wall, in the order the wall lists them. */
  const live = assets.filter((asset) => selection.has(asset.id))

  const resetPage = (): void => {
    controllerRef.current?.abort()
    controllerRef.current = null
    setSelection(new Set())
    setStatus({ kind: 'idle' })
  }

  /**
   * Runs `step` over `targets` in order under one controller, stopping at the
   * first failure: the assets before it already changed and cannot be undone,
   * so the status reports what happened rather than retrying or rolling back.
   * `total` counts what was asked for, so an action allowed to touch fewer
   * assets than that reports the difference as skipped.
   *
   * Returns whether the run finished under this controller — a batch detached
   * by a page reset or a filter change returns false and owns no state.
   */
  const run = async (batch: {
    readonly action: AssetBatchAction
    readonly targets: readonly MediaAssetView[]
    readonly total: number
    readonly step: (
      asset: MediaAssetView,
      signal: AbortSignal
    ) => Promise<CreationApiResult<unknown>>
  }): Promise<boolean> => {
    if (controllerRef.current !== null || batch.targets.length === 0) return false
    const controller = new AbortController()
    controllerRef.current = controller
    for (let index = 0; index < batch.targets.length; index++) {
      setStatus({
        kind: 'running',
        action: batch.action,
        current: index + 1,
        total: batch.total
      })
      const result = await batch.step(batch.targets[index], controller.signal)
      if (controllerRef.current !== controller) return false
      if (controller.signal.aborted || result.outcome !== 'succeeded') {
        const cancelled =
          controller.signal.aborted ||
          (result.outcome === 'request-rejected' && result.code === 'download_cancelled')
        controllerRef.current = null
        setStatus({
          kind: cancelled ? 'cancelled' : 'failed',
          action: batch.action,
          current: index + 1,
          total: batch.total
        })
        return true
      }
    }
    controllerRef.current = null
    const skipped = batch.total - batch.targets.length
    setStatus({
      kind: 'complete',
      action: batch.action,
      total: batch.total,
      ...(skipped > 0 ? { skipped } : {})
    })
    return true
  }

  return {
    selecting,
    // Resolved against the loaded wall rather than trusted: once a delete
    // re-reads it, a selection that still named the deleted cards would leave a
    // count for cards that are gone and actions that confirm, then do nothing.
    selection: new Set(live.map((asset) => asset.id)),
    publishable: live.some((asset) => asset.capabilities.canPublish),
    status,
    begin: () => setSelecting(true),
    exit: () => {
      resetPage()
      setSelecting(false)
    },
    resetPage,
    toggle: (assetId) => {
      setSelection((current) => {
        const next = new Set(current)
        if (next.has(assetId)) next.delete(assetId)
        else next.add(assetId)
        return next
      })
    },
    download: async () => {
      await run({
        action: 'download',
        targets: live,
        total: live.length,
        step: async (asset, signal) => {
          const result = await ports.loadAssetContent(asset.id, asset.checksumSha256, {
            signal,
            purpose: 'download',
            expectedByteSize: asset.byteSize
          })
          if (result.outcome === 'succeeded') save(asset, result.value)
          return result
        }
      })
    },
    remove: async () => {
      const finished = await run({
        action: 'remove',
        targets: live,
        total: live.length,
        step: (asset) => ports.deleteAsset(asset.id)
      })
      if (finished) onAssetsChanged()
    },
    publish: async () => {
      // `canPublish` is exact: it already requires ownership, so an asset the
      // server would refuse is never attempted, and no probe request is needed.
      const targets = live.filter((asset) => asset.capabilities.canPublish)
      const finished = await run({
        action: 'publish',
        targets,
        total: live.length,
        step: async (asset) => {
          // Retrying a half-finished batch must not publish an asset twice.
          const key = publishKeys.current.get(asset.id) ?? crypto.randomUUID()
          publishKeys.current.set(asset.id, key)
          const result = await ports.publishAsset(asset.id, key)
          if (result.outcome === 'succeeded') publishKeys.current.delete(asset.id)
          return result
        }
      })
      if (finished) onAssetsChanged()
    },
    cancel: () => controllerRef.current?.abort()
  }
}
