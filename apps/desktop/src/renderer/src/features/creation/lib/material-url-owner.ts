/** Owns the object URLs created for Reference Material thumbnails. */
export class MaterialUrlOwner {
  readonly #thumbnails = new Map<string, string>()
  readonly #urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>

  constructor(urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL) {
    this.#urls = urls
  }

  replaceThumbnail(materialId: string, blob: Blob): string {
    const previous = this.#thumbnails.get(materialId)
    if (previous !== undefined) this.#urls.revokeObjectURL(previous)
    const url = this.#urls.createObjectURL(blob)
    this.#thumbnails.set(materialId, url)
    return url
  }

  releaseMaterial(materialId: string): void {
    const thumbnail = this.#thumbnails.get(materialId)
    if (thumbnail !== undefined) {
      this.#urls.revokeObjectURL(thumbnail)
      this.#thumbnails.delete(materialId)
    }
  }

  releaseThumbnails(): void {
    for (const url of this.#thumbnails.values()) this.#urls.revokeObjectURL(url)
    this.#thumbnails.clear()
  }

  dispose(): void {
    this.releaseThumbnails()
  }
}
