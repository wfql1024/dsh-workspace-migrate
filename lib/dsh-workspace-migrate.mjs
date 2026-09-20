#!/usr/bin/env node
/**
 * dsh-workspace-migrate — re-home a DSH workspace (project directory move) so that
 * existing sessions keep their history and stay grouped under the workspace.
 *
 * Why an external script: a migration mutates `$DSH_HOME/sessions/<projectKey>` and the
 * storage metadata that a RUNNING DSH holds in memory and checkpoints back to disk. So
 * the mutation must happen in the window where DSH is stopped. `dsh web` re-reads
 * everything from disk on the next start, which is why exactly one restart is needed.
 *
 * Safety model
 *   - plan    : read-only. Produces a machine-readable plan and a staged runner.
 *   - apply   : backup first, then mutate; auto-rollback on failure.
 *   - verify  : read-only invariant check (safe to run while DSH is up or down).
 *   - rollback: restore the backup and reverse the moves (idempotent).
 *
 * Frame safety: `session*.jsonl.zstd` is a multi-frame Zstandard stream and DSH asserts at
 * boot that frame 0 decompresses to EXACTLY one header line ending in `\n`
 * (`assertZstdHeaderFrame`). This tool therefore recompresses frame 0 only and copies every
 * later frame byte-for-byte. A whole-file recompress would collapse the stream into one
 * frame and make `dsh web` abort at startup.
 *
 * MIT. Node >= 24 (native `zlib.zstd*`).
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'

import {
  atomicWrite,
  encodeSegment,
  generationLogFilename,
  normalizeCwd,
  parseGenerationLogFilename,
  projectKey,
  readHeaderFrameText,
  readSessionHeader,
  realpathOrSelf,
  relocateSessionLog,
  rewriteHeaderCwd,
  samePath,
  splitFrames,
  zstdFrameLength,
} from './zstd-frames.mjs'
const TOOL = 'dsh-workspace-migrate'
const VERSION = '1.0.0'
const SESSION_LOCK = 'session.lock'


// ─────────────────────────────────────────────────────────────────────────────
// small utilities
// ─────────────────────────────────────────────────────────────────────────────

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8')
  return { value: JSON.parse(raw), trailingNewline: raw.endsWith('\n') }
}

function writeJsonPreservingStyle(file, value, trailingNewline) {
  atomicWrite(file, JSON.stringify(value, null, 2) + (trailingNewline ? '\n' : ''))
}

/** Every leaf-level difference between two JSON values, as `[jsonPath, before, after]`. */
function diffLeafPaths(before, after, prefix = '') {
  const out = []
  const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
  if (isObj(before) && isObj(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    for (const key of keys) {
      out.push(...diffLeafPaths(before[key], after[key], `${prefix}/${key}`))
    }
    return out
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const max = Math.max(before.length, after.length)
    for (let i = 0; i < max; i++) out.push(...diffLeafPaths(before[i], after[i], `${prefix}/${i}`))
    return out
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) out.push([prefix || '/', before, after])
  return out
}

/** All JSON leaf paths whose string value equals `needle`. */
function findPathValues(node, needle, prefix = '') {
  const out = []
  if (typeof node === 'string') {
    if (node === needle) out.push(prefix)
    return out
  }
  if (Array.isArray(node)) {
    node.forEach((child, i) => out.push(...findPathValues(child, needle, `${prefix}/${i}`)))
    return out
  }
  if (typeof node === 'object' && node !== null) {
    for (const [key, child] of Object.entries(node)) {
      out.push(...findPathValues(child, needle, `${prefix}/${key}`))
    }
  }
  return out
}

/** Read the value at a `/a/b/c` path. */
function getAtPath(root, jsonPath) {
  return jsonPath
    .split('/')
    .filter((part) => part.length > 0)
    .reduce((acc, part) => (acc === undefined || acc === null ? acc : acc[part]), root)
}

/** Set the value at a `/a/b/c` path, creating containers only where the path already exists. */
function setAtPath(root, jsonPath, value) {
  const parts = jsonPath.split('/').filter((part) => part.length > 0)
  if (parts.length === 0) throw new Error('refusing to replace a whole JSON document')
  let cursor = root
  for (let i = 0; i < parts.length - 1; i++) {
    if (cursor[parts[i]] === undefined || cursor[parts[i]] === null) cursor[parts[i]] = {}
    cursor = cursor[parts[i]]
  }
  if (cursor[parts[parts.length - 1]] === undefined) {
    throw new Error(`refusing to create a missing JSON field at ${jsonPath}`)
  }
  cursor[parts[parts.length - 1]] = value
}

function walkFiles(root, options = {}) {
  const { skipDirNames = new Set(), maxBytes = 32 * 1024 * 1024, maxFiles = 20000 } = options
  const out = []
  const skipped = []
  const stack = [root]
  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (skipDirNames.has(entry.name)) continue
        stack.push(full)
      } else if (entry.isFile()) {
        let size = 0
        try {
          size = fs.statSync(full).size
        } catch {
          continue
        }
        if (size > maxBytes) {
          skipped.push({ file: full, reason: `larger than ${maxBytes} bytes` })
          continue
        }
        out.push(full)
      }
    }
  }
  return { files: out, skipped }
}

// ─────────────────────────────────────────────────────────────────────────────
// environment / preflight
// ─────────────────────────────────────────────────────────────────────────────

function resolveEnv(opts) {
  const dshHome = path.resolve(
    opts['dsh-home'] ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
  )
  const sessionsRoot = path.resolve(opts['sessions-root'] ?? path.join(dshHome, 'sessions'))
  const storagesRoot = path.resolve(opts['storages-root'] ?? path.join(dshHome, 'storages'))
  const backupRoot = path.resolve(opts['backup-dir'] ?? path.join(dshHome, 'migration-backups'))
  const runRoot = path.resolve(opts['run-dir'] ?? path.join(dshHome, 'migration-runs'))
  return { dshHome, sessionsRoot, storagesRoot, backupRoot, runRoot }
}

/**
 * Where a displaced destination tree is parked: the user's Desktop, as agreed with the UI.
 *
 * The Windows Desktop can be redirected into OneDrive or keep a localized folder name, so every
 * candidate is checked and the first that exists wins.
 */
function desktopRoot() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir()
  const candidates = [
    path.join(home, 'Desktop'),
    path.join(home, 'OneDrive', 'Desktop'),
    path.join(home, '桌面'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return candidates[0]
}

/** A fresh Desktop directory to park a displaced destination tree in. */
function desktopBackupDir(label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const slug = String(label).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) || 'workspace'
  return path.join(desktopRoot(), `dsh-workspace-migrate-backup-${stamp}-${slug}`)
}

/**
 * Is something still listening on the origin DSH was serving when the plan was written?
 *
 * This is the check that does not depend on reading another process's command line: a plan made
 * while DSH was up records `running.origin`, and if that port still answers then DSH is still up —
 * including on machines where the process probe finds nothing, which is exactly how a manual
 * migration once ran under a live DSH and lost its result to the next checkpoint.
 */
function probeWebOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0) return { checked: false, listening: false, origin }
  const separator = origin.lastIndexOf(':')
  if (separator <= 0) return { checked: false, listening: false, origin }
  const host = origin.slice(0, separator)
  const port = Number(origin.slice(separator + 1))
  if (host.length === 0 || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return { checked: false, listening: false, origin }
  }
  const script = [
    "const net=require('node:net')",
    'const socket=net.connect({host:process.argv[1],port:Number(process.argv[2])})',
    "const done=(up)=>{process.stdout.write(up?'up':'down');socket.destroy();process.exit(0)}",
    'socket.setTimeout(1200)',
    "socket.on('connect',()=>done(true))",
    "socket.on('timeout',()=>done(false))",
    "socket.on('error',()=>done(false))",
  ].join(';')
  const result = spawnSync(process.execPath, ['-e', script, host, String(port)], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 8000,
  })
  const status = result.status === null || result.status === undefined ? -1 : result.status
  if (status !== 0 || typeof result.stdout !== 'string') return { checked: false, listening: false, origin }
  return { checked: true, listening: result.stdout.trim() === 'up', origin }
}

/**
 * Detect a live DSH process. Returns the matching command lines (may be empty).
 *
 * The probe is retried once: a transient WMI/PowerShell failure must not read as "no DSH is
 * running", because the caller's guard treats an answer it cannot get as a refusal.
 */
function detectDshProcesses() {
  const first = probeDshProcesses()
  if (first.checked) return first
  return probeDshProcesses()
}

