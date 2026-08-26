export { authenticationResourceOwner, authenticationResources } from './i18n/resources'
export {
  REAUTH_ACTIONS,
  createReauthProofRequester,
  isReauthAction,
  type IdentityApiFailure,
  type IssuedReauthProof,
  type ReauthAction,
  type ReauthProofRequester
} from './api/reauth'
export { AuthenticationProvider } from './ui/authentication-provider'
export { AuthenticationSurface } from './ui/authentication-surface'
export { ReauthenticationDialog } from './ui/reauthentication-dialog'
export {
  useCurrentSession,
  type CurrentSession,
  type SessionAcquisition,
  type SessionUserSummary
} from './model/current-session'
