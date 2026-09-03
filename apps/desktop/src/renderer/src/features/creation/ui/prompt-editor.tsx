import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import {
  $applyNodeReplacement,
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isLineBreakNode,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COPY_COMMAND,
  CUT_COMMAND,
  CUT_TAG,
  DecoratorNode,
  HISTORY_PUSH_TAG,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  PASTE_COMMAND,
  PASTE_TAG,
  TextNode,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode
} from 'lexical'
import {
  decodePromptDocument,
  expandPromptDocument,
  filterPromptMentionCandidates,
  normalizePromptDocument,
  promptDocumentLength,
  type PromptDocument,
  type PromptMentionCandidate
} from '../model/prompt-document'
import { ReferenceKindIcon } from './reference-kind-icon'

export interface PromptEditorProps {
  readonly document: PromptDocument
  readonly documentKey: string
  readonly candidates: readonly PromptMentionCandidate[]
  readonly thumbnails: Readonly<Record<string, string>>
  readonly maxChars: number
  readonly placeholder: string
  readonly label: string
  readonly emptyLabel: string
  readonly noResultsLabel: string
  readonly onChange: (document: PromptDocument) => void
  readonly onPreview: (materialId: string, focusTarget: HTMLElement) => void
  readonly onMentionHover: (materialId: string | null, anchor: HTMLElement | null) => void
}

interface MentionPresentation {
  readonly candidates: readonly PromptMentionCandidate[]
  readonly thumbnails: Readonly<Record<string, string>>
  readonly onPreview: PromptEditorProps['onPreview']
  readonly onMentionHover: PromptEditorProps['onMentionHover']
}

const MentionPresentationContext = createContext<MentionPresentation | null>(null)
// This editor-only anchor gives Chromium a text caret before a leading chip. It must never
// enter PromptDocument, character counts, or clipboard output.
const MENTION_CARET_SENTINEL = '\u200b'

export function PromptEditor({
  document,
  documentKey,
  candidates,
  thumbnails,
  placeholder,
  label,
  emptyLabel,
  noResultsLabel,
  maxChars,
  onChange,
  onPreview,
  onMentionHover
}: PromptEditorProps): React.JSX.Element {
  const initialDocument = useRef(document)
  const config = useMemo(
    () => ({
      namespace: 'creation-prompt',
      nodes: [ReferenceMentionCaretNode, ReferenceMentionNode],
      editorState: () => replaceEditorDocument(initialDocument.current),
      onError: (error: Error) => {
        throw error
      }
    }),
    []
  )
  const presentation = useMemo(
    () => ({ candidates, thumbnails, onPreview, onMentionHover }),
    [candidates, onMentionHover, onPreview, thumbnails]
  )

  return (
    <MentionPresentationContext.Provider value={presentation}>
      <LexicalComposer initialConfig={config}>
        <div className="relative size-full">
          <PlainTextPlugin
            contentEditable={
              <ContentEditable
                id="composer-prompt"
                data-testid="composer-prompt"
                role="combobox"
                aria-label={label}
                aria-autocomplete="list"
                aria-haspopup="listbox"
                aria-multiline="true"
                className="text-foreground size-full [scrollbar-width:none] overflow-y-auto bg-transparent px-1 py-1 text-xs leading-5 outline-none"
              />
            }
            placeholder={
              <div className="text-muted-foreground/70 pointer-events-none absolute top-1 left-1 text-xs leading-5">
                {placeholder}
              </div>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <DocumentPlugin document={document} documentKey={documentKey} onChange={onChange} />
          <MentionTypeaheadPlugin
            candidates={candidates}
            maxChars={maxChars}
            emptyLabel={emptyLabel}
            noResultsLabel={noResultsLabel}
            menuLabel={label}
          />
          <ClipboardPlugin documentKey={documentKey} candidates={candidates} maxChars={maxChars} />
        </div>
      </LexicalComposer>
    </MentionPresentationContext.Provider>
  )
}

const EXTERNAL_DOCUMENT_TAG = 'prompt-editor-external-document'

function DocumentPlugin({
  document,
  documentKey,
  onChange
}: {
  readonly document: PromptDocument
  readonly documentKey: string
  readonly onChange: (document: PromptDocument) => void
}): null {
  const [editor] = useLexicalComposerContext()
  const lastEmitted = useRef<string | null>(null)
  const previousDocumentKey = useRef(documentKey)
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves, tags }) => {
        if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return
        if (tags.has(EXTERNAL_DOCUMENT_TAG)) return
        editorState.read(() => {
          const nextDocument = readEditorDocument()
          lastEmitted.current = documentSignature(nextDocument)
          onChange(nextDocument)
        })
      }),
    [editor, onChange]
  )

  useEffect(() => {
    const normalized = normalizePromptDocument(document)
    const desiredSignature = documentSignature(normalized)
    const actualSignature = editor
      .getEditorState()
      .read(() => documentSignature(readEditorDocument()))
    const keyChanged = previousDocumentKey.current !== documentKey
    previousDocumentKey.current = documentKey
    if (!keyChanged && desiredSignature === lastEmitted.current) return
    if (!keyChanged && desiredSignature === actualSignature) return
    editor.update(() => replaceEditorDocument(normalized), {
      tag: EXTERNAL_DOCUMENT_TAG,
      onUpdate: () => editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined)
    })
    lastEmitted.current = desiredSignature
  }, [document, documentKey, editor])
  return null
}

