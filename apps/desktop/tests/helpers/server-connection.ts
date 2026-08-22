import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Pre-writes the device's persisted server connection exactly as saving it
 * through the Connection Screen would, so specs can start from a configured
 * device. The connection specs themselves drive the real UI instead.
 */
export async function seedServerConnection(userDataDir: string, url: string): Promise<void> {
  const storePath = join(userDataDir, 'server-connection.json')
  await mkdir(userDataDir, { recursive: true })
  await writeFile(
    storePath,
    JSON.stringify({ version: 1, url, certificatePins: {} }, null, 0),
    'utf8'
  )
}
