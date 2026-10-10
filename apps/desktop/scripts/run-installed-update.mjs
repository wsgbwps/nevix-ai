import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign, X509Certificate } from 'node:crypto'
import { createServer } from 'node:https'
import { mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'vite'

/* eslint-disable @typescript-eslint/explicit-function-return-type -- directly executed Node CI fixture. */
const require = createRequire(import.meta.url)
const desktop = resolve(import.meta.dirname, '..')
const root = resolve(desktop, '../../.scratch/342-windows-updates')
const packageDir = join(root, 'app')
const buildOnly = process.argv.includes('--build-only')
if (!buildOnly) {
  assert.equal(process.platform, 'win32', 'installed NSIS verification requires Windows')
  assert.equal(process.env.CI, 'true', 'run installation only on an isolated CI runner')
}
assert.equal(require('electron-updater/package.json').version, '6.8.9')
assert.equal(require('electron/package.json').version, '39.8.10')
assert.equal(require('electron-builder/package.json').version, '26.15.3')
const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: desktop, stdio: 'inherit', ...options })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))
    )
  })
async function waitFor(path, predicate) {
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    try {
      const result = JSON.parse(await readFile(path, 'utf8'))
      if (predicate(result)) return result
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${path}`)
}
await mkdir(packageDir, { recursive: true })
const certPath = join(root, 'tls.crt'),
  keyPath = join(root, 'tls.key')
const openssl =
  process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl'
await run(openssl, [
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-keyout',
  keyPath,
  '-out',
  certPath,
  '-days',
  '1',
  '-subj',
  '/CN=localhost',
  '-addext',
  'subjectAltName=IP:127.0.0.1,DNS:localhost'
])
const certificate = await readFile(certPath),
  tlsKey = await readFile(keyPath)
const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
let envelope,
  installerBytes,
  versionUnavailable = false
const requests = []
const server = createServer({ cert: certificate, key: tlsKey }, (request, response) => {
  const pathname = new URL(request.url, 'https://127.0.0.1').pathname
  requests.push(pathname)
  response.setHeader('Content-Type', 'application/json')
  if (pathname === '/health')
    response.end(JSON.stringify({ status: 'ok', service: 'nevix-server' }))
  else if (pathname === '/release/version' && !versionUnavailable)
    response.end(
      JSON.stringify({ service: 'nevix-server', version: '1.0.0', min_desktop_version: '1.0.0' })
    )
  else if (pathname === '/stable/win32-x64.json') response.end(JSON.stringify(envelope))
  else if (pathname === '/new.exe') {
    response.setHeader('Content-Length', installerBytes.length)
    response.end(installerBytes)
  } else if (pathname === '/invalidate-version') {
    versionUnavailable = true
    response.end('{}')
  } else {
    response.writeHead(503)
    response.end('{}')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `https://127.0.0.1:${server.address().port}/`
try {
  await writeFile(join(packageDir, 'fixture.json'), JSON.stringify({ root }))
  await build({
    configFile: false,
    root: desktop,
    logLevel: 'warn',
    plugins: [
      {
        name: 'isolated-release-inputs',
        enforce: 'pre',
        transform(source, id) {
          if (!id.endsWith('/src/main/updater/official-source.ts')) return
          const anchor = /export const RELEASE_PUBLIC_KEY_PEM = (?:'[^']*'|`[^`]*`)/
          assert.match(source, anchor, 'Fixture must replace the compiled release anchor')
          return source
            .replace(anchor, `export const RELEASE_PUBLIC_KEY_PEM = ${JSON.stringify(publicKey)}`)
            .replace(
              /'https:\/\/cnb\.cool\/nevix\.ai\/nevix-releases\/-\/git\/raw\/main\/stable\/'/,
              JSON.stringify(`${base}stable/`)
            )
        }
      }
    ],
    ssr: { noExternal: ['i18next'] },
    build: {
      ssr: join(desktop, 'tests/updater/installed-fixture.ts'),
      outDir: join(packageDir, 'main'),
      minify: false,
      rollupOptions: {
        external: ['electron', /^node:/, /^electron-updater/],
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  })
  const bundle = await readFile(join(packageDir, 'main/index.cjs'), 'utf8')
  assert.ok(
    bundle.includes(publicKey.split('\n')[1]),
    'the isolated fixture contains its ephemeral anchor'
  )
  assert.ok(
    !bundle.includes('https://cnb.cool/nevix.ai/nevix-releases/'),
    'the isolated fixture uses only its controlled source'
  )
  assert.ok(!bundle.includes('require("i18next")'), 'fixture language dependency is bundled')
  await writeFile(
    join(packageDir, 'preload.cjs'),
    `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fixture', { invoke: (channel, request) => ipcRenderer.invoke(channel, request),
 onDecision: (handler) => ipcRenderer.on('window:ordinary-close-requested', (_, request) => handler(request)) });`
  )
  await writeFile(
    join(packageDir, 'renderer.html'),
    `<!doctype html><meta charset="utf-8"><title>Isolated Nevix updater fixture</title>
<script>
const mode = new URLSearchParams(location.search).get('mode');
window.fixture.onDecision(async ({ requestId }) => {
  await window.fixture.invoke('fixture:before-decision');
  await window.fixture.invoke('window:decide-ordinary-close', { requestId: mode === 'wrong-request' ? 'stale' : requestId,
    decision: mode === 'cancel' ? 'cancel' : 'allow' });
});
window.fixtureReady = mode === 'not-ready' ? Promise.resolve() : window.fixture.invoke('window:ordinary-close-ready');
</script>`
  )
  if (buildOnly) {
    console.log('Integrated updater + Window fixture build passed; no installer built or executed.')
  } else {
    const config = {
      appId: 'com.nevix.ai',
      productName: 'Nevix Update CI',
      electronVersion: require('electron/package.json').version,
      directories: { app: packageDir, output: join(root, 'artifacts') },
      files: ['**/*'],
      npmRebuild: false,
      win: { target: [{ target: 'nsis', arch: ['x64'] }], signAndEditExecutable: false },
      nsis: {
        oneClick: true,
        perMachine: false,
        runAfterFinish: false,
        createDesktopShortcut: false,
        createStartMenuShortcut: false,
        artifactName: 'nevix-update-${version}.exe'
      },
      publish: { provider: 'generic', url: `${base}unused/` }
    }
    const configPath = join(root, 'builder.json')
    await writeFile(configPath, JSON.stringify(config))
    const npmCli = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    await access(npmCli)
    for (const version of ['1.0.0', '1.0.1']) {
      await writeFile(
        join(packageDir, 'package.json'),
        JSON.stringify({
          name: 'nevix-update-ci',
          version,
          description: 'Isolated integrated updater CI fixture',
          author: 'Nevix AI',
          main: 'main/index.cjs',
          dependencies: { 'electron-updater': '6.8.9' }
        })
      )
      if (version === '1.0.0')
        await run(process.execPath, [
          npmCli,
          'install',
          '--prefix',
          packageDir,
          '--no-audit',
          '--no-fund'
        ])
      await run(process.execPath, [
        require.resolve('electron-builder/cli.js'),
        '--win',
        '--x64',
        '--config',
        configPath,
        '--publish',
        'never'
      ])
    }
    installerBytes = await readFile(join(root, 'artifacts/nevix-update-1.0.1.exe'))
    const release = {
      version: '1.0.1',
      channel: 'stable',
      platform: 'win32',
      arch: 'x64',
      min_server_version: '1.0.0',
      min_desktop_version: '1.0.0',
      url: `${base}new.exe`,
      size: installerBytes.length,
      sha512: createHash('sha512').update(installerBytes).digest('base64')
    }
    const payload = Buffer.from(JSON.stringify(release))
    envelope = {
      format: 'nevix-release-v1',
      payload: payload.toString('base64'),
      signature: sign(null, payload, keys.privateKey).toString('base64')
    }
    await mkdir(join(root, 'userData'), { recursive: true })
    await writeFile(
      join(root, 'userData/server-connection.json'),
      JSON.stringify({
        version: 1,
        url: base,
        certificatePins: {
          '127.0.0.1': new X509Certificate(certificate).fingerprint256
            .replaceAll(':', '')
            .toLowerCase()
        }
      })
    )
    await writeFile(
      join(root, 'userData/language-mode.json'),
      JSON.stringify({ languageMode: 'en' })
    )
    const installDir = join(root, 'installed'),
      executable = join(installDir, 'Nevix Update CI.exe')
    await run(join(root, 'artifacts/nevix-update-1.0.0.exe'), ['/S', `/D=${installDir}`])
    const results = []
    for (const mode of [
      'initial',
      'ordinary',
      'later',
      'cancel',
      'not-ready',
      'unavailable',
      'wrong-request',
      'server-unavailable',
      'replaced-cache',
      'approved'
    ]) {
      versionUnavailable = false
      await rm(join(root, `${mode}.json`), { force: true })
      await writeFile(join(root, 'scenario.json'), JSON.stringify({ id: mode, mode, base }))
      const exited = run(executable, [], { env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath } })
      const [result] = await Promise.all([
        waitFor(
          join(root, `${mode}.json`),
          (result) => result.version === (mode === 'approved' ? '1.0.1' : '1.0.0')
        ),
        exited
      ])
      assert.equal(resolve(result.executable), resolve(executable))
      if (!['initial', 'ordinary', 'approved'].includes(mode)) assert.equal(result.confirmations, 1)
      results.push({ mode, ...result })
    }
    assert.ok(requests.includes('/new.exe'), 'startup downloaded the actual full NSIS installer')
    assert.ok(
      requests.every((request) => !request.endsWith('.yml')),
      'the signed provider never consults an unsigned feed'
    )
    const report = {
      platform: process.platform,
      updater: require('electron-updater/package.json').version,
      release,
      results,
      requests,
      limitations: [
        'Ephemeral publisher key and isolated HTTPS CA; production trust remains unset.',
        'Native confirmation responses and renderer decisions are scripted; SmartScreen and complete Settings UI remain separate acceptance.'
      ]
    }
    await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  }
} finally {
  await new Promise((resolve) => server.close(resolve))
}
