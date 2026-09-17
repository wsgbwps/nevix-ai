import '../../../src/renderer/src/app/globals.css'
import { useEffect, useMemo } from 'react'
import { I18nextProvider } from 'react-i18next'
import { testI18n } from './creation-workbench-i18n'
import { AssetLibraryPage } from '../../../src/renderer/src/features/creation'
import { prepareAssetSimilarDraft } from '../../../src/renderer/src/features/creation/model/asset-similar-draft'
import type {
  AssetDetailView,
  AssetLibraryPorts,
  AssetPageRequest,
  AssetPrivateOrigin,
  MediaAssetView
} from '../../../src/renderer/src/features/creation/api/asset-library-http'
import type { InspirationPorts } from '../../../src/renderer/src/features/creation/api/inspiration-http'

const imageBlob = new Blob(
  [
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#66a"/></svg>'
  ],
  { type: 'image/svg+xml' }
)

function asset(
  id: string,
  createdAt: string,
  mediaType: 'image' | 'video' = 'image'
): MediaAssetView {
  return {
    id,
    creator: { id: 'user-one', displayName: 'Aster' },
    mediaType,
    mimeType: mediaType === 'image' ? 'image/svg+xml' : 'video/mp4',
    byteSize: imageBlob.size,
    checksumSha256: 'aa'.repeat(32),
    widthPx: 120,
    heightPx: 80,
    durationMs: mediaType === 'video' ? 3000 : null,
    createdAt,
    restricted: false,
    restrictionState: null,
    publication: null,
    capabilities: {
      canDelete: true,
      canCreateSimilar: true,
      canPublish: true,
      canRestrict: false,
      canRelease: false
    }
  }
}

const assets = [
  asset('asset-one', new Date(2026, 8, 16, 0, 30).toISOString()),
  asset('asset-two', new Date(2026, 8, 16, 23, 30).toISOString(), 'video'),
  asset('asset-three', new Date(2026, 8, 15, 8).toISOString())
]

const denseAssets = Array.from({ length: 24 }, (_, index) =>
  asset(`dense-${index + 1}`, new Date(2026, 8, 16, 12, index).toISOString())
)

const detail: AssetDetailView = {
  asset: assets[0],
  siblings: assets.slice(0, 2),
  privateOrigin: {
    sessionId: 'session-one',
    sessionName: 'Launch',
    taskId: 'task-one',
    slotIndex: 0,
    specification: {
      schemaVersion: 1,
      mediaType: 'image',
      prompt: 'A quiet launch scene',
      model: 'seedream',
      mode: 'text-to-image',
      manifestVersion: 4,
      ratio: '3:2',
      resolution: '2K',
      quantity: 1,
      durationSeconds: null,
      references: [
        { materialId: 'material-one', role: 'reference', kind: 'image', claimsVersion: 1 }
      ]
    },
    references: [
      {
        id: 'material-one',
        role: 'reference',
        kind: 'image',
        fileName: 'reference.png',
        mimeType: 'image/png',
        byteSize: 120,
        widthPx: 120,
        heightPx: 80,
        durationMs: null,
        claimsVersion: 1
      }
    ]
  }
}

interface AssetLibraryTestControls {
  listCalls(): readonly AssetPageRequest[]
  reused(): readonly AssetPrivateOrigin[]
  recordReuse(
    origin: AssetPrivateOrigin,
    replaceExisting?: boolean
  ): 'prepared' | 'replacement-required' | 'unavailable'
  replacements(): readonly boolean[]
  detailCalls(): readonly string[]
  previewCalls(): readonly string[]
  maxActivePreviews(): number
  releasePreviews(): void
  abortedDownloads(): number
  maxActiveDownloads(): number
  releaseDownloads(): void
  releaseNextDownload(): void
  publishKeys(): readonly string[]
  withdraws(): readonly string[]
}

declare global {
  interface Window {
    __assetLibraryTest?: AssetLibraryTestControls
  }
}