function probeDshProcesses() {
  if (process.platform !== 'win32') {
    const r = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', windowsHide: true })
    if (r.status !== 0 || typeof r.stdout !== 'string') return { checked: false, matches: [] }
    const matches = r.stdout
      .split('\n')
      .filter((line) => /@deepseek-ai[\\/]dsh|dsh[\\/](lib|bin)|dsh-cli|\bdsh(\.cmd|\.js)?["'\s]+(web|plugin|run)\b/i.test(line))
      .filter((line) => !line.includes('dsh-workspace-migrate'))
      .map((line) => line.trim())
    return { checked: true, matches, selfPid: process.pid }
  }
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match '@deepseek-ai[\\\\/]dsh|dsh[\\\\/](lib|bin)|dsh-cli|dsh(\\.cmd|\\.js)?\\"?\\s+(web|plugin|run)' -and $_.ProcessId -ne ${process.pid} -and $_.CommandLine -notmatch 'dsh-workspace-migrate' } | Select-Object -ExpandProperty CommandLine`,
  ].join('; ')
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 },
  )
  if (r.status !== 0 || typeof r.stdout !== 'string') return { checked: false, matches: [] }
  const matches = r.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return { checked: true, matches, selfPid: process.pid }
}

/** Every `session.lock` lease file under the sessions root (a live write lease). */
function findSessionLocks(sessionsRoot) {
  if (!fs.existsSync(sessionsRoot)) return []
  const { files } = walkFiles(sessionsRoot, { maxBytes: Number.POSITIVE_INFINITY })
  return files.filter((file) => path.basename(file) === SESSION_LOCK)
}

/**
 * The invariant DSH itself enforces on load (`assertStoredIdentity`): every session
 * directory must live under the project key derived from its own header cwd. A violation
 * means DSH will refuse the log or silently drop the session out of its workspace.
 *
 * Violations are split by whether this migration is responsible for them. A pre-existing
 * violation elsewhere in the store must never fail — and thereby auto-roll-back — an
 * otherwise correct migration.
 */
function auditSessionPlacement(sessionsRoot, migratedIds = new Set()) {
  const violations = []
  let scanned = 0
  if (!fs.existsSync(sessionsRoot)) return { violations, scanned }
  for (const projectEntry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue
    const projectDir = path.join(sessionsRoot, projectEntry.name)
    for (const sessionEntry of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (!sessionEntry.isDirectory()) continue
      scanned++
      const dir = path.join(projectDir, sessionEntry.name)
      let info
      try {
        info = inspectSessionDir(dir)
      } catch (error) {
        violations.push({ dir, related: migratedIds.has(sessionEntry.name), problem: `unreadable: ${String(error?.message ?? error)}` })
        continue
      }
      if (info.generations.length === 0) continue
      const expectedKey = info.cwd === undefined ? '_no-cwd' : projectKey(info.cwd)
      if (expectedKey !== projectEntry.name) {
        violations.push({
          dir,
          related: migratedIds.has(sessionEntry.name),
          problem: `header cwd "${info.cwd}" derives project key ${expectedKey}, but the directory is ${projectEntry.name}`,
        })
      }
    }
  }
  return { violations, scanned }
}

/** Session directories under `sessions/<projectKey>`. */
function listSessionDirs(sessionsRoot, key) {
  const dir = path.join(sessionsRoot, key)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name))
    .sort()
}

/** Classify one session directory by its generation logs. */
function inspectSessionDir(dir) {
  const id = path.basename(dir)
  const generations = []
  for (const name of fs.readdirSync(dir).sort()) {
    const version = parseGenerationLogFilename(name)
    if (version === undefined) continue
    const file = path.join(dir, name)
    const info = readSessionHeader(file)
    generations.push({
      file,
      name,
      version,
      cwd: info.header.cwd,
      sessionId: info.header.id,
      frameCount: info.frameCount,
      bytes: info.bytes,
    })
  }
  generations.sort((a, b) => a.version - b.version)
  const authoritative = generations.length > 0 ? generations[generations.length - 1] : undefined
  return { id, dir, generations, authoritative, headerId: authoritative?.sessionId, cwd: authoritative?.cwd }
}

/** Discover every JSON document under the storage roots that contains the old path. */
function scanMetadata(env, oldCwd) {
  const patches = []
  const scanned = []
  const skipped = []
  const roots = [env.storagesRoot]
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    const walked = walkFiles(root, { skipDirNames: new Set(['node_modules', '.git']) })
    skipped.push(...walked.skipped)
    for (const file of walked.files) {
      if (!file.toLowerCase().endsWith('.json')) continue
      let value
      try {
        value = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        continue
      }
      scanned.push(file)
      for (const jsonPath of findPathValues(value, oldCwd)) {
        patches.push({ file, jsonPath, from: oldCwd })
      }
    }
  }
  return { patches, scannedCount: scanned.length, scanned, skipped }
}

/**
 * Workspace records in `workspace.json` that claim one path.
 *
 * DSH refuses to boot when two records claim the same path — "path ... is claimed by both
 * workspace A and B" — so a patch that re-points a record onto an already-claimed path leaves
 * the store unbootable. Returns `[]` when the file, the table, or the path is absent.
 */
function workspaceClaims(env, cwd) {
  const file = path.join(env.storagesRoot, 'workspace.json')
  if (!fs.existsSync(file)) return []
  let value
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  const table = value?.tables?.workspaces
  if (table === undefined || table === null || typeof table !== 'object') return []
  const claims = []
  for (const [id, workspace] of Object.entries(table)) {
    if (workspace === null || typeof workspace !== 'object') continue
    if (!samePath(workspace.path, cwd)) continue
    claims.push({
      id,
      path: typeof workspace.path === 'string' ? workspace.path : cwd,
      title: typeof workspace.title === 'string' ? workspace.title : undefined,
      sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [],
    })
  }
  return claims
}

/**
 * Which session a metadata patch belongs to, or `undefined` when the patch is not
 * session-scoped. Session-scoped patches must follow only the sessions that actually
 * move: rewriting a staying session's cached `cwd` would strand it under a workspace
 * it no longer belongs to.
 */
function patchSessionId(patch) {
  const inAggregate = /\/tables\/sessions\/([^/]+)\//.exec(patch.jsonPath)
  if (inAggregate !== null) return inAggregate[1]
  const base = path.basename(patch.file)
  if (base.endsWith('.json')) {
    const candidate = base.slice(0, -'.json'.length)
    if (candidate.startsWith('session-')) return candidate
  }
  return undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// plan
// ─────────────────────────────────────────────────────────────────────────────

function buildPlan(options) {
  const env = resolveEnv(options)
  const warnings = []
  const errors = []

  const fromRaw = options.from
  const toRaw = options.to
  if (typeof fromRaw !== 'string' || fromRaw.length === 0) errors.push('--from is required for plan')
  if (typeof toRaw !== 'string' || toRaw.length === 0) errors.push('--to is required for plan')
  if (errors.length > 0) {
    return { ok: false, env, warnings, errors, from: fromRaw, to: toRaw }
  }

  const from = normalizeCwd(fromRaw)
  const to = normalizeCwd(toRaw)
  const oldKey = projectKey(from)
  const newKey = projectKey(to)
  const keysEqual = oldKey === newKey

  /** Optional explicit id allow-list (`--sessions a,b`): used by the live caller. */
  const sessionFilter =
    typeof options.sessions === 'string' && options.sessions.length > 0
      ? new Set(
          options.sessions
            .split(',')
            .map((id) => id.trim())
            .filter((id) => id.length > 0),
        )
      : undefined
  /**
   * When true this run must NOT touch storages/workspace.json: a live caller owns
   * that file through the workspace registry, and two writers would fight.
   */
  const skipWorkspaceJson = options['no-workspace-json'] === true || options.skipWorkspaceJson === true

  if (samePath(from, to)) errors.push('source and destination are the same path')
  if (keysEqual) {
    warnings.push(
      'old and new cwd produce the SAME projectKey: session directories need no move, only the header cwd and metadata are rewritten',
    )
  }
  if (from.length > 200 || to.length > 200) {
    warnings.push('a path is long enough that projectKey truncation (251 chars) may collide with another workspace')
  }

  // sessions
  const oldDirs = listSessionDirs(env.sessionsRoot, oldKey)
  const newDirs = listSessionDirs(env.sessionsRoot, newKey)
  let toMigrate = []
  const foreign = []
  const alreadyAtNew = []
  const broken = []

  for (const dir of oldDirs) {
    let info
    try {
      info = inspectSessionDir(dir)
    } catch (error) {
      broken.push({ dir, error: String(error.message ?? error) })
      continue
    }
    if (info.generations.length === 0) {
      foreign.push({ ...info, reason: 'no recognizable generation log' })
      continue
    }
    if (info.cwd === undefined) {
      foreign.push({ ...info, reason: 'header has no cwd (belongs to no workspace)' })
      continue
    }
    if (projectKey(info.cwd) !== oldKey) {
      foreign.push({ ...info, reason: `projectKey(header.cwd) = ${projectKey(info.cwd)} != ${oldKey}` })
      continue
    }
    if (!samePath(info.cwd, from)) {
      foreign.push({
        ...info,
        reason: `header.cwd "${info.cwd}" differs from --from "${from}" (same projectKey by truncation or alias); not moved`,
      })
      continue
    }
    const mismatched = info.generations.filter((g) => !samePath(g.cwd, from))
    if (mismatched.length > 0) {
      warnings.push(
        `${info.id}: non-authoritative generations already deviate (${mismatched.map((g) => `${g.name}=${g.cwd}`).join(', ')})`,
      )
    }
    toMigrate.push(info)
  }

  // `--sessions` narrows the migration to an explicit id set. This is how a LIVE
  // caller (the dsh-workspace-migrate plugin, with DSH still running) relocates the
  // cold sessions of one workspace without touching anything else: it owns the
  // in-memory workspace registry and passes only the ids it has proven cold.
  if (sessionFilter !== undefined) {
    const missing = [...sessionFilter].filter((id) => !toMigrate.some((session) => session.id === id))
    if (missing.length > 0) {
      errors.push(
        `requested session(s) are not relocatable from "${from}": ${missing.join(', ')} (not found under ${oldKey}, or their header cwd differs)`,
      )
    }
    // Sessions outside the allow-list stay where they are. Recording them as foreign
    // keeps every downstream invariant honest: the old projectKey directory is
    // legitimately still populated, so it must not be required to disappear.
    for (const session of toMigrate) {
      if (sessionFilter.has(session.id)) continue
      foreign.push(Object.assign({}, session, { reason: 'not selected by --sessions (left in place)' }))
    }
    toMigrate = toMigrate.filter((session) => sessionFilter.has(session.id))
  }

  for (const dir of newDirs) {
    try {
      const info = inspectSessionDir(dir)
      if (info.generations.length === 0) continue
      if (info.cwd !== undefined && samePath(info.cwd, to)) alreadyAtNew.push(info)
      else {
        warnings.push(
          `${info.id}: a session already exists under the destination key with cwd "${info.cwd}" — left untouched`,
        )
      }
    } catch (error) {
      warnings.push(`unreadable session directory under the destination key: ${dir} (${String(error.message ?? error)})`)
    }
  }

  const oldIds = new Set(toMigrate.map((s) => s.id))
  const collisions = alreadyAtNew.filter((s) => oldIds.has(s.id)).map((s) => s.id)
  if (collisions.length > 0) {
    errors.push(
      `session id(s) present under BOTH project keys: ${collisions.join(', ')} — DSH refuses to load a duplicated JSONL session id`,
    )
  }

  // locks / processes
  const locks = findSessionLocks(env.sessionsRoot)
  const dshProcesses = detectDshProcesses()
  // The origin DSH was serving when this plan was made. Recorded so a later `check-quiescent`
  // (from the staged .cmd) can decide "is DSH still up?" without depending on the process probe,
  // which on this machine has returned "nothing found" while DSH was in fact running.
  const dshOrigin = typeof options['dsh-origin'] === 'string' ? options['dsh-origin'] : undefined
  if (locks.length > 0) {
    warnings.push(`${locks.length} live session.lock lease file(s) found — apply will refuse unless --allow-lock`)
  }
  if (dshProcesses.matches.length > 0) {
    warnings.push(`a DSH process appears to be running — apply will refuse unless --allow-running`)
  }
  if (!dshProcesses.checked) {
    warnings.push('could not enumerate processes on this platform; the run check is advisory only')
  }
  if (dshOrigin !== undefined) {
    const originProbe = probeWebOrigin(dshOrigin)
    if (originProbe.checked && originProbe.listening) {
      warnings.push(`DSH is answering on ${dshOrigin} right now — apply will refuse unless --allow-running`)
    }
  }

  // project directory
  const oldExists = fs.existsSync(from)
  const newExists = fs.existsSync(to)
  const projectStat = oldExists ? directoryStats(from) : undefined
  const newStat = newExists ? directoryStats(to) : undefined
  let projectAction = options['project'] ?? 'auto'
  if (projectAction === 'auto') {
    if (!oldExists && newExists) projectAction = 'keep'
    else if (!oldExists && !newExists) projectAction = 'keep'
    else projectAction = 'move'
  }
  if (projectAction !== 'keep' && !oldExists) {
    errors.push(`--project ${projectAction} requested but the source directory does not exist: ${from}`)
  }
  // "Move the files too" into a destination that already holds files is only safe when the user
  // asked for the destination to be backed up and overwritten first (the UI's checkbox). Without
  // that, refuse with the reason instead of quietly merging two trees.
  const destinationHasContent = newExists && (newStat?.files ?? 0) > 0
  const backupExistingTarget = options['backup-target'] === true
  const projectBackupDir = backupExistingTarget && destinationHasContent ? desktopBackupDir(path.basename(to) || 'workspace') : undefined
  if (projectAction === 'move' && destinationHasContent && !backupExistingTarget) {
    errors.push(
      `the destination directory already holds ${newStat?.files} file(s): ${to} — turn on "back up the destination and overwrite", or empty it yourself first`,
    )
  }
  if (projectAction === 'move' && destinationHasContent && backupExistingTarget) {
    warnings.push(
      `the destination already holds ${newStat?.files} file(s); they will be moved to ${projectBackupDir} before the project is moved in`,
    )
  }

  // metadata
  const metadata = scanMetadata(env, from)
  const expectedMetadataFiles = [
    path.join(env.storagesRoot, 'workspace.json'),
    path.join(env.storagesRoot, 'session_projcache.json'),
  ].filter((file) => fs.existsSync(file))
  for (const file of expectedMetadataFiles) {
    if (!metadata.patches.some((patch) => patch.file === file)) {
      warnings.push(`no occurrence of the old path in ${file} (nothing to patch there)`)
    }
  }
  if (metadata.patches.length === 0) {
    warnings.push('no metadata file references the old path; only the session logs and directories need work')
  }

  const titlePatch = options.title !== undefined && !skipWorkspaceJson ? { file: path.join(env.storagesRoot, 'workspace.json'), title: options.title } : undefined

  // A live caller owns workspace.json through the workspace registry, so this run
  // must leave that file alone: its patches are reported but never applied or checked.
  let metadataPatches = metadata.patches
  const workspaceJsonSkipped = []
  const sessionScopedDeferred = []

  // Every session-scoped patch must belong to a session that is actually moving.
  // `scanMetadata` finds the old path anywhere under storages/, which also matches the
  // cached identity of sessions that stay behind (foreign ones, or ones excluded by
  // --sessions); rewriting those would corrupt them.
  const movingIds = new Set(toMigrate.map((session) => session.id))
  metadataPatches = metadataPatches.filter((patch) => {
    const sessionId = patchSessionId(patch)
    if (sessionId === undefined || movingIds.has(sessionId)) return true
    sessionScopedDeferred.push(Object.assign({}, patch, { reason: `session ${sessionId} is not moving` }))
    return false
  })

  if (skipWorkspaceJson) {
    const workspaceFile = path.join(env.storagesRoot, 'workspace.json')
    metadataPatches = metadataPatches.filter((patch) => patch.file !== workspaceFile)
    workspaceJsonSkipped.push(...metadata.patches.filter((patch) => patch.file === workspaceFile))
    warnings.push(
      workspaceJsonSkipped.length > 0
        ? `--no-workspace-json: ${workspaceJsonSkipped.length} patch(es) in workspace.json are intentionally left to the caller`
        : '--no-workspace-json: workspace.json needs no patch for this path',
    )
  }

  // A workspace.json patch re-points the record that claims the SOURCE path. If another record
  // already claims the DESTINATION, that patch would leave two records claiming one path — the
  // state DSH refuses to boot on. An empty record at the destination is the husk a previous
  // move leaves behind, so it is dropped along with the patch; a record that still holds
  // sessions is a merge decision this tool does not make on its own.
  const removals = []
  if (!skipWorkspaceJson) {
    const sourceClaims = workspaceClaims(env, from)
    const destinationClaims = workspaceClaims(env, to)
    if (sourceClaims.length > 1) {
      errors.push(
        `the source path ${from} is already claimed by ${sourceClaims.length} workspace records (${sourceClaims
          .map((claim) => claim.id)
          .join(', ')}) — DSH cannot boot from that; delete the extra record in the sidebar first`,
      )
    }
    if (!samePath(from, to) && destinationClaims.length > 0) {
      const occupied = destinationClaims.filter((claim) => claim.sessionIds.length > 0)
      if (occupied.length > 0) {
        errors.push(
          `the destination path ${to} is already claimed by workspace record(s) ${occupied
            .map((claim) => `${claim.id} (${claim.sessionIds.length} session(s))`)
            .join(', ')} — merging two workspaces is not something this tool decides; delete or rename that workspace in the sidebar first`,
        )
      }
      for (const claim of destinationClaims) {
        removals.push({
          file: path.join(env.storagesRoot, 'workspace.json'),
          jsonPath: `/tables/workspaces/${claim.id}`,
          id: claim.id,
          path: claim.path,
          reason: 'an empty workspace record already claims the destination path',
        })
      }
      if (removals.length > 0) {
        warnings.push(
          `the destination path is already claimed by ${removals.length} empty workspace record(s) (${removals
            .map((removal) => removal.id)
            .join(', ')}); apply removes them, because one path may only be claimed once`,
        )
      }
    }
  }

  // A typo in --from must not read as a green light: with no source directory and
  // no stored session there is simply nothing to move, which is never a "ready".
  if (!oldExists && toMigrate.length === 0) {
    errors.push(
      `nothing to migrate: the source workspace path does not exist (${from}) and no session is stored under its projectKey (${oldKey})`,
    )
  }

  const plan = {
    tool: TOOL,
    version: VERSION,
    command: 'plan',
    generatedAt: new Date().toISOString(),
    ok: errors.length === 0,
    env,
    from,
    to,
    fromRealpath: realpathOrSelf(from),
    toRealpath: newExists ? realpathOrSelf(to) : to,
    oldKey,
    newKey,
    keysEqual,
    nodePath: process.execPath,
    platform: process.platform,
    running: { dshProcesses: dshProcesses.matches, checked: dshProcesses.checked, locks, origin: dshOrigin },
    project: {
      action: projectAction,
      oldExists,
      newExists,
      oldFileCount: projectStat?.files,
      oldBytes: projectStat?.bytes,
      newFileCount: newStat?.files,
      backupExistingTarget,
      destinationHasContent,
      backupDir: projectBackupDir,
      freeBytesDestination: freeBytes(path.parse(to).root),
    },
    sessions: {
      oldDirs,
      newDirs,
      toMigrate,
      foreign,
      alreadyAtNew: alreadyAtNew.map((s) => ({ id: s.id, dir: s.dir, cwd: s.cwd })),
      broken,
      duplicateIds: collisions,
    },
    metadata: {
      patches: metadataPatches,
      removals,
      workspaceJsonSkipped,
      sessionScopedDeferred,
      skipWorkspaceJson,
      scannedCount: metadata.scannedCount,
      skipped: metadata.skipped,
    },
    titlePatch,
    warnings,
    errors,
  }
  return plan
}

function directoryStats(dir) {
  let files = 0
  let bytes = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        files++
        try {
          bytes += fs.statSync(full).size
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { files, bytes }
}

function freeBytes(root) {
  try {
    const stats = fs.statfsSync(root)
    return Number(stats.bsize) * Number(stats.bavail)
  } catch {
    return undefined
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// staging
// ─────────────────────────────────────────────────────────────────────────────

function stageRun(plan) {
  if (!plan.env || !plan.from || !plan.to) return undefined
  const stamp = plan.generatedAt.replace(/[:.]/g, '-')
  const slug = `${path.basename(plan.from) || 'workspace'}`.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40)
  const dir = path.join(plan.env.runRoot, `${stamp}-${slug}`)
  fs.mkdirSync(dir, { recursive: true })

  const planFile = path.join(dir, 'plan.json')
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2))

  const engineSource = fs.readFileSync(new URL(import.meta.url), 'utf8')
  const engineFile = path.join(dir, 'dsh-workspace-migrate.mjs')
  fs.writeFileSync(engineFile, engineSource)
  // The engine imports its frame/path primitives from the shared module, so a staged run is
  // only self-contained once that module travels with it.
  fs.writeFileSync(path.join(dir, 'zstd-frames.mjs'), fs.readFileSync(new URL('./zstd-frames.mjs', import.meta.url), 'utf8'))

  const node = process.execPath
  // The staged scripts are the last line of defence: by the time someone double-clicks one, the
  // plan is old and nothing else will notice that DSH is still up. A live DSH checkpoints its
  // in-memory workspace state back over the migration, so the script refuses instead.
  const guard = [
    'echo   checking that DSH is not running...',
    `"%NODE_EXE%" "%~dp0dsh-workspace-migrate.mjs" check-quiescent --plan "%~dp0plan.json"`,
    'if errorlevel 1 (',
    '  echo.',
    '  echo   [X] DSH still appears to be running. Quit DSH completely, then run this script again.',
    '  echo       A migration performed under a live DSH is lost: DSH checkpoints its',
    '  echo       in-memory workspace state back over the changed files.',
    '  echo.',
    '  pause',
    '  exit /b 1',
    ')',
    'echo.',
  ].join('\r\n')
  const cmd = (extra, { guarded = false } = {}) =>
    [
      '@echo off',
      'chcp 65001 >nul',
      'setlocal',
      `cd /d "%~dp0"`,
      `set "NODE_EXE=${node}"`,
      'if not exist "%NODE_EXE%" set "NODE_EXE=node"',
      ...(guarded ? [guard] : []),
      `"%NODE_EXE%" "%~dp0dsh-workspace-migrate.mjs" ${extra}`,
      'set "CODE=%ERRORLEVEL%"',
      'echo.',
      'echo   exit code: %CODE%',
      'pause',
      'exit /b %CODE%',
      '',
    ].join('\r\n')

  const files = {
    applyCmd: path.join(dir, '1-apply-migration.cmd'),
    verifyCmd: path.join(dir, '2-verify.cmd'),
    rollbackCmd: path.join(dir, '3-rollback.cmd'),
  }
  fs.writeFileSync(files.applyCmd, cmd(`apply --plan "%~dp0plan.json" --yes`, { guarded: true }))
  fs.writeFileSync(files.verifyCmd, cmd(`verify --plan "%~dp0plan.json"`))
  fs.writeFileSync(files.rollbackCmd, cmd(`rollback --plan "%~dp0plan.json" --yes`, { guarded: true }))

  const readme = [
    `${TOOL} v${VERSION} — staged migration run`,
    ''.padEnd(60, '='),
    '',
    `  from : ${plan.from}`,
    `  to   : ${plan.to}`,
    `  key  : ${plan.oldKey}  ->  ${plan.newKey}`,
    `  sessions to migrate: ${plan.sessions.toMigrate.length}`,
    `  metadata patches   : ${plan.metadata.patches.length}`,
    `  project action     : ${plan.project.action}`,
    '',
    'ORDER (do not reorder):',
    '  1. QUIT DSH COMPLETELY (web server + every session process).',
    '  2. Run  1-apply-migration.cmd',
    '  3. Run  2-verify.cmd      (read-only; must end with all checks PASS)',
    '  4. Start DSH again and confirm the workspace and its sessions are grouped.',
    '',
    '  If anything looks wrong: run 3-rollback.cmd, then 2-verify.cmd (order is irrelevant',
    '  after a rollback; verify reads the plan and the backup).',
    '',
    `  A full backup of the session directory and every patched storage file is written under:`,
    `    ${plan.env.backupRoot}`,
    '',
    '  Frame safety: only frame 0 of each session log is recompressed; every later zstd frame',
    '  is copied byte-for-byte, preserving the boot invariant DSH asserts on startup.',
    '',
  ].join('\r\n')
  const readmeFile = path.join(dir, 'README.txt')
  fs.writeFileSync(readmeFile, readme)

  return { dir, planFile, engineFile, readmeFile, ...files }
}

// ─────────────────────────────────────────────────────────────────────────────
// apply
// ─────────────────────────────────────────────────────────────────────────────

function preflightForApply(plan, options, { recheckDrift = true } = {}) {
  const blockers = []
  const notes = []

  if (!plan.ok) blockers.push(`the plan is not ok (${plan.errors.length} error(s)); rebuild it after fixing them`)

  const locks = findSessionLocks(plan.env.sessionsRoot)
  if (locks.length > 0 && options['allow-lock'] !== true) {
    blockers.push(`live session.lock lease file(s): ${locks.join(', ')} — quit DSH completely, or pass --allow-lock`)
  }
  const processes = detectDshProcesses()
  // A second, independent signal: the port DSH was serving when the plan was written. The process
  // probe alone once reported "no DSH" while DSH was running, and the migration was then overwritten
  // by the next checkpoint — so anything that answers is treated as a live DSH.
  const originProbe = probeWebOrigin(plan.running?.origin)
  if (options['allow-running'] !== true) {
    if (processes.matches.length > 0) {
      blockers.push(
        `a DSH process is running (a restart is required for DSH to re-read disk, and a running DSH would checkpoint stale state back over the metadata). Quit DSH first, or pass --allow-running. Detected: ${processes.matches
          .map((m) => m.slice(0, 120))
          .join(' | ')}`,
      )
    } else if (originProbe.checked && originProbe.listening) {
      blockers.push(
        `something is still answering on ${originProbe.origin}, which is where DSH was serving when this plan was written — quit DSH completely, or pass --allow-running`,
      )
    } else if (!processes.checked && !originProbe.checked) {
      // An answer the probes could not produce is not permission to rewrite the store.
      blockers.push(
        'could not determine whether DSH is running: neither the process probe nor the recorded origin could be checked. Confirm DSH is stopped yourself, then re-run with --allow-running',
      )
    } else if (originProbe.checked && !originProbe.listening) {
      notes.push(`nothing answers on ${originProbe.origin} any more, so DSH looks stopped`)
    }
  }

  if (recheckDrift) {
    for (const session of plan.sessions.toMigrate) {
      for (const generation of session.generations) {
        if (!fs.existsSync(generation.file)) {
          blockers.push(`session log disappeared since planning: ${generation.file}`)
          continue
        }
        const current = readSessionHeader(generation.file)
        if (!samePath(current.header.cwd, plan.from)) {
          blockers.push(
            `session log changed since planning (${generation.file}): cwd is now "${current.header.cwd}"`,
          )
        }
      }
    }
  }
  return { blockers, notes }
}

function performBackup(plan, options) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(plan.env.backupRoot, stamp)
  fs.mkdirSync(dir, { recursive: true })

  const sessionBackup = path.join(dir, `sessions-${plan.oldKey}`)
  const oldSessionDir = path.join(plan.env.sessionsRoot, plan.oldKey)
  if (fs.existsSync(oldSessionDir)) copyTree(oldSessionDir, sessionBackup)

  const metadataBackup = path.join(dir, 'storages')
  const metadataEntries = []
  const files = new Set(plan.metadata.patches.map((patch) => patch.file))
  if (plan.titlePatch !== undefined) files.add(plan.titlePatch.file)
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    const rel = path.relative(plan.env.dshHome, file)
    const target = path.join(metadataBackup, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(file, target)
    metadataEntries.push({ file, backup: target })
  }

  const manifest = {
    tool: TOOL,
    version: VERSION,
    createdAt: new Date().toISOString(),
    plan: { from: plan.from, to: plan.to, oldKey: plan.oldKey, newKey: plan.newKey },
    sessionBackup: fs.existsSync(sessionBackup) ? sessionBackup : null,
    metadata: metadataEntries,
    projectAction: plan.project.action,
    projectFrom: plan.from,
    projectTo: plan.to,
  }
  fs.writeFileSync(path.join(dir, 'backup-manifest.json'), JSON.stringify(manifest, null, 2))
  return { dir, manifest }
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) copyTree(src, dst)
    else if (entry.isFile()) fs.copyFileSync(src, dst)
  }
}

function removeTreeIfEmpty(dir) {
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir)
      return true
    }
  } catch {
    /* ignore */
  }
  return false
}

function moveDirectory(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try {
    fs.renameSync(from, to)
    return 'rename'
  } catch {
    copyTree(from, to)
    fs.rmSync(from, { recursive: true, force: true })
    return 'copy+delete'
  }
}

function robocopy(from, to, { move }) {
  const args = [
    from,
    to,
    '/E',
    '/COPY:DAT',
    '/DCOPY:DAT',
    '/R:2',
    '/W:1',
    '/NFL',
    '/NDL',
    '/NJH',
    '/NJS',
    '/NP',
  ]
  if (move) args.push('/MOVE')
  const result = spawnSync('robocopy', args, { windowsHide: true, encoding: 'utf8' })
  if (result.error !== undefined && result.error !== null) {
    throw new Error(`robocopy could not start: ${result.error.message}`)
  }
  const code = result.status ?? -1
  // robocopy: 0-7 are success-ish, >=8 is failure.
  if (code < 0 || code >= 8) {
    throw new Error(`robocopy failed with exit code ${code}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  }
  return { code, mode: move ? 'robocopy /E /MOVE' : 'robocopy /E' }
}

