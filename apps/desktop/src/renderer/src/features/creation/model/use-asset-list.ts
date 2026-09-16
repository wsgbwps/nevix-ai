import { useEffect, useState } from 'react'
import type {
  AssetLibraryPorts,
  AssetMediaType,
  AssetPageRequest,
  AssetSort,
  MediaAssetView
} from '../api/asset-library-http'

const PAGE_SIZE = 24

export interface AssetFilters {
  readonly mediaType: '' | AssetMediaType
  readonly creator: string
  readonly createdSince: string
  readonly sort: AssetSort
  readonly search: string
}

function pageRequest(filters: AssetFilters, cursor: string | null): AssetPageRequest {
  return {
    limit: PAGE_SIZE,
    cursor,
    mediaType: filters.mediaType || undefined,
    creator: filters.creator.trim() || undefined,
    createdSince: filters.createdSince
      ? new Date(`${filters.createdSince}T00:00:00`).toISOString()
      : undefined,
    sort: filters.sort,
    search: filters.search.trim() || undefined
  }
}

export function useAssetList(
  ports: AssetLibraryPorts,
  initialFilters: AssetFilters
): {
  readonly assets: readonly MediaAssetView[]
  readonly status: 'loading' | 'ready' | 'failed'
  readonly canPrevious: boolean
  readonly canNext: boolean
  readonly submit: (filters: AssetFilters) => void
  readonly retry: () => void
  readonly refresh: () => void
  readonly previous: () => void
  readonly next: () => void
} {
  const [submittedFilters, setSubmittedFilters] = useState(initialFilters)
  const [cursor, setCursor] = useState<string | null>(null)
  const [cursorHistory, setCursorHistory] = useState<(string | null)[]>([])
  const [assets, setAssets] = useState<readonly MediaAssetView[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    void ports.listAssets(pageRequest(submittedFilters, cursor)).then((result) => {
      if (!active) return
      if (result.outcome !== 'succeeded') {
        setStatus('failed')
        return
      }
      if (result.value.assets.length === 0 && cursorHistory.length > 0) {
        setStatus('loading')
        setCursor(cursorHistory.at(-1) ?? null)
        setCursorHistory((history) => history.slice(0, -1))
        return
      }
      setAssets(result.value.assets)
      setNextCursor(result.value.nextCursor)
      setStatus('ready')
    })
    return () => {
      active = false
    }
  }, [cursor, cursorHistory, ports, reload, submittedFilters])

  const refresh = (): void => {
    setStatus('loading')
    setReload((value) => value + 1)
  }

  return {
    assets,
    status,
    canPrevious: cursorHistory.length > 0,
    canNext: nextCursor !== null,
    submit: (filters) => {
      setStatus('loading')
      setCursor(null)
      setCursorHistory([])
      setSubmittedFilters(filters)
      setReload((value) => value + 1)
    },
    retry: refresh,
    refresh,
    previous: () => {
      setStatus('loading')
      setCursor(cursorHistory.at(-1) ?? null)
      setCursorHistory((history) => history.slice(0, -1))
    },
    next: () => {
      if (nextCursor === null) return
      setStatus('loading')
      setCursorHistory((history) => [...history, cursor])
      setCursor(nextCursor)
    }
  }
}
