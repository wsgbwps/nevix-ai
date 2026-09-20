import { useState } from 'react'
import { useCursorPages, type MoreStatus, type PageStatus } from '../../../hooks/use-cursor-pages'
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
  readonly status: PageStatus
  readonly more: MoreStatus
  readonly hasMore: boolean
  readonly submittedFilters: InspirationFilters
  readonly loadMore: () => void
  readonly submit: (filters: InspirationFilters) => void
  readonly clear: () => void
  readonly retry: () => void
  readonly refresh: () => void
} {
  const [submittedFilters, setSubmittedFilters] = useState(initialFilters)

  const pages = useCursorPages<InspirationItem>(async (cursor) => {
    const result = await ports.listInspiration(request(submittedFilters, cursor))
    if (result.outcome !== 'succeeded') return null
    return { items: result.value.items, nextCursor: result.value.nextCursor }
  })

  const submit = (filters: InspirationFilters): void => {
    setSubmittedFilters(filters)
    pages.reset()
  }

  return {
    items: pages.items,
    status: pages.status,
    more: pages.more,
    hasMore: pages.hasMore,
    submittedFilters,
    loadMore: pages.loadMore,
    submit,
    clear: () => submit(initialFilters),
    retry: pages.reset,
    refresh: pages.refresh
  }
}
