import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node executes this CLI directly without a TypeScript runtime. */

const desktopRoot = resolve(import.meta.dirname, '..')
const nativeSmokeSpecs = [
  'tests/startup/renderer-readiness.spec.ts',
  'tests/window/native-editing.spec.ts',
  'tests/window/window-state.spec.ts',
  'tests/auth/native-secure-persistence.spec.ts'
]

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

function isPackagedExecutable(path, distRoot, platform) {
  const normalized = relative(distRoot, path).split(sep).join('/')
  if (platform === 'darwin') {
    return /(?:^|\/)[^/]+\.app\/Contents\/MacOS\/Nevix AI$/.test(normalized)
  }
  if (platform === 'win32') {
    return /(?:^|\/)win-unpacked\/Nevix AI\.exe$/.test(normalized)
  }
  throw new Error(`Native Smoke supports only macOS and Windows, not ${platform}`)
}

export async function resolvePackagedExecutable(root, platform) {
  const distRoot = join(root, 'dist')
  const matches = (await filesBelow(distRoot)).filter((path) =>
    isPackagedExecutable(path, distRoot, platform)
  )

  if (matches.length !== 1) {
    const candidates = matches.length === 0 ? 'none' : matches.join(', ')
    throw new Error(
      `Expected exactly one packaged ${platform} executable below ${distRoot}; found ${matches.length}: ${candidates}`
    )
  }
  return matches[0]
}

function runPnpm(args, environment = {}) {
  const npmExecPath = process.env.npm_execpath
  const command = npmExecPath
    ? process.execPath
    : process.platform === 'win32'
      ? 'pnpm.cmd'
      : 'pnpm'
  const commandArgs = npmExecPath ? [npmExecPath, ...args] : args
  const result = spawnSync(command, commandArgs, {
    cwd: desktopRoot,
    env: { ...process.env, ...environment },
    stdio: 'inherit'
  })

  if (result.error) throw result.error
  return result.status ?? 1
}

async function main() {
  const [mode] = process.argv.slice(2)
  if (mode !== 'source' && mode !== 'packaged') {
    throw new Error('usage: run-native-smoke.mjs <source|packaged>')
  }
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    throw new Error(`Native Smoke supports only macOS and Windows, not ${process.platform}`)
  }

  if (mode === 'source') {
    const buildStatus = runPnpm(['exec', 'electron-vite', 'build', '--mode', 'test'])
    if (buildStatus !== 0) return buildStatus
  }

  const environment = {
    // Native Smoke is deliberately backend-free and source mode must never
    // inherit a packaged executable from an earlier local run.
    NEVIX_TEST_SERVER_URL: '',
    NEVIX_TEST_ELECTRON_EXECUTABLE_PATH:
      mode === 'packaged' ? await resolvePackagedExecutable(desktopRoot, process.platform) : ''
  }

  return runPnpm(
    ['exec', 'playwright', 'test', ...nativeSmokeSpecs, '--grep', '@native-smoke', '--workers=1'],
    environment
  )
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    process.exitCode = await main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
