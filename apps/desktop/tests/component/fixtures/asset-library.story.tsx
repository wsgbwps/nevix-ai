import '../../../src/renderer/src/app/globals.css'
import { useEffect, useMemo } from 'react'
import { I18nextProvider } from 'react-i18next'
import { ImagesIcon } from 'lucide-react'
import { testI18n } from './creation-workbench-i18n'
import { AssetLibraryPage } from '../../../src/renderer/src/features/creation'
import { SidebarBrand } from '../../../src/renderer/src/app/shell/sidebar-brand'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider
} from '../../../src/renderer/src/components/ui/sidebar'
import { TooltipProvider } from '../../../src/renderer/src/components/ui/tooltip'
import videoUrl from '../../../../../scripts/dev/fixtures/video-with-audio.mp4?url'
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

/**
 * The display grant's URL, and a URL a real browser can actually load — a
 * signed bucket URL is neither reachable from the test page nor valid. The
 * variant is asserted through `displayCalls`, not through the URL.
 */
const grantedUrl = URL.createObjectURL(imageBlob)
const grantedExpiry = new Date(Date.now() + 10 * 60_000).toISOString()

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
    // Large enough that a size-based wall gate would refuse it: display is
    // authorized by variant, never by the weight of the file.
    byteSize: mediaType === 'video' ? 900 * 1024 * 1024 : imageBlob.size,
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

/** Shared default: a fresh `[]` per render would rebuild the harness every time. */
const NO_IDS: readonly string[] = []

/** The page behind the first cursor, so appending has something distinct to show. */
const nextPage = [
  asset('asset-four', new Date(2026, 8, 14, 9).toISOString()),
  asset('asset-five', new Date(2026, 8, 14, 10).toISOString())
]

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
  setLanguage(language: 'en' | 'zh-CN'): Promise<void>
  listCalls(): readonly AssetPageRequest[]
  reused(): readonly AssetPrivateOrigin[]
  recordReuse(
    origin: AssetPrivateOrigin,
    replaceExisting?: boolean
  ): 'prepared' | 'replacement-required' | 'unavailable'
  replacements(): readonly boolean[]
  detailCalls(): readonly string[]
  /** Every display authorization the page asked for, with its fixed variant. */
  displayCalls(): readonly { readonly id: string; readonly purpose: string }[]
  maxActiveDisplays(): number
  releaseDisplays(): void
  /** Clears the injected failures so a manual retry can succeed. */
  resetDisplayAttempts(): void
  abortedDownloads(): number
  maxActiveDownloads(): number
  releaseDownloads(): void
  releaseNextDownload(): void
  publishKeys(): readonly string[]
  withdraws(): readonly string[]
  deletes(): readonly string[]
}

declare global {
  interface Window {
    __assetLibraryTest?: AssetLibraryTestControls
  }
}

/**
 * How the display authorization answers. `deferred` holds every card at the
 * gate so the wall's concurrency ceiling is observable; `fail-once` spends the
 * card's single automatic re-authorization; `always-fail` reaches the manual
 * retry; `gone` is the generic unavailable state.
 */
type DisplayMode =
  | 'immediate'
  | 'deferred'
  | 'fail-once'
  | 'always-fail'
  | 'gone'
  | 'video-retry-pending'