function applyPlan(plan, options, report) {
  const steps = report.steps
  const record = (name, fn) => {
    const started = Date.now()
    try {
      const detail = fn()
      steps.push({ name, status: 'ok', ms: Date.now() - started, detail: detail ?? null })
      return detail
    } catch (error) {
      steps.push({ name, status: 'failed', ms: Date.now() - started, error: String(error?.message ?? error) })
      throw error
    }
  }

  const preflight = preflightForApply(plan, options)
  if (preflight.blockers.length > 0) {
    const error = new Error(`preflight refused:\n  - ${preflight.blockers.join('\n  - ')}`)
    error.blockers = preflight.blockers
    throw error
  }

  // 1) backup everything before the first mutation
  const backup = record('backup', () => performBackup(plan, options))
  report.backup = backup

  // 2) move the project body
  const projectAction = options['project'] ?? plan.project.action
  record('project', () => {
    if (projectAction === 'keep') return { action: 'keep' }
    if (!fs.existsSync(plan.from)) throw new Error(`source project directory vanished: ${plan.from}`)
    // A destination that holds files is only entered when the plan says to park them first. The
    // re-check is here rather than trusting planning: the directory can gain files in between.
    let parked = null
    if (projectAction === 'move' && fs.existsSync(plan.to) && (directoryStats(plan.to).files ?? 0) > 0) {
      if (plan.project.backupExistingTarget !== true) {
        throw new Error(
          `destination project directory has files and the plan does not allow backing them up: ${plan.to}`,
        )
      }
      const backupDir = plan.project.backupDir ?? desktopBackupDir(path.basename(plan.to) || 'workspace')
      if (fs.existsSync(backupDir)) throw new Error(`the destination backup directory already exists: ${backupDir}`)
      fs.mkdirSync(path.dirname(backupDir), { recursive: true })
      parked = { dir: backupDir, mode: moveDirectory(plan.to, backupDir) }
      fs.mkdirSync(plan.to, { recursive: true })
    }
    if (projectAction === 'copy') {
      const mode =
        process.platform === 'win32' ? robocopy(plan.from, plan.to, { move: false }) : copyTree(plan.from, plan.to)
      return { action: 'copy', mode, parked }
    }
    const mode = process.platform === 'win32' ? robocopy(plan.from, plan.to, { move: true }) : moveDirectory(plan.from, plan.to)
    return { action: 'move', mode, parked }
  })

  // 3) rewrite each session log's header cwd, in place
  record('rewrite-headers', () => {
    const rewritten = []
    for (const session of plan.sessions.toMigrate) {
      for (const generation of session.generations) {
        rewritten.push(rewriteHeaderCwd(generation.file, plan.to))
      }
    }
    return { files: rewritten.length, rewritten }
  })

  // 4) move session directories into the destination project key
  record('move-session-dirs', () => {
    const moved = []
    if (plan.keysEqual) return { moved, note: 'projectKey unchanged; directories stay in place' }
    for (const session of plan.sessions.toMigrate) {
      const target = path.join(plan.env.sessionsRoot, plan.newKey, path.basename(session.dir))
      if (fs.existsSync(target)) {
        throw new Error(`destination session directory already exists: ${target}`)
      }
      moved.push({ from: session.dir, to: target, mode: moveDirectory(session.dir, target) })
    }
    const removedOldKey = removeTreeIfEmpty(path.join(plan.env.sessionsRoot, plan.oldKey))
    return { moved, removedOldKey }
  })

  // 5) patch the storage metadata
  record('patch-metadata', () => {
    const applied = []
    // Removals first: an empty record that already claims the destination has to be gone
    // before — or at least in the same write as — the record that is re-pointed onto it.
    for (const removal of plan.metadata.removals ?? []) {
      const loaded = readJson(removal.file)
      const after = structuredClone(loaded.value)
      const table = after?.tables?.workspaces
      if (table === undefined || table === null || table[removal.id] === undefined) {
        // Already gone (a re-run, or the user deleted it): not an error.
        applied.push({ file: removal.file, jsonPath: removal.jsonPath, removed: false, reason: 'already absent' })
        continue
      }
      delete table[removal.id]
      if (Array.isArray(after?.global?.workspaceIds)) {
        after.global.workspaceIds = after.global.workspaceIds.filter((id) => id !== removal.id)
      }
      writeJsonPreservingStyle(removal.file, after, loaded.trailingNewline)
      applied.push({ file: removal.file, jsonPath: removal.jsonPath, removed: true, reason: removal.reason })
    }
    for (const patch of plan.metadata.patches) {
      const loaded = readJson(patch.file)
      const after = structuredClone(loaded.value)
      setAtPath(after, patch.jsonPath, plan.to)
      const diffs = diffLeafPaths(loaded.value, after, '')
      const unexpected = diffs.filter(([jsonPath]) => jsonPath !== patch.jsonPath)
      if (unexpected.length > 0) {
        throw new Error(
          `refusing to write ${patch.file}: the patch would also change ${unexpected
            .map(([p]) => p)
            .join(', ')}`,
        )
      }
      writeJsonPreservingStyle(patch.file, after, loaded.trailingNewline)
      applied.push({ file: patch.file, jsonPath: patch.jsonPath, from: patch.from, to: plan.to })
    }
    if (plan.titlePatch !== undefined) {
      const file = plan.titlePatch.file
      if (fs.existsSync(file)) {
        const loaded = readJson(file)
        const after = structuredClone(loaded.value)
        // Set the title for the workspace whose path is the destination.
        const table = after?.tables?.workspaces
        if (table !== undefined && typeof table === 'object') {
          for (const [id, workspace] of Object.entries(table)) {
            if (workspace !== null && typeof workspace === 'object' && samePath(workspace.path, plan.to)) {
              workspace.title = plan.titlePatch.title
              applied.push({ file, jsonPath: `/tables/workspaces/${id}/title`, to: plan.titlePatch.title })
            }
          }
        }
        writeJsonPreservingStyle(file, after, loaded.trailingNewline)
      }
    }
    return { applied }
  })
  // 6) close the loop with a read-only verification
  const verification = record('verify', () => verifyPlan(plan, { expectMigrated: true }))
  report.verification = verification
  if (!verification.ok) {
    throw new Error(`post-migration verification failed: ${verification.failures.join('; ')}`)
  }
  return report
}

