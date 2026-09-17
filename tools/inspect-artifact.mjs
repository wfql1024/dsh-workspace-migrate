// Read one session artifact exactly the way the plugin's engine does: split frames by the
// RFC 8878 grammar, inflate only frame 0, and report the header line plus frame count.
import fs from 'node:fs'
import zlib from 'node:zlib'
import { splitFrames } from '../lib/zstd-frames.mjs'

const file = process.argv[2]
const frames = splitFrames(fs.readFileSync(file))
const head = zlib.zstdDecompressSync(frames[0])
const text = head.toString('utf8')
console.log(
  JSON.stringify(
    {
      file,
      frameCount: frames.length,
      // The host's own assertion, byte-for-byte: dsh-session-persistence-jsonl/lib/index.js:2185
      frame0IsExactlyOneHeaderLine: head.length > 0 && head.indexOf(10) === head.length - 1,
      header: JSON.parse(text.slice(0, -1)),
      frame0Bytes: frames[0].length,
    },
    null,
    2,
  ),
)