interface MentionQuery {
  readonly nodeKey: NodeKey
  readonly startOffset: number
  readonly endOffset: number
  readonly value: string
  readonly rect: DOMRect
}

function MentionTypeaheadPlugin({
  candidates,
  maxChars,
  emptyLabel,
  noResultsLabel,
  menuLabel
}: {
  readonly candidates: readonly PromptMentionCandidate[]
  readonly maxChars: number
  readonly emptyLabel: string
  readonly noResultsLabel: string
  readonly menuLabel: string
}): React.JSX.Element | null {
  const [editor] = useLexicalComposerContext()
  const [query, setQuery] = useState<MentionQuery | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const menuId = useId()
  const previousQueryValue = useRef<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const matches = useMemo(
    () => (query === null ? [] : filterPromptMentionCandidates(query.value, candidates)),
    [candidates, query]
  )
  const selectedIndex = Math.min(activeIndex, Math.max(0, matches.length - 1))

  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        const nextQuery = editorState.read(() => readMentionQuery(editor))
        const nextValue = nextQuery?.value ?? null
        if (nextValue !== previousQueryValue.current) setActiveIndex(0)
        previousQueryValue.current = nextValue
        setQuery(nextQuery)
      }),
    [editor]
  )

  useEffect(() => {
    const selectActive = (): boolean => {
      if (query === null || matches.length === 0 || editor.isComposing()) return false
      if (!insertMention(editor, query, matches[selectedIndex], candidates, maxChars)) {
        return false
      }
      setQuery(null)
      return true
    }
    const move = (delta: number, event: KeyboardEvent): boolean => {
      if (query === null || matches.length === 0 || editor.isComposing()) return false
      event.preventDefault()
      setActiveIndex((current) => (current + delta + matches.length) % matches.length)
      return true
    }
    return mergeUnregister(
      editor.registerCommand(
        KEY_ARROW_DOWN_COMMAND,
        (event) => move(1, event),
        COMMAND_PRIORITY_HIGH
      ),
      editor.registerCommand(
        KEY_ARROW_UP_COMMAND,
        (event) => move(-1, event),
        COMMAND_PRIORITY_HIGH
      ),
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (
            event?.target instanceof Element &&
            event.target.closest('[data-reference-mention-id]') !== null
          ) {
            return false
          }
          if (query === null) {
            const selection = $getSelection()
            if (!$isRangeSelection(selection)) return false
            event?.preventDefault()
            selection.insertRawText('\n')
            return true
          }
          if (!selectActive()) return false
          event?.preventDefault()
          return true
        },
        COMMAND_PRIORITY_HIGH
      ),
      editor.registerCommand(
        KEY_TAB_COMMAND,
        (event) => {
          if (!selectActive()) return false
          event.preventDefault()
          return true
        },
        COMMAND_PRIORITY_HIGH
      ),
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        (event) => {
          if (query === null || editor.isComposing()) return false
          event.preventDefault()
          setQuery(null)
          return true
        },
        COMMAND_PRIORITY_HIGH
      )
    )
  }, [candidates, editor, matches, maxChars, query, selectedIndex])

  useEffect(() => {
    if (query === null) return
    const closeOutside = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (
        editor.getRootElement()?.contains(event.target) ||
        menuRef.current?.contains(event.target)
      ) {
        return
      }
      setQuery(null)
    }
    window.document.addEventListener('pointerdown', closeOutside, true)
    return () => window.document.removeEventListener('pointerdown', closeOutside, true)
  }, [editor, query])

  useEffect(() => {
    const root = editor.getRootElement()
    if (root === null) return
    root.setAttribute('aria-expanded', String(query !== null))
    if (query === null) {
      root.removeAttribute('aria-controls')
      root.removeAttribute('aria-activedescendant')
    } else {
      root.setAttribute('aria-controls', menuId)
      if (matches.length > 0) {
        root.setAttribute('aria-activedescendant', optionId(menuId, selectedIndex))
      } else {
        root.removeAttribute('aria-activedescendant')
      }
    }
    return () => {
      root.setAttribute('aria-expanded', 'false')
      root.removeAttribute('aria-controls')
      root.removeAttribute('aria-activedescendant')
    }
  }, [editor, matches.length, menuId, query, selectedIndex])

  if (query === null) return null
  const position = typeaheadPosition(query.rect, matches.length)
  return createPortal(
    <div
      id={menuId}
      ref={menuRef}
      role="listbox"
      aria-label={menuLabel}
      className="bg-popover text-popover-foreground fixed z-50 max-h-80 overflow-y-auto rounded-lg border p-1 shadow-lg"
      style={{ left: position.left, top: position.top, width: position.width }}
    >
      {candidates.length === 0 ? (
        <p className="text-muted-foreground px-3 py-2 text-xs">{emptyLabel}</p>
      ) : matches.length === 0 ? (
        <p className="text-muted-foreground px-3 py-2 text-xs">{noResultsLabel}</p>
      ) : (
        matches.map((candidate, index) => (
          <button
            key={candidate.materialId}
            id={optionId(menuId, index)}
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            className="aria-selected:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs"
            onPointerDown={(event) => {
              event.preventDefault()
              if (insertMention(editor, query, candidate, candidates, maxChars)) setQuery(null)
            }}
          >
            <ReferenceKindIcon kind={candidate.kind} className="size-4 shrink-0" />
            <span>{candidate.label}</span>
            <span className="text-muted-foreground truncate">{candidate.fileName}</span>
          </button>
        ))
      )}
    </div>,
    window.document.body
  )
}

