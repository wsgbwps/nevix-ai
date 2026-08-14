interface PreventableCloseEvent {
  preventDefault(): void
}

export interface OrdinaryCloseWindow {
  isDestroyed(): boolean
  close(): void
  on(event: 'close', listener: (event: PreventableCloseEvent) => void): unknown
  on(event: 'closed', listener: () => void): unknown
}

export interface OrdinaryCloseRequest {
  readonly requestId: string
}

export interface OrdinaryCloseDecision {
  readonly requestId: string
  readonly decision: 'allow' | 'cancel'
}

interface PendingClose {
  readonly requestId: string
  resume: 'window-close' | 'application-quit'
}

interface ProtectedWindowState {
  bypassNextClose: boolean
  pending?: PendingClose
}

interface OrdinaryCloseDependencies {
  readonly createRequestId: () => string
  readonly quitApplication: () => void
  readonly requestDecision: (window: OrdinaryCloseWindow, request: OrdinaryCloseRequest) => boolean
}

export interface OrdinaryCloseCoordinator {
  readonly protect: (window: OrdinaryCloseWindow) => void
  readonly requestApplicationQuit: () => void
  readonly decide: (window: OrdinaryCloseWindow, request: OrdinaryCloseDecision) => void
  readonly rendererUnavailable: (window: OrdinaryCloseWindow) => void
}

export function createOrdinaryCloseCoordinator({
  createRequestId,
  quitApplication,
  requestDecision
}: OrdinaryCloseDependencies): OrdinaryCloseCoordinator {
  const protectedWindows = new Map<OrdinaryCloseWindow, ProtectedWindowState>()
  let applicationQuitRequested = false

  function protect(window: OrdinaryCloseWindow): void {
    if (protectedWindows.has(window)) return

    const state: ProtectedWindowState = { bypassNextClose: false }
    protectedWindows.set(window, state)

    window.on('close', (event) => {
      if (state.bypassNextClose) {
        state.bypassNextClose = false
        return
      }
      if (window.isDestroyed()) return

      if (state.pending) {
        event.preventDefault()
        if (applicationQuitRequested) state.pending.resume = 'application-quit'
        return
      }

      const requestId = createRequestId()
      state.pending = {
        requestId,
        resume: applicationQuitRequested ? 'application-quit' : 'window-close'
      }
      if (!requestDecision(window, { requestId })) {
        state.pending = undefined
        return
      }
      event.preventDefault()
    })

    window.on('closed', () => {
      protectedWindows.delete(window)
    })
  }

  function requestApplicationQuit(): void {
    applicationQuitRequested = true
    for (const state of protectedWindows.values()) {
      if (state.pending) state.pending.resume = 'application-quit'
    }
  }

  function resumeClose(
    window: OrdinaryCloseWindow,
    state: ProtectedWindowState,
    resume: PendingClose['resume']
  ): void {
    state.bypassNextClose = true
    if (resume === 'application-quit') quitApplication()
    else window.close()
  }

  function rendererUnavailable(window: OrdinaryCloseWindow): void {
    const state = protectedWindows.get(window)
    if (!state?.pending) return

    const { resume } = state.pending
    state.pending = undefined
    resumeClose(window, state, resume)
  }

  function decide(window: OrdinaryCloseWindow, request: OrdinaryCloseDecision): void {
    const { requestId, decision } = request
    if (window.isDestroyed()) {
      throw new Error('Ordinary close decision requires a live owning window')
    }

    const state = protectedWindows.get(window)
    if (!state?.pending || state.pending.requestId !== requestId) {
      throw new Error('Ordinary close decision does not match a pending request')
    }

    const { resume } = state.pending
    state.pending = undefined
    if (decision === 'cancel') {
      if (resume === 'application-quit') applicationQuitRequested = false
      return
    }

    resumeClose(window, state, resume)
  }

  return { protect, requestApplicationQuit, decide, rendererUnavailable }
}
