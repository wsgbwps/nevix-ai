// Reads an ISO-BMFF/MP4 file's box layout so issue #292 criterion 10 can attribute
// a video long tail to file layout instead of guessing from the `.mp4` extension:
// whether `moov` is front-loaded (fast-start) or trails `mdat`, and which codecs
// the sample descriptions actually declare.
//
// A trailing `moov` costs the player an extra tail read before metadata resolves,
// which is invisible in markup and visible in `loadedmetadata` latency.
//
//   node apps/desktop/scripts/media-wall-benchmark/inspect-mp4.mjs <file.mp4>
//
// This reports on a file from a shell, so it must run directly in Node without a
// TypeScript runtime.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFileSync } from 'node:fs'

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex', 'moof', 'traf'])

/**
 * Walks sibling boxes in [start, end). Each record carries `header` (8, or 16 for
 * a 64-bit size) because every caller needs the payload offset, which is
 * `start + header` and not `start + 8`.
 */
function boxes(buffer, start, end) {
  const found = []
  let offset = start
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    let header = 8
    if (size === 1) {
      if (offset + 16 > end) break
      size = Number(buffer.readBigUInt64BE(offset + 8))
      header = 16
    } else if (size === 0) {
      size = end - offset
    }
    if (size < header || offset + size > end) break
    found.push({ type, start: offset, size, header })
    offset += size
  }
  return found
}

/** Collects the sample-entry fourccs under every `stsd` in the tree. */
function sampleEntries(buffer, box, out) {
  if (box.type === 'stsd') {
    // version/flags (4) + entry_count (4), then sample entries.
    const entriesStart = box.start + box.header + 8
    const count = buffer.readUInt32BE(box.start + box.header + 4)
    for (const entry of boxes(buffer, entriesStart, box.start + box.size).slice(0, count)) {
      out.push(entry.type)
    }
    return
  }
  if (!CONTAINERS.has(box.type)) return
  for (const child of boxes(buffer, box.start + box.header, box.start + box.size)) {
    sampleEntries(buffer, child, out)
  }
}

const path = process.argv[2]
if (!path) {
  console.error('usage: inspect-mp4.mjs <file.mp4>')
  process.exit(2)
}

const buffer = readFileSync(path)
const top = boxes(buffer, 0, buffer.length)
const moov = top.find((box) => box.type === 'moov')
const mdat = top.find((box) => box.type === 'mdat')
const ftyp = top.find((box) => box.type === 'ftyp')

const codecs = []
if (moov !== undefined) sampleEntries(buffer, moov, codecs)

const result = {
  file: path,
  byteSize: buffer.length,
  topLevel: top.map((box) => `${box.type}@${box.start}(${box.size})`),
  brand: ftyp !== undefined ? buffer.toString('latin1', ftyp.start + 8, ftyp.start + 12) : null,
  moovOffset: moov?.start ?? null,
  mdatOffset: mdat?.start ?? null,
  // The durable statement is the ordering, not a ratio.
  moovPlacement:
    moov === undefined
      ? 'absent'
      : mdat !== undefined && moov.start < mdat.start
        ? 'front-loaded'
        : 'trailing',
  sampleEntries: [...new Set(codecs)]
}

console.log(JSON.stringify(result, null, 2))

// Criterion 10 only asks that the asset be inspected; a `moov`-less file is the
// one layout that makes the check meaningless.
process.exit(moov === undefined ? 1 : 0)
