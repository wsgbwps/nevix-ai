import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  macOSLocalizationPaths,
  missingMacOSPermissionKeys
} from './packaged-localization-contract.mjs'

const packageDirectory = resolve(process.argv[2] ?? 'dist')

const appBundles = await findAppBundles(packageDirectory)
if (appBundles.length === 0) {
  throw new Error(`No macOS app bundle found under ${packageDirectory}`)
}

for (const appBundle of appBundles) {
  for (const [language, localizationPath] of Object.entries(macOSLocalizationPaths)) {
    const localization = await readFile(
      join(appBundle, 'Contents', 'Resources', localizationPath),
      'utf8'
    )

    const missingKeys = missingMacOSPermissionKeys(localization)
    if (missingKeys.length > 0) {
      throw new Error(`${appBundle} is missing ${language} values for ${missingKeys.join(', ')}`)
    }
  }
}

// This verifier must run directly in Node without a TypeScript runtime.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function findAppBundles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const appBundles = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const path = join(directory, entry.name)
    if (entry.name.endsWith('.app')) {
      appBundles.push(path)
      continue
    }

    appBundles.push(...(await findAppBundles(path)))
  }

  return appBundles
}
