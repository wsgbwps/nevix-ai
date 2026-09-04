import { useEffect, useRef, useState } from 'react'
import '../../../src/renderer/src/app/globals.css'
import { PromptEditor } from '../../../src/renderer/src/features/creation/ui/prompt-editor'
import {
  textPromptDocument,
  type PromptDocument,
  type PromptMentionCandidate
} from '../../../src/renderer/src/features/creation/model/prompt-document'

const candidates: readonly PromptMentionCandidate[] = [
  { materialId: 'image-a', kind: 'image', ordinal: 1, label: 'Image 1', fileName: 'shoe.png' },
  { materialId: 'video-a', kind: 'video', ordinal: 1, label: 'Video 1', fileName: 'spin.mp4' }
]

const chineseCandidates: readonly PromptMentionCandidate[] = [
  { materialId: 'image-a', kind: 'image', ordinal: 1, label: '图片 1', fileName: 'shoe.png' }
]

const imageThumbnail = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='

declare global {
  interface Window {
    __referenceMentionEditorTest?: {
      document(): PromptDocument
      setExternalDocument(document: PromptDocument, documentKey?: string): void
      setCandidates(candidates: readonly PromptMentionCandidate[]): void
      previewCalls(): readonly string[]
      hoverCalls(): readonly (string | null)[]
    }
  }
}

export function ReferenceMentionEditorStory(): React.JSX.Element {
  return <EditorStory initialDocument={textPromptDocument('')} maxChars={2000} />
}

export function ChineseAlignmentEditorStory(): React.JSX.Element {
  return (
    <EditorStory
      initialDocument={textPromptDocument('')}
      initialCandidates={chineseCandidates}
      maxChars={2000}
    />
  )
}

export function MentionOnlyEditorStory(): React.JSX.Element {
  return (
    <EditorStory
      initialDocument={{ version: 1, nodes: [{ type: 'mention', materialId: 'image-a' }] }}
      maxChars={2000}
    />
  )
}

export function TightLimitEditorStory(): React.JSX.Element {
  return <EditorStory initialDocument={textPromptDocument('1234')} maxChars={7} />
}

function EditorStory({
  initialDocument,
  initialCandidates = candidates,
  maxChars
}: {
  readonly initialDocument: PromptDocument
  readonly initialCandidates?: readonly PromptMentionCandidate[]
  readonly maxChars: number
}): React.JSX.Element {
  const [document, setDocument] = useState<PromptDocument>(initialDocument)
  const [documentKey, setDocumentKey] = useState('draft-a')
  const [currentCandidates, setCandidates] = useState(initialCandidates)
  const previewCalls = useRef<string[]>([])
  const hoverCalls = useRef<(string | null)[]>([])
  useEffect(() => {
    window.__referenceMentionEditorTest = {
      document: () => document,
      setExternalDocument: (nextDocument, nextDocumentKey = documentKey) => {
        setDocument(nextDocument)
        setDocumentKey(nextDocumentKey)
      },
      setCandidates,
      previewCalls: () => previewCalls.current,
      hoverCalls: () => hoverCalls.current
    }
    return () => {
      delete window.__referenceMentionEditorTest
    }
  }, [document, documentKey])

  return (
    <div style={{ width: 560, padding: 24 }}>
      <PromptEditor
        document={document}
        documentKey={documentKey}
        candidates={currentCandidates}
        thumbnails={{ 'image-a': imageThumbnail }}
        maxChars={maxChars}
        placeholder="Describe an idea"
        label="Prompt"
        emptyLabel="Add reference material first"
        noResultsLabel="No matching reference material"
        onChange={setDocument}
        onPreview={(materialId) => previewCalls.current.push(materialId)}
        onMentionHover={(materialId) => hoverCalls.current.push(materialId)}
      />
    </div>
  )
}
