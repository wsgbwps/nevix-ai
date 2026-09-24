import '../../../src/renderer/src/app/globals.css'
import { useEffect, useMemo } from 'react'
import { I18nextProvider } from 'react-i18next'
import videoUrl from '../../../../../scripts/dev/fixtures/video-with-audio.mp4?url'
import { InspirationPage } from '../../../src/renderer/src/features/creation'
import type {
  InspirationItem,
  InspirationPageRequest,
  InspirationPorts,
  PublicationView
} from '../../../src/renderer/src/features/creation/api/inspiration-http'
import { testI18n } from './creation-workbench-i18n'

const imageBlob = new Blob(
  [
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320"><rect width="240" height="320" fill="#5665d8"/></svg>'
  ],
  { type: 'image/svg+xml' }
)
const videoBlob = new Blob([await (await fetch(videoUrl)).arrayBuffer()], { type: 'video/mp4' })

/**
 * The display grant's URL: a URL a real browser can load, since a signed bucket
 * URL is neither reachable from the test page nor valid. Which variant was
 * asked for is asserted through `displayCalls`, never through the URL.
 */
const grantedUrl = URL.createObjectURL(imageBlob)
const grantedExpiry = new Date(Date.now() + 10 * 60_000).toISOString()

function publication(index: number): PublicationView {
  return {
    id: `publication-${index}`,
    sourceAssetId: `source-${index}`,
    publisher: { id: 'publisher-one', displayName: 'Aster' },
    mediaType: index % 5 === 0 ? 'video' : 'image',
    mimeType: index % 5 === 0 ? 'video/mp4' : 'image/svg+xml',
    byteSize: imageBlob.size,
    checksumSha256: 'aa'.repeat(32),
    widthPx: index % 3 === 0 ? 320 : 240,
    heightPx: index % 3 === 0 ? 180 : 320,
    durationMs: index % 5 === 0 ? 4000 : null,
    publishedAt: `2026-09-${String(10 + (index % 7)).padStart(2, '0')}T08:00:00Z`,
    restricted: false,
    restrictionState: null,
    capabilities: {
      canWithdraw: index === 1,
      canCreateSimilar: true,
      canRestrict: false,
      canRelease: false
    }
  }
}

const publicationItem: InspirationItem = { type: 'publication', publication: publication(1) }
/* Probe for the tie rule: cards 3 and 6 differ by less than
   columnHeightTolerance but not by zero, both clear of the 112px floor that
   would freeze the shorter one, with the gap scaling off the column width. */
const layoutProbeItems: readonly InspirationItem[] = [
  [100, 200],
  [100, 200],
  [120, 100],
  [100, 200],
  [100, 200],
  [125, 100],
  [100, 100],
  [100, 100]
].map(([widthPx, heightPx], index) => ({
  type: 'publication',
  publication: { ...publication(index + 1), widthPx, heightPx }
}))
const adminAsset: InspirationItem = {
  type: 'asset',
  asset: {
    id: 'admin-asset',
    creator: { id: 'creator-two', displayName: 'Beryl' },
    mediaType: 'image',
    mimeType: 'image/svg+xml',
    byteSize: imageBlob.size,
    checksumSha256: 'bb'.repeat(32),
    widthPx: 300,
    heightPx: 200,
    durationMs: null,
    createdAt: '2026-09-16T09:00:00Z',
    restricted: true,
    restrictionState: 'active',
    publication: {
      id: 'admin-publication',
      publishedAt: '2026-09-16T10:00:00Z',
      restricted: true,
      restrictionState: 'active'
    },
    capabilities: {
      canDelete: true,
      canPublish: false,
      canCreateSimilar: false,
      canRestrict: false,
      canRelease: true
    }
  }
}

