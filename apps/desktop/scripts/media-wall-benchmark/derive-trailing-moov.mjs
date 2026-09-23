// Derives a trailing-moov twin of an MP4, so the claim that `inspect-mp4.mjs`
// can tell the two layouts apart is checkable rather than asserted. It exists to
// prove the criterion-10 checker is not a rubber stamp: if it reported
// "front-loaded" for every input, the check on the real asset would mean nothing.
//
//   node apps/desktop/scripts/media-wall-benchmark/derive-trailing-moov.mjs <in.mp4> <out.mp4>
//
// Reordering the top-level boxes moves `mdat`, and every absolute chunk offset in
// `stco` points into it, so those offsets are rewritten by the same delta. Without
// that the file still parses but plays nothing.
//
// This runs directly in Node without a TypeScript runtime.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFileSync, writeFileSync } from 'node:fs'

function boxes(buffer, start, end) {
  const found = []
  let offset = start
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    let header = 8
    if (size === 1) {
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

const [source, destination] = process.argv.slice(2)
if (!source || !destination) {
  console.error('usage: derive-trailing-moov.mjs <in.mp4> <out.mp4>')
  process.exit(2)
}
const buffer = readFileSync(source)

const top = boxes(buffer, 0, buffer.length)
const ftyp = top.find((box) => box.type === 'ftyp')
const free = top.find((box) => box.type === 'free')
const moov = top.find((box) => box.type === 'moov')
const mdat = top.find((box) => box.type === 'mdat')
if (!ftyp || !moov || !mdat) throw new Error('input does not have the expected top-level boxes')

const rebuilt = [ftyp, free, mdat, moov].filter(Boolean)
const pieces = rebuilt.map((box) => buffer.subarray(box.start, box.start + box.size))
const result = Buffer.concat(pieces)
if (result.length !== buffer.length) throw new Error('reorder changed the file size')

const newMdatStart = pieces
  .slice(0, rebuilt.indexOf(mdat))
  .reduce((sum, piece) => sum + piece.length, 0)
const delta = newMdatStart - mdat.start
console.log(`mdat moved ${mdat.start} -> ${newMdatStart} (delta ${delta})`)

if (delta !== 0) {
  const moovStart = newMdatStart + mdat.size
  const stco = result.indexOf(Buffer.from('stco', 'latin1'), moovStart)
  if (stco === -1) throw new Error('no stco box found in moov')
  if (result.indexOf(Buffer.from('co64', 'latin1'), moovStart) !== -1) {
    throw new Error('input uses co64; this tool only rewrites stco')
  }
  const boxStart = stco - 4
  const count = result.readUInt32BE(boxStart + 12)
  console.log(`rewriting ${count} stco entries by ${delta}`)
  for (let index = 0; index < count; index += 1) {
    const at = boxStart + 16 + index * 4
    result.writeUInt32BE(result.readUInt32BE(at) + delta, at)
  }
}

writeFileSync(destination, result)
console.log(`wrote ${destination} (${result.length} bytes)`)
