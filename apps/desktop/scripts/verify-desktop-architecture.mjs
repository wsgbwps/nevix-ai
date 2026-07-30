// CLI entry for the Desktop architecture verification command. Reads the real
// src/ tree, applies the deterministic Domain-first rules with the documented
// migration-debt allowlist, and exits non-zero on any violation.
// This verifier must run directly in Node without a TypeScript runtime.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { verifyDesktopArchitecture, formatViolations } from './architecture/verifier.mjs'
import { migrationDebtAllowlist } from './architecture/migration-debt-allowlist.mjs'

const desktopRoot = new URL('..', import.meta.url).pathname
const SOURCE_FILE = /\.(ts|tsx|mts|cts)$/

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

const files = new Map()
for (const file of (await filesBelow(join(desktopRoot, 'src'))).sort()) {
  if (!SOURCE_FILE.test(file)) continue
  const path = relative(desktopRoot, file).split(sep).join('/')
  files.set(path, await readFile(file, 'utf8'))
}

const { ok, violations } = verifyDesktopArchitecture(files, migrationDebtAllowlist)

if (ok) {
  console.log(`Desktop architecture verification passed (${files.size} source files checked).`)
} else {
  console.error(
    `Desktop architecture verification failed with ${violations.length} violation(s):\n`
  )
  for (const line of formatViolations(violations)) console.error(line)
  process.exitCode = 1
}