const specification = {
  schemaVersion: 1,
  mediaType: 'image' as const,
  prompt: 'A precise editorial launch scene',
  model: 'archived-model',
  mode: 'reference-image',
  manifestVersion: 2,
  ratio: '3:4',
  resolution: '2K',
  quantity: 1,
  durationSeconds: null,
  references: [
    {
      materialId: 'reference-one',
      role: 'reference' as const,
      kind: 'image' as const,
      claimsVersion: 1
    }
  ]
}

const reference = {
  id: 'reference-one',
  role: 'reference' as const,
  kind: 'image' as const,
  fileName: 'product-reference.png',
  mimeType: 'image/png',
  byteSize: 1024,
  widthPx: 400,
  heightPx: 400,
  durationMs: null,
  claimsVersion: 1
}

/** How the display grant answers: the wall's own failure modes, as in the Asset Library. */
type DisplayMode = 'immediate' | 'deferred' | 'always-fail' | 'fail-once' | 'gone'

interface InspirationControls {
  setLanguage(language: 'en' | 'zh-CN'): Promise<void>
  listCalls(): readonly InspirationPageRequest[]
  displayCalls(): readonly { readonly id: string; readonly purpose: string }[]
  contentCalls(): readonly string[]
  maxActiveDisplays(): number
  releaseDisplays(): void
  resetDisplayAttempts(): void
  similarCalls(): readonly string[]
  recordSimilar(publicationId: string): void
  withdraws(): readonly string[]
  previewCalls(): readonly string[]
  safetyCalls(): readonly string[]
  releaseSafety(): void
}

type InspirationStoryState =
  | 'member'
  | 'admin'
  | 'admin-partial'
  | 'admin-no-references'
  | 'empty'
  | 'failed'
  | 'dense'
  | 'layout-probe'
  | 'preview-refresh'
  | 'preview-refresh-failed'
  | 'admin-deleted-publication'
  | 'admin-safety-delayed'
  | 'admin-safety-failed'

function isVideo(item: InspirationItem): boolean {
  return (item.type === 'publication' ? item.publication : item.asset).mediaType === 'video'
}

declare global {
  interface Window {
    __inspirationTest?: InspirationControls
  }
}

