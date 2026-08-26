import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type TestCertificateName = 'a' | 'b' | 'c' | 'e'

/** Rotates the test TLS terminator by atomically replacing its certificate pointer. */
export async function rotateCertificateTo(
  rotationDir: string,
  name: TestCertificateName
): Promise<void> {
  const pointerPath = join(rotationDir, 'rotation.json')
  const pendingPath = `${pointerPath}.pending`
  await writeFile(
    pendingPath,
    JSON.stringify({ cert: `cert-${name}.pem`, key: `key-${name}.pem` }),
    'utf8'
  )
  await rename(pendingPath, pointerPath)
  // The directory watcher applies the new context asynchronously; the next
  // handshake must not race that reload.
  await new Promise((resolve) => setTimeout(resolve, 750))
}
