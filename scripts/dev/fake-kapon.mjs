// 本地开发与图片 E2E 的 fake Kapon（仓库不发布、不进生产镜像）：实现
// Connection Check 用到的 GET /v1/models，以及切片 10 图片生成路径的
// POST /v1/images/generations 与临时 URL 输出端点（issue #160）。接受
// FAKE_KAPON_KEY（默认 test-key），其余一律 401，便于同时验证"候选被拒绝"
// 的路径。自动化测试不得注入生产 Token（规格 #150）。
import { createServer } from 'node:http'
import { deflateSync } from 'node:zlib'

const port = Number(process.env.FAKE_KAPON_PORT ?? 9399)
const acceptedKey = process.env.FAKE_KAPON_KEY ?? 'test-key'

// Deterministic 64x64 RGBA PNG: the fake's verified-bytes fixture, encoded
// in-process so no binary fixture file ships in the tree.
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

createServer((req, res) => {
  const bearer = req.headers.authorization ?? ''
  const marker = req.headers['x-forwarded-proto'] ?? '(none)'
  if (req.method === 'GET' && req.url === '/v1/models' && authorized(req)) {
    console.log(`[fake-kapon] 200 ${req.url} (x-forwarded-proto: ${marker})`)
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        data: [{ id: 'doubao-seedream-5.0-lite' }, { id: 'doubao-seedance-2-5' }]
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
  console.log(`[fake-kapon] 401 ${req.url}`)
  res.statusCode = 401
  res.end('{}')
}).listen(port, '127.0.0.1', () => {
  console.log(`[fake-kapon] listening on http://127.0.0.1:${port} (accepts key "${acceptedKey}")`)
})
