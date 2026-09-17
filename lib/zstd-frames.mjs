/**
 * Frame-safe primitives for DSH session logs, shared by the standalone engine
 * (`dsh-workspace-migrate.mjs`) and the in-process live-move path (`live-move.mjs`).
 *
 * Why this is one module and not two copies: the frame-0 invariant is the single most
 * dangerous thing this project touches. DSH asserts at boot that frame 0 of
 * `session*.jsonl.zstd` decompresses to EXACTLY one header line ending in `\n`
 * (`dsh-session-persistence-jsonl`: `assertZstdHeaderFrame`). A whole-file
 * decompress→edit→recompress collapses the multi-frame stream into one frame and makes
 * `dsh web` abort at startup. The live path cannot shell out to the engine, because the
 * relocation has to be interleaved with a live writer on the same event loop, so both
 * callers must share this implementation rather than grow a second one.
 *
 * Frame splitting parses the Zstandard frame/block grammar (RFC 8878 §3) instead of
 * scanning for the magic bytes, so compressed payload that happens to contain
 * `28 B5 2F FD` can never split a frame.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

/**
 * Exact length of one Zstandard frame at `off`, computed from the frame header and the
 * block headers.
 * @param buf - buffer holding the stream.
 * @param off - byte offset of the frame's magic number.
 * @returns the frame's byte length.
 */
export function zstdFrameLength(buf, off) {
  if (off + 4 > buf.length) throw new Error(`truncated frame header at ${off}`)
  if (buf.readUInt32LE(off) !== ZSTD_MAGIC) throw new Error(`no zstd magic at offset ${off}`)
  let p = off + 4
  if (p >= buf.length) throw new Error(`truncated frame header at ${off}`)
  const fhd = buf[p++]
  if (fhd & 0x08) throw new Error(`reserved frame-header bit set at ${off}`)
  const fcsFlag = (fhd >> 6) & 3
  const singleSegment = (fhd >> 5) & 1
  const contentChecksum = (fhd >> 2) & 1
  const dictIdFlag = fhd & 3
  if (!singleSegment) p += 1 // Window_Descriptor
  p += [0, 1, 2, 4][dictIdFlag] // Dictionary_ID
  p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag] // Frame_Content_Size
  for (;;) {
    if (p + 3 > buf.length) throw new Error(`truncated block header at ${p}`)
    const blockHeader = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    const lastBlock = blockHeader & 1
    const blockType = (blockHeader >> 1) & 3
    const blockSize = (blockHeader >> 3) & 0x1fffff
    p += 3
    if (blockType === 3) throw new Error(`reserved block type at ${p - 3}`)
    p += blockType === 1 ? 1 : blockSize // RLE blocks carry one byte
    if (lastBlock) break
    if (p > buf.length) throw new Error('truncated frame body')
  }
  if (contentChecksum) p += 4
  if (p > buf.length) throw new Error('truncated frame checksum')
  return p - off
}

/**
 * Split a concatenated zstd stream into its frames.
 * @param buf - the whole file.
 * @returns one Buffer per frame, in order.
 */
export function splitFrames(buf) {
  const frames = []
  let off = 0
  while (off < buf.length) {
    const len = zstdFrameLength(buf, off)
    frames.push(buf.subarray(off, off + len))
    off += len
  }
  if (off !== buf.length) throw new Error(`frame coverage mismatch: ${off} != ${buf.length}`)
  return frames
}

/** Decoded text of frame 0, asserting the DSH boot invariant. */
export function readHeaderFrameText(frames, file) {
  const text = zlib.zstdDecompressSync(frames[0]).toString('utf8')
  const onlyNewlineIsLast = text.length > 0 && text.indexOf('\n') === text.length - 1
  if (!onlyNewlineIsLast) {
    throw new Error(`corrupt session log (first frame is not exactly one header line): ${file}`)
  }
  return text
}

