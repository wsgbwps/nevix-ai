import { useState } from 'react'
import { useCursorPages, type MoreStatus, type PageStatus } from '../../../hooks/use-cursor-pages'
import type {
  AssetFacetVocabulary,
  AssetLibraryPorts,
  AssetMediaType,
  AssetPageRequest,
  AssetSort,
  MediaAssetView
} from '../api/asset-library-http'

const PAGE_SIZE = 24

export interface AssetFilters {
  readonly mediaType: AssetMediaType
  /** Inclusive local start day (`YYYY-MM-DD`) or empty. */
  readonly createdSince: string
  /** Inclusive local end day (`YYYY-MM-DD`) or empty. */
  readonly createdUntil: string
  readonly sort: AssetSort
  /** Frozen Generation Specification facets; empty means unconstrained. */
  readonly modes: readonly string[]
  readonly ratios: readonly string[]
  readonly resolutions: readonly string[]
}

/** True when any facet is selected, i.e. the panel is narrowing the wall. */
export function hasFacets(filters: AssetFilters): boolean {
  return filters.modes.length > 0 || filters.ratios.length > 0 || filters.resolutions.length > 0
}

/** Local calendar day (`YYYY-MM-DD`) of an instant — the day an Asset is filed under. */
export function isoDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Instant of a local day boundary; `offsetDays` shifts by whole days. */
function dayBoundary(day: string, offsetDays: number): string | undefined {
  if (!day) return undefined
  const [year, month, date] = day.split('-').map(Number)
  if (!year || !month || !date) return undefined
  return new Date(year, month - 1, date + offsetDays).toISOString()
}

function pageRequest(filters: AssetFilters, cursor: string | null): AssetPageRequest {
  return {
    limit: PAGE_SIZE,
    cursor,
    mediaType: filters.mediaType,
    createdSince: dayBoundary(filters.createdSince, 0),
    createdUntil: dayBoundary(filters.createdUntil, 1),
    sort: filters.sort,
    modes: filters.modes,
    ratios: filters.ratios,
    resolutions: filters.resolutions
  }
}

export function useAssetList(
  ports: AssetLibraryPorts,
  initialFilters: AssetFilters
): {
  readonly assets: readonly MediaAssetView[]
  readonly facets: AssetFacetVocabulary | null
  readonly status: PageStatus
  readonly more: MoreStatus
  readonly hasMore: boolean
  readonly loadMore: () => void
  readonly submit: (filters: AssetFilters) => void
  readonly retry: () => void
  readonly refresh: () => void
} {
  const [submittedFilters, setSubmittedFilters] = useState(initialFilters)
  // The vocabulary is per media: keep the media it was issued for, so a
  // switched tab never offers the previous media's values.
  const [facetSet, setFacetSet] = useState<{
    readonly mediaType: AssetMediaType
    readonly vocabulary: AssetFacetVocabulary
  } | null>(null)

  const pages = useCursorPages<MediaAssetView>(async (cursor) => {
    const result = await ports.listAssets(pageRequest(submittedFilters, cursor))
    if (result.outcome !== 'succeeded') return null
    if (result.value.facets !== null) {
      setFacetSet({
        mediaType: submittedFilters.mediaType,
        vocabulary: result.value.facets
      })
    }
    return { items: result.value.assets, nextCursor: result.value.nextCursor }
  })

  return {
    assets: pages.items,
    facets: facetSet?.mediaType === submittedFilters.mediaType ? facetSet.vocabulary : null,
    status: pages.status,
    more: pages.more,
    hasMore: pages.hasMore,
    loadMore: pages.loadMore,
    submit: (filters) => {
      setSubmittedFilters(filters)
      pages.reset()
    },
    retry: pages.reset,
    refresh: pages.refresh
  }
}