const PROMPT_CLIPBOARD_MIME = 'application/x-nevix-prompt-fragment'

function ClipboardPlugin({
  documentKey,
  candidates,
  maxChars
}: {
  readonly documentKey: string
  readonly candidates: readonly PromptMentionCandidate[]
  readonly maxChars: number
}): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    const copy = (event: ClipboardEvent | KeyboardEvent | null, cut: boolean): boolean => {
      if (!(event instanceof ClipboardEvent) || event.clipboardData === null) return false
      const fragment = readSelectedDocument()
      if (fragment === null) return false
      event.preventDefault()
      event.clipboardData.setData('text/plain', expandPromptDocument(fragment, candidates))
      event.clipboardData.setData(
        PROMPT_CLIPBOARD_MIME,
        JSON.stringify({ version: 1, documentKey, document: fragment })
      )
      if (cut) {
        editor.update(
          () => {
            const selection = $getSelection()
            if ($isRangeSelection(selection)) selection.removeText()
          },
          { tag: CUT_TAG }
        )
      }
      return true
    }
    return mergeUnregister(
      editor.registerCommand(COPY_COMMAND, (event) => copy(event, false), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(CUT_COMMAND, (event) => copy(event, true), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          if (!(event instanceof ClipboardEvent) || event.clipboardData === null) return false
          const clipboard = event.clipboardData
          const payload = parseClipboardPayload(clipboard.getData(PROMPT_CLIPBOARD_MIME))
          const materialIds = new Set(candidates.map((candidate) => candidate.materialId))
          const preserveMentions =
            payload !== null &&
            payload.documentKey === documentKey &&
            payload.document.nodes.every(
              (node) => node.type === 'text' || materialIds.has(node.materialId)
            )
          const fragment = preserveMentions ? payload.document : null
          const insertedLength =
            fragment === null
              ? [...clipboard.getData('text/plain')].length
              : promptDocumentLength(fragment, candidates)
          const { currentLength, selectedLength } = editor.getEditorState().read(() => {
            const selected = readSelectedDocument()
            return {
              currentLength: promptDocumentLength(readEditorDocument(), candidates),
              selectedLength: selected === null ? 0 : promptDocumentLength(selected, candidates)
            }
          })
          event.preventDefault()
          if (currentLength - selectedLength + insertedLength > maxChars) return true
          editor.update(
            () => {
              const selection = $getSelection()
              if (!$isRangeSelection(selection)) return
              if (fragment === null) {
                selection.insertRawText(clipboard.getData('text/plain'))
              } else {
                selection.insertNodes(createLexicalNodes(fragment))
              }
            },
            { tag: PASTE_TAG }
          )
          return true
        },
        COMMAND_PRIORITY_HIGH
      )
    )
  }, [candidates, documentKey, editor, maxChars])
  return null
}