/** Parse a session log's header record (frame 0) without touching the rest of the file. */
export function readSessionHeader(file) {
  const frames = splitFrames(fs.readFileSync(file))
  const text = readHeaderFrameText(frames, file)
  const header = JSON.parse(text.slice(0, -1))
  return { header, frameCount: frames.length, bytes: fs.statSync(file).size }
}

/** Write a file atomically: fully write a sibling temp file, then rename over the target. */
export function atomicWrite(file, data) {
  const tmp = `${file}.migrate-tmp-${process.pid}`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

/**
 * Re-encode a session log's frame 0 with a new `cwd`, leaving every later frame
 * byte-identical. Pure: nothing is written.
 *
 * The edit is a verified textual splice, and the surviving bytes are proven to round-trip
 * to the original header with exactly one field changed.
 * @param original - the whole current file.
 * @param newCwd - the header's new `cwd`.
 * @param file - path used for error messages.
 * @returns `{ out, changed, previousCwd, frameCount }`.
 */
export function rebuildHeaderFrame(original, newCwd, file) {
  const frames = splitFrames(original)
  const text = readHeaderFrameText(frames, file)
  const line = text.slice(0, -1)
  const before = JSON.parse(line)
  if (typeof before.cwd !== 'string') throw new Error(`session header has no cwd: ${file}`)
  const previousCwd = before.cwd
  if (previousCwd === newCwd) {
    return { out: original, changed: false, previousCwd, frameCount: frames.length }
  }

  const cwdPattern = /("cwd"\s*:\s*)"(?:[^"\\]|\\.)*"/
  const matches = line.match(new RegExp(cwdPattern, 'g'))
  if (matches === null || matches.length !== 1) {
    throw new Error(`expected exactly one "cwd" field in the header of ${file}, found ${matches === null ? 0 : matches.length}`)
  }
  const rewrittenLine = line.replace(cwdPattern, `$1${JSON.stringify(newCwd)}`)

  // Prove the splice is minimal: same object except cwd, same key order.
  const after = JSON.parse(rewrittenLine)
  const beforeKeys = Object.keys(before)
  const afterKeys = Object.keys(after)
  if (beforeKeys.length !== afterKeys.length || beforeKeys.some((key, index) => key !== afterKeys[index])) {
    throw new Error(`header key set/order changed while rewriting ${file}`)
  }
  for (const key of beforeKeys) {
    if (key === 'cwd') continue
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      throw new Error(`header field "${key}" changed unexpectedly while rewriting ${file}`)
    }
  }
  if (after.cwd !== newCwd) throw new Error(`cwd rewrite verification failed for ${file}`)

  const headerFrame = zlib.zstdCompressSync(Buffer.from(`${rewrittenLine}\n`, 'utf8'))
  const out = Buffer.concat([headerFrame, ...frames.slice(1)])

  // Re-read the produced bytes through the same parser DSH uses.
  const check = splitFrames(out)
  const checkText = readHeaderFrameText(check, file)
  if (JSON.parse(checkText.slice(0, -1)).cwd !== newCwd) {
    throw new Error(`rewritten log failed its own header check: ${file}`)
  }
  if (check.length !== frames.length) {
    throw new Error(`frame count changed (${frames.length} -> ${check.length}) for ${file}`)
  }
  return { out, changed: true, previousCwd, frameCount: frames.length }
}

/**
 * Rewrite a session log's header `cwd` in place.
 * @returns `{ file, changed, previousCwd, frameCount, bytes }`.
 */
export function rewriteHeaderCwd(file, newCwd) {
  const rebuilt = rebuildHeaderFrame(fs.readFileSync(file), newCwd, file)
  if (rebuilt.changed) atomicWrite(file, rebuilt.out)
  return { file, changed: rebuilt.changed, previousCwd: rebuilt.previousCwd, frameCount: rebuilt.frameCount, bytes: rebuilt.out.length }
}

