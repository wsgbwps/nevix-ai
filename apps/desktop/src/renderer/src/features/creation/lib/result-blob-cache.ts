/**
 * Owns the verified result bytes and display URLs for succeeded slots
 * (ADR-0018): a succeeded slot's output is immutable, so every consumer —
 * gallery render, download, reference re-upload — rides one transfer per
 * (task, slot). Display URLs are created once per blob and revoked on
 * dispose; a failed transfer is not sticky, the next request retries.
 */
export class ResultBlobCache {
  readonly #entries = new Map<string, { blob: Promise<Blob | null>; url: string | null }>()
  readonly #load: (taskId: string, slotIndex: number) => Promise<Blob | null>
  readonly #urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>

  constructor(
    load: (taskId: string, slotIndex: number) => Promise<Blob | null>,
    urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL
  ) {
    this.#load = load
    this.#urls = urls
  }

  async objectUrl(taskId: string, slotIndex: number): Promise<string | null> {
    const entry = this.#entry(taskId, slotIndex)
    const blob = await entry.blob
    if (blob === null) return null
    // A dispose between transfer and URL creation orphaned this entry;
    // manufacturing an untracked URL would leak it forever.
    if (this.#entries.get(this.#key(taskId, slotIndex)) !== entry) return null
    if (entry.url === null) entry.url = this.#urls.createObjectURL(blob)
    return entry.url
  }

  blob(taskId: string, slotIndex: number): Promise<Blob | null> {
    return this.#entry(taskId, slotIndex).blob
  }

  /** Revokes every display URL and forgets every transfer; later requests
   * cross the wire again. */
  dispose(): void {
    for (const entry of this.#entries.values()) {
      if (entry.url !== null) this.#urls.revokeObjectURL(entry.url)
    }
    this.#entries.clear()
  }

  #key(taskId: string, slotIndex: number): string {
    return `${taskId}:${slotIndex}`
  }

  #entry(taskId: string, slotIndex: number): { blob: Promise<Blob | null>; url: string | null } {
    const key = this.#key(taskId, slotIndex)
    let entry = this.#entries.get(key)
    if (entry === undefined) {
      entry = {
        url: null,
        // A failed transfer must not stick: null evicts this entry so the
        // next request crosses the wire again instead of caching the
        // outage — but only while it is still the live entry, never a
        // successor that a dispose-and-retry already installed.
        blob: this.#load(taskId, slotIndex)
          .catch((): Blob | null => null)
          .then((blob) => {
            if (blob === null && this.#entries.get(key) === entry) this.#entries.delete(key)
            return blob
          })
      }
      this.#entries.set(key, entry)
    }
    return entry
  }
}
