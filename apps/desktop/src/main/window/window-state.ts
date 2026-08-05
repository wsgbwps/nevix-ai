import { app, screen, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Fallback bounds used when no persisted state exists or it cannot be trusted. */
export const DEFAULT_WINDOW_STATE = { width: 1280, height: 800 } as const
/** The window never shrinks below these bounds, regardless of persisted state. */
export const MIN_WINDOW_WIDTH = 960
export const MIN_WINDOW_HEIGHT = 600

interface WindowState {
  readonly width: number
  readonly height: number
  readonly x?: number
  readonly y?: number
  readonly isMaximized: boolean
}

const WINDOW_STATE_FILE = 'window-state.json'
const SAVE_DEBOUNCE_MS = 300

function stateFilePath(): string {
  return join(app.getPath('userData'), WINDOW_STATE_FILE)
}

function isValidSize(width: number, height: number): boolean {
  return (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width >= MIN_WINDOW_WIDTH &&
    height >= MIN_WINDOW_HEIGHT
  )
}

function isVisibleOnSomeDisplay(bounds: {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}): boolean {
  return screen.getAllDisplays().some(({ workArea }) => {
    return (
      bounds.x < workArea.x + workArea.width &&
      bounds.x + bounds.width > workArea.x &&
      bounds.y < workArea.y + workArea.height &&
      bounds.y + bounds.height > workArea.y
    )
  })
}

/**
 * Reads the persisted window bounds. Corrupt or untrusted state falls back to the
 * default size; a position that is no longer visible on any display is dropped
 * so a removed monitor cannot leave the window off-screen.
 */
export function loadWindowState(): WindowState {
  try {
    const raw = JSON.parse(readFileSync(stateFilePath(), 'utf8')) as {
      width?: number
      height?: number
      x?: number
      y?: number
      isMaximized?: boolean
    }
    const width = Number(raw.width)
    const height = Number(raw.height)
    if (!isValidSize(width, height)) {
      return { ...DEFAULT_WINDOW_STATE, isMaximized: false }
    }
    const { x, y } = raw
    const position =
      typeof x === 'number' &&
      Number.isFinite(x) &&
      typeof y === 'number' &&
      Number.isFinite(y) &&
      isVisibleOnSomeDisplay({ x, y, width, height })
        ? { x, y }
        : {}
    return {
      width,
      height,
      ...position,
      isMaximized: raw.isMaximized === true
    }
  } catch {
    return { ...DEFAULT_WINDOW_STATE, isMaximized: false }
  }
}

/** Persists bounds and maximized state while the window lives, so the next launch restores them. */
export function trackWindowState(window: BrowserWindow): void {
  const persist = (): void => {
    const { x, y, width, height } = window.getBounds()
    try {
      writeFileSync(
        stateFilePath(),
        JSON.stringify({ x, y, width, height, isMaximized: window.isMaximized() }),
        'utf8'
      )
    } catch {
      // Best-effort persistence: a full disk must not break the running window.
    }
  }

  let timer: NodeJS.Timeout | undefined
  const schedulePersist = (): void => {
    clearTimeout(timer)
    timer = setTimeout(persist, SAVE_DEBOUNCE_MS)
  }

  window.on('resize', schedulePersist)
  window.on('move', schedulePersist)
  window.on('close', () => {
    clearTimeout(timer)
    persist()
  })
}
