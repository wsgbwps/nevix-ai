import { expect, test } from '@playwright/experimental-ct-react'
import {
  ChineseAlignmentEditorStory,
  MentionOnlyEditorStory,
  ReferenceMentionEditorStory,
  TightLimitEditorStory
} from './fixtures/reference-mention-editor.story'

test('the prompt remains a multiline combobox and emits a canonical text document', async ({
  mount,
  page
}) => {
  await mount(<ReferenceMentionEditorStory />)

  const editor = page.getByRole('combobox', { name: 'Prompt' })
  await editor.fill('first line\nsecond line')

  await expect(editor).toHaveText('first line\nsecond line')
  await expect
    .poll(() => page.evaluate(() => window.__referenceMentionEditorTest?.document()))
    .toEqual({ version: 1, nodes: [{ type: 'text', text: 'first line\nsecond line' }] })
  await expect(editor).toHaveAttribute('aria-multiline', 'true')
  await expect(editor).toHaveAttribute('aria-expanded', 'false')
})

test('an at sign anywhere opens a filtered menu and selecting replaces the query with a mention', async ({
  mount,
  page
}) => {
  await mount(<ReferenceMentionEditorStory />)
  const editor = page.getByRole('combobox', { name: 'Prompt' })

  await editor.fill('look@sho')
  const menu = page.getByRole('listbox', { name: 'Prompt' })
  const option = menu.getByRole('option', { name: /Image 1.*shoe\.png/ })
  await expect(option).toBeVisible()
  await expect(menu.getByRole('option', { name: /Video 1/ })).toHaveCount(0)
  await expect(editor).toHaveAttribute('aria-expanded', 'true')
  await expect(editor).toHaveAttribute('aria-controls', await menu.getAttribute('id'))
  await expect(editor).toHaveAttribute('aria-activedescendant', await option.getAttribute('id'))
  await page.keyboard.press('Enter')

  await expect(page.getByRole('button', { name: 'Image 1' })).toBeVisible()
  await expect(editor).toHaveAttribute('aria-expanded', 'false')
  await expect(editor).not.toHaveAttribute('aria-controls', /.+/)
  await expect
    .poll(() => page.evaluate(() => window.__referenceMentionEditorTest?.document()))
    .toEqual({
      version: 1,
      nodes: [
        { type: 'text', text: 'look' },
        { type: 'mention', materialId: 'image-a' }
      ]
    })
})

test('deleting preceding text restores the caret boundary before a leading mention', async ({
  mount,
  page
}) => {
  await mount(<ReferenceMentionEditorStory />)
  const editor = page.getByRole('combobox', { name: 'Prompt' })

  await editor.fill('head@')
  await page.keyboard.press('Enter')
  await editor.evaluate((root) => {
    const text = [...root.querySelectorAll('span')]
      .map((element) => element.firstChild)
      .find((node): node is Text => node instanceof Text && node.textContent === 'head')
    if (text === undefined) throw new Error('Expected the leading text node')
    window.getSelection()?.setBaseAndExtent(text, 0, text, text.length)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await page.keyboard.press('Backspace')

  await expect
    .poll(() => page.evaluate(() => window.__referenceMentionEditorTest?.document()))
    .toEqual({ version: 1, nodes: [{ type: 'mention', materialId: 'image-a' }] })
  await expect(editor.locator('[data-reference-mention-caret]')).toHaveCount(1)
})

test('a mention deletes atomically and undo restores it', async ({ mount, page }) => {
  await mount(<ReferenceMentionEditorStory />)
  const editor = page.getByRole('combobox', { name: 'Prompt' })

  await editor.fill('look@sho')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Image 1' })).toBeVisible()

  await page.keyboard.press('Backspace')
  await expect(page.getByRole('button', { name: 'Image 1' })).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => window.__referenceMentionEditorTest?.document()))
    .toEqual({ version: 1, nodes: [{ type: 'text', text: 'look' }] })

  await page.keyboard.press('Meta+z')
  await expect(page.getByRole('button', { name: 'Image 1' })).toBeVisible()
})

test('a mention-only document renders and an over-limit mention insertion is rejected', async ({
  mount,
  page
}) => {
  const component = await mount(<MentionOnlyEditorStory />)
  await expect(page.getByRole('button', { name: 'Image 1' })).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.__referenceMentionEditorTest?.document()))
    .toEqual({ version: 1, nodes: [{ type: 'mention', materialId: 'image-a' }] })

  await component.update(<TightLimitEditorStory />)
  const editor = page.getByRole('combobox', { name: 'Prompt' })
  await editor.fill('1234@sho')
  await page.keyboard.press('Enter')

  await expect(page.getByRole('button', { name: 'Image 1' })).toHaveCount(0)
  await expect(editor).toHaveText('1234@sho')

  await editor.fill('1234567')
  await page.keyboard.press('Meta+a')
  await editor.evaluate((element) => {
    const clipboard = new DataTransfer()
    clipboard.setData('text/plain', 'ok')
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard })
    )
  })
  await expect(editor).toHaveText('ok')
})

