// 本地开发的 readiness 证据生成器（仓库不发布、不进生产）：读取 Server 的
// readiness checklist（单一事实源），写出一份把指定媒体全部 slot 标记为
// passed 的 evidence 文档，供 NEVIX_CREATION_READINESS_FILE 指向，让本地
// Workbench 能测试真实生成路径。
//
// 红线：这份证据是本地合成的，不是发布验收事实。生产的 evidence 只能由
// scripts/production-readiness/probe.mjs 对真实 Kapon 逐 slot 执行产生
// （T16 #166）；生产部署绝不允许出现 evidence_ref 为 local-dev/ 前缀的文档。
//
// 用法：
//   node scripts/dev/dev-readiness-evidence.mjs --out /tmp/nevix-dev-readiness.json
//   node scripts/dev/dev-readiness-evidence.mjs --media image --out ...
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const checklistPath = join(scriptDir, '../../server/internal/creation/domain/readiness-checklist.json')

function argument(name) {
  const argv = process.argv
  const inline = argv.find((value) => value.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const index = argv.indexOf(`--${name}`)
  if (index !== -1 && index + 1 < argv.length) return argv[index + 1]
  return undefined
}

const out = argument('out')
if (!out) {
  console.error('usage: dev-readiness-evidence.mjs --out <path> [--media image|video]')
  process.exit(2)
}
const media = argument('media')

const checklist = JSON.parse(await readFile(checklistPath, 'utf8'))
const slots = checklist.slots.filter((slot) => !media || slot.media === media)
if (slots.length === 0) {
  console.error(`no checklist slots for media "${media ?? '(all)'}"`)
  process.exit(2)
}

const now = new Date().toISOString()
const evidence = {
  schema_version: 1,
  generated_at: now,
  entries: slots.map((slot) => ({
    slot_id: slot.id,
    status: 'passed',
    checked_at: now,
    evidence_ref: `local-dev/${slot.id}`
  }))
}
mkdirSync(dirname(out), { recursive: true })
await writeFile(out, JSON.stringify(evidence))
console.log(
  `[dev-readiness] 本地合成证据已写入 ${out}（${slots.length} 个 slot，media=${media ?? 'all'}）。` +
    '这是本地开发合成证据，不是发布验收事实；生产证据只能来自 scripts/production-readiness 对真实 Kapon 的执行。'
)