function rollbackRun(plan, options) {
  const steps = []
  const backupRoot = options['from-backup'] ?? newestBackup(plan.env.backupRoot)
  if (backupRoot === undefined) throw new Error(`no backup directory found under ${plan.env.backupRoot}`)
  const manifestFile = path.join(backupRoot, 'backup-manifest.json')
  if (!fs.existsSync(manifestFile)) throw new Error(`backup manifest not found: ${manifestFile}`)
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))

  const record = (name, fn) => {
    try {
      const detail = fn()
      steps.push({ name, status: 'ok', detail: detail ?? null })
      return detail
    } catch (error) {
      steps.push({ name, status: 'failed', error: String(error?.message ?? error) })
      throw error
    }
  }

  // 1) project body back
  record('project', () => {
    if (manifest.projectAction === 'keep' || manifest.projectAction === 'copy') {
      return { action: 'keep', note: 'project files were not moved by apply' }
    }
    if (!fs.existsSync(manifest.projectFrom)) {
      const mode = process.platform === 'win32'
        ? robocopy(manifest.projectTo, manifest.projectFrom, { move: true })
        : moveDirectory(manifest.projectTo, manifest.projectFrom)
      return { action: 'move-back', mode }
    }
    return { action: 'skipped', note: 'source project directory already exists' }
  })

  // 2) metadata restore
  record('restore-metadata', () => {
    const restored = []
    for (const entry of manifest.metadata ?? []) {
      if (!fs.existsSync(entry.backup)) continue
      fs.mkdirSync(path.dirname(entry.file), { recursive: true })
      fs.copyFileSync(entry.backup, entry.file)
      restored.push(entry.file)
    }
    return { restored }
  })

  // 3) session directories back
  record('restore-sessions', () => {
    const moved = []
    const oldDirRoot = path.join(plan.env.sessionsRoot, manifest.plan.oldKey)
    const newDirRoot = path.join(plan.env.sessionsRoot, manifest.plan.newKey)
    if (!manifest.sessionBackup || !fs.existsSync(manifest.sessionBackup)) {
      return { moved, note: 'no session backup present' }
    }
    if (manifest.plan.oldKey !== manifest.plan.newKey && fs.existsSync(newDirRoot)) {
      // Remove whatever apply produced, then restore the pristine copy.
      fs.rmSync(newDirRoot, { recursive: true, force: true })
    }
    copyTree(manifest.sessionBackup, oldDirRoot)
    for (const entry of fs.readdirSync(oldDirRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) moved.push(path.join(oldDirRoot, entry.name))
    }
    return { moved, restoredFrom: manifest.sessionBackup }
  })

  // 4) prove the restored logs satisfy the original identities
  const verification = record('verify', () => verifyPlan(plan, { expectMigrated: false }))
  return { steps, backupRoot, verification }
}