test('keyboard navigation can place text before a leading mention', async ({ mount, page }) => {
  await mount(<ReferenceMentionEditorStory />)
  const editor = page.getByRole('combobox', { name: 'Prompt' })

  await editor.fill('@')
  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.type('head')

  await expect
    .poll(() => page.evaluate(() => window.__referenceMentionEditorTest?.document()))
    .toEqual({
      version: 1,
      nodes: [
        { type: 'text', text: 'head' },
        { type: 'mention', materialId: 'image-a' }
      ]
    })

  const copied = await editor.evaluate((element) => {
    const caretText = element.querySelector('[data-reference-mention-caret]')?.firstChild
    if (!(caretText instanceof Text)) throw new Error('Expected the mention caret text node')
    window.getSelection()?.setBaseAndExtent(caretText, 0, caretText, caretText.length)
    document.dispatchEvent(new Event('selectionchange'))
    const clipboard = new DataTransfer()
    element.dispatchEvent(
      new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: clipboard })
    )
    return {
      custom: clipboard.getData('application/x-nevix-prompt-fragment'),
      plain: clipboard.getData('text/plain')
    }
  })
  expect(copied.plain).toBe('head')
  expect(JSON.parse(copied.custom)).toEqual({
    version: 1,
    documentKey: 'draft-a',
    document: { version: 1, nodes: [{ type: 'text', text: 'head' }] }
  })
})

test('cutting the leading mention caret restores its text anchor', async ({ mount, page }) => {
  await mount(<ReferenceMentionEditorStory />)
  const editor = page.getByRole('combobox', { name: 'Prompt' })

  await editor.fill('@')
  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.type('head')
  await editor.evaluate((element) => {
    const caretText = element.querySelector('[data-reference-mention-caret]')?.firstChild
    if (!(caretText instanceof Text)) throw new Error('Expected the mention caret text node')
    const sentinelOffset = caretText.textContent?.indexOf('\u200b') ?? -1
    if (sentinelOffset < 0) throw new Error('Expected the caret sentinel')
    window
      .getSelection()
      ?.setBaseAndExtent(caretText, sentinelOffset, caretText, sentinelOffset + 1)
    document.dispatchEvent(new Event('selectionchange'))
    element.dispatchEvent(
      new ClipboardEvent('cut', {
        bubbles: true,
        cancelable: true,
        clipboardData: new DataTransfer()
      })
    )
  })

  await expect
    .poll(() =>
      editor
        .locator('[data-reference-mention-caret]')
        .evaluateAll((elements) => elements.map((element) => element.textContent))
    )
    .toEqual(['\u200bhead'])
  await expect
    .poll(() => page.evaluate(() => window.__referenceMentionEditorTest?.document()))
    .toEqual({
      version: 1,
      nodes: [
        { type: 'text', text: 'head' },
        { type: 'mention', materialId: 'image-a' }
      ]
    })
})

test('deleting a mention turns its populated caret anchor into plain text', async ({
  mount,
  page
}) => {
  await mount(<ReferenceMentionEditorStory />)
  const editor = page.getByRole('combobox', { name: 'Prompt' })

  await editor.fill('@')
  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.type('head')
  const chip = page.getByRole('button', { name: 'Image 1' })
  await chip.focus()
  await page.keyboard.press('Backspace')

  await expect(chip).toHaveCount(0)
  await expect(editor.locator('[data-reference-mention-caret]')).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => window.__referenceMentionEditorTest?.document()))
    .toEqual({ version: 1, nodes: [{ type: 'text', text: 'head' }] })
})

test('a mention chip is vertically centered with neighboring text', async ({ mount, page }) => {
  await mount(<ChineseAlignmentEditorStory />)
  const editor = page.getByRole('combobox', { name: 'Prompt' })

  await editor.fill('@')
  await page.keyboard.press('Enter')
  await page.keyboard.type('对齐')

  const centerDeltas = await editor.evaluate((root) => {
    const chip = root.querySelector<HTMLElement>('[data-reference-mention-id]')
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let text: Text | null = null
    while (walker.nextNode()) {
      if (walker.currentNode.textContent?.includes('对齐')) {
        text = walker.currentNode as Text
        break
      }
    }
    const label = chip?.querySelector('span')?.firstChild
    if (chip === null || text === null || label === null) {
      return { chip: Number.POSITIVE_INFINITY, label: Number.POSITIVE_INFINITY }
    }
    const textRange = document.createRange()
    textRange.selectNodeContents(text)
    const labelRange = document.createRange()
    labelRange.selectNodeContents(label)
    const chipRect = chip.getBoundingClientRect()
    const textRect = textRange.getBoundingClientRect()
    const labelRect = labelRange.getBoundingClientRect()
    return {
      chip: Math.abs(chipRect.top + chipRect.height / 2 - (textRect.top + textRect.height / 2)),
      label: Math.abs(labelRect.top + labelRect.height / 2 - (textRect.top + textRect.height / 2))
    }
  })
  expect(centerDeltas.chip).toBeLessThanOrEqual(0.5)
  expect(centerDeltas.label).toBeLessThanOrEqual(0.5)
})

