import { saveRememberedActiveOrganizationId } from '../active-organization-store'
import type {
  RememberedActiveOrganization,
  SetRememberedActiveOrganizationRequest
} from '../../../shared/ipc/organization/types'

export async function setRememberedActiveOrganizationHandler(
  _: Electron.IpcMainInvokeEvent,
  { organizationId }: SetRememberedActiveOrganizationRequest
): Promise<RememberedActiveOrganization> {
  if (typeof organizationId !== 'string' || organizationId.trim().length === 0) {
    throw new Error('Remembered Active Organization id is invalid.')
  }

  await saveRememberedActiveOrganizationId(organizationId)
  return { organizationId }
}