function createHarness(
  state: InspirationStoryState,
  displayMode: DisplayMode
): {
  readonly ports: InspirationPorts
  readonly controls: InspirationControls
} {
  const listCalls: InspirationPageRequest[] = []
  const similarCalls: string[] = []
  const withdraws: string[] = []
  const previewCalls: string[] = []
  const safetyCalls: string[] = []
  const displayCalls: { id: string; purpose: string }[] = []
  const contentCalls: string[] = []
  const displayAttempts = new Map<string, number>()
  let activeDisplays = 0
  let maxActiveDisplays = 0
  let releaseDisplays = (): void => undefined
  const displayGate = new Promise<void>((resolve) => {
    releaseDisplays = resolve
  })
  let releaseSafety: (() => void) | null = null
  let assetReleased = false
  let publicationReleased = false
  const items =
    state === 'dense'
      ? Array.from(
          { length: 24 },
          (_, index): InspirationItem => ({
            type: 'publication',
            publication: publication(index + 1)
          })
        )
      : state === 'layout-probe'
        ? layoutProbeItems
        : state === 'admin-deleted-publication'
          ? [
              {
                type: 'publication' as const,
                publication: {
                  ...publication(1),
                  id: 'deleted-publication',
                  restricted: true,
                  restrictionState: 'active' as const,
                  capabilities: {
                    canWithdraw: true,
                    canCreateSimilar: false,
                    canRestrict: false,
                    canRelease: true
                  }
                }
              }
            ]
          : state === 'admin' ||
              state === 'admin-partial' ||
              state === 'admin-no-references' ||
              state === 'admin-safety-delayed' ||
              state === 'admin-safety-failed'
            ? [publicationItem, adminAsset]
            : state === 'empty'
              ? []
              : [publicationItem]
  return {
    ports: {
      listInspiration: async (request) => {
        listCalls.push(request)
        if (state === 'failed') return { outcome: 'network-failure' }
        const filtered =
          request.search === 'none' ||
          (state === 'admin-deleted-publication' && publicationReleased)
            ? []
            : items
        return { outcome: 'succeeded', value: { items: filtered, nextCursor: null } }
      },
      getInspirationDetail: async (item) =>
        item.type === 'publication'
          ? {
              outcome: 'succeeded',
              value: {
                type: 'publication',
                publication:
                  state === 'admin-deleted-publication'
                    ? {
                        ...item.publication,
                        restricted: !publicationReleased,
                        restrictionState: publicationReleased ? 'released' : 'active',
                        capabilities: {
                          ...item.publication.capabilities,
                          canRestrict: publicationReleased,
                          canRelease: !publicationReleased
                        }
                      }
                    : item.publication,
                specification,
                references: [reference]
              }
            }
          : {
              outcome: 'succeeded',
              value: {
                type: 'asset',
                asset: {
                  ...item.asset,
                  restricted: !assetReleased,
                  restrictionState: assetReleased ? 'released' : 'active',
                  capabilities: {
                    ...item.asset.capabilities,
                    canRestrict: assetReleased,
                    canRelease: !assetReleased
                  }
                },
                specification:
                  state === 'admin-no-references'
                    ? { ...specification, references: [] }
                    : state === 'admin-partial'
                      ? {
                          ...specification,
                          references: [
                            specification.references[0],
                            {
                              materialId: 'missing-reference',
                              role: 'first_frame',
                              kind: 'video',
                              claimsVersion: 2
                            },
                            {
                              materialId: 'reference-three',
                              role: 'last_frame',
                              kind: 'image',
                              claimsVersion: 1
                            },
                            specification.references[0]
                          ]
                        }
                      : specification,
                references:
                  state === 'admin-no-references'
                    ? []
                    : state === 'admin-partial'
                      ? [
                          reference,
                          {
                            ...reference,
                            id: 'reference-three',
                            fileName: 'third-reference.png',
                            role: 'last_frame' as const
                          },
                          reference
                        ]
                      : [reference],
                publication: {
                  ...publication(2),
                  id: 'admin-publication',
                  sourceAssetId: item.asset.id,
                  publisher: item.asset.creator,
                  publishedAt: '2026-09-16T10:00:00Z',
                  restricted: !publicationReleased,
                  restrictionState: publicationReleased ? 'released' : 'active',
                  capabilities: {
                    canWithdraw: true,
                    canCreateSimilar: false,
                    canRestrict: publicationReleased,
                    canRelease: !publicationReleased
                  }
                }
              }
            },
      loadInspirationDisplay: async (item, purpose) => {
        const id = item.type === 'publication' ? item.publication.id : item.asset.id
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
        return {
          outcome: 'succeeded',
          value: { url: isVideo(item) ? videoUrl : grantedUrl, expiresAt: grantedExpiry }
        }
      },
      loadInspirationContent: async (item) => {
        contentCalls.push(item.type === 'publication' ? item.publication.id : item.asset.id)
        return { outcome: 'succeeded', value: isVideo(item) ? videoBlob : imageBlob }
      },
      loadInspirationReferencePreview: async (_item, referenceId) => {
        previewCalls.push(referenceId)
        if (state === 'preview-refresh-failed' && previewCalls.length === 2) {
          return { outcome: 'network-failure' }
        }
        return {
          outcome: 'succeeded',
          value: {
            url:
              (state === 'preview-refresh' || state === 'preview-refresh-failed') &&
              previewCalls.length === 1
                ? 'data:image/png;base64,invalid'
                : 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
            expiresAt: '2026-09-17T09:00:00Z'
          }
        }
      },
      publishAsset: async () => ({ outcome: 'request-rejected', code: 'not_used' }),
      withdrawPublication: async (publicationId) => {
        withdraws.push(publicationId)
        return { outcome: 'succeeded', value: undefined }
      },
      createPublicationSimilar: async () => ({ outcome: 'request-rejected', code: 'not_used' }),
      restrictAsset: async (assetId) => {
        safetyCalls.push(`restrict:asset:${assetId}`)
        assetReleased = false
        return state === 'admin-safety-failed'
          ? { outcome: 'network-failure' }
          : {
              outcome: 'succeeded',
              value: {
                ...adminAsset.asset,
                restricted: true,
                restrictionState: 'active',
                capabilities: {
                  ...adminAsset.asset.capabilities,
                  canRestrict: false,
                  canRelease: true
                }
              }
            }
      },
      releaseAsset: async (assetId) => {
        safetyCalls.push(`release:asset:${assetId}`)
        if (state === 'admin-safety-delayed') {
          await new Promise<void>((resolve) => {
            releaseSafety = resolve
          })
        }
        assetReleased = true
        return state === 'admin-safety-failed'
          ? { outcome: 'network-failure' }
          : {
              outcome: 'succeeded',
              value: {
                ...adminAsset.asset,
                restricted: false,
                restrictionState: 'released',
                capabilities: {
                  ...adminAsset.asset.capabilities,
                  canRestrict: true,
                  canRelease: false
                }
              }
            }
      },
      restrictPublication: async (publicationId) => {
        safetyCalls.push(`restrict:publication:${publicationId}`)
        publicationReleased = false
        const current = publication(1)
        return state === 'admin-deleted-publication'
          ? {
              outcome: 'succeeded',
              value: {
                ...current,
                id: publicationId,
                restricted: true,
                restrictionState: 'active',
                capabilities: {
                  ...current.capabilities,
                  canWithdraw: true,
                  canCreateSimilar: false,
                  canRestrict: false,
                  canRelease: true
                }
              }
            }
          : { outcome: 'request-rejected', code: 'not_used' }
      },
      releasePublication: async (publicationId) => {
        safetyCalls.push(`release:publication:${publicationId}`)
        publicationReleased = true
        const current = publication(2)
        return state === 'admin-safety-failed'
          ? { outcome: 'network-failure' }
          : {
              outcome: 'succeeded',
              value: {
                ...current,
                id: publicationId,
                sourceAssetId: adminAsset.asset.id,
                publisher: adminAsset.asset.creator,
                publishedAt: '2026-09-16T10:00:00Z',
                restricted: false,
                restrictionState: 'released',
                capabilities: {
                  ...current.capabilities,
                  canWithdraw: false,
                  canCreateSimilar: false,
                  canRestrict: true,
                  canRelease: false
                }
              }
            }
      }
    },
    controls: {
      listCalls: () => listCalls,
      displayCalls: () => displayCalls,
      contentCalls: () => contentCalls,
      maxActiveDisplays: () => maxActiveDisplays,
      releaseDisplays: () => releaseDisplays(),
      resetDisplayAttempts: () => displayAttempts.clear(),
      similarCalls: () => similarCalls,
      recordSimilar: (publicationId) => similarCalls.push(publicationId),
      setLanguage: (language) => testI18n.changeLanguage(language),
      withdraws: () => withdraws,
      previewCalls: () => previewCalls,
      safetyCalls: () => safetyCalls,
      releaseSafety: () => releaseSafety?.()
    }
  }
}

export function InspirationStory({
  state = 'member',
  displayMode = 'immediate'
}: {
  readonly state?: InspirationStoryState
  readonly displayMode?: DisplayMode
}): React.JSX.Element {
  const harness = useMemo(() => createHarness(state, displayMode), [state, displayMode])
  useEffect(() => {
    window.__inspirationTest = harness.controls
    return () => {
      delete window.__inspirationTest
    }
  }, [harness])
  return (
    <I18nextProvider i18n={testI18n}>
      <div className="bg-background text-foreground flex h-screen min-h-0">
        <InspirationPage
          ports={harness.ports}
          onCreateSimilar={async (publicationId) => {
            harness.controls.recordSimilar(publicationId)
            return 'prepared'
          }}
        />
      </div>
    </I18nextProvider>
  )
}
