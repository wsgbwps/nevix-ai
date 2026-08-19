import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import {
  allowOrdinaryClose,
  cancelOrdinaryClose,
  useOrdinaryCloseHandler
} from '../ordinary-close-handler'
import { installSettingsBackInterception } from './settings-back-navigation'
import {
  createSettingsOrganizationPickerState,
  replaceSettingsOrganizationPickerPhase,
  replaceSettingsSection,
  restoreSettingsEntryAfterOrganizationPicker,
  returnToSettingsSource,
  type SettingsEntry,
  type SettingsSection,
  type SettingsSourceDescriptor
} from './settings-navigation'
import {
  resolveDeferredSettingsClose,
  settingsCloseDecision,
  settingsLeaveIntent,
  settingsNavigationBlockDecision,
  type PendingSettingsDiscardPrompt,
  type SettingsLeaveSemantics
} from './settings-leave-semantics'

export type SettingsContribution = SettingsLeaveSemantics

/**
 * Only the Home surface (`/`) is a re-enterable business source: every other
 * path either belongs to a flow that owns its own lifecycle or no longer
 * exists, so returning there would strand the user mid-flow.
 */
function canEnterBusinessSource(source: SettingsSourceDescriptor): boolean {
  return source.pathname === '/'
}

interface SettingsCoordinatorOptions {
  readonly entry: SettingsEntry
  readonly contribution: SettingsContribution
  readonly organizationId: string | undefined
  readonly openOrganizationPicker: (origin: 'settings') => void
}

interface SettingsCoordinator {
  readonly section: SettingsSection
  readonly navigationDisabled: boolean
  readonly discardPromptOpen: boolean
  readonly switchSection: (section: SettingsSection) => void
  readonly forceSwitchSection: (section: SettingsSection) => void
  readonly returnToSource: () => void
  readonly openOrganizationPicker: () => void
  readonly openOrganizationCreation: () => void
  readonly finishOrganizationPicker: () => void
  readonly continueEditing: () => void
  readonly discardChanges: () => void
}