function newestBackup(backupRoot) {
  if (!fs.existsSync(backupRoot)) return undefined
  const dirs = fs
    .readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(backupRoot, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'backup-manifest.json')))
    .sort()
  return dirs.length > 0 ? dirs[dirs.length - 1] : undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// verify
// ─────────────────────────────────────────────────────────────────────────────

/** Locate one session's directory under either the old or the new project key. */
function locateSessionDir(plan, session) {
  const candidates = [
    path.join(plan.env.sessionsRoot, plan.newKey, session.id),
    path.join(plan.env.sessionsRoot, plan.oldKey, session.id),
  ]
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue
    try {
      const info = inspectSessionDir(dir)
      if (info.generations.length > 0) return { dir, info }
    } catch {
      /* try the next candidate */
    }
  }
  return undefined
}

/**
 * Decide, from disk alone, whether this plan has been applied. Lets `verify` be run
 * before or after the migration without reporting the not-yet-applied state as damage.
 */
function detectState(plan) {
  let original = 0
  let migrated = 0
  let other = 0
  const sample = (value) => {
    if (typeof value !== 'string') return
    if (samePath(value, plan.from)) original++
    else if (samePath(value, plan.to)) migrated++
    else other++
  }
  for (const session of plan.sessions.toMigrate) {
    const located = locateSessionDir(plan, session)
    if (located === undefined) {
      other++
      continue
    }
    sample(located.info.cwd)
  }
  for (const patch of plan.metadata.patches) {
    try {
      sample(getAtPath(JSON.parse(fs.readFileSync(patch.file, 'utf8')), patch.jsonPath))
    } catch {
      other++
    }
  }
  if (plan.project.action !== 'keep') {
    if (fs.existsSync(plan.to)) migrated++
    else if (fs.existsSync(plan.from)) original++
  }
  const seen = original + migrated + other
  if (seen === 0) return 'unknown'
  if (original > 0 && migrated > 0) return 'mixed'
  if (migrated > 0) return other > 0 ? 'mixed' : 'migrated'
  if (original > 0) return other > 0 ? 'mixed' : 'original'
  return 'unknown'
}

