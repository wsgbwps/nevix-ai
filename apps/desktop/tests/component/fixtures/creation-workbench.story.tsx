import i18next from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { createI18nOptions } from '../../../src/shared/i18n/i18next-options'
import {
  creationResources,
  CreationRuntimeContext,
  CreationWorkbenchPage,
  type CreationWorkspacePorts
} from '../../../src/renderer/src/features/creation'
import type {
  CreationApiResult,
  CreationSessionView,
  ReferenceMaterialView
} from '../../../src/renderer/src/features/creation/api/go-creation-http'

/**
 * Black-box composition for the Creation Workbench public surface (issue
 * #156): the exported page mounted with scripted in-memory ports. Tests drive
 * visible UI and observe caller-visible port calls; no internal store or hook
 * is exposed beyond a narrow assertion handle.
 */

const testI18n = i18next.createInstance()
await testI18n.init(
  createI18nOptions({
    language: 'en',
    resources: creationResources,
    defaultNS: 'creation',
    environment: 'test'
  })
)

const sessionA: CreationSessionView = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  name: 'Spring campaign',
  createdAt: '2026-08-20T10:00:00Z',
  updatedAt: '2026-08-21T10:00:00Z'
}
const sessionB: CreationSessionView = {
  id: 'bbbbbbbb-0000-4000-8000-000000000002',
  name: '',
  createdAt: '2026-08-22T10:00:00Z',
  updatedAt: '2026-08-22T10:00:00Z'
}

function material(partial: {
  id: string
  kind: ReferenceMaterialView['kind']
  fileName: string
}): ReferenceMaterialView {
  return {
    id: partial.id,
    kind: partial.kind,
    fileName: partial.fileName,
    mimeType: partial.kind === 'image' ? 'image/png' : 'audio/mpeg',
    byteSize: 1024,
    widthPx: partial.kind === 'image' ? 24 : null,
    heightPx: partial.kind === 'image' ? 16 : null,
    pixelCount: partial.kind === 'image' ? 384 : null,
    durationMs: null,
    checksumSha256: 'aa'.repeat(32),
    claimsVersion: 1,
    createdAt: '2026-08-23T08:00:00Z'
  }
}

const materialOne = material({
  id: 'cccccccc-0000-4000-8000-000000000003',
  kind: 'image',
  fileName: 'poster.png'
})
const materialTwo = material({
  id: 'dddddddd-0000-4000-8000-000000000004',
  kind: 'image',
  fileName: 'banner.png'
})
const materialThree = material({
  id: '77777777-0000-4000-8000-000000000005',
  kind: 'image',
  fileName: 'hero.png'
})

const thumbnailUrl =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="100%" height="100%" fill="#88f"/></svg>'
  )

interface PileTestControls {
  uploadCalls(): ReadonlyArray<{ sessionId: string; name: string }>
  deleteMaterialCalls(): string[]
  thumbRequests(): string[]
  createCalls(): ReadonlyArray<string>
}

declare global {
  interface Window {
    __creationPileTest?: PileTestControls
  }
}

function succeeded<T>(value: T): CreationApiResult<T> {
  return { outcome: 'succeeded', value }
}

// Builds the standard story's ports and installs the assertion handle.
// Window writes live here, in a plain module function outside component
// scope, matching the established fixture pattern.
function installStandardRuntime(): CreationWorkspacePorts {
  const uploadCalls: Array<{ sessionId: string; name: string }> = []
  const deletedIds: string[] = []
  const thumbIds: string[] = []
  const createdNames: string[] = []

  const ports: CreationWorkspacePorts = {
    listSessions: async () => succeeded({ sessions: [sessionA, sessionB], nextCursor: null }),
    createSession: async (name) => {
      createdNames.push(name ?? '')
      return succeeded({ ...sessionB, id: sessionB.id, name: name ?? '' })
    },
    renameSession: async () => succeeded(sessionA),
    deleteSession: async () => succeeded(undefined),
    listMaterials: async () =>
      succeeded({ materials: [materialOne, materialTwo, materialThree], nextCursor: null }),
    uploadMaterial: async (sessionId, file) => {
      uploadCalls.push({ sessionId, name: file.name })
      return succeeded(
        material({ id: 'ffffffff-0000-4000-8000-000000000006', kind: 'image', fileName: file.name })
      )
    },
    deleteMaterial: async (materialId) => {
      deletedIds.push(materialId)
      return succeeded(undefined)
    },
    loadImageBlobUrl: async (materialId) => {
      thumbIds.push(materialId)
      return thumbnailUrl
    }
  }

  window.__creationPileTest = {
    uploadCalls: () => uploadCalls,
    deleteMaterialCalls: () => deletedIds,
    thumbRequests: () => thumbIds,
    createCalls: () => createdNames
  }
  return ports
}

/** The standard story: two sessions, one selected with three image materials. */
export function CreationWorkbenchStory(): React.JSX.Element {
  return (
    <CreationRuntimeContext.Provider value={installStandardRuntime()}>
      <Frame>
        <CreationWorkbenchPage />
      </Frame>
    </CreationRuntimeContext.Provider>
  )
}

/** The connected creator's very first visit: zero sessions. */
export function CreationWorkbenchEmptyStory(): React.JSX.Element {
  const ports: CreationWorkspacePorts = {
    listSessions: async () => succeeded({ sessions: [], nextCursor: null }),
    createSession: async (name) =>
      succeeded({ ...sessionB, id: 'eeeeeeee-0000-4000-8000-000000000007', name: name ?? '' }),
    renameSession: async () => succeeded(sessionB),
    deleteSession: async () => succeeded(undefined),
    listMaterials: async () => succeeded({ materials: [], nextCursor: null }),
    uploadMaterial: async (_sessionId, file) =>
      succeeded(
        material({ id: 'ffffffff-0000-4000-8000-000000000099', kind: 'image', fileName: file.name })
      ),
    deleteMaterial: async () => succeeded(undefined),
    loadImageBlobUrl: async () => null
  }
  return (
    <CreationRuntimeContext.Provider value={ports}>
      <Frame>
        <CreationWorkbenchPage />
      </Frame>
    </CreationRuntimeContext.Provider>
  )
}

function Frame({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <I18nextProvider i18n={testI18n}>
      <div style={{ height: 480 }}>{children}</div>
    </I18nextProvider>
  )
}
