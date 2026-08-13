import type {
  RememberedEmailClear,
  RememberedEmailRead,
  RememberedEmailWrite
} from '../../../../../shared/ipc/authentication/types'

export function readRememberedEmail(): Promise<RememberedEmailRead> {
  return window.api.invoke('authentication:read-remembered-email')
}

export function replaceRememberedEmail(email: string): Promise<RememberedEmailWrite> {
  return window.api.invoke('authentication:replace-remembered-email', { email })
}

export function clearRememberedEmail(): Promise<RememberedEmailClear> {
  return window.api.invoke('authentication:clear-remembered-email')
}
