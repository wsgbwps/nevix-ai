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

interface PendingInstallation {
  readonly window: OrdinaryCloseWindow
  readonly requestId: string
  readonly deadline: number
  readonly validate: (signal: AbortSignal) => Promise<void>
  readonly controller: AbortController
  readonly install: () => void
  readonly resolve: (installed: boolean) => void
  readonly timeout: ReturnType<typeof setTimeout>
  deciding: boolean
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
  readonly requestUpdateInstallation: (
    window: OrdinaryCloseWindow,
    validate: (signal: AbortSignal) => Promise<void>,
    install: () => void
  ) => Promise<boolean>
  readonly cancelUpdateInstallation: () => void
}

export function createOrdinaryCloseCoordinator({
  createRequestId,
  quitApplication,
  requestDecision
}: OrdinaryCloseDependencies): OrdinaryCloseCoordinator {
  const protectedWindows = new Map<OrdinaryCloseWindow, ProtectedWindowState>()
  let applicationQuitRequested = false
  let installation: PendingInstallation | undefined

  function cancelUpdateInstallation(): void {
    if (!installation) return
    clearTimeout(installation.timeout)
    installation.controller.abort()
    installation.resolve(false)
    installation = undefined
  }

  function requestUpdateInstallation(
    window: OrdinaryCloseWindow,
    validate: (signal: AbortSignal) => Promise<void>,
    install: () => void
  ): Promise<boolean> {
    cancelUpdateInstallation()
    const state = protectedWindows.get(window)
    if (!state || state.pending || window.isDestroyed() || protectedWindows.size !== 1)
      return Promise.resolve(false)
    const requestId = createRequestId()
    return new Promise((resolve) => {
      const timeout = setTimeout(cancelUpdateInstallation, 60000)
      installation = {
        window,
        requestId,
        validate,
        controller: new AbortController(),
        install,
        resolve,
        timeout,
        deadline: Date.now() + 60000,
        deciding: false
      }
      if (!requestDecision(window, { requestId })) cancelUpdateInstallation()
    })
  }

  function protect(window: OrdinaryCloseWindow): void {
    if (protectedWindows.has(window)) return

    const state: ProtectedWindowState = { bypassNextClose: false }
    protectedWindows.set(window, state)

    window.on('close', (event) => {
      if (state.bypassNextClose) {
        state.bypassNextClose = false
        return
      }
      cancelUpdateInstallation()
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
      if (installation?.window === window) cancelUpdateInstallation()
      protectedWindows.delete(window)
    })
  }

  function requestApplicationQuit(): void {
    cancelUpdateInstallation()
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
    if (installation?.window === window) cancelUpdateInstallation()
    const state = protectedWindows.get(window)
    if (!state?.pending) return

    const { resume } = state.pending
    state.pending = undefined
    resumeClose(window, state, resume)
  }

  function decide(window: OrdinaryCloseWindow, request: OrdinaryCloseDecision): void {
    const { requestId, decision } = request
    if (installation) {
      const pending = installation
      if (
        pending.window !== window ||
        pending.requestId !== requestId ||
        pending.deciding ||
        window.isDestroyed() ||
        Date.now() >= pending.deadline
      ) {
        cancelUpdateInstallation()
        throw new Error('Update decision does not match a live pending request')
      }
      if (decision !== 'allow') {
        cancelUpdateInstallation()
        return
      }
      pending.deciding = true
      void pending.validate(pending.controller.signal).then(
        () => {
          if (installation !== pending) return
          if (
            window.isDestroyed() ||
            Date.now() >= pending.deadline ||
            protectedWindows.size !== 1
          ) {
            cancelUpdateInstallation()
            return
          }
          const state = protectedWindows.get(window)!
          clearTimeout(pending.timeout)
          installation = undefined
          state.bypassNextClose = true
          try {
            pending.install()
            pending.resolve(true)
          } catch {
            state.bypassNextClose = false
            pending.resolve(false)
          }
        },
        () => {
          if (installation === pending) cancelUpdateInstallation()
        }
      )
      return
    }
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

  return {
    protect,
    requestApplicationQuit,
    decide,
    rendererUnavailable,
    requestUpdateInstallation,
    cancelUpdateInstallation
  }
}