export function useSettingsCoordinator({
  entry,
  contribution,
  organizationId,
  openOrganizationPicker
}: SettingsCoordinatorOptions): SettingsCoordinator {
  const router = useRouter()
  const [discardPrompt, setDiscardPrompt] = useState<PendingSettingsDiscardPrompt>()
  const discardPromptRef = useRef<PendingSettingsDiscardPrompt | undefined>(undefined)
  const queuedCloseRequestRef = useRef<string | undefined>(undefined)
  const savingCloseRequestRef = useRef<string | undefined>(undefined)
  const outstandingCloseRequestsRef = useRef(new Set<string>())

  const answerClose = useCallback((requestId: string, decision: 'allow' | 'cancel'): void => {
    outstandingCloseRequestsRef.current.delete(requestId)
    if (decision === 'allow') void allowOrdinaryClose(requestId)
    else void cancelOrdinaryClose(requestId)
  }, [])

  const openDiscardPrompt = useCallback((prompt: PendingSettingsDiscardPrompt): boolean => {
    if (discardPromptRef.current) return false
    discardPromptRef.current = prompt
    setDiscardPrompt(prompt)
    return true
  }, [])

  const clearDiscardPrompt = useCallback((): PendingSettingsDiscardPrompt | undefined => {
    const prompt = discardPromptRef.current
    discardPromptRef.current = undefined
    setDiscardPrompt(undefined)
    return prompt
  }, [])

  const runLeaveIntent = useCallback(
    (navigate: () => void): void => {
      settingsLeaveIntent(contribution, navigate, openDiscardPrompt)
    },
    [contribution, openDiscardPrompt]
  )

  useEffect(
    () =>
      router.history.block({
        enableBeforeUnload: false,
        blockerFn: async ({ currentLocation, nextLocation }) => {
          const decision = settingsNavigationBlockDecision(
            currentLocation.pathname,
            nextLocation.pathname,
            contribution
          )
          if (decision === 'pass') return false
          if (decision === 'block') return true

          return await new Promise<boolean>((resolve) => {
            const didOpen = openDiscardPrompt({
              continueEditing: () => resolve(true),
              discardChanges: () => {
                contribution.discard?.()
                resolve(false)
              }
            })
            if (!didOpen) resolve(true)
          })
        }
      }),
    [contribution, openDiscardPrompt, router.history]
  )

  const handleOrdinaryClose = useCallback(
    ({ requestId }: { readonly requestId: string }): void => {
      outstandingCloseRequestsRef.current.add(requestId)
      switch (settingsCloseDecision(contribution, discardPromptRef.current !== undefined)) {
        case 'allow':
          answerClose(requestId, 'allow')
          break
        case 'defer':
          savingCloseRequestRef.current = requestId
          break
        case 'cancel':
          answerClose(requestId, 'cancel')
          break
        case 'queue':
          queuedCloseRequestRef.current = requestId
          break
        case 'prompt':
          openDiscardPrompt({
            continueEditing: () => answerClose(requestId, 'cancel'),
            discardChanges: () => {
              contribution.discard?.()
              answerClose(requestId, 'allow')
            }
          })
          break
      }
    },
    [answerClose, contribution, openDiscardPrompt]
  )
  useOrdinaryCloseHandler(handleOrdinaryClose)

  useEffect(() => {
    const requestId = savingCloseRequestRef.current
    if (!requestId || contribution.close === 'defer') return

    savingCloseRequestRef.current = undefined
    answerClose(requestId, resolveDeferredSettingsClose(contribution))
  }, [answerClose, contribution])

  useEffect(
    () => () => {
      for (const requestId of outstandingCloseRequestsRef.current) {
        void allowOrdinaryClose(requestId)
      }
      outstandingCloseRequestsRef.current.clear()
    },
    []
  )

  const switchSection = useCallback(
    (section: SettingsSection): void => {
      if (section === entry.section) return
      runLeaveIntent(() => {
        router.history.replace(
          '/settings',
          replaceSettingsSection(router.history.location.state, section),
          { ignoreBlocker: true }
        )
      })
    },
    [entry.section, router.history, runLeaveIntent]
  )

  const forceSwitchSection = useCallback(
    (section: SettingsSection): void => {
      const prompt = clearDiscardPrompt()
      prompt?.continueEditing()
      const queuedCloseRequest = queuedCloseRequestRef.current
      queuedCloseRequestRef.current = undefined
      if (queuedCloseRequest) answerClose(queuedCloseRequest, 'cancel')
      if (contribution.navigate === 'confirm-discard') contribution.discard?.()
      if (section === entry.section) return
      router.history.replace(
        '/settings',
        replaceSettingsSection(router.history.location.state, section),
        { ignoreBlocker: true }
      )
    },
    [answerClose, clearDiscardPrompt, contribution, entry.section, router.history]
  )

  const navigateToSource = useCallback((): void => {
    returnToSettingsSource(router.history, entry.source, organizationId, canEnterBusinessSource)
  }, [entry.source, organizationId, router.history])

  const returnToSource = useCallback((): void => {
    runLeaveIntent(navigateToSource)
  }, [navigateToSource, runLeaveIntent])

  useEffect(
    () => installSettingsBackInterception(router.history, returnToSource),
    [returnToSource, router.history]
  )

  const requestOrganizationPicker = useCallback((): void => {
    runLeaveIntent(() => {
      openOrganizationPicker('settings')
      router.history.replace(
        '/settings',
        createSettingsOrganizationPickerState(router.history.location.state, entry),
        { ignoreBlocker: true }
      )
    })
  }, [entry, openOrganizationPicker, router.history, runLeaveIntent])

  const openOrganizationCreation = useCallback((): void => {
    router.history.replace(
      '/settings',
      replaceSettingsOrganizationPickerPhase(router.history.location.state, 'organization-create'),
      { ignoreBlocker: true }
    )
  }, [router.history])

  const finishOrganizationPicker = useCallback((): void => {
    router.history.replace(
      '/settings',
      restoreSettingsEntryAfterOrganizationPicker(router.history.location.state),
      { ignoreBlocker: true }
    )
  }, [router.history])

  const continueEditing = useCallback((): void => {
    const prompt = clearDiscardPrompt()
    const queuedCloseRequest = queuedCloseRequestRef.current
    queuedCloseRequestRef.current = undefined
    if (queuedCloseRequest) answerClose(queuedCloseRequest, 'cancel')
    prompt?.continueEditing()
  }, [answerClose, clearDiscardPrompt])

  const discardChanges = useCallback((): void => {
    const prompt = clearDiscardPrompt()
    const queuedCloseRequest = queuedCloseRequestRef.current
    queuedCloseRequestRef.current = undefined
    if (queuedCloseRequest) {
      if (contribution.navigate === 'confirm-discard') contribution.discard?.()
      answerClose(queuedCloseRequest, 'allow')
      prompt?.continueEditing()
      return
    }
    prompt?.discardChanges()
  }, [answerClose, clearDiscardPrompt, contribution])

  return {
    section: entry.section,
    navigationDisabled: contribution.navigate === 'blocked',
    discardPromptOpen: discardPrompt !== undefined,
    switchSection,
    forceSwitchSection,
    returnToSource,
    openOrganizationPicker: requestOrganizationPicker,
    openOrganizationCreation,
    finishOrganizationPicker,
    continueEditing,
    discardChanges
  }
}
