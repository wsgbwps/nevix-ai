// Aggregates one media-wall benchmark report into the SLO verdicts issue #292
// asks for. Nearest-rank percentiles, matching the helper the Asset Library spec
// already uses, so a p95 here means the same thing it means there.
//
//   node apps/desktop/scripts/media-wall-benchmark/aggregate.mjs <report.json>
//
// Exits non-zero when a target is missed, so the benchmark cannot pass quietly.
//
// This reports a benchmark from a shell, so it must run directly in Node without
// a TypeScript runtime.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFileSync } from 'node:fs'

/** The SLO table from issue #292 criteria 4-7. */
const TARGETS = {
  // Page framework/cards: p75 no more than 500ms (criterion 4).
  cardsReady: { phase: 'image', p75: 500 },
  // First initially visible preview: p75 <= 1.0s, p95 <= 1.5s (criterion 5).
  firstVisibleDecoded: { phase: 'image', p75: 1_000, p95: 1_500 },
  // All initially visible previews: p75 <= 1.5s, p95 <= 2.5s (criterion 6).
  allVisibleDecoded: { phase: 'image', p75: 1_500, p95: 2_500 },
  // Pointer-enter to video motion: p75 <= 1.0s, p95 <= 2.5s (criterion 7).
  hoverToPlaying: { phase: 'video', p75: 1_000, p95: 2_500 }
}

function percentile(samples, fraction) {
  if (samples.length === 0) return Number.POSITIVE_INFINITY
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * fraction) - 1]
}

function ms(value) {
  return Number.isFinite(value) ? `${Math.round(value)}ms` : 'n/a'
}

const reportPath = process.argv[2]
if (!reportPath) {
  console.error('usage: aggregate.mjs <report.json>')
  process.exit(2)
}
const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const entries = report.entries ?? []
const phaseEntries = (phase) => entries.filter((entry) => entry.phase === phase)

let failed = false
const samples = {
  cardsReady: [],
  firstVisibleDecoded: [],
  allVisibleDecoded: [],
  hoverToPlaying: []
}
const failures = []
const videoMetadata = []
const videoData = []

// Every phase is a delta from its own arm, so cold and warm entries and both
// routes pool into one distribution per phase.
for (const entry of phaseEntries('image')) {
  const t0 = entry.t0
  const cards = entry.cards ?? []
  const visible = cards.filter((card) => card.initiallyVisible)
  if (cards.length > 0) {
    samples.cardsReady.push(Math.max(...cards.map((card) => card.appearedAt)) - t0)
  }
  const decoded = visible.filter((card) => card.decodedAt !== null)
  if (decoded.length > 0) {
    samples.firstVisibleDecoded.push(Math.min(...decoded.map((card) => card.decodedAt)) - t0)
  }
  if (visible.length > 0 && decoded.length === visible.length) {
    samples.allVisibleDecoded.push(Math.max(...decoded.map((card) => card.decodedAt)) - t0)
  }
}

for (const entry of entries) {
  for (const card of entry.cards ?? []) {
    if (card.failed !== null) {
      failures.push({ route: entry.route, phase: entry.phase, mode: entry.mode, kind: card.failed })
    }
  }
}

for (const entry of phaseEntries('video')) {
  for (const card of entry.cards ?? []) {
    if (card.mediaKind !== 'video') continue
    // Observations only — criteria 4-7 attach no target to these two.
    if (card.loadedMetadataAt !== null) videoMetadata.push(card.loadedMetadataAt - entry.t0)
    if (card.decodedAt !== null) videoData.push(card.decodedAt - entry.t0)
    if (card.hoverEnteredAt !== null && card.playingAt !== null) {
      samples.hoverToPlaying.push(card.playingAt - card.hoverEnteredAt)
    }
  }
}

const coldCount = entries.filter((entry) => entry.mode === 'cold' && entry.phase === 'image').length
const warmCount = entries.filter((entry) => entry.mode === 'warm' && entry.phase === 'image').length
console.log(
  `route entries: ${coldCount} cold, ${warmCount} warm (each also measured as a video wall)`
)
console.log(`measurements: ${entries.length}`)
const videoCards = phaseEntries('video').flatMap((entry) =>
  (entry.cards ?? []).filter((card) => card.mediaKind === 'video')
)
console.log(`video cards observed across video phases: ${videoCards.length}`)
if (videoMetadata.length > 0) {
  console.log(
    `  loadedmetadata  p75 ${ms(percentile(videoMetadata, 0.75))}  p95 ${ms(percentile(videoMetadata, 0.95))}   (no target)`
  )
}
if (videoData.length > 0) {
  console.log(
    `  loadeddata      p75 ${ms(percentile(videoData, 0.75))}  p95 ${ms(percentile(videoData, 0.95))}   (no target)`
  )
}
const dprs = [...new Set(entries.map((entry) => entry.devicePixelRatio))]
console.log(`devicePixelRatio observed: ${dprs.join(', ') || 'n/a'}`)
console.log('')