function createHarness(
  downloadMode: 'immediate' | 'deferred' | 'sequenced' | 'cancelled' | 'failed',
  visibility: 'private' | 'public',
  staleOnReuse: boolean,
  replacementRequired: boolean,
  storageFailure: boolean,
  emptyNextPage: boolean,
  deferredPreviews: boolean,
  dense: boolean
): {
  readonly ports: AssetLibraryPorts & Pick<InspirationPorts, 'publishAsset' | 'withdrawPublication'>
  readonly controls: AssetLibraryTestControls
} {
  const listCalls: AssetPageRequest[] = []
  const reused: AssetPrivateOrigin[] = []
  const replacements: boolean[] = []
  const local = {
    length: 0,
    clear: () => undefined,
    getItem: () => null,
    key: () => null,
    removeItem: () => undefined,
    setItem: () => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    }
  } satisfies Storage
  const detailCalls: string[] = []
  const previewCalls: string[] = []
  let abortedDownloads = 0
  let activePreviews = 0
  let maxActivePreviews = 0
  let releasePreviews = (): void => undefined
  const previewGate = new Promise<void>((resolve) => {
    releasePreviews = resolve
  })
  let activeDownloads = 0
  let maxActiveDownloads = 0
  let releaseDownloads = (): void => undefined
  const gate = new Promise<void>((resolve) => {
    releaseDownloads = resolve
  })
  const pendingDownloadReleases: Array<() => void> = []
  const publishKeys: string[] = []
  const withdraws: string[] = []
  let activePublication: {
    readonly id: string
    readonly publishedAt: string
    readonly restricted: boolean
    readonly restrictionState: null
  } | null = null
  return {
    ports: {
      listAssets: async (request) => {
        listCalls.push(request)
        if (emptyNextPage && request.cursor === 'next') {
          return { outcome: 'succeeded', value: { assets: [], nextCursor: null } }
        }
        return {
          outcome: 'succeeded',
          value: {
            assets: dense
              ? denseAssets
              : deferredPreviews
                ? Array.from({ length: 8 }, (_, index) =>
                    asset(`preview-${index + 1}`, new Date(2026, 8, 16, 8, index).toISOString())
                  )
                : assets,
            nextCursor: 'next'
          }
        }
      },
      getAsset: async (id) => {
        detailCalls.push(id)
        if (staleOnReuse && detailCalls.length > 1) {
          return { outcome: 'request-rejected' as const, code: 'asset_not_found' }
        }
        const selected = {
          ...(id === 'asset-two' ? assets[1] : assets[0]),
          publication: activePublication,
          capabilities: {
            ...(id === 'asset-two' ? assets[1] : assets[0]).capabilities,
            canPublish: activePublication === null
          }
        }
        return {
          outcome: 'succeeded',
          value:
            visibility === 'public'
              ? {
                  ...detail,
                  asset: {
                    ...selected,
                    capabilities: {
                      canDelete: false,
                      canCreateSimilar: false,
                      canPublish: false,
                      canRestrict: false,
                      canRelease: false
                    }
                  },
                  privateOrigin: null
                }
              : id === 'asset-two'
                ? {
                    ...detail,
                    asset: selected,
                    privateOrigin: detail.privateOrigin
                      ? {
                          ...detail.privateOrigin,
                          specification: {
                            ...detail.privateOrigin.specification,
                            mediaType: 'video',
                            quantity: 2,
                            durationSeconds: 5
                          }
                        }
                      : null
                  }
                : { ...detail, asset: selected }
        }
      },
      loadAssetContent: async (id, _checksumSha256, options) => {
        if (options?.purpose !== 'download') {
          previewCalls.push(id)
          activePreviews += 1
          maxActivePreviews = Math.max(maxActivePreviews, activePreviews)
          if (deferredPreviews) await previewGate
          activePreviews -= 1
          return { outcome: 'succeeded', value: imageBlob }
        }
        activeDownloads += 1
        maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads)
        if (downloadMode === 'deferred') await gate
        if (downloadMode === 'sequenced') {
          await new Promise<void>((resolve) => pendingDownloadReleases.push(resolve))
        }
        if (downloadMode === 'cancelled') {
          await new Promise<void>((resolve) =>
            options.signal?.addEventListener(
              'abort',
              () => {
                abortedDownloads += 1
                resolve()
              },
              { once: true }
            )
          )
          activeDownloads -= 1
          return { outcome: 'request-rejected', code: 'download_cancelled' }
        }
        if (downloadMode === 'failed') {
          activeDownloads -= 1
          return { outcome: 'request-rejected', code: 'checksum_mismatch' }
        }
        activeDownloads -= 1
        return { outcome: 'succeeded', value: imageBlob }
      },
      publishAsset: async (_assetId, idempotencyKey) => {
        publishKeys.push(idempotencyKey)
        activePublication = {
          id: 'publication-one',
          publishedAt: '2026-09-17T08:00:00Z',
          restricted: false,
          restrictionState: null
        }
        return {
          outcome: 'succeeded',
          value: {
            id: 'publication-one',
            sourceAssetId: 'asset-one',
            publisher: { id: 'user-one', displayName: 'Aster' },
            mediaType: 'image',
            mimeType: 'image/svg+xml',
            byteSize: imageBlob.size,
            checksumSha256: 'aa'.repeat(32),
            widthPx: 120,
            heightPx: 80,
            durationMs: null,
            publishedAt: '2026-09-17T08:00:00Z',
            restricted: false,
            restrictionState: null,
            capabilities: {
              canWithdraw: true,
              canCreateSimilar: true,
              canRestrict: false,
              canRelease: false
            }
          }
        }
      },
      withdrawPublication: async (publicationId) => {
        withdraws.push(publicationId)
        activePublication = null
        return { outcome: 'succeeded', value: undefined }
      },
      deleteAsset: async () => ({ outcome: 'succeeded', value: undefined })
    },
    controls: {
      listCalls: () => listCalls,
      reused: () => reused,
      recordReuse: (origin, replaceExisting = false) => {
        replacements.push(replaceExisting)
        if (storageFailure) {
          return prepareAssetSimilarDraft(local, 'user-one', origin, replaceExisting)
        }
        if (replacementRequired && !replaceExisting) return 'replacement-required'
        reused.push(origin)
        return 'prepared'
      },
      replacements: () => replacements,
      detailCalls: () => detailCalls,
      previewCalls: () => previewCalls,
      maxActivePreviews: () => maxActivePreviews,
      releasePreviews: () => releasePreviews(),
      abortedDownloads: () => abortedDownloads,
      maxActiveDownloads: () => maxActiveDownloads,
      releaseDownloads: () => releaseDownloads(),
      releaseNextDownload: () => pendingDownloadReleases.shift()?.(),
      publishKeys: () => publishKeys,
      withdraws: () => withdraws
    }
  }
}

