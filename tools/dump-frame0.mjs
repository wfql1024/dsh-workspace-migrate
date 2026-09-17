import fs from 'node:fs'
import zlib from 'node:zlib'
import { splitFrames } from '../lib/zstd-frames.mjs'
const file = process.argv[2]
const frames = splitFrames(fs.readFileSync(file))
const head = zlib.zstdDecompressSync(frames[0])
const text = head.toString('utf8')
console.log('frames', frames.length, 'frame0 length', head.length)
console.log('last 6 bytes', [...head.slice(-6)])
console.log('first 20 chars', JSON.stringify(text.slice(0, 20)))
console.log('newline count', (text.match(/\n/g) || []).length)
console.log('endsWith newline', text.endsWith('\n'))
