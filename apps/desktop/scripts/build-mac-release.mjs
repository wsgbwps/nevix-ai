import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node CLI. */

export function signingInputs(environment) {
  const identity = environment.NEVIX_MAC_SIGNING_SHA1
  const keychain = environment.NEVIX_MAC_SIGNING_KEYCHAIN
  assert.match(identity ?? '', /^[a-fA-F0-9]{40}$/, 'Supply the fixed Mac signing certificate SHA1')
  assert.ok(keychain, 'Supply the existing protected Mac signing keychain path')
  return { identity: identity.toUpperCase(), keychain: resolve(keychain) }
}

async function main() {
  assert.equal(process.platform, 'darwin', 'Mac release signing requires macOS')
  assert.equal(process.arch, 'arm64', 'Only Apple Silicon is supported')
  const { identity, keychain } = signingInputs(process.env)
  assert.ok((await stat(keychain)).isFile(), 'Signing keychain must already exist')
  const identities = execFileSync('security', ['find-identity', '-p', 'codesigning', keychain], {
    encoding: 'utf8'
  })
  assert.ok(
    identities.includes(identity),
    'Pinned signing identity is absent from supplied keychain'
  )
  const desktopRoot = resolve(import.meta.dirname, '..')
  await stat(join(desktopRoot, 'out/main/index.js'))
  const require = createRequire(join(desktopRoot, 'package.json'))
  assert.equal(require('electron-builder/package.json').version, '26.15.3')
  assert.equal(require('electron-updater/package.json').version, '6.8.9')
  const { build, Platform, Arch } = require('electron-builder')
  const signingRequire = createRequire(require.resolve('electron-builder'))
  const { signAsync } = signingRequire('@electron/osx-sign')
  const entitlements = join(desktopRoot, 'build/entitlements.mac.plist')
  const values = JSON.parse(
    execFileSync('plutil', ['-convert', 'json', '-o', '-', entitlements], {
      encoding: 'utf8'
    })
  )
  assert.deepEqual(values, {
    'com.apple.security.cs.allow-jit': true,
    'com.apple.security.cs.allow-unsigned-executable-memory': true,
    'com.apple.security.cs.allow-dyld-environment-variables': true,
    'com.apple.security.cs.disable-library-validation': true
  })
  await build({
    projectDir: desktopRoot,
    targets: Platform.MAC.createTarget(['dmg', 'zip'], Arch.arm64),
    publish: 'never',
    config: {
      extends: join(desktopRoot, 'electron-builder.yml'),
      mac: { identity: null, notarize: false },
      afterPack: async ({ appOutDir }) => {
        const appPath = join(appOutDir, 'Nevix AI.app')
        // v26 cannot discover a free self-signed identity; pin it explicitly, without trust changes.
        await signAsync({
          app: appPath,
          identity,
          keychain,
          identityValidation: false,
          preAutoEntitlements: false,
          optionsForFile: () => ({ entitlements, hardenedRuntime: true, timestamp: 'none' })
        })
        execFileSync(
          'codesign',
          [
            '--verify',
            '--deep',
            '--strict',
            '-R',
            `identifier "com.nevix.ai" and certificate leaf = H"${identity}"`,
            appPath
          ],
          {
            stdio: 'inherit'
          }
        )
        const certificateDir = await mkdtemp(join(tmpdir(), 'nevix-mac-public-cert-'))
        try {
          const prefix = join(certificateDir, 'certificate')
          execFileSync('codesign', ['--display', '--extract-certificates', prefix, appPath], {
            stdio: 'inherit'
          })
          const certificate = new X509Certificate(await readFile(`${prefix}0`))
          assert.equal(certificate.fingerprint.replaceAll(':', ''), identity)
        } finally {
          await rm(certificateDir, { recursive: true, force: true })
        }
      }
    }
  })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
