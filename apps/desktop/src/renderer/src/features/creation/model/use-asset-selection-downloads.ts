import { useEffect, useRef, useState } from 'react'
import type { AssetLibraryPorts, MediaAssetView } from '../api/asset-library-http'

export type AssetBatchStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly current: number; readonly total: number }
  | { readonly kind: 'cancelled'; readonly current: number; readonly total: number }
  | { readonly kind: 'failed'; readonly current: number; readonly total: number }
  | { readonly kind: 'complete'; readonly total: number }

export function useAssetSelectionDownloads(
  ports: AssetLibraryPorts,
  assets: readonly MediaAssetView[],
  save: (asset: MediaAssetView, blob: Blob) => void
): {
  readonly selecting: boolean
  readonly selection: ReadonlySet<string>
  readonly status: AssetBatchStatus
  readonly begin: () => void
  readonly exit: () => void
  readonly resetPage: () => void
  readonly toggle: (assetId: string) => void
  readonly download: () => Promise<void>
  readonly cancel: () => void
} {
  const [selecting, setSelecting] = useState(false)
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set())
  const [status, setStatus] = useState<AssetBatchStatus>({ kind: 'idle' })
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(
    () => () => {
      controllerRef.current?.abort()
    },
    []
  )

  const resetPage = (): void => {
    controllerRef.current?.abort()
    controllerRef.current = null
    setSelection(new Set())
    setStatus({ kind: 'idle' })
  }

  return {
    selecting,
    selection,
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
      if (controllerRef.current !== null) return
      const chosen = assets.filter((asset) => selection.has(asset.id))
      const controller = new AbortController()
      controllerRef.current = controller
      for (let index = 0; index < chosen.length; index++) {
        setStatus({ kind: 'running', current: index + 1, total: chosen.length })
        const result = await ports.loadAssetContent(
          chosen[index].id,
          chosen[index].checksumSha256,
          {
            signal: controller.signal,
            purpose: 'download',
            expectedByteSize: chosen[index].byteSize
          }
        )
        if (controllerRef.current !== controller) return
        if (controller.signal.aborted || result.outcome !== 'succeeded') {
          const cancelled =
            controller.signal.aborted ||
            (result.outcome === 'request-rejected' && result.code === 'download_cancelled')
          setStatus({
            kind: cancelled ? 'cancelled' : 'failed',
            current: index + 1,
            total: chosen.length
          })
          controllerRef.current = null
          return
        }
        save(chosen[index], result.value)
      }
      controllerRef.current = null
      setStatus({ kind: 'complete', total: chosen.length })
    },
    cancel: () => controllerRef.current?.abort()
  }
}
