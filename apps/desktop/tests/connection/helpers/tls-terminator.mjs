#!/usr/bin/env node
/**
 * Test-only TLS terminator for the Desktop E2E connection suite: fronts the
 * identity server with a self-signed certificate so the app's TOFU flow sees a
 * real untrusted chain, and supports mid-run certificate rotation through a
 * single atomically-replaced JSON pointer (new connections present the new
 * certificate; established TLS sessions keep the old one).
 *
 * Usage: tls-terminator.mjs --listen 127.0.0.1:8443 --target http://127.0.0.1:8080 \
 *   --rotation-file <dir>/rotation.json
 *
 * rotation.json: { "cert": "cert-b.pem", "key": "key-b.pem" } — paths resolved
 * against the rotation file's directory. Rotate by writing a new file and
 * renaming it over rotation.json.
 */
import http from 'node:http'
import https from 'node:https'
import { readFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { dirname, join } from 'node:path'

/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node executes this helper directly without a TypeScript runtime. */

function argument(name) {
  const prefix = `--${name}=`
  const argument_ = process.argv.find((value) => value.startsWith(prefix))
  if (!argument_) throw new Error(`missing required argument --${name}`)
  return argument_.slice(prefix.length)
}

const listen = argument('listen')
const target = argument('target')
const rotationFilePath = argument('rotation-file')
const rotationDir = dirname(rotationFilePath)

async function readRotation() {
  const rotation = JSON.parse(await readFile(rotationFilePath, 'utf8'))
  const [cert, key] = await Promise.all([
    readFile(join(rotationDir, rotation.cert), 'utf8'),
    readFile(join(rotationDir, rotation.key), 'utf8')
  ])
  return { cert, key }
}

const initial = await readRotation()
const server = https.createServer({ ...initial }, (request, response) => {
  const upstream = http.request(
    new URL(request.url ?? '/', target),
    { method: request.method, headers: { ...request.headers, host: new URL(target).host } },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    }
  )
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502)
    response.end()
  })
  request.pipe(upstream)
})

// Rotation: tls.Server#setSecureContext applies to connections established
// after the call, which is exactly the observable the fingerprint-change spec
// needs. The rotation pointer is replaced atomically, so a reload always reads
// a complete cert/key pair.
watch(rotationDir, async (_event, filename) => {
  if (filename !== 'rotation.json') return
  try {
    server.setSecureContext(await readRotation())
    console.log(`[tls-terminator] rotated certificate (${new Date().toISOString()})`)
  } catch (error) {
    console.error('[tls-terminator] rotation failed', error)
  }
})

const [listenHost, listenPort] = listen.split(':')
server.listen(Number(listenPort), listenHost, () => {
  console.log(`[tls-terminator] listening on https://${listen} -> ${target}`)
})
