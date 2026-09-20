import { useCallback, useEffect, useRef, useState } from 'react'

export interface CursorPage<T> {
  readonly items: readonly T[]
  readonly nextCursor: string | null
}

/** Load one page; resolve `null` when the request failed. */
export type FetchCursorPage<T> = (cursor: string | null) => Promise<CursorPage<T> | null>

/** How much of the first page is on screen. */
export type PageStatus = 'loading' | 'ready' | 'failed'

/** How the page after the loaded ones is going. */
export type MoreStatus = 'idle' | 'loading' | 'failed'

export interface CursorPages<T> {
  readonly items: readonly T[]
  /** The first page only, so a later failure never blanks what is already on screen. */
  readonly status: PageStatus
  readonly more: MoreStatus
  readonly hasMore: boolean
  readonly loadMore: () => void
  /** Start over from the first page: a filter change, or a retry after a failed first page. */
  readonly reset: () => void
  /** Re-fetch every loaded page in place, so a mutation reconciles without dropping the list. */
  readonly refresh: () => void
}

export function useCursorPages<T>(fetchPage: FetchCursorPage<T>): CursorPages<T> {
  const fetch = useRef(fetchPage)

  const [items, setItems] = useState<readonly T[]>([])
  // The cursor that fetched each loaded page, oldest first; its length is the
  // page count, and `null` at index 0 is always the first page.
  const [trail, setTrail] = useState<readonly (string | null)[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [status, setStatus] = useState<PageStatus>('loading')
  const [more, setMore] = useState<MoreStatus>('idle')
  const [generation, setGeneration] = useState(0)

  // One request at a time, and only the newest may settle: a superseded reply
  // must not clear the guard its successor owns. `busy` is checked and set
  // synchronously, so a scroll and a click landing in one tick still send one
  // request rather than two.
  const sequence = useRef(0)
  const busy = useRef(false)

  useEffect(() => {
    fetch.current = fetchPage
  })

  useEffect(() => {
    const id = ++sequence.current
    busy.current = true
    void fetch.current(null).then((page) => {
      if (id !== sequence.current) return
      busy.current = false
      if (page === null) {
        setStatus('failed')
        return
      }
      setItems(page.items)
      setTrail([null])
      setNextCursor(page.nextCursor)
      setStatus('ready')
    })
  }, [generation])

  const loadMore = useCallback(() => {
    if (busy.current || nextCursor === null) return
    const id = ++sequence.current
    busy.current = true
    setMore('loading')
    void fetch.current(nextCursor).then((page) => {
      if (id !== sequence.current) return
      busy.current = false
      if (page === null) {
        setMore('failed')
        return
      }
      setItems((current) => [...current, ...page.items])
      setTrail((current) => [...current, nextCursor])
      // A server handing back the cursor it was just given would append forever.
      setNextCursor(page.nextCursor === nextCursor ? null : page.nextCursor)
      setMore('idle')
    })
  }, [nextCursor])

  const reset = useCallback(() => {
    // Supersede anything in flight here: the generation effect above re-arms
    // `sequence` a pass later, and a reply settling inside that window would
    // otherwise append its page onto the list this reset just cleared.
    sequence.current += 1
    busy.current = false
    setItems([])
    setTrail([])
    setNextCursor(null)
    setStatus('loading')
    setMore('idle')
    setGeneration((value) => value + 1)
  }, [])

  const refresh = useCallback(() => {
    const cursors = trail
    if (cursors.length === 0) {
      // Nothing ever loaded, so there is no page to replay: start over rather
      // than leave a mutation-triggered refresh a silent no-op.
      reset()
      return
    }
    const id = ++sequence.current
    busy.current = true
    setMore('loading')
    void (async () => {
      const pages: CursorPage<T>[] = []
      for (const cursor of cursors) {
        const page = await fetch.current(cursor)
        if (id !== sequence.current) return
        if (page === null) {
          // Whatever asked for this refresh already reported its own outcome;
          // leaving the list one refresh stale reads better than blanking it.
          // ponytail: silent-stale, surface a notice if a stale wall ever misleads.
          busy.current = false
          setMore('idle')
          return
        }
        pages.push(page)
      }
      busy.current = false
      setItems(pages.flatMap((page) => page.items))
      setNextCursor(pages.at(-1)?.nextCursor ?? null)
      setMore('idle')
    })()
  }, [reset, trail])

  return {
    items,
    status,
    more,
    hasMore: nextCursor !== null,
    loadMore,
    reset,
    refresh
  }
}
