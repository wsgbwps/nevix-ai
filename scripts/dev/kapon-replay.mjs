#!/usr/bin/env node
// Throwaway diagnostic harness: replays image-generation bodies against the
// real Kapon route to bisect the intermittent invalid_request_error 400 on
// watermark. Each shape repeats (gateway routing can differ per request), a
// success reports the model id the gateway echoed — the backend pool that
// actually served it — and a canonical versioned model id is probed as an
// alternative to the dotted alias. Credentials come from the environment
// (KAPON_API_KEY) and are never printed; output URLs too.
//
//   KAPON_API_KEY=... node scripts/dev/kapon-replay.mjs [--repeat 2]
//     [--size 1568x672] [--host models|svip|both] [--prompt '...']
//
// Defaults: --host is the KAPON_BASE_URL from server/.env.local (what the
// dev server actually uses), --size is the field-reported failing size.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptDir, '..', '..')

const apiKey = process.env.KAPON_API_KEY
if (!apiKey) {
  console.error('KAPON_API_KEY is not set')
  process.exit(1)
}

function flag(name, fallback) {
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`))
  if (inline) return inline.split('=').slice(1).join('=')
  const at = process.argv.indexOf(`--${name}`)
  return at !== -1 && process.argv[at + 1] && !process.argv[at + 1].startsWith('--')
    ? process.argv[at + 1]
    : fallback
}

function configuredBaseURL() {
  if (process.env.KAPON_BASE_URL) return process.env.KAPON_BASE_URL
  try {
    const env = readFileSync(join(repoRoot, 'server', '.env.local'), 'utf8')
    const match = env.match(/^KAPON_BASE_URL=['"]?([^'"\n]+)['"]?/m)
    if (match) return match[1]
  } catch {
    // no .env.local — fall through to the compiled-in default
  }
  return 'https://models.kapon.cloud'
}

const hostFlag = flag('host', '')
const hosts =
  hostFlag === 'both'
    ? ['https://models.kapon.cloud', 'https://svip.kapon.cloud']
    : hostFlag === 'models'
      ? ['https://models.kapon.cloud']
      : hostFlag === 'svip'
        ? ['https://svip.kapon.cloud']
        : [configuredBaseURL()]

const repeat = Math.max(1, Number(flag('repeat', '2')))
const size = flag('size', '1568x672') // 21:9 1K — the field-reported failing size
const prompt = flag(
  'prompt',
  '生成两张图，一只可爱的熊猫在竹林里吃竹子，阳光透过树叶洒下斑驳的光影'
)
// --model switches the model under test (e.g. doubao-seedream-5.0): rows
// A/C run against it and each 200's served-by echo reveals the versioned
// backend id behind its flaky alias — the id the adapter should map to.
const aliasModel = flag('model', 'doubao-seedream-5.0-pro')
const sizeHint = aliasModel === 'doubao-seedream-5.0-pro' ? size : '2048x2048' // 1:1 2K exists on every tier set
// Accepted request ids confirmed on the live route: pro's dotted alias
// routes flakily so the versioned backend id is used; the base display id
// must travel as its catalog alias (the versioned echo 260128 is rejected
// as an input).
const versionedBackendIds = {
  'doubao-seedream-5.0-pro': 'doubao-seedream-5-0-pro-260628',
  'doubao-seedream-5.0': 'doubao-seedream-5.0-n'
}

async function call(baseURL, path, init = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    const response = await fetch(baseURL + path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...init.headers
      },
      signal: controller.signal
    })
    const text = await response.text()
    return { status: response.status, text }
  } catch (error) {
    return { status: 0, text: `transport: ${error?.cause?.code ?? error?.name ?? 'unknown'}` }
  } finally {
    clearTimeout(timer)
  }
}

function facts({ status, text }) {
  if (status === 200) {
    try {
      const parsed = JSON.parse(text)
      const image = parsed.data?.[0] ?? {}
      return `served-by=${parsed.model ?? '?'} format=${image.output_format ?? '?'}`
    } catch {
      return 'OK (unparseable body)'
    }
  }
  try {
    const error = JSON.parse(text).error ?? {}
    return [error.code, error.message].filter(Boolean).join(' · ')
  } catch {
    return text.length > 140 ? `${text.slice(0, 140)}…` : text
  }
}

async function catalogIds(baseURL) {
  const result = await call(baseURL, '/v1/models')
  if (result.status !== 200) {
    console.log(`  catalog GET /v1/models -> HTTP ${result.status}`)
    return []
  }
  try {
    const ids = JSON.parse(result.text).data.map((item) => String(item.id))
    const seedream = ids.filter((id) => /seedream/i.test(id))
    console.log(`  catalog seedream ids: ${seedream.length > 0 ? seedream.join(', ') : '(none)'}`)
    return seedream
  } catch {
    console.log('  catalog body unparseable')
    return []
  }
}

async function generation(baseURL, name, body) {
  const outcomes = []
  for (let i = 1; i <= repeat; i++) {
    const result = await call(baseURL, '/v1/images/generations', {
      method: 'POST',
      body: JSON.stringify(body)
    })
    outcomes.push(`${result.status}(${facts(result)})`)
  }
  console.log(`  ${name.padEnd(42)} ${outcomes.join('  ')}`)
}

for (const baseURL of hosts) {
  console.log(`\n== ${baseURL.replace(/^https:\/\//, '')} ==`)
  const catalog = await catalogIds(baseURL)
  // Prefer a versioned id the catalog itself lists; the confirmed backend
  // ids are the fallback when the catalog hides them.
  const canonical =
    catalog.find((id) => id !== aliasModel && new RegExp(aliasModel.replace(/\./g, '\\.'), 'i').test(id)) ??
    versionedBackendIds[aliasModel] ?? null

  await generation(baseURL, `A ${aliasModel} + watermark:false ×${repeat}`, {
    model: aliasModel, prompt, size: sizeHint, response_format: 'url', watermark: false
  })
  if (canonical !== null) {
    await generation(baseURL, `B ${canonical} + watermark:false ×${repeat}`, {
      model: canonical, prompt, size: sizeHint, response_format: 'url', watermark: false
    })
  }
  await generation(baseURL, `C ${aliasModel} minimal (control) ×${repeat}`, {
    model: aliasModel, prompt, size: sizeHint, response_format: 'url'
  })
}
console.log(
  '\n判读：A/C 混杂 400-200 → 别名路由抖动（已证实，pro 走版本化 id 规避）；' +
    '任何 200 的 served-by=… 就是该别名对应的版本化后端 id，把它加进适配器映射即可；' +
    '全 400 → 换 --prompt 复测你的真实 prompt。\n'
)
