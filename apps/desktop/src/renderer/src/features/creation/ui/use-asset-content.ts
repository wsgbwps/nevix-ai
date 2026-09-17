import { useEffect, useState } from 'react'
import type { AssetContentOptions, MediaAssetView } from '../api/asset-library-http'
import type { CreationApiResult } from '../api/go-creation-http'

export interface AssetContentPort {
  readonly loadAssetContent: (
    assetId: string,
    checksumSha256: string,
    options?: AssetContentOptions
  ) => Promise<CreationApiResult<Blob>>
}

export const WALL_PREVIEW_MAX_BYTES = 8 * 1024 * 1024
const WALL_PREVIEW_CONCURRENCY = 4

interface PreviewJob {
  readonly signal: AbortSignal
  readonly run: () => Promise<void>
}

let activePreviews = 0
const pendingPreviews: PreviewJob[] = []

function runPreviews(): void {
  while (activePreviews < WALL_PREVIEW_CONCURRENCY) {
    const job = pendingPreviews.shift()
    if (!job) return
    if (job.signal.aborted) continue
    activePreviews += 1
    void job.run().finally(() => {
      activePreviews -= 1
      runPreviews()
    })
  }
}

function queuePreview(job: PreviewJob): void {
  pendingPreviews.push(job)
  runPreviews()
}

export function useAssetContent(
  ports: AssetContentPort,
  asset: Pick<MediaAssetView, 'id' | 'checksumSha256' | 'byteSize'>,
  enabled: boolean,
  queued: boolean
): { readonly url: string | null; readonly failed: boolean } {
  const [state, setState] = useState<{ assetId: string; url: string | null; failed: boolean }>({
    assetId: asset.id,
    url: null,
    failed: false
  })

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let url: string | null = null
    const load = async (): Promise<void> => {
      const result = await ports.loadAssetContent(asset.id, asset.checksumSha256, {
        signal: controller.signal,
        purpose: 'preview',
        expectedByteSize: asset.byteSize
      })
      if (controller.signal.aborted) return
      if (result.outcome !== 'succeeded') {
        setState({ assetId: asset.id, url: null, failed: true })
        return
      }
      url = URL.createObjectURL(result.value)
      setState({ assetId: asset.id, url, failed: false })
    }

    if (queued) queuePreview({ signal: controller.signal, run: load })
    else void load()
    return () => {
      controller.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [asset.byteSize, asset.checksumSha256, asset.id, enabled, ports, queued])

  return state.assetId === asset.id ? state : { url: null, failed: false }
}
