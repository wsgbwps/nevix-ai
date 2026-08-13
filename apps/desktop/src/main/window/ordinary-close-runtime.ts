import { app, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  createOrdinaryCloseCoordinator,
  type OrdinaryCloseCoordinator,
  type OrdinaryCloseDecision,
  type OrdinaryCloseRequest
} from './ordinary-close'

let coordinator: OrdinaryCloseCoordinator | undefined

export function initializeOrdinaryCloseRuntime(
  requestDecision: (window: BrowserWindow, request: OrdinaryCloseRequest) => boolean
): void {
  if (coordinator) throw new Error('Ordinary close runtime is already initialized')
  coordinator = createOrdinaryCloseCoordinator({
    createRequestId: randomUUID,
    quitApplication: () => app.quit(),
    requestDecision: (window, request) => requestDecision(window as BrowserWindow, request)
  })
}

function requireCoordinator(): OrdinaryCloseCoordinator {
  if (!coordinator) throw new Error('Ordinary close runtime is not initialized')
  return coordinator
}

export function protectOrdinaryClose(window: BrowserWindow): void {
  requireCoordinator().protect(window)
}

export function requestApplicationQuit(): void {
  requireCoordinator().requestApplicationQuit()
}

export function decideOrdinaryClose(window: BrowserWindow, request: OrdinaryCloseDecision): void {
  requireCoordinator().decide(window, request)
}