interface PromptClipboardPayload {
  readonly version: 1
  readonly documentKey: string
  readonly document: PromptDocument
}

function readSelectedDocument(): PromptDocument | null {
  const selection = $getSelection()
  if (!$isRangeSelection(selection) || selection.isCollapsed()) return null
  const domSelection = window.getSelection()
  if (domSelection === null || domSelection.rangeCount === 0 || domSelection.isCollapsed)
    return null
  const range = domSelection.getRangeAt(0)
  const nodes: PromptDocument['nodes'][number][] = []
  appendClipboardNodes(
    range.cloneContents(),
    nodes,
    isInsideMentionCaret(range.commonAncestorContainer)
  )
  return normalizePromptDocument({ version: 1, nodes })
}

function appendClipboardNodes(
  node: Node,
  nodes: PromptDocument['nodes'][number][],
  stripBareCaretText = false
): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = stripBareCaretText
      ? stripMentionCaretSentinel(node.textContent ?? '')
      : (node.textContent ?? '')
    if (text.length > 0) {
      nodes.push({ type: 'text', text })
    }
    return
  }
  if (!(node instanceof Element || node instanceof DocumentFragment)) return
  if (node instanceof Element) {
    if (node.hasAttribute('data-reference-mention-caret')) {
      const text = stripMentionCaretSentinel(node.textContent ?? '')
      if (text.length > 0) nodes.push({ type: 'text', text })
      return
    }
    const materialId = node.getAttribute('data-reference-mention-id')
    if (materialId !== null) {
      nodes.push({ type: 'mention', materialId })
      return
    }
    if (node.tagName === 'BR') {
      nodes.push({ type: 'text', text: '\n' })
      return
    }
  }
  for (const child of node.childNodes) appendClipboardNodes(child, nodes, stripBareCaretText)
}

function isInsideMentionCaret(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement
  return element !== null && element.closest('[data-reference-mention-caret]') !== null
}