function verifyPlan(plan, { expectMigrated = true, autoDetected = false, detectedState = undefined } = {}) {
  const checks = []
  const notes = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })

  const oldKeyDir = path.join(plan.env.sessionsRoot, plan.oldKey)
  const newKeyDir = path.join(plan.env.sessionsRoot, plan.newKey)
  const expectedCwd = expectMigrated ? plan.to : plan.from
  const expectedKey = expectMigrated ? plan.newKey : plan.oldKey
  const expectedRoot = expectMigrated ? newKeyDir : oldKeyDir

  add(
    `sessions root exists`,
    fs.existsSync(plan.env.sessionsRoot),
    plan.env.sessionsRoot,
  )

  for (const session of plan.sessions.toMigrate) {
    const dir = path.join(expectedRoot, session.id)
    if (!fs.existsSync(dir)) {
      add(`session ${session.id} directory`, false, `missing: ${dir}`)
      continue
    }
    add(`session ${session.id} directory`, true, dir)
    for (const generation of session.generations) {
      const file = path.join(dir, generation.name)
      if (!fs.existsSync(file)) {
        add(`${session.id}/${generation.name}`, false, 'missing')
        continue
      }
      try {
        const header = readSessionHeader(file)
        const ok = samePath(header.header.cwd, expectedCwd)
        add(
          `${session.id}/${generation.name} header cwd`,
          ok,
          `cwd="${header.header.cwd}" expected="${expectedCwd}" frames=${header.frameCount}`,
        )
      } catch (error) {
        add(`${session.id}/${generation.name} header`, false, String(error?.message ?? error))
      }
    }
  }

  if (expectMigrated && !plan.keysEqual) {
    const leftovers = plan.sessions.toMigrate
      .map((session) => path.join(oldKeyDir, path.basename(session.dir)))
      .filter((dir) => fs.existsSync(dir))
    add(
      `no migrated session directory remains under the old project key`,
      leftovers.length === 0,
      leftovers.length === 0
        ? plan.sessions.foreign.length > 0
          ? `old key directory intentionally kept for ${plan.sessions.foreign.length} foreign session(s)`
          : 'clean'
        : leftovers.join(', '),
    )
    if (plan.sessions.foreign.length === 0) {
      add(`old project key directory removed`, !fs.existsSync(oldKeyDir), fs.existsSync(oldKeyDir) ? oldKeyDir : 'removed')
    }
  }
  add(`expected project key directory exists`, fs.existsSync(expectedRoot), expectedRoot)

  // The invariant DSH asserts at boot: no workspace path may be claimed by two records. This
  // is the check whose absence let a manual apply leave the store unbootable.
  const claimCounts = new Map()
  try {
    const workspaceFile = path.join(plan.env.storagesRoot, 'workspace.json')
    if (fs.existsSync(workspaceFile)) {
      const table = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'))?.tables?.workspaces
      for (const [id, workspace] of Object.entries(table ?? {})) {
        if (workspace === null || typeof workspace !== 'object') continue
        const key = normalizeCwd(workspace.path) ?? String(workspace.path)
        const list = claimCounts.get(key) ?? []
        list.push(id)
        claimCounts.set(key, list)
      }
    }
  } catch (error) {
    notes.push(`could not audit workspace path claims: ${String(error?.message ?? error)}`)
  }
  const doubleClaims = [...claimCounts.entries()].filter(([, ids]) => ids.length > 1)
  add(
    'no workspace path is claimed by two records',
    doubleClaims.length === 0,
    doubleClaims.length === 0 ? `${claimCounts.size} workspace record(s) checked` : doubleClaims.map(([claimPath, ids]) => `${claimPath} <- ${ids.join(', ')}`).join(' | '),
  )
  for (const removal of plan.metadata.removals ?? []) {
    let gone = false
    try {
      const table = JSON.parse(fs.readFileSync(removal.file, 'utf8'))?.tables?.workspaces
      gone = table === undefined || table[removal.id] === undefined
    } catch {
      gone = false
    }
    add(`empty record ${removal.id} no longer claims the destination path`, gone, gone ? 'removed' : 'still present')
  }

  // The load-time invariant DSH asserts for every stored session.
  const migratedIds = new Set(plan.sessions.toMigrate.map((session) => session.id))
  const placement = auditSessionPlacement(plan.env.sessionsRoot, migratedIds)
  const relatedViolations = placement.violations.filter((violation) => violation.related)
  const unrelatedViolations = placement.violations.filter((violation) => !violation.related)
  add(
    'every migrated session directory matches the project key of its own header cwd',
    relatedViolations.length === 0,
    relatedViolations.length === 0
      ? `${placement.scanned} session directories audited`
      : relatedViolations.map((v) => `${v.dir}: ${v.problem}`).join(' | '),
  )
  for (const violation of unrelatedViolations) {
    notes.push(
      `pre-existing placement violation not caused by this migration (left untouched): ${violation.dir} — ${violation.problem}`,
    )
  }

  // Global uniqueness of session ids across every project directory.
  //
  // Two rules keep this from failing over damage this run did not cause:
  //   · A directory holding no generation log is not a session under that key — it is an empty
  //     orphan, the kind an interrupted relocation leaves behind. Counting it would refuse a
  //     migration because of a directory that contains nothing.
  //   · Only an id this migration moved, or one sitting under a key this migration writes, can
  //     be blamed on this run. A duplicate between two unrelated project keys predates the
  //     migration: it is reported and left untouched, because blocking on it would keep every
  //     later migration broken until someone hand-repairs unrelated state.
  const oldKeyName = path.basename(oldKeyDir)
  const newKeyName = path.basename(newKeyDir)
  const byId = new Map()
  const emptyOrphans = []
  if (fs.existsSync(plan.env.sessionsRoot)) {
    for (const entry of fs.readdirSync(plan.env.sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const projectDir = path.join(plan.env.sessionsRoot, entry.name)
      for (const sessionEntry of fs.readdirSync(projectDir, { withFileTypes: true })) {
        if (!sessionEntry.isDirectory()) continue
        const dir = path.join(projectDir, sessionEntry.name)
        let empty = false
        try {
          empty = inspectSessionDir(dir).generations.length === 0
        } catch {
          // Unreadable is NOT empty: it may well be the session, so it still counts.
          empty = false
        }
        if (empty) {
          emptyOrphans.push(dir)
          continue
        }
        const list = byId.get(sessionEntry.name) ?? []
        list.push(entry.name)
        byId.set(sessionEntry.name, list)
      }
    }
  }
  const duplicated = [...byId.entries()].filter(([, keys]) => keys.length > 1)
  const causedByThisRun = ([id, keys]) => migratedIds.has(id) || keys.includes(newKeyName) || keys.includes(oldKeyName)
  const relatedDuplicates = duplicated.filter(causedByThisRun)
  const unrelatedDuplicates = duplicated.filter((entry) => !causedByThisRun(entry))
  add(
    'no session id appears under two project keys',
    relatedDuplicates.length === 0,
    relatedDuplicates.length === 0 ? `${byId.size} session directories scanned` : JSON.stringify(relatedDuplicates),
  )
  for (const [id, keys] of unrelatedDuplicates) {
    notes.push(
      `pre-existing duplicate session id, not caused by this migration (left untouched): ${id} under ${keys.join(', ')} — delete the stale copy if it is not wanted`,
    )
  }
  if (emptyOrphans.length > 0) {
    notes.push(
      `${emptyOrphans.length} session directory/directories hold no session log at all (left behind by an interrupted relocation); they are not counted as sessions and are not touched: ${emptyOrphans.join(', ')}`,
    )
  }

  // metadata
  for (const patch of plan.metadata.patches) {
    if (!fs.existsSync(patch.file)) {
      add(`metadata ${path.basename(patch.file)}`, false, 'file missing')
      continue
    }
    const value = JSON.parse(fs.readFileSync(patch.file, 'utf8'))
    const current = getAtPath(value, patch.jsonPath)
    add(
      `metadata ${path.basename(patch.file)}${patch.jsonPath}`,
      samePath(current, expectedCwd),
      `"${current}" expected "${expectedCwd}"`,
    )
  }

  // project directory
  if (plan.project.action !== 'keep') {
    const expectedProject = expectMigrated ? plan.to : plan.from
    add(`project directory`, fs.existsSync(expectedProject), expectedProject)
  }

  // Locks: a lease file inside a session directory travels with that directory, and a
  // stale one is harmless once DSH has stopped, so this is reported rather than failed.
  // Enforcement lives in the apply preflight, which refuses to mutate while one is held.
  const locks = findSessionLocks(plan.env.sessionsRoot)
  if (locks.length > 0) notes.push(`${locks.length} session.lock lease file(s) present: ${locks.join(', ')}`)

  const failedChecks = checks.filter((check) => !check.ok)
  const failures = failedChecks.map((check) => `${check.name}: ${check.detail}`)

  if (autoDetected) {
    if (detectedState === 'original') {
      notes.push(
        'the migration has NOT been applied yet: the workspace and its sessions are still intact at the original path, which is why this run expects the original state',
      )
    } else if (detectedState === 'mixed') {
      notes.push(
        'the on-disk state is neither fully original nor fully migrated — a previous run may have failed part-way; inspect the notes above and the newest backup before proceeding',
      )
    } else if (detectedState === 'unknown') {
      notes.push('could not determine whether the plan was applied from disk alone')
    }
  }

  return {
    command: 'verify',
    expectMigrated,
    autoDetected,
    detectedState,
    generatedAt: new Date().toISOString(),
    ok: failures.length === 0,
    checked: checks.length,
    checks,
    notes,
    failures,
    expectedKey,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const options = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const eq = token.indexOf('=')
    if (eq !== -1) {
      options[token.slice(2, eq)] = token.slice(eq + 1)
      continue
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      options[key] = true
    } else {
      options[key] = next
      i++
    }
  }
  return { command: positional[0], options, positional }
}