// Criterion 9: what the transport actually did, read off the wire, not inferred
// from the markup. Byte volumes come from Content-Length because
// PerformanceResourceTiming.transferSize is structurally 0 for these requests:
// the renderer is a file:// document, so every fetch is cross-origin and Aliyun
// OSS sends no Timing-Allow-Origin.
const network = report.network ?? []
const media = network.filter((row) => row.resourceType === 'media')
const images = network.filter((row) => row.resourceType === 'image')
const partial = network.filter((row) => row.status === 206)
const ranged = network.filter((row) => row.range !== '')
console.log('network evidence (from response headers)')
console.log(`  media responses observed: ${media.length}`)
console.log(`  image responses observed: ${images.length}`)
console.log(`  HTTP 206 responses: ${partial.length}`)
console.log(`  requests with a Range header: ${ranged.length}`)
if (ranged.length > 0) {
  const distinct = [...new Set(ranged.map((row) => row.range))]
  console.log(`  distinct Range request headers: ${distinct.join(' | ')}`)
}
const contentRanges = [...new Set(partial.map((row) => row.contentRange).filter(Boolean))]
if (contentRanges.length > 0) {
  console.log(`  transferred byte ranges (Content-Range), ${contentRanges.length} distinct:`)
  for (const range of contentRanges.slice(0, 8)) console.log(`    ${range}`)
}

const byOrigin = new Map()
for (const row of network) {
  const key = `${row.origin} [${row.resourceType}]`
  const aggregate = byOrigin.get(key) ?? { count: 0, bytes: 0, statuses: new Set() }
  aggregate.count += 1
  aggregate.bytes += row.contentLength
  aggregate.statuses.add(row.status)
  byOrigin.set(key, aggregate)
}
for (const [key, row] of byOrigin) {
  console.log(
    `  ${key}: ${row.count} responses, ${row.bytes} bytes, status ${[...row.statuses].join('/')}`
  )
}

// Criterion 3 wants the real topology. A run whose media never left the machine
// measured something else, however green its numbers look.
const ossOrigins = [...new Set(network.map((row) => row.origin))].filter((origin) =>
  origin.includes('.aliyuncs.com')
)
if (ossOrigins.length === 0) {
  console.log('  FAIL  no Aliyun OSS origin observed — this was not the real OSS path')
  failed = true
} else {
  console.log(`  real Object Storage origin exercised: ${ossOrigins.join(', ')}`)
}
console.log('')

console.log('SLO verdicts')
for (const [phase, target] of Object.entries(TARGETS)) {
  const values = samples[phase]
  if (values.length === 0) {
    console.log(`  FAIL  ${phase.padEnd(20)} no samples`)
    failed = true
    continue
  }
  const p75 = percentile(values, 0.75)
  const p95 = percentile(values, 0.95)
  const ok75 = target.p75 === undefined || p75 <= target.p75
  const ok95 = target.p95 === undefined || p95 <= target.p95
  if (!ok75 || !ok95) failed = true
  const budget = [
    target.p75 === undefined ? null : `p75 <= ${target.p75}ms`,
    target.p95 === undefined ? null : `p95 <= ${target.p95}ms`
  ]
    .filter(Boolean)
    .join(', ')
  console.log(
    `  ${ok75 && ok95 ? 'PASS' : 'FAIL'}  ${phase.padEnd(20)} n=${String(values.length).padEnd(4)} p75 ${ms(p75).padStart(7)}  p95 ${ms(p95).padStart(7)}   (${budget})`
  )
}

console.log('')
if (failures.length > 0) {
  failed = true
  console.log(`media-load failures: ${failures.length}`)
  for (const failure of failures.slice(0, 20)) {
    console.log(`  ${failure.mode} ${failure.route} ${failure.phase}: ${failure.kind}`)
  }
} else {
  console.log('media-load failures: 0')
}

// Criterion 3: the sample has to be large enough to mean anything.
if (coldCount < 30 || warmCount < 30) {
  console.log(`FAIL  sample size: cold ${coldCount}/30, warm ${warmCount}/30`)
  failed = true
}

process.exit(failed ? 1 : 0)