function parseClipboardPayload(serialized: string): PromptClipboardPayload | null {
  if (serialized.length === 0) return null
  try {
    const value: unknown = JSON.parse(serialized)
    if (!isRecord(value) || value.version !== 1 || typeof value.documentKey !== 'string')
      return null
    const document = decodePromptDocument(value.document)
    if (document === null) return null
    return {
      version: 1,
      documentKey: value.documentKey,
      document
    }
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readMentionQuery(editor: LexicalEditor): MentionQuery | null {
  if (editor.isComposing()) return null
  const selection = $getSelection()
  if (
    !$isRangeSelection(selection) ||
    !selection.isCollapsed() ||
    selection.anchor.type !== 'text'
  ) {
    return null
  }
  const node = selection.anchor.getNode()
  if (!$isTextNode(node)) return null
  const endOffset = selection.anchor.offset
  const match = node
    .getTextContent()
    .slice(0, endOffset)
    .match(/@([\p{L}\p{N}]*)$/u)
  if (match === null) return null
  const domSelection = window.getSelection()
  if (domSelection === null || domSelection.rangeCount === 0) return null
  return {
    nodeKey: node.getKey(),
    startOffset: endOffset - match[0].length,
    endOffset,
    value: match[1],
    rect: domSelection.getRangeAt(0).getBoundingClientRect()
  }
}

function insertMention(
  editor: LexicalEditor,
  query: MentionQuery,
  candidate: PromptMentionCandidate,
  candidates: readonly PromptMentionCandidate[],
  maxChars: number
): boolean {
  const projectedLength = editor
    .getEditorState()
    .read(
      () =>
        promptDocumentLength(readEditorDocument(), candidates) -
        [...`@${query.value}`].length +
        [...candidate.label].length
    )
  if (projectedLength > maxChars) return false
  editor.update(
    () => {
      const node = $getNodeByKey(query.nodeKey)
      if (!$isTextNode(node)) return
      const selection = $createRangeSelection()
      selection.anchor.set(node.getKey(), query.startOffset, 'text')
      selection.focus.set(node.getKey(), query.endOffset, 'text')
      $setSelection(selection)
      selection.insertNodes([$createReferenceMentionNode(candidate.materialId)])
    },
    { tag: HISTORY_PUSH_TAG }
  )
  editor.focus()
  return true
}

function typeaheadPosition(
  rect: DOMRect,
  optionCount: number
): {
  readonly left: number
  readonly top: number
  readonly width: number
} {
  const gutter = 8
  const width = Math.min(320, window.innerWidth - gutter * 2)
  const estimatedHeight = Math.min(320, Math.max(44, optionCount * 40 + 8))
  const left = Math.min(Math.max(gutter, rect.left), window.innerWidth - width - gutter)
  const fitsAbove = rect.top >= estimatedHeight + gutter
  const top = fitsAbove
    ? rect.top - estimatedHeight - 4
    : Math.min(rect.bottom + 4, window.innerHeight - estimatedHeight - gutter)
  return { left, top: Math.max(gutter, top), width }
}

function optionId(menuId: string, index: number): string {
  return `${menuId}-option-${index}`
}

interface SerializedReferenceMentionNode extends SerializedLexicalNode {
  readonly type: 'reference-mention'
  readonly version: 1
  readonly materialId: string
}

class ReferenceMentionCaretNode extends TextNode {
  $config(): ReturnType<TextNode['$config']> {
    return this.config('reference-mention-caret', { extends: TextNode })
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = super.createDOM(config)
    element.setAttribute('data-reference-mention-caret', '')
    return element
  }

  static transform(): (node: LexicalNode) => void {
    return (node) => {
      if (!$isReferenceMentionCaretNode(node)) return
      const text = stripMentionCaretSentinel(node.getTextContent())
      if (!$isReferenceMentionNode(node.getNextSibling())) {
        if (text.length === 0) node.remove()
        else node.replace($createTextNode(text))
        return
      }
      if (!node.getTextContent().includes(MENTION_CARET_SENTINEL)) {
        node.setTextContent(`${MENTION_CARET_SENTINEL}${text}`)
      }
    }
  }
}

function $createReferenceMentionCaretNode(): ReferenceMentionCaretNode {
  return $applyNodeReplacement(new ReferenceMentionCaretNode(MENTION_CARET_SENTINEL))
}

function $isReferenceMentionCaretNode(
  node: LexicalNode | null | undefined
): node is ReferenceMentionCaretNode {
  return node instanceof ReferenceMentionCaretNode
}

class ReferenceMentionNode extends DecoratorNode<React.JSX.Element> {
  __materialId: string

  static getType(): string {
    return 'reference-mention'
  }

  static clone(node: ReferenceMentionNode): ReferenceMentionNode {
    return new ReferenceMentionNode(node.__materialId, node.__key)
  }

  static importJSON(
    serialized: SerializedLexicalNode & Record<string, unknown>
  ): ReferenceMentionNode {
    return $createReferenceMentionNode(String(serialized.materialId))
  }

  static transform(): (node: LexicalNode) => void {
    return (node) => {
      if (!$isReferenceMentionNode(node)) return
      const previous = node.getPreviousSibling()
      if (previous === null || $isLineBreakNode(previous) || $isReferenceMentionNode(previous)) {
        node.insertBefore($createReferenceMentionCaretNode())
      }
    }
  }

  constructor(materialId: string, key?: NodeKey) {
    super(key)
    this.__materialId = materialId
  }

  createDOM(): HTMLElement {
    const element = window.document.createElement('span')
    element.style.verticalAlign = 'middle'
    // CSS middle uses the font's x-height, so lower the chip to match Chinese glyph centers.
    element.style.position = 'relative'
    element.style.top = '1px'
    return element
  }

  updateDOM(): false {
    return false
  }

  exportJSON(): SerializedReferenceMentionNode {
    return { type: 'reference-mention', version: 1, materialId: this.__materialId }
  }

  getMaterialId(): string {
    return this.getLatest().__materialId
  }

  getTextContent(): string {
    return ''
  }

  isInline(): true {
    return true
  }

  isKeyboardSelectable(): false {
    return false
  }

  decorate(editor: LexicalEditor): React.JSX.Element {
    return <MentionChip materialId={this.__materialId} nodeKey={this.__key} editor={editor} />
  }
}

function $createReferenceMentionNode(materialId: string): ReferenceMentionNode {
  return $applyNodeReplacement(new ReferenceMentionNode(materialId))
}

function $isReferenceMentionNode(
  node: LexicalNode | null | undefined
): node is ReferenceMentionNode {
  return node instanceof ReferenceMentionNode
}

function MentionChip({
  materialId,
  nodeKey,
  editor
}: {
  readonly materialId: string
  readonly nodeKey: NodeKey
  readonly editor: LexicalEditor
}): React.JSX.Element {
  const presentation = useContext(MentionPresentationContext)
  const candidate = presentation?.candidates.find((item) => item.materialId === materialId)
  const label = candidate?.label ?? candidate?.fileName ?? ''
  const thumbnail = presentation?.thumbnails[materialId]
  return (
    <button
      type="button"
      contentEditable={false}
      data-reference-mention-id={materialId}
      aria-label={label}
      className="bg-muted mx-0.5 inline-flex max-w-40 items-center gap-1 rounded-md px-1.5 py-0.5 align-baseline text-xs"
      onClick={(event) => presentation?.onPreview(materialId, event.currentTarget)}
      onPointerEnter={(event) => presentation?.onMentionHover(materialId, event.currentTarget)}
      onPointerLeave={() => presentation?.onMentionHover(null, null)}
      onFocus={(event) => presentation?.onMentionHover(materialId, event.currentTarget)}
      onBlur={() => presentation?.onMentionHover(null, null)}
      onKeyDown={(event) => {
        if (event.key !== 'Backspace' && event.key !== 'Delete') return
        event.preventDefault()
        event.stopPropagation()
        editor.update(() => $getNodeByKey(nodeKey)?.remove(), { tag: HISTORY_PUSH_TAG })
        editor.focus()
      }}
    >
      {thumbnail !== undefined ? (
        <img src={thumbnail} alt="" className="size-4 rounded-sm object-cover" />
      ) : candidate !== undefined ? (
        <ReferenceKindIcon kind={candidate.kind} className="size-3.5" />
      ) : null}
      <span className="truncate">{label}</span>
    </button>
  )
}

function readEditorDocument(): PromptDocument {
  const nodes: PromptDocument['nodes'][number][] = []
  for (const block of $getRoot().getChildren()) {
    for (const child of $isElementNode(block) ? block.getChildren() : [block]) {
      if ($isTextNode(child)) {
        const text = $isReferenceMentionCaretNode(child)
          ? stripMentionCaretSentinel(child.getTextContent())
          : child.getTextContent()
        nodes.push({ type: 'text', text })
      } else if ($isLineBreakNode(child)) nodes.push({ type: 'text', text: '\n' })
      else if ($isReferenceMentionNode(child)) {
        nodes.push({ type: 'mention', materialId: child.getMaterialId() })
      }
    }
  }
  return normalizePromptDocument({ version: 1, nodes })
}

function replaceEditorDocument(document: PromptDocument): void {
  const root = $getRoot()
  root.clear()
  const paragraph = $createParagraphNode()
  paragraph.append(...createLexicalNodes(document))
  root.append(paragraph)
}

function createLexicalNodes(document: PromptDocument): LexicalNode[] {
  const nodes: LexicalNode[] = []
  for (const node of normalizePromptDocument(document).nodes) {
    if (node.type === 'mention') {
      nodes.push($createReferenceMentionNode(node.materialId))
      continue
    }
    const lines = node.text.split('\n')
    lines.forEach((line, index) => {
      if (index > 0) nodes.push($createLineBreakNode())
      if (line.length > 0) nodes.push($createTextNode(line))
    })
  }
  return nodes
}

function stripMentionCaretSentinel(text: string): string {
  return text.replaceAll(MENTION_CARET_SENTINEL, '')
}

function mergeUnregister(...unregister: readonly (() => void)[]): () => void {
  return () => unregister.forEach((dispose) => dispose())
}

function documentSignature(document: PromptDocument): string {
  return JSON.stringify(normalizePromptDocument(document))
}