test('the caret before a mention matches a caret inside neighboring text', async ({
  mount,
  page
}) => {
  await mount(<ReferenceMentionEditorStory />)
  const editor = page.getByRole('combobox', { name: 'Prompt' })

  await editor.fill('@')
  await page.keyboard.press('Enter')
  await page.keyboard.type('after')
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowLeft')

  const metrics = await editor.evaluate((root) => {
    const selection = window.getSelection()
    const beforeRect = selection?.rangeCount
      ? selection.getRangeAt(0).getBoundingClientRect()
      : new DOMRect()
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let text: Text | null = null
    while (walker.nextNode()) {
      if (walker.currentNode.textContent?.includes('after')) {
        text = walker.currentNode as Text
        break
      }
    }
    if (text === null) {
      return { beforeIsText: false, beforeHeight: 0, textHeight: Number.POSITIVE_INFINITY }
    }
    const textCaret = document.createRange()
    textCaret.setStart(text, 1)
    textCaret.collapse(true)
    return {
      beforeIsText: selection?.anchorNode?.nodeType === Node.TEXT_NODE,
      beforeHeight: beforeRect.height,
      textHeight: textCaret.getBoundingClientRect().height
    }
  })
  expect(metrics.beforeIsText).toBe(true)
  expect(metrics.beforeHeight).toBeCloseTo(metrics.textHeight, 0)
})

test('typeahead keyboard controls respect composition and manual mention text', async ({
  mount,
  page
}) => {
  await mount(<ReferenceMentionEditorStory />)
  const editor = page.getByRole('combobox', { name: 'Prompt' })

  await editor.fill('@sho')
  await editor.dispatchEvent('compositionstart', { data: 's' })
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Image 1' })).toHaveCount(0)
  await editor.dispatchEvent('compositionend', { data: 's' })
  await page.evaluate(() =>
    window.__referenceMentionEditorTest?.setExternalDocument({ version: 1, nodes: [] }, 'draft-b')
  )
  await expect(editor).toHaveText('')

  await editor.fill('@shoe.')
  await expect(page.getByRole('listbox', { name: 'Prompt' })).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Image 1' })).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => window.__referenceMentionEditorTest?.document()))
    .toEqual({ version: 1, nodes: [{ type: 'text', text: '@shoe.\n' }] })

  await editor.fill('@')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Video 1' })).toBeVisible()
})

