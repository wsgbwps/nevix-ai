import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Device memory of the Active Organization id: main-process persistence with
// no localStorage in the renderer, following the language-mode-store precedent
// (ADR-0002/0003). The value is not sensitive, so it stays plain JSON.
const ACTIVE_ORGANIZATION_FILE_NAME = 'active-organization.json'

export async function loadRememberedActiveOrganizationId(): Promise<string | null> {
  try {
    const contents = await readFile(getActiveOrganizationPath(), 'utf8')
    const storedValue: unknown = JSON.parse(contents)
    if (typeof storedValue === 'object' && storedValue !== null) {
      const { organizationId } = storedValue as { organizationId?: unknown }
      if (typeof organizationId === 'string' && organizationId.trim().length > 0) {
        return organizationId
      }
    }
  } catch {
    // A missing or invalid device memory intentionally falls back to no remembered Organization.
  }

  return null
}

export async function saveRememberedActiveOrganizationId(organizationId: string): Promise<void> {
  const activeOrganizationPath = getActiveOrganizationPath()
  await mkdir(dirname(activeOrganizationPath), { recursive: true })
  await writeFile(activeOrganizationPath, JSON.stringify({ organizationId }), 'utf8')
}

function getActiveOrganizationPath(): string {
  return join(app.getPath('userData'), ACTIVE_ORGANIZATION_FILE_NAME)
}