function loadPlanFromOptions(options) {
  if (typeof options.plan === 'string') {
    if (!fs.existsSync(options.plan)) throw new Error(`plan file not found: ${options.plan}`)
    return JSON.parse(fs.readFileSync(options.plan, 'utf8'))
  }
  if (typeof options.from === 'string' && typeof options.to === 'string') {
    const plan = buildPlan(options)
    if (!plan.ok) throw new Error(`plan is not ok:\n  - ${plan.errors.join('\n  - ')}`)
    return plan
  }
  throw new Error('either --plan <plan.json> or both --from and --to are required')
}

const USAGE = `
${TOOL} v${VERSION}
Re-home a DSH workspace so existing sessions keep their history and stay grouped.

  plan     --from <old> --to <new> [--title T] [--project auto|move|copy|keep]
                                     [--backup-target] [--dsh-origin host:port]
                                     [--dsh-home P] [--sessions-root P] [--storages-root P]
                                     [--run-dir P] [--backup-dir P] [--no-stage] [--sessions a,b]
  relocate-sessions  --from <old> --to <new> --sessions <id,id> --yes
                                     [--report <file>] [--allow-running] [--allow-lock]
                                     [--no-auto-rollback]
                     --rollback --report <file> --yes
                                     Narrows the file work to an explicit id set and never writes
                                     storages/workspace.json (a live caller owns it).
  apply    (--plan <plan.json> | --from <old> --to <new>) --yes
                                     [--project auto|move|copy|keep] [--backup-target]
                                     [--allow-running] [--allow-lock] [--no-auto-rollback]
  check-quiescent  [--plan <plan.json>] [--dsh-origin host:port]
                                     Exit 0 only when this looks like a stopped DSH; the staged
                                     .cmd scripts run it before touching anything.
  verify   (--plan <plan.json> | --from <old> --to <new>) [--expect auto|original|migrated]
  rollback (--plan <plan.json> | --from <old> --to <new>) --yes [--from-backup <dir>]
  list     [--run-dir P] [--dsh-home P]

  --json   machine-readable output on stdout (plans, verify, apply, rollback)
  --quiet  suppress the human-readable summary

Codes: 0 ok · 1 refused / failed · 2 usage
`.trim()

function humanSummary(plan) {
  const lines = []
  lines.push(`${TOOL} v${VERSION} — plan`)
  lines.push(`  from        : ${plan.from}`)
  lines.push(`  to          : ${plan.to}`)
  lines.push(`  projectKey  : ${plan.oldKey}`)
  lines.push(`             -> ${plan.newKey}`)
  lines.push(`  sessions    : ${plan.sessions.toMigrate.length} to migrate, ${plan.sessions.foreign.length} foreign, ${plan.sessions.alreadyAtNew.length} already at destination`)
  if (plan.sessions.toMigrate.length > 0) {
    for (const session of plan.sessions.toMigrate) {
      lines.push(`      - ${session.id} (${session.generations.length} generation(s), newest v${session.authoritative?.version})`)
    }
  }
  for (const session of plan.sessions.foreign) {
    lines.push(`      ! skipped ${session.id}: ${session.reason}`)
  }
  lines.push(`  project     : ${plan.project.action} (source ${plan.project.oldExists ? 'present' : 'absent'}, destination ${plan.project.newExists ? 'present' : 'absent'}${plan.project.oldFileCount !== undefined ? `, ${plan.project.oldFileCount} files` : ''})`)
  lines.push(`  metadata    : ${plan.metadata.patches.length} patch(es) in ${new Set(plan.metadata.patches.map((p) => p.file)).size} file(s)`)
  for (const patch of plan.metadata.patches) {
    lines.push(`      - ${patch.file} ${patch.jsonPath}`)
  }
  lines.push(`  DSH running : ${plan.running.dshProcesses.length > 0 ? 'YES (apply will refuse)' : 'no'}; lock files: ${plan.running.locks.length}`)
  for (const warning of plan.warnings) lines.push(`  warn  ${warning}`)
  for (const error of plan.errors) lines.push(`  ERROR ${error}`)
  lines.push(`  result      : ${plan.ok ? 'OK' : 'BLOCKED'}`)
  return lines.join('\n')
}

