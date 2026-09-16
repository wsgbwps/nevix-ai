// Local Creation E2E fake; never inject production tokens (spec #150).
import { createServer } from 'node:http'
import { deflateSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

const port = Number(process.env.FAKE_KAPON_PORT ?? 9399)
const acceptedKey = process.env.FAKE_KAPON_KEY ?? 'test-key'
const videoBytes = readFileSync(new URL('./fixtures/video-with-audio.mp4', import.meta.url))
const videoPath = '/volcark/api/v3/contents/generations/tasks'
const videoTasks = new Map()
let nextVideoId = 0

// Deterministic 64x64 RGBA PNG, encoded in-process.
const fakePng = (() => {
  const width = 64
  const height = 64
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4)
    raw[rowStart] = 0
    for (let x = 0; x < width; x++) {
      const at = rowStart + 1 + x * 4
      raw[at] = (x * 4) % 256
      raw[at + 1] = (y * 4) % 256
      raw[at + 2] = 180
      raw[at + 3] = 255
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const table = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })()
  function crc32(buffer) {
    let c = 0xffffffff
    for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8)
    return c ^ 0xffffffff
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
})()

const authorized = (req) => req.headers.authorization === `Bearer ${acceptedKey}`

createServer(async (req, res) => {
  const bearer = req.headers.authorization ?? ''
  const marker = req.headers['x-forwarded-proto'] ?? '(none)'
  if (req.method === 'GET' && req.url === '/v1/models' && authorized(req)) {
    console.log(`[fake-kapon] 200 ${req.url} (x-forwarded-proto: ${marker})`)
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        data: [{ id: 'doubao-seedream-5.0-pro' }, { id: 'doubao-seedance-2-5' }]
      })
    )
    return
  }
  if (req.method === 'POST' && req.url === '/v1/images/generations') {
    if (!authorized(req)) {
      res.statusCode = 401
      res.end('{}')
      return
    }
    let body = ''
    req.on('data', (piece) => {
      body += piece
    })
    req.on('end', () => {
      let quantity = 1
      try {
        quantity = Math.max(1, Math.min(4, Number(JSON.parse(body).n ?? 1)))
      } catch {
        // A malformed body still yields one output; this fake never judges
        // vendor-side prompt policy.
      }
      console.log(`[fake-kapon] 200 ${req.url} n=${quantity}`)
      res.setHeader('content-type', 'application/json')
      const data = []
      for (let i = 0; i < quantity; i++) {
        data.push({ url: `http://127.0.0.1:${port}/provider-outputs/image/${i}` })
      }
      res.end(JSON.stringify({ created: 0, data }))
    })
    return
  }
  if (req.method === 'GET' && req.url?.startsWith('/provider-outputs/image/')) {
    res.setHeader('content-type', 'image/png')
    res.end(fakePng)
    return
  }
  if (req.url === videoPath && req.method === 'POST') {
    if (!authorized(req)) {
      res.writeHead(401).end('{}')
      return
    }
    try {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 1 << 20) throw new Error('oversize fixture request')
      }
      const payload = JSON.parse(body)
      if (
        payload.model !== 'doubao-seedance-2-5' ||
        !['480p', '720p', '1080p'].includes(payload.resolution) ||
        ![5, 10].includes(payload.duration) ||
        !['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'].includes(payload.ratio) ||
        Object.hasOwn(payload, 'output_format') ||
        payload.generate_audio !== true ||
        !Array.isArray(payload.content) ||
        payload.content[0]?.type !== 'text'
      )
        throw new Error('unsupported fixture request')
      const id = `fake-video-${++nextVideoId}`
      videoTasks.set(id, { polls: 0, cancelled: false })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ id }))
    } catch {
      res.writeHead(400).end(JSON.stringify({ error: { code: 'invalid_request' } }))
    }
    return
  }
  if (req.url?.startsWith(`${videoPath}/`) && ['GET', 'DELETE'].includes(req.method)) {
    if (!authorized(req)) {
      res.writeHead(401).end('{}')
      return
    }
    const id = req.url.slice(videoPath.length + 1)
    const task = videoTasks.get(id)
    if (!task) {
      res.writeHead(404).end('{}')
      return
    }
    if (req.method === 'DELETE') {
      task.cancelled = true
      res.writeHead(204).end()
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify(
        task.cancelled
          ? { id, status: 'cancelled' }
          : ++task.polls === 1
            ? { id, status: 'running' }
            : {
                id,
                status: 'succeeded',
                content: {
                  video_url: `http://127.0.0.1:${port}/provider-outputs/video/${id}`
                }
              }
      )
    )
    return
  }
  if (req.method === 'GET' && req.url?.startsWith('/provider-outputs/video/')) {
    res.setHeader('content-type', 'video/mp4')
    res.end(videoBytes)
    return
  }
  console.log(`[fake-kapon] 401 ${req.url}`)
  res.statusCode = 401
  res.end('{}')
}).listen(port, '127.0.0.1', () => {
  console.log(`[fake-kapon] listening on http://127.0.0.1:${port} (accepts key "${acceptedKey}")`)
})
