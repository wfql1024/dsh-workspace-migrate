// Read-only probe: validate exact zstd frame parsing against real DSH session logs.
import fs from 'node:fs'
import zlib from 'node:zlib'

const MAGIC = 0xfd2fb528

// Exact frame length via the zstd frame/block header grammar (no magic-byte scanning).
function frameLength(buf, off) {
  if (buf.readUInt32LE(off) !== MAGIC) throw new Error(`no zstd magic at ${off}`)
  let p = off + 4
  const fhd = buf[p++]
  const fcsFlag = (fhd >> 6) & 3
  const singleSegment = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  const didFlag = fhd & 3
  if (fhd & 0x08) throw new Error('reserved frame header bit set')
  if (!singleSegment) p += 1 // Window_Descriptor
  p += [0, 1, 2, 4][didFlag]
  const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
  p += fcsSize
  for (;;) {
    const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) // 3-byte LE block header
    const last = bh & 1
    const type = (bh >> 1) & 3
    const size = (bh >> 3) & 0x1fffff
    p += 3
    if (type === 3) throw new Error('reserved block type')
    p += type === 1 ? 1 : size
    if (last) break
  }
  if (checksum) p += 4
  return p - off
}

function splitFrames(buf) {
  const out = []
  let off = 0
  while (off < buf.length) {
    const len = frameLength(buf, off)
    out.push(buf.subarray(off, off + len))
    off += len
  }
  if (off !== buf.length) throw new Error(`trailing bytes: ${off} != ${buf.length}`)
  return out
}

for (const file of process.argv.slice(2)) {
  const buf = fs.readFileSync(file)
  const frames = splitFrames(buf)
  const first = zlib.zstdDecompressSync(frames[0]).toString('utf8')
  const lines = first.split('\n')
  console.log(`\n=== ${file}`)
  console.log(`bytes=${buf.length} frames=${frames.length}`)
  console.log(`frame0 bytes=${frames[0].length} decompressed=${first.length}`)
  console.log(`frame0 endsWithNL=${first.endsWith('\n')} frame0LineCount=${lines.length}`)
  console.log(`frame0 raw=${JSON.stringify(first.length > 400 ? first.slice(0, 400) : first)}`)
  const covered = frames.reduce((a, f) => a + f.length, 0)
  console.log(`frameCoverage=${covered === buf.length ? 'EXACT' : 'MISMATCH'}`)
  if (lines.length > 2) console.log('  !! frame 0 has more than one line')
}