function main() {
  const { command, options } = parseArgv(process.argv.slice(2))
  const json = options.json === true
  const quiet = options.quiet === true
  const emit = (value, human) => {
    if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    else if (!quiet && human !== undefined) process.stdout.write(`${human}\n`)
  }

  if (command === undefined || command === 'help' || options.help === true) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  try {
    if (command === 'plan') {
      const plan = buildPlan(options)
      if (options['no-stage'] !== true && plan.from !== undefined && plan.to !== undefined) {
        plan.stage = stageRun(plan)
      }
      emit(plan, plan.from === undefined ? undefined : humanSummary(plan))
      return plan.ok ? 0 : 1
    }

    if (command === 'list') {
      const env = resolveEnv(options)
      const runs = []
      if (fs.existsSync(env.runRoot)) {
        for (const entry of fs.readdirSync(env.runRoot, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const dir = path.join(env.runRoot, entry.name)
          const planFile = path.join(dir, 'plan.json')
          const reportFile = path.join(dir, 'report.json')
          const record = { dir, planFile, reportFile, hasPlan: fs.existsSync(planFile), hasReport: fs.existsSync(reportFile) }
          // The runner paths are what a caller actually needs after quitting DSH.
          record.applyCmd = path.join(dir, '1-apply-migration.cmd')
          record.verifyCmd = path.join(dir, '2-verify.cmd')
          record.rollbackCmd = path.join(dir, '3-rollback.cmd')
          if (record.hasReport) {
            try {
              const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
              record.report = { status: report.status, finishedAt: report.finishedAt, from: report.plan?.from, to: report.plan?.to }
            } catch {
              /* ignore */
            }
          }
          if (record.hasPlan) {
            try {
              const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))
              record.from = plan.from
              record.to = plan.to
              record.sessions = plan.sessions?.toMigrate?.length ?? 0
              record.ok = plan.ok
            } catch {
              /* ignore */
            }
          }
          runs.push(record)
        }
      }
      runs.sort((a, b) => a.dir.localeCompare(b.dir))
      emit({ command: 'list', runRoot: env.runRoot, backupRoot: env.backupRoot, runs }, runs.map((r) => `${r.dir}  sessions=${r.sessions ?? '?'} report=${r.report?.status ?? '-'}`).join('\n'))
      return 0
    }

    if (command === 'verify') {
      const plan = loadPlanFromOptions(options)
      const expectOption = typeof options.expect === 'string' ? options.expect : 'auto'
      const detectedState = detectState(plan)
      let expectMigrated
      let autoDetected = false
      if (expectOption === 'original') expectMigrated = false
      else if (expectOption === 'migrated' || expectOption === 'applied') expectMigrated = true
      else {
        // auto: a pre-apply check must not read as damage
        expectMigrated = detectedState !== 'original'
        autoDetected = true
      }
      const result = verifyPlan(plan, { expectMigrated, autoDetected, detectedState })
      const human = [
        `${TOOL} — verify (${expectMigrated ? 'expecting the migrated state' : 'expecting the original state'}${autoDetected ? `, auto-detected: ${detectedState}` : ''})`,
        ...result.checks.map((check) => `  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name}  ${check.detail ?? ''}`),
        ...result.notes.map((note) => `  note  ${note}`),
        `  result: ${result.ok ? 'ALL CHECKS PASS' : `${result.failures.length} FAILURE(S)`}`,
      ].join('\n')
      emit(result, human)
      return result.ok ? 0 : 1
    }

    if (command === 'check-quiescent') {
      // The staged scripts call this before touching anything: a live DSH would checkpoint its
      // in-memory workspace state back over the migration, and an answer this probe cannot
      // produce is treated as "not safe yet" rather than as permission.
      //
      // Two independent signals, because the process probe alone has already been wrong once:
      // the recorded origin (the port DSH served when the plan was written) and the process list.
      let origin
      if (typeof options.plan === 'string' && fs.existsSync(options.plan)) {
        try {
          origin = JSON.parse(fs.readFileSync(options.plan, 'utf8'))?.running?.origin
        } catch {
          origin = undefined
        }
      }
      if (typeof options['dsh-origin'] === 'string') origin = options['dsh-origin']
      const processes = detectDshProcesses()
      const originProbe = probeWebOrigin(origin)
      const originAnswers = originProbe.checked && originProbe.listening
      if (processes.matches.length > 0 || originAnswers) {
        process.stderr.write(
          [
            `${TOOL} — DSH is still running`,
            ...processes.matches.map((line) => `  process: ${line.slice(0, 160)}`),
            ...(originAnswers ? [`  http:    ${originProbe.origin} is answering`] : []),
            '  Quit DSH completely (the web server and every session process) and run this again.',
            '',
          ].join('\n'),
        )
        return 1
      }
      if (!processes.checked && !originProbe.checked) {
        process.stderr.write(
          `${TOOL} — could not determine whether DSH is running (the process probe failed, and this plan records no origin to probe).\n  Confirm DSH is stopped, then run the migration with --allow-running.\n`,
        )
        return 1
      }
      const how = originProbe.checked ? `nothing answers on ${originProbe.origin}` : 'no DSH process matched'
      process.stdout.write(`DSH is not running (${how}); safe to continue.\n`)
      return 0
    }

    if (command === 'apply') {
      if (options.yes !== true && options['dry-run'] !== true) {
        process.stderr.write('refusing to mutate without --yes (run `plan` first, then `apply --yes`)\n')
        return 2
      }
      const plan = loadPlanFromOptions(options)
      if (options['dry-run'] === true) {
        const result = { command: 'apply', dryRun: true, plan: { from: plan.from, to: plan.to, oldKey: plan.oldKey, newKey: plan.newKey } }
        emit(result, 'dry run: nothing was modified')
        return 0
      }
      const report = {
        tool: TOOL,
        version: VERSION,
        command: 'apply',
        status: 'running',
        startedAt: new Date().toISOString(),
        plan: { from: plan.from, to: plan.to, oldKey: plan.oldKey, newKey: plan.newKey },
        steps: [],
      }
      try {
        applyPlan(plan, options, report)
        report.status = 'ok'
      } catch (error) {
        report.status = 'failed'
        report.error = String(error?.message ?? error)
        report.blockers = error?.blockers
        if (options['no-auto-rollback'] !== true && report.backup !== undefined) {
          try {
            report.autoRollback = rollbackRun(plan, options)
            report.status = report.autoRollback.verification?.ok ? 'rolled-back' : 'rollback-incomplete'
          } catch (rollbackError) {
            report.rollbackError = String(rollbackError?.message ?? rollbackError)
          }
        }
        report.finishedAt = new Date().toISOString()
        writeReport(plan, report)
        const human = [
          `${TOOL} — apply FAILED`,
          `  ${report.error}`,
          ...(report.blockers ?? []).map((b) => `    - ${b}`),
          report.autoRollback !== undefined
            ? `  automatic rollback: ${report.autoRollback.verification?.ok ? 'succeeded, original state restored' : 'INCOMPLETE — inspect the backup manually'}`
            : '  no automatic rollback was attempted',
          report.backup !== undefined ? `  backup: ${report.backup.dir}` : '',
        ]
          .filter((line) => line.length > 0)
          .join('\n')
        emit(report, human)
        return 1
      }
      report.finishedAt = new Date().toISOString()
      writeReport(plan, report)
      const human = [
        `${TOOL} — apply OK`,
        ...report.steps.map((step) => `  ok    ${step.name} (${step.ms}ms)`),
        `  backup      : ${report.backup?.dir}`,
        `  verification: ${report.verification?.checked} checks, ${report.verification?.ok ? 'ALL PASS' : 'FAILURES'}`,
        '',
        '  Next: start DSH again and confirm the workspace and its sessions are grouped.',
      ].join('\n')
      emit(report, human)
      return 0
    }

    if (command === 'relocate-sessions') {
      // Live-caller entry point. The caller (the dsh-workspace-migrate plugin, with
      // DSH still running) has already proven the sessions are cold and owns both the
      // project-directory move and storages/workspace.json, so this command narrows
      // the scope to `--sessions` and never touches workspace.json.
      const env = resolveEnv(options)
      const reportFile =
        typeof options.report === 'string' && options.report.length > 0
          ? path.resolve(options.report)
          : path.join(env.runRoot, `relocate-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)

      if (options.rollback === true) {
        if (options.yes !== true) {
          process.stderr.write('refusing to mutate without --yes\n')
          return 2
        }
        if (!fs.existsSync(reportFile)) throw new Error(`report not found: ${reportFile}`)
        const saved = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
        if (saved.planData === undefined) {
          throw new Error(`this report carries no plan snapshot, so it cannot be rolled back: ${reportFile}`)
        }
        const result = rollbackRun(saved.planData, options)
        result.tool = TOOL
        result.version = VERSION
        result.command = 'relocate-sessions'
        result.mode = 'rollback'
        result.ok = result.verification?.ok === true
        emit(
          result,
          [
            `${TOOL} — relocate-sessions rollback ${result.ok ? 'OK' : 'INCOMPLETE'}`,
            ...result.steps.map((step) => `  ${step.status === 'ok' ? 'ok   ' : 'FAIL '} ${step.name}`),
            `  verification: ${result.verification?.ok ? 'ALL PASS (original state)' : `${result.verification?.failures?.length ?? '?'} FAILURE(S)`}`,
          ].join('\n'),
        )
        return result.ok ? 0 : 1
      }

      if (options.yes !== true) {
        process.stderr.write('refusing to mutate without --yes\n')
        return 2
      }
      const plan = buildPlan(Object.assign({}, options, { project: 'keep', 'no-workspace-json': true }))
      const report = {
        tool: TOOL,
        version: VERSION,
        command: 'relocate-sessions',
        mode: 'apply',
        status: 'running',
        startedAt: new Date().toISOString(),
        reportFile,
        plan: { from: plan.from, to: plan.to, oldKey: plan.oldKey, newKey: plan.newKey },
        steps: [],
      }

      if (!plan.ok) {
        report.status = 'refused'
        report.errors = plan.errors
        report.planData = plan
        fs.mkdirSync(path.dirname(reportFile), { recursive: true })
        fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
        emit(report, `${TOOL} — relocate-sessions refused:\n  - ${plan.errors.join('\n  - ')}`)
        return 1
      }

      try {
        applyPlan(plan, options, report)
        report.status = 'ok'
      } catch (error) {
        report.status = 'failed'
        report.error = String(error?.message ?? error)
        report.blockers = error?.blockers
        if (options['no-auto-rollback'] !== true && report.backup !== undefined) {
          try {
            report.autoRollback = rollbackRun(plan, options)
            report.status = report.autoRollback.verification?.ok ? 'rolled-back' : 'rollback-incomplete'
          } catch (rollbackError) {
            report.rollbackError = String(rollbackError?.message ?? rollbackError)
          }
        }
        report.planData = plan
        report.finishedAt = new Date().toISOString()
        fs.mkdirSync(path.dirname(reportFile), { recursive: true })
        fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
        emit(
          report,
          [
            `${TOOL} — relocate-sessions FAILED`,
            `  ${report.error}`,
            ...(report.blockers ?? []).map((blocker) => `    - ${blocker}`),
            report.autoRollback !== undefined
              ? `  automatic rollback: ${report.autoRollback.verification?.ok ? 'succeeded, original state restored' : 'INCOMPLETE — inspect the backup manually'}`
              : '  no automatic rollback was attempted',
            `  report: ${reportFile}`,
          ].join('\n'),
        )
        return 1
      }

      report.planData = plan
      report.finishedAt = new Date().toISOString()
      fs.mkdirSync(path.dirname(reportFile), { recursive: true })
      fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
      emit(
        report,
        [
          `${TOOL} — relocate-sessions OK`,
          ...report.steps.map((step) => `  ok    ${step.name} (${step.ms}ms)`),
          `  backup      : ${report.backup?.dir}`,
          `  verification: ${report.verification?.checked} checks, ${report.verification?.ok ? 'ALL PASS' : 'FAILURES'}`,
          `  workspace.json left to the caller (${plan.metadata.workspaceJsonSkipped.length} patch(es) deferred)`,
          `  report      : ${reportFile}`,
        ].join('\n'),
      )
      return 0
    }

    if (command === 'rollback') {
      if (options.yes !== true) {
        process.stderr.write('refusing to mutate without --yes\n')
        return 2
      }
      const plan = loadPlanFromOptions(options)
      const result = rollbackRun(plan, options)
      result.tool = TOOL
      result.version = VERSION
      result.command = 'rollback'
      result.ok = result.verification?.ok === true
      const human = [
        `${TOOL} — rollback ${result.ok ? 'OK' : 'INCOMPLETE'}`,
        ...result.steps.map((step) => `  ${step.status === 'ok' ? 'ok   ' : 'FAIL '} ${step.name}`),
        `  backup      : ${result.backupRoot}`,
        `  verification: ${result.verification?.ok ? 'ALL PASS (original state)' : `${result.verification?.failures?.length ?? '?'} FAILURE(S)`}`,
      ].join('\n')
      emit(result, human)
      return result.ok ? 0 : 1
    }

    process.stderr.write(`unknown command "${command}"\n\n${USAGE}\n`)
    return 2
  } catch (error) {
    const message = String(error?.message ?? error)
    if (json) process.stdout.write(`${JSON.stringify({ tool: TOOL, command, ok: false, error: message }, null, 2)}\n`)
    else process.stderr.write(`${TOOL}: ${message}\n`)
    return 1
  }
}

function writeReport(plan, report) {
  try {
    const dir = plan.stage?.dir ?? (typeof plan.env?.runRoot === 'string' ? plan.env.runRoot : undefined)
    if (dir === undefined) return
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2))
  } catch {
    /* a report is best-effort */
  }
}

process.exitCode = main()
