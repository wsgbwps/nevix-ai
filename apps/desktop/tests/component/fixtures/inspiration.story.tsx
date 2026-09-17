import '../../../src/renderer/src/app/globals.css'
import { useEffect, useMemo } from 'react'
import { I18nextProvider } from 'react-i18next'
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
    capabilities: { canWithdraw: index === 1, canCreateSimilar: true }
  }
}

const publicationItem: InspirationItem = { type: 'publication', publication: publication(1) }
const layoutProbeItems: readonly InspirationItem[] = [
  [100, 200],
  [100, 200],
  [172, 100],
  [100, 200],
  [100, 200],
  [200, 100],
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
    publication: {
      id: 'admin-publication',
      publishedAt: '2026-09-16T10:00:00Z',
      restricted: true
    },
    capabilities: { canDelete: true, canPublish: false, canCreateSimilar: false }
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
      materialId: 'clone-material',
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

interface InspirationControls {
  listCalls(): readonly InspirationPageRequest[]
  similarCalls(): readonly string[]
  recordSimilar(publicationId: string): void
  withdraws(): readonly string[]
  previewCalls(): readonly string[]
}

type InspirationStoryState =
  | 'member'
  | 'admin'
  | 'empty'
  | 'failed'
  | 'dense'
  | 'layout-probe'
  | 'layout-failed'
  | 'preview-refresh'
  | 'preview-refresh-failed'

declare global {
  interface Window {
    __inspirationTest?: InspirationControls
  }
}

function createHarness(state: InspirationStoryState): {
  readonly ports: InspirationPorts
  readonly controls: InspirationControls
} {
  const listCalls: InspirationPageRequest[] = []
  const similarCalls: string[] = []
  const withdraws: string[] = []
  const previewCalls: string[] = []
  const items =
    state === 'dense'
      ? Array.from(
          { length: 24 },
          (_, index): InspirationItem => ({
            type: 'publication',
            publication: publication(index + 1)
          })
        )
      : state === 'layout-probe' || state === 'layout-failed'
        ? layoutProbeItems
        : state === 'admin'
          ? [publicationItem, adminAsset]
          : state === 'empty'
            ? []
            : [publicationItem]
  return {
    ports: {
      listInspiration: async (request) => {
        listCalls.push(request)
        if (state === 'failed') return { outcome: 'network-failure' }
        const filtered = request.search === 'none' ? [] : items
        return { outcome: 'succeeded', value: { items: filtered, nextCursor: null } }
      },
      getInspirationDetail: async (item) =>
        item.type === 'publication'
          ? {
              outcome: 'succeeded',
              value: {
                type: 'publication',
                publication: item.publication,
                specification,
                references: [reference]
              }
            }
          : {
              outcome: 'succeeded',
              value: {
                type: 'asset',
                asset: item.asset,
                specification,
                references: [reference],
                publication: {
                  ...publication(2),
                  id: 'admin-publication',
                  sourceAssetId: item.asset.id,
                  publisher: item.asset.creator,
                  publishedAt: '2026-09-16T10:00:00Z',
                  restricted: true,
                  capabilities: { canWithdraw: true, canCreateSimilar: false }
                }
              }
            },
      loadInspirationContent: async () =>
        state === 'layout-failed'
          ? { outcome: 'network-failure' }
          : { outcome: 'succeeded', value: imageBlob },
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
      createPublicationSimilar: async () => ({ outcome: 'request-rejected', code: 'not_used' })
    },
    controls: {
      listCalls: () => listCalls,
      similarCalls: () => similarCalls,
      recordSimilar: (publicationId) => similarCalls.push(publicationId),
      withdraws: () => withdraws,
      previewCalls: () => previewCalls
    }
  }
}

export function InspirationStory({
  state = 'member'
}: {
  readonly state?: InspirationStoryState
}): React.JSX.Element {
  const harness = useMemo(() => createHarness(state), [state])
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
