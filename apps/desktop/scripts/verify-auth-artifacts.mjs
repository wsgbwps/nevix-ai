import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const desktopRoot = new URL('..', import.meta.url).pathname
const roots = ['out', 'test-results']
const exactForbiddenValues = [process.env.NEVIX_TEST_ADMIN_INITIAL_PASSWORD].filter(
  (value) => typeof value === 'string' && value.length > 0
)
const forbiddenPatterns = [/postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@/, /initial-horse-battery-staple/]

/**
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
// This verifier must run directly in Node without a TypeScript runtime.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const files = []

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await filesBelow(path)))
    else if (entry.isFile()) files.push(path)
  }

  return files
}

for (const root of roots) {
  for (const file of await filesBelow(join(desktopRoot, root))) {
    const contents = await readFile(file)
    const text = contents.toString('utf8')
    const containsExactValue = exactForbiddenValues.some((value) =>
      contents.includes(Buffer.from(value))
    )
    const containsForbiddenPattern = forbiddenPatterns.some((pattern) => pattern.test(text))

    if (containsExactValue || containsForbiddenPattern) {
      throw new Error(`Sensitive Authentication material found in ${relative(desktopRoot, file)}`)
    }
  }
}
