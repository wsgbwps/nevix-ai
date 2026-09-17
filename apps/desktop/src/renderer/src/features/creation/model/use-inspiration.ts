import { useEffect, useState } from 'react'
import type {
  InspirationItem,
  InspirationPageRequest,
  InspirationPorts
} from '../api/inspiration-http'

const PAGE_SIZE = 24

export interface InspirationFilters {
  readonly mediaType: '' | 'image' | 'video'
  readonly creator: string
  readonly search: string
}

function request(filters: InspirationFilters, cursor: string | null): InspirationPageRequest {
  return {
    cursor,
    mediaType: filters.mediaType || undefined,
    creator: filters.creator.trim() || undefined,
    search: filters.search.trim() || undefined,
    limit: PAGE_SIZE
  }
}

export function hasInspirationFilters(filters: InspirationFilters): boolean {
  return Boolean(filters.mediaType || filters.creator.trim() || filters.search.trim())
}

export function useInspiration(
  ports: InspirationPorts,
  initialFilters: InspirationFilters
): {
  readonly items: readonly InspirationItem[]
  readonly status: 'loading' | 'ready' | 'failed'
  readonly submittedFilters: InspirationFilters
  readonly canPrevious: boolean
  readonly canNext: boolean
  readonly submit: (filters: InspirationFilters) => void
  readonly clear: () => void
  readonly retry: () => void
  readonly refresh: () => void
  readonly previous: () => void
  readonly next: () => void
} {
  const [submittedFilters, setSubmittedFilters] = useState(initialFilters)
  const [cursor, setCursor] = useState<string | null>(null)
  const [cursorHistory, setCursorHistory] = useState<(string | null)[]>([])
  const [items, setItems] = useState<readonly InspirationItem[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    void ports.listInspiration(request(submittedFilters, cursor)).then((result) => {
      if (!active) return
      if (result.outcome !== 'succeeded') {
        setStatus('failed')
        return
      }
      if (result.value.items.length === 0 && cursorHistory.length > 0) {
        setCursor(cursorHistory.at(-1) ?? null)
        setCursorHistory((history) => history.slice(0, -1))
        return
      }
      setItems(result.value.items)
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
  const submit = (filters: InspirationFilters): void => {
    setStatus('loading')
    setCursor(null)
    setCursorHistory([])
    setSubmittedFilters(filters)
    setReload((value) => value + 1)
  }

  return {
    items,
    status,
    submittedFilters,
    canPrevious: cursorHistory.length > 0,
    canNext: nextCursor !== null,
    submit,
    clear: () => submit(initialFilters),
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