/**
 * Move one session log to a new location while rewriting its header `cwd`.
 *
 * The order is chosen so a failure can never leave the session id present at two paths
 * (DSH refuses to load a duplicated JSONL session id): the new file is published under a
 * temp name, the old file is hidden, and only then is the temp renamed into place. Any
 * failure unwinds to the original bytes.
 * @param fromFile - the current artifact path.
 * @param toFile - the destination artifact path.
 * @param newCwd - the header's new `cwd`.
 * @returns `{ changed, previousCwd, frameCount, bytes, fromFile, toFile }`.
 */
export function relocateSessionLog(fromFile, toFile, newCwd) {
  const original = fs.readFileSync(fromFile)
  const rebuilt = rebuildHeaderFrame(original, newCwd, fromFile)
  if (path.resolve(fromFile) === path.resolve(toFile)) {
    if (rebuilt.changed) atomicWrite(fromFile, rebuilt.out)
    return { changed: rebuilt.changed, previousCwd: rebuilt.previousCwd, frameCount: rebuilt.frameCount, bytes: rebuilt.out.length, fromFile, toFile }
  }

  fs.mkdirSync(path.dirname(toFile), { recursive: true })
  const tempNew = `${toFile}.migrate-new-${process.pid}`
  const hiddenOld = `${fromFile}.migrate-old-${process.pid}`
  fs.writeFileSync(tempNew, rebuilt.out)
  try {
    fs.renameSync(fromFile, hiddenOld)
  } catch (error) {
    fs.rmSync(tempNew, { force: true })
    throw new Error(`could not hide the old session artifact, nothing was changed: ${String((error && error.message) || error)}`)
  }
  try {
    fs.renameSync(tempNew, toFile)
  } catch (error) {
    try {
      fs.renameSync(hiddenOld, fromFile)
    } catch {
      /* reported below */
    }
    fs.rmSync(tempNew, { force: true })
    throw new Error(`could not publish the relocated session artifact, the original was restored: ${String((error && error.message) || error)}`)
  }
  fs.rmSync(hiddenOld, { force: true })
  return { changed: rebuilt.changed, previousCwd: rebuilt.previousCwd, frameCount: rebuilt.frameCount, bytes: rebuilt.out.length, fromFile, toFile }
}

// ─────────────────────────────────────────────────────────────────────────────
// DSH path grammar (mirrors dsh-session-persistence-jsonl exactly)
// ─────────────────────────────────────────────────────────────────────────────

/** Encode one arbitrary string as a single safe path segment (mirrors `encodeSegment`). */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/** Build the project directory key for a cwd (mirrors `projectKey`, including 251 truncation). */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** Generation-log filename for a format version (v0 has no version component). */
export function generationLogFilename(version, compression = 'zstd') {
  const suffix = compression === 'zstd' ? '.zstd' : ''
  return `${version === 0 ? 'session' : `session.v${version}`}.jsonl${suffix}`
}

/** Parse a canonical generation-log filename, or undefined when it is not one. */
export function parseGenerationLogFilename(filename) {
  if (!filename.endsWith('.jsonl.zstd')) return undefined
  const stem = filename.slice(0, -'.jsonl.zstd'.length)
  if (stem === 'session') return 0
  const match = /^session\.v([1-9][0-9]*)$/.exec(stem)
  return match === undefined || match === null ? undefined : Number(match[1])
}

/** Case-insensitive path equality on Windows; exact elsewhere. */
export function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = path.resolve(a)
  const right = path.resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Drop a trailing separator and resolve `.`/`..` without requiring existence. */
export function normalizeCwd(p) {
  let out = path.resolve(p)
  if (out.length > 3 && out.endsWith(path.sep)) out = out.slice(0, -1)
  return out
}

/** Realpath when it exists; otherwise a normalized absolute path (used for display only). */
export function realpathOrSelf(p) {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}
