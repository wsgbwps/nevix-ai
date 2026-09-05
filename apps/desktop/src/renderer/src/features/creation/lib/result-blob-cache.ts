export const RESULT_BLOB_CACHE_MAX_BYTES = 64 * 1024 * 1024

export interface ResultBlobUrlLease {
  readonly url: string
  release(): void
}

interface CacheEntry {
  readonly key: string
  readonly blob: Promise<Blob | null>
  value: Blob | null
  url: string | null
  bytes: number
  leases: number
  lastUsed: number
}

interface ResultBlobCacheOptions {
  readonly maxBytes?: number
  readonly urls?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>
}

/**
 * Owns verified result bytes and display URLs for succeeded slots
 * (ADR-0018). Idle entries are retained under a byte-measured LRU budget;
 * active URL leases may temporarily exceed it because revoking a URL still
 * displayed by a card would corrupt the visible result.
 */
export class ResultBlobCache {
  readonly #entries = new Map<string, CacheEntry>()
  readonly #load: (taskId: string, slotIndex: number) => Promise<Blob | null>
  readonly #urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>
  readonly #maxBytes: number
  #bytes = 0
  #clock = 0

  constructor(
    load: (taskId: string, slotIndex: number) => Promise<Blob | null>,
    options: ResultBlobCacheOptions = {}
  ) {
    this.#load = load
    this.#urls = options.urls ?? URL
    this.#maxBytes = options.maxBytes ?? RESULT_BLOB_CACHE_MAX_BYTES
  }

  async acquireObjectUrl(taskId: string, slotIndex: number): Promise<ResultBlobUrlLease | null> {
    const entry = this.#entry(taskId, slotIndex)
    entry.leases += 1
    this.#touch(entry)
    const blob = await entry.blob
    if (blob === null || this.#entries.get(entry.key) !== entry) {
      if (this.#entries.get(entry.key) === entry) entry.leases -= 1
      return null
    }
    if (entry.url === null) entry.url = this.#urls.createObjectURL(blob)
    const url = entry.url
    let released = false
    return {
      url,
      release: () => {
        if (released) return
        released = true
        if (this.#entries.get(entry.key) !== entry) return
        entry.leases -= 1
        this.#touch(entry)
        this.#evict()
      }
    }
  }

  async blob(taskId: string, slotIndex: number): Promise<Blob | null> {
    const entry = this.#entry(taskId, slotIndex)
    entry.leases += 1
    this.#touch(entry)
    const blob = await entry.blob
    if (this.#entries.get(entry.key) !== entry) return null
    entry.leases -= 1
    this.#touch(entry)
    this.#evict()
    return blob
  }

  /** Retires this display generation, including its in-flight transfers. */
  dispose(): void {
    for (const entry of [...this.#entries.values()]) this.#remove(entry)
  }

  #key(taskId: string, slotIndex: number): string {
    return `${taskId}:${slotIndex}`
  }

  #entry(taskId: string, slotIndex: number): CacheEntry {
    const key = this.#key(taskId, slotIndex)
    const existing = this.#entries.get(key)
    if (existing !== undefined) {
      this.#touch(existing)
      return existing
    }

    const blob = this.#load(taskId, slotIndex)
      .catch((): Blob | null => null)
      .then((value) => {
        const current = this.#entries.get(key)
        if (current === undefined || current.blob !== blob) return null
        if (value === null) {
          this.#remove(current)
          return null
        }
        current.value = value
        current.bytes = value.size
        this.#bytes += value.size
        this.#touch(current)
        this.#evict()
        return this.#entries.get(key) === current ? value : null
      })
    const entry: CacheEntry = {
      key,
      value: null,
      url: null,
      bytes: 0,
      leases: 0,
      lastUsed: 0,
      blob
    }
    this.#touch(entry)
    this.#entries.set(key, entry)
    return entry
  }

  #touch(entry: CacheEntry): void {
    entry.lastUsed = ++this.#clock
  }

  #evict(): void {
    if (this.#bytes <= this.#maxBytes) return
    const released = [...this.#entries.values()]
      .filter((entry) => entry.value !== null && entry.leases === 0)
      .sort((left, right) => left.lastUsed - right.lastUsed)
    for (const entry of released) {
      this.#remove(entry)
      if (this.#bytes <= this.#maxBytes) break
    }
  }

  #remove(entry: CacheEntry): void {
    if (this.#entries.get(entry.key) !== entry) return
    this.#entries.delete(entry.key)
    this.#bytes -= entry.bytes
    if (entry.url !== null) this.#urls.revokeObjectURL(entry.url)
  }
}