export function AssetLibraryStory({
  downloadMode = 'immediate',
  visibility = 'private',
  staleOnReuse = false,
  replacementRequired = false,
  storageFailure = false,
  emptyNextPage = false,
  deferredPreviews = false,
  dense = false
}: {
  readonly downloadMode?: 'immediate' | 'deferred' | 'sequenced' | 'cancelled' | 'failed'
  readonly visibility?: 'private' | 'public'
  readonly staleOnReuse?: boolean
  readonly replacementRequired?: boolean
  readonly storageFailure?: boolean
  readonly emptyNextPage?: boolean
  readonly deferredPreviews?: boolean
  readonly dense?: boolean
}): React.JSX.Element {
  const harness = useMemo(
    () =>
      createHarness(
        downloadMode,
        visibility,
        staleOnReuse,
        replacementRequired,
        storageFailure,
        emptyNextPage,
        deferredPreviews,
        dense
      ),
    [
      dense,
      deferredPreviews,
      downloadMode,
      emptyNextPage,
      replacementRequired,
      staleOnReuse,
      storageFailure,
      visibility
    ]
  )
  useEffect(() => {
    window.__assetLibraryTest = harness.controls
    return () => {
      delete window.__assetLibraryTest
    }
  }, [harness])
  return (
    <I18nextProvider i18n={testI18n}>
      <div className="bg-background text-foreground flex h-screen min-h-0">
        <AssetLibraryPage ports={harness.ports} onCreateSimilar={harness.controls.recordReuse} />
      </div>
    </I18nextProvider>
  )
}
