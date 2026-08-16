import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import {
  allowOrdinaryClose,
  cancelOrdinaryClose,
  useOrdinaryCloseHandler
} from '../ordinary-close-handler'
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
import type { SettingsBackNavigation } from './settings-back-navigation'
import {
  runSettingsNavigationIntent,
  type PendingSettingsDiscardPrompt,
  type SettingsNavigationContribution
} from './settings-navigation-intent'

export const SettingsBackNavigationContext = createContext<SettingsBackNavigation | undefined>(
  undefined
)

export type SettingsContribution = SettingsNavigationContribution

interface SettingsCoordinatorOptions {
  readonly entry: SettingsEntry
  readonly contribution: SettingsContribution
  readonly organizationId: string | undefined
  readonly canEnterSource: (source: SettingsSourceDescriptor) => boolean
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

const FORCED_SECURITY_PATHS = new Set(['/auth', '/onboarding', '/select-organization'])

export function useSettingsCoordinator({
  entry,
  contribution,
  organizationId,
  canEnterSource,
  openOrganizationPicker
}: SettingsCoordinatorOptions): SettingsCoordinator {
  const router = useRouter()
  const backNavigation = useContext(SettingsBackNavigationContext)
  if (!backNavigation) {
    throw new Error('Settings back navigation must be provided by the app composition root.')
  }
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

  const runNavigationIntent = useCallback(
    (navigate: () => void): void => {
      runSettingsNavigationIntent(contribution, navigate, openDiscardPrompt)
    },
    [contribution, openDiscardPrompt]
  )

  useEffect(
    () =>
      router.history.block({
        enableBeforeUnload: false,
        blockerFn: async ({ currentLocation, nextLocation }) => {
          if (
            currentLocation.pathname !== '/settings' ||
            FORCED_SECURITY_PATHS.has(nextLocation.pathname)
          ) {
            return false
          }

          const current = contribution

          if (current.status === 'clean') return false
          if (current.status !== 'dirty') return true

          return await new Promise<boolean>((resolve) => {
            const didOpen = openDiscardPrompt({
              continueEditing: () => resolve(true),
              discardChanges: () => {
                current.discard()
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
      const current = contribution
      if (current.status === 'clean') {
        answerClose(requestId, 'allow')
        return
      }
      if (current.status === 'saving') {
        savingCloseRequestRef.current = requestId
        return
      }
      if (current.status !== 'dirty') {
        answerClose(requestId, 'cancel')
        return
      }
      if (discardPromptRef.current) {
        queuedCloseRequestRef.current = requestId
        return
      }

      openDiscardPrompt({
        continueEditing: () => answerClose(requestId, 'cancel'),
        discardChanges: () => {
          current.discard()
          answerClose(requestId, 'allow')
        }
      })
    },
    [answerClose, contribution, openDiscardPrompt]
  )
  useOrdinaryCloseHandler(handleOrdinaryClose)

  useEffect(() => {
    const requestId = savingCloseRequestRef.current
    if (!requestId || contribution.status === 'saving') return

    savingCloseRequestRef.current = undefined
    answerClose(requestId, contribution.status === 'clean' ? 'allow' : 'cancel')
  }, [answerClose, contribution.status])

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
      runNavigationIntent(() => {
        router.history.replace(
          '/settings',
          replaceSettingsSection(router.history.location.state, section),
          { ignoreBlocker: true }
        )
      })
    },
    [entry.section, router.history, runNavigationIntent]
  )

  const forceSwitchSection = useCallback(
    (section: SettingsSection): void => {
      const prompt = clearDiscardPrompt()
      prompt?.continueEditing()
      const queuedCloseRequest = queuedCloseRequestRef.current
      queuedCloseRequestRef.current = undefined
      if (queuedCloseRequest) answerClose(queuedCloseRequest, 'cancel')
      if (contribution.status === 'dirty') contribution.discard()
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
    returnToSettingsSource(router.history, entry.source, organizationId, canEnterSource)
  }, [canEnterSource, entry.source, organizationId, router.history])

  const returnToSource = useCallback((): void => {
    runNavigationIntent(navigateToSource)
  }, [navigateToSource, runNavigationIntent])

  useEffect(() => backNavigation.register(returnToSource), [backNavigation, returnToSource])

  const requestOrganizationPicker = useCallback((): void => {
    runNavigationIntent(() => {
      openOrganizationPicker('settings')
      router.history.replace(
        '/settings',
        createSettingsOrganizationPickerState(router.history.location.state, entry),
        { ignoreBlocker: true }
      )
    })
  }, [entry, openOrganizationPicker, router.history, runNavigationIntent])

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
      if (contribution.status === 'dirty') contribution.discard()
      answerClose(queuedCloseRequest, 'allow')
      prompt?.continueEditing()
      return
    }
    prompt?.discardChanges()
  }, [answerClose, clearDiscardPrompt, contribution])

  return {
    section: entry.section,
    navigationDisabled: contribution.status !== 'clean' && contribution.status !== 'dirty',
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