test('dismissing a typeahead keeps the unchanged query as plain text', async ({ mount, page }) => {
  await mount(<ReferenceMentionEditorStory />)
  const editor = page.getByRole('combobox', { name: 'Prompt' })

  await editor.fill('@sho')
  await expect(page.getByRole('listbox', { name: 'Prompt' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox', { name: 'Prompt' })).toHaveCount(0)
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('listbox', { name: 'Prompt' })).toHaveCount(0)
  await page.keyboard.press('ArrowRight')

  await page.mouse.click(700, 500)
  await editor.click()
  await expect(page.getByRole('listbox', { name: 'Prompt' })).toHaveCount(0)
  await page.keyboard.type('e')
  await expect(page.getByRole('listbox', { name: 'Prompt' })).toBeVisible()
  await expect(editor).toHaveText('@shoe')
})

test('typeahead uses localized empty states', async ({ mount, page }) => {
  await mount(<ReferenceMentionEditorStory />)
  const editor = page.getByRole('combobox', { name: 'Prompt' })

  await editor.fill('@missing')
  await expect(page.getByText('No matching reference material')).toBeVisible()
  await page.mouse.click(700, 500)
  await expect(page.getByRole('listbox', { name: 'Prompt' })).toHaveCount(0)

  await page.evaluate(() => window.__referenceMentionEditorTest?.setCandidates([]))
  await editor.fill('')
  await editor.fill('@')
  await expect(page.getByText('Add reference material first')).toBeVisible()
})

test('mention focus and pointer hover expose the same preview anchor', async ({ mount, page }) => {
  await mount(<MentionOnlyEditorStory />)
  const chip = page.getByRole('button', { name: 'Image 1' })

  await chip.focus()
  await expect
    .poll(() => page.evaluate(() => window.__referenceMentionEditorTest?.hoverCalls()))
    .toEqual(['image-a'])

  await chip.hover()
  await expect
    .poll(() => page.evaluate(() => window.__referenceMentionEditorTest?.hoverCalls()))
    .toEqual(['image-a', 'image-a'])
  await chip.click()
  await chip.focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Space')
  await expect
    .poll(() => page.evaluate(() => window.__referenceMentionEditorTest?.previewCalls()))
    .toEqual(['image-a', 'image-a', 'image-a'])

  await chip.focus()
  await page.keyboard.press('Backspace')
  await expect(chip).toHaveCount(0)
  await expect(page.locator('[data-reference-mention-caret]')).toHaveCount(0)
  await expect(page.getByText('Describe an idea')).toBeVisible()
})

test('external prune and document-key replacement reset editor history', async ({
  mount,
  page
}) => {
  await mount(<MentionOnlyEditorStory />)
  const chip = page.getByRole('button', { name: 'Image 1' })
  await expect(chip).toBeVisible()

  await page.evaluate(() =>
    window.__referenceMentionEditorTest?.setExternalDocument(
      { version: 1, nodes: [{ type: 'text', text: 'replacement' }] },
      'draft-b'
    )
  )
  const editor = page.getByRole('combobox', { name: 'Prompt' })
  await expect(editor).toHaveText('replacement')
  await page.keyboard.press('Meta+z')
  await expect(editor).toHaveText('replacement')
  await expect(chip).toHaveCount(0)
})

test('clipboard preserves a user-authored zero-width space', async ({ mount, page }) => {
  await mount(<ReferenceMentionEditorStory />)
  const editor = page.getByRole('combobox', { name: 'Prompt' })
  await editor.fill('a\u200bb')
  await page.keyboard.press('Meta+a')

  const copied = await editor.evaluate((element) => {
    const clipboard = new DataTransfer()
    element.dispatchEvent(
      new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: clipboard })
    )
    return {
      custom: clipboard.getData('application/x-nevix-prompt-fragment'),
      plain: clipboard.getData('text/plain')
    }
  })
  expect(copied.plain).toBe('a\u200bb')
  expect(JSON.parse(copied.custom)).toEqual({
    version: 1,
    documentKey: 'draft-a',
    document: { version: 1, nodes: [{ type: 'text', text: 'a\u200bb' }] }
  })
})

test('clipboard preserves valid same-draft mentions and degrades cross-draft data to labels', async ({
  mount,
  page
}) => {
  await mount(<ReferenceMentionEditorStory />)
  const editor = page.getByRole('combobox', { name: 'Prompt' })
  await editor.fill('@sho')
  await page.keyboard.press('Enter')
  await page.keyboard.type('B')
  await page.keyboard.press('Meta+a')

  const copied = await editor.evaluate((element) => {
    const clipboard = new DataTransfer()
    element.dispatchEvent(
      new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: clipboard })
    )
    return {
      custom: clipboard.getData('application/x-nevix-prompt-fragment'),
      plain: clipboard.getData('text/plain')
    }
  })
  expect(copied.plain).toBe('Image 1B')
  expect(copied.custom).not.toBe('')

  await editor.fill('')
  await editor.evaluate((element, data) => {
    const clipboard = new DataTransfer()
    clipboard.setData('application/x-nevix-prompt-fragment', data.custom)
    clipboard.setData('text/plain', data.plain)
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard })
    )
  }, copied)
  await expect(page.getByRole('button', { name: 'Image 1' })).toBeVisible()

  await page.evaluate(() =>
    window.__referenceMentionEditorTest?.setExternalDocument({ version: 1, nodes: [] }, 'draft-b')
  )
  await expect(editor).toHaveText('')
  await editor.evaluate((element, data) => {
    const clipboard = new DataTransfer()
    clipboard.setData('application/x-nevix-prompt-fragment', data.custom)
    clipboard.setData('text/plain', data.plain)
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard })
    )
  }, copied)
  await expect(page.getByRole('button', { name: 'Image 1' })).toHaveCount(0)
  await expect(editor).toHaveText('Image 1B')

  await page.evaluate(() => {
    window.__referenceMentionEditorTest?.setCandidates([])
    window.__referenceMentionEditorTest?.setExternalDocument({ version: 1, nodes: [] }, 'draft-a')
  })
  await expect(editor).toHaveText('')
  await editor.evaluate((element, data) => {
    const clipboard = new DataTransfer()
    clipboard.setData('application/x-nevix-prompt-fragment', data.custom)
    clipboard.setData('text/plain', data.plain)
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard })
    )
  }, copied)
  await expect(page.getByRole('button', { name: 'Image 1' })).toHaveCount(0)
  await expect(editor).toHaveText('Image 1B')
})