function createHarness(
  downloadMode: 'immediate' | 'deferred' | 'sequenced' | 'cancelled' | 'failed',
  visibility: 'private' | 'public',
  staleOnReuse: boolean,
  replacementRequired: boolean,
  storageFailure: boolean,
  paginated: boolean,
  append: 'succeed' | 'fail-once' | 'echo',
  displayMode: DisplayMode,
  dense: boolean,
  unpublishableIds: readonly string[]
): {
  readonly ports: AssetLibraryPorts & Pick<InspirationPorts, 'publishAsset' | 'withdrawPublication'>
  readonly controls: AssetLibraryTestControls
} {
  const listCalls: AssetPageRequest[] = []
  let appendAttempts = 0
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
  const displayCalls: { id: string; purpose: string }[] = []
  const displayAttempts = new Map<string, number>()
  let abortedDownloads = 0
  let activeDisplays = 0
  let maxActiveDisplays = 0
  let releaseDisplays = (): void => undefined
  const displayGate = new Promise<void>((resolve) => {
    releaseDisplays = resolve
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
  const deletes: string[] = []
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
        const afterFirst = request.cursor === 'next'
        if (afterFirst) appendAttempts += 1
        if (paginated && afterFirst && append === 'fail-once' && appendAttempts === 1) {
          return { outcome: 'request-rejected' as const, code: 'internal_error' }
        }
        const facets =
          request.mediaType === 'video'
            ? {
                modes: ['text-to-video', 'first-frame', 'first-last-frame', 'omni-reference'],
                ratios: ['16:9', '1:1'],
                resolutions: ['480p', '720p', '1080p']
              }
            : {
                modes: ['text-to-image', 'reference-image'],
                ratios: ['16:9', '1:1'],
                resolutions: ['1K', '2K']
              }
        const listed = afterFirst
          ? nextPage
          : dense
            ? denseAssets
            : displayMode === 'deferred'
              ? Array.from({ length: 8 }, (_, index) =>
                  asset(`preview-${index + 1}`, new Date(2026, 8, 16, 8, index).toISOString())
                )
              : assets
        return {
          outcome: 'succeeded',
          value: {
            // A delete is a real delete: the re-read the page asks for must not
            // hand back the asset it just acted on.
            assets: listed
              .filter((item) => !deletes.includes(item.id))
              .map((item) =>
                unpublishableIds.includes(item.id)
                  ? { ...item, capabilities: { ...item.capabilities, canPublish: false } }
                  : item
              ),
            // Only `paginated` reads past the first page, and only `echo` claims
            // a further one: a terminal cursor everywhere else keeps the
            // auto-loading sentinel quiet for the tests asserting an exact count.
            nextCursor: paginated && (!afterFirst || append === 'echo') ? 'next' : null,
            facets
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
      loadAssetDisplay: async (id, purpose) => {
        displayCalls.push({ id, purpose })
        activeDisplays += 1
        maxActiveDisplays = Math.max(maxActiveDisplays, activeDisplays)
        if (displayMode === 'deferred') await displayGate
        activeDisplays -= 1
        const attempts = (displayAttempts.get(id) ?? 0) + 1
        displayAttempts.set(id, attempts)
        if (displayMode === 'always-fail') return { outcome: 'network-failure' }
        if (displayMode === 'fail-once' && attempts === 1) return { outcome: 'network-failure' }
        if (displayMode === 'gone') return { outcome: 'request-rejected', code: 'not_found' }
        const retryVideoUrl = new URL(videoUrl, window.location.href)
        retryVideoUrl.searchParams.set('retry', '1')
        return {
          outcome: 'succeeded',
          value: {
            url:
              id === 'asset-two'
                ? displayMode === 'video-retry-pending' && attempts > 1
                  ? retryVideoUrl.href
                  : videoUrl
                : grantedUrl,
            expiresAt: grantedExpiry
          }
        }
      },
      downloadAssetContent: async (_id, _checksumSha256, options) => {
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
      deleteAsset: async (assetId) => {
        deletes.push(assetId)
        return { outcome: 'succeeded', value: undefined }
      }
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
      displayCalls: () => displayCalls,
      maxActiveDisplays: () => maxActiveDisplays,
      releaseDisplays: () => releaseDisplays(),
      resetDisplayAttempts: () => displayAttempts.clear(),
      abortedDownloads: () => abortedDownloads,
      maxActiveDownloads: () => maxActiveDownloads,
      releaseDownloads: () => releaseDownloads(),
      releaseNextDownload: () => pendingDownloadReleases.shift()?.(),
      publishKeys: () => publishKeys,
      withdraws: () => withdraws,
      deletes: () => deletes
    }
  }
}

export function AssetLibraryStory({
  downloadMode = 'immediate',
  visibility = 'private',
  staleOnReuse = false,
  replacementRequired = false,
  storageFailure = false,
  paginated = false,
  append = 'succeed',
  displayMode = 'immediate',
  dense = false,
  unpublishableIds = NO_IDS
}: {
  readonly downloadMode?: 'immediate' | 'deferred' | 'sequenced' | 'cancelled' | 'failed'
  readonly visibility?: 'private' | 'public'
  readonly staleOnReuse?: boolean
  readonly replacementRequired?: boolean
  readonly storageFailure?: boolean
  readonly paginated?: boolean
  readonly append?: 'succeed' | 'fail-once' | 'echo'
  readonly displayMode?: DisplayMode
  readonly dense?: boolean
  readonly unpublishableIds?: readonly string[]
}): React.JSX.Element {
  const harness = useMemo(
    () =>
      createHarness(
        downloadMode,
        visibility,
        staleOnReuse,
        replacementRequired,
        storageFailure,
        paginated,
        append,
        displayMode,
        dense,
        unpublishableIds
      ),
    [
      append,
      dense,
      displayMode,
      downloadMode,
      paginated,
      replacementRequired,
      unpublishableIds,
      staleOnReuse,
      storageFailure,
      visibility
    ]
  )
  useEffect(() => {
    // A spec cannot import `testI18n` itself — it awaits at module scope — so the
    // switch has to come through here.
    window.__assetLibraryTest = {
      ...harness.controls,
      setLanguage: async (language) => {
        await testI18n.changeLanguage(language)
      }
    }
    return () => {
      delete window.__assetLibraryTest
    }
  }, [harness])
  return (
    <I18nextProvider i18n={testI18n}>
      {/* The wall's tooltips need the provider the app shell mounts. */}
      <TooltipProvider delayDuration={0}>
        {/* The real App Shell around the page: the header row's box is measured
            against the sidebar, so a story without it measures 256px too wide.
            Same mirror as creation-workbench-real-shell.story.tsx. */}
        <SidebarProvider className="h-svh">
          <Sidebar collapsible="icon">
            <SidebarBrand />
            <SidebarContent className="overflow-hidden">
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton aria-label="Assets" tooltip="Assets">
                        <ImagesIcon />
                        <span className="group-data-[collapsible=icon]:hidden">Assets</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
          <SidebarInset>
            <div className="flex flex-1 flex-col overflow-auto">
              <AssetLibraryPage
                ports={harness.ports}
                onCreateSimilar={harness.controls.recordReuse}
              />
            </div>
          </SidebarInset>
        </SidebarProvider>
      </TooltipProvider>
    </I18nextProvider>
  )
}
