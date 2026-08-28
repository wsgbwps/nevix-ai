// 本地开发的 fake Kapon（仓库不发布、不进生产镜像）：只实现 Connection Check
// 用到的 GET /v1/models。接受 FAKE_KAPON_KEY（默认 test-key），其余一律 401，
// 便于同时验证"候选被拒绝"的路径。自动化测试不得注入生产 Token（规格 #150）。
import { createServer } from 'node:http'

const port = Number(process.env.FAKE_KAPON_PORT ?? 9399)
const acceptedKey = process.env.FAKE_KAPON_KEY ?? 'test-key'

createServer((req, res) => {
  const bearer = req.headers.authorization ?? ''
  const marker = req.headers['x-forwarded-proto'] ?? '(none)'
  if (req.url === '/v1/models' && bearer === `Bearer ${acceptedKey}`) {
    console.log(`[fake-kapon] 200 ${req.url} (x-forwarded-proto: ${marker})`)
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        data: [{ id: 'doubao-seedream-5.0-lite' }, { id: 'doubao-seedance-2-5' }]
      })
    )
    return
  }
  console.log(`[fake-kapon] 401 ${req.url}`)
  res.statusCode = 401
  res.end('{}')
}).listen(port, '127.0.0.1', () => {
  console.log(`[fake-kapon] listening on http://127.0.0.1:${port} (accepts key "${acceptedKey}")`)
})
