import { useEffect, useRef, useState } from 'react'
import type {
  AssetDetailView,
  AssetLibraryPorts,
  AssetPrivateOrigin,
  MediaAssetView
} from '../api/asset-library-http'

export type AssetDetailStatus = 'idle' | 'loading' | 'failed'
export type AssetDownloadStatus = 'idle' | 'running' | 'failed' | 'complete'
export type PrepareAssetSimilar = (
  origin: AssetPrivateOrigin,
  replaceExisting?: boolean
) => 'prepared' | 'replacement-required' | 'unavailable'

export function useAssetDetail({
  ports,
  prepareSimilar,
  save,
  onDeleted
}: {
  readonly ports: AssetLibraryPorts
  readonly prepareSimilar: PrepareAssetSimilar
  readonly save: (asset: MediaAssetView, blob: Blob) => void
  readonly onDeleted: () => void
}): {
  readonly assetId: string | null
  readonly detail: AssetDetailView | null
  readonly status: AssetDetailStatus
  readonly downloadStatus: AssetDownloadStatus
  readonly reuseFailed: boolean
  readonly open: (assetId: string) => void
  readonly close: () => void
  readonly download: (asset: MediaAssetView) => Promise<void>
  readonly createSimilar: (confirmReplacement: () => boolean) => Promise<void>
  readonly remove: (confirmDeletion: () => boolean) => Promise<void>
} {
  const [assetId, setAssetId] = useState<string | null>(null)
  const [detail, setDetail] = useState<AssetDetailView | null>(null)
  const [status, setStatus] = useState<AssetDetailStatus>('idle')
  const [downloadStatus, setDownloadStatus] = useState<AssetDownloadStatus>('idle')
  const [reuseFailed, setReuseFailed] = useState(false)
  const downloadController = useRef<AbortController | null>(null)
  const assetIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (assetId === null) return
    let active = true
    void ports.getAsset(assetId).then((result) => {
      if (!active) return
      if (result.outcome !== 'succeeded') {
        setStatus('failed')
        return
      }
      setDetail(result.value)
      setStatus('idle')
    })
    return () => {
      active = false
    }
  }, [assetId, ports])

  useEffect(
    () => () => {
      downloadController.current?.abort()
    },
    []
  )

  const close = (): void => {
    downloadController.current?.abort()
    downloadController.current = null
    assetIdRef.current = null
    setAssetId(null)
    setDetail(null)
    setStatus('idle')
    setDownloadStatus('idle')
    setReuseFailed(false)
  }

  return {
    assetId,
    detail,
    status,
    downloadStatus,
    reuseFailed,
    open: (nextAssetId) => {
      if (nextAssetId === assetIdRef.current) return
      downloadController.current?.abort()
      downloadController.current = null
      setDetail(null)
      setStatus('loading')
      setDownloadStatus('idle')
      setReuseFailed(false)
      assetIdRef.current = nextAssetId
      setAssetId(nextAssetId)
    },
    close,
    download: async (asset) => {
      downloadController.current?.abort()
      const controller = new AbortController()
      downloadController.current = controller
      setDownloadStatus('running')
      const result = await ports.loadAssetContent(asset.id, asset.checksumSha256, {
        signal: controller.signal,
        purpose: 'download'
      })
      if (controller.signal.aborted || assetIdRef.current !== asset.id) return
      downloadController.current = null
      if (result.outcome !== 'succeeded') {
        setDownloadStatus('failed')
        return
      }
      save(asset, result.value)
      setDownloadStatus('complete')
    },
    createSimilar: async (confirmReplacement) => {
      if (detail === null) return
      const selectedId = detail.asset.id
      setReuseFailed(false)
      const result = await ports.getAsset(selectedId)
      if (
        assetIdRef.current !== selectedId ||
        result.outcome !== 'succeeded' ||
        result.value.asset.id !== selectedId ||
        !result.value.asset.capabilities.canCreateSimilar ||
        result.value.privateOrigin === null
      ) {
        if (assetIdRef.current === selectedId) setReuseFailed(true)
        return
      }
      const outcome = prepareSimilar(result.value.privateOrigin)
      if (outcome !== 'replacement-required') {
        if (outcome === 'unavailable') setReuseFailed(true)
        return
      }
      if (!confirmReplacement()) return
      if (prepareSimilar(result.value.privateOrigin, true) !== 'prepared') setReuseFailed(true)
    },
    remove: async (confirmDeletion) => {
      if (detail === null || !confirmDeletion()) return
      const result = await ports.deleteAsset(detail.asset.id)
      if (result.outcome !== 'succeeded') return
      close()
      onDeleted()
    }
  }
}
