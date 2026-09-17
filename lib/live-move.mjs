/**
 * Live (no-restart) workspace relocation, orchestrated through DSH's own services.
 *
 * Why this lives above the engine rather than replacing it: the FILE work (rewriting
 * frame 0 of each session log, moving the session directory under the new projectKey,
 * fixing the projection cache) is the part that must never be reimplemented — it is
 * covered by the engine's own sandbox suite. The MEMORY work (the workspace registry's
 * in-memory entities and index maps) is the part only a running DSH can do. So this
 * module owns the memory work and delegates the file work to the engine.
 *
 * Scope: COLD SESSIONS ONLY. A live session would additionally require flushing the
 * live handle, holding the persistence coordinator's per-id lock, rebinding the live
 * writer and rolling back the live header — the complexity dsh-session-manager pays
 * ~200 lines of private-surface work for. Sessions being re-homed across workspaces are
 * cold by definition, so this refuses rather than guesses.
 *
 * Every mutation registers its own inverse on an undo stack, and every failure path
 * unwinds that stack, so the four layers (project directory → workspace registration →
 * files → in-memory registry) never end up disagreeing.
 *
 * Everything touching a private surface is probed (`typeof x === "function"`) and
 * skipped when absent: the worst degradation is "grouping is only correct after a
 * restart", never a thrown error.
 *
 * On `sessionProjectionCache` — deliberately NOT called from here:
 * its public contract is `coldSnapshot(meta, inheritedEventCount, events)`, which demands
 * the session's complete event log in seq order; the one-argument `coldSnapshot(id)` that
 * dsh-session-manager calls is a concrete-backend extra, not a contract. What the cache
 * actually needs after a move is that the stored `identity.cwd` matches the session's
 * header, because `cachedSnapshot` uses the caller's header as "the identity witness".
 * The engine rewrites exactly that field at the file level, on a per-session record.
 * Cold sessions have only three durable write points — creation, `turn/end`, disposal —
 * none of which fire while a session stays closed, so the file edit is not raced by a
 * write-behind, and the cache self-heals on the next write if it ever diverges.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { projectKey, relocateSessionLog } from './zstd-frames.mjs'

/** The engine shipped beside this module. */
const ENGINE = fileURLToPath(new URL('./dsh-workspace-migrate.mjs', import.meta.url))

/** One engine run may legitimately take minutes on a large store. */
const ENGINE_TIMEOUT_MS = 300000

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
}

/** Call a probe without letting an unexpected throw escape. */
function attempt(fn, fallback) {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function messageOf(error) {
  return String((error && error.message) || error)
}

// ─────────────────────────────────────────────────────────────────────────────
// Live-session support
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The rebindable write handle for a session, when this DSH build exposes one.
 *
 * Verified against a live host: `sessionPersistence.tracker.writers` is a
 * `Map<SessionId, handle>`, and the handle's `header` is a WRITABLE property at runtime
 * (declared readonly on the TypeScript surface) from which the backend derives the
 * artifact path. Rewriting that property therefore retargets every later append without
 * replacing the handle the running agent still holds.
 *
 * This is a private surface, mirroring what dsh-session-manager probes for. It is read
 * defensively: an absent tracker simply means live relocation is unavailable here.
 */
export function liveWriterOf(persistence, sessionId) {
  if (persistence === undefined || persistence === null) return undefined
  const tracker = attempt(() => persistence.tracker, undefined)
  const writers = tracker === undefined || tracker === null ? undefined : attempt(() => tracker.writers, undefined)
  return typeof writers?.get === 'function' ? attempt(() => writers.get(sessionId), undefined) : undefined
}

/** Whether a session currently holds a live write handle, even without a live Session. */
export function hasLiveWriter(persistence, sessionId) {
  const writer = liveWriterOf(persistence, sessionId)
  return writer !== undefined && writer !== null
}

/** Whether a writer's header can actually be retargeted on this build. */
export function isRebindable(writer) {
  return writer !== undefined && writer !== null && typeof writer.header === 'object' && writer.header !== null
}

/** Await a probe without letting an unexpected rejection escape. */
async function attemptAsync(fn, fallback) {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

/** Remove a directory when it is empty; best-effort, never throws. */
function removeIfEmpty(directory) {
  try {
    if (directory.length > 0 && fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory)
  } catch {
    /* best-effort */
  }
}

/** Whether a path is a directory that holds nothing; false when missing or unreadable. */
function isEmptyDirectory(directory) {
  try {
    return fs.statSync(directory).isDirectory() && fs.readdirSync(directory).length === 0
  } catch {
    return false
  }
}

/**
 * The session storage root, preferring the persistence backend's own answer. DSH may be
 * configured with a shared root that is not `$DSH_HOME/sessions`.
 */
export function sessionsRootFrom(services) {
  const persistence = services.get('sessionPersistence')
  const root = persistence === undefined || persistence === null ? undefined : attempt(() => persistence.root, undefined)
  return typeof root === 'string' && root.length > 0 ? root : join(dshHome(), 'sessions')
}

/**
 * Where a session's current artifact lives, derived from a header.
 *
 * `sessionPersistence.locate(header)` is the backend's own answer and is preferred; the
 * documented `sessions/<projectKey(cwd)>/<sessionId>/session*.jsonl.zstd` layout is the
 * fallback, which can only name an existing file.
 */
export function artifactPathFor(persistence, header, sessionId, sessionsRoot, fallbackFileName) {
  if (persistence !== undefined && persistence !== null && typeof persistence.locate === 'function') {
    const located = attempt(() => persistence.locate(header), undefined)
    const locatedPath = located === undefined || located === null ? undefined : located.path
    if (typeof locatedPath === 'string' && locatedPath.length > 0) return locatedPath
  }
  if (typeof header.cwd !== 'string' || header.cwd.length === 0) return undefined
  const dir = join(sessionsRoot, projectKey(header.cwd), sessionId)
  if (fallbackFileName !== undefined) return join(dir, fallbackFileName)
  if (!fs.existsSync(dir)) return undefined
  const names = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl.zstd'))
    .sort()
  return names.length === 0 ? undefined : join(dir, names[names.length - 1])
}

/**
 * Build the replacement header the host will accept: the SAME prototype, the same fields, a
 * new `cwd`, frozen.
 *
 * `Object.assign({}, header, { cwd })` is not good enough. A live Session's header is a plain
 * frozen JSON object created in the host realm, while this module runs in the Cordis plugin
 * sandbox realm — measured on a live session, the plain copy came back with a *different*
 * `Object.prototype`, and DSH rejects exactly that shape on the restore path:
 *
 *   // dsh-session/lib/types/index.js:68-76
 *   if (prototype !== Object.prototype && prototype !== null)
 *     throw new Error('session header is not a plain JSON record')
 *
 * Inheriting the original prototype keeps the header indistinguishable from DSH's own. Verified
 * against the live session of the running conversation: the write is accepted, the prototype
 * survives, `persistence.stat(id)` still answers, and the workspace registry still reads the
 * header afterwards.
 */
export function headerWithCwd(header, cwd) {
  const source = header !== null && typeof header === 'object' ? header : {}
  const prototype = Object.getPrototypeOf(source)
  const next = Object.create(prototype === undefined ? null : prototype)
  Object.assign(next, source, { cwd })
  return Object.freeze(next)
}

/**
 * Relocate ONE live session's artifact in process, and retarget its writer.
 *
 * Why in process, and why synchronously: the move must never be interleaved with a writer
 * append. Node runs a single event loop, so a stretch of code containing no `await` cannot
 * be interleaved — a stronger guarantee than the per-session lock this build does not
 * expose (`sessionPersistence.coordinator` is absent here). The sequence is:
 *
 *   1. flush the session, so every buffered event is durable in the OLD artifact;
 *   2. with no `await` in between: rewrite frame 0, move the artifact, and rewrite the
 *      writer's header, so an append that was already queued reads the NEW header when it
 *      finally runs and lands in the new file;
 *   3. leave the registry update to the caller.
 *
 * @returns `{ fromFile, toFile, previousCwd, frameCount, bytes, writerRebound, liveHeaderUpdated }`.
 */
export async function relocateLiveSession({ services, session, sessionId, newCwd, sessionsRoot }) {
  const sessions = services.get('sessions')
  const persistence = services.get('sessionPersistence')

  const writer = liveWriterOf(persistence, sessionId)
  if (!isRebindable(writer)) {
    throw new Error(
      `this DSH runtime exposes no rebindable live persistence writer for '${sessionId}', so a running session cannot be relocated safely — close that conversation and retry`,
    )
  }

  // A session can hold a writer without a live Session object (the UI closed but the handle
  // lingers); the writer's own header is then the authority.
  const oldHeader =
    session !== undefined && session !== null && session.header !== undefined && session.header !== null ? session.header : writer.header
  if (oldHeader === undefined || oldHeader === null || typeof oldHeader.cwd !== 'string') {
    throw new Error(`the live session '${sessionId}' carries no cwd to relocate from`)
  }
  const previousCwd = oldHeader.cwd

  // Step 1: make the OLD artifact the complete, durable record before anything moves.
  // `sessions.flush` takes a Session object, so it is only usable when one exists: a
  // session can hold a write handle without a live Session (verified against the real
  // host — calling `sessions.flush(undefined)` throws inside DSH reading `session.id`).
  if (session !== undefined && session !== null && sessions !== undefined && typeof sessions.flush === 'function') {
    await sessions.flush(session)
  } else if (typeof writer.flush === 'function') {
    await writer.flush()
  }

  const fromFile = artifactPathFor(persistence, oldHeader, sessionId, sessionsRoot)
  if (fromFile === undefined || !fs.existsSync(fromFile)) {
    throw new Error(`could not locate the current artifact of '${sessionId}'`)
  }
  const fileName = fromFile.slice(fromFile.lastIndexOf('/') + 1).split('\\').pop()
  // Only `cwd` is read from this copy (to derive the destination path); it is never handed to
  // the host, so it does not need the original prototype.
  const destinationHeader = Object.assign({}, oldHeader, { cwd: newCwd })
  const toFile = artifactPathFor(persistence, destinationHeader, sessionId, sessionsRoot, fileName)
  if (toFile === undefined) throw new Error(`could not derive the destination artifact path for '${sessionId}'`)

  // Step 2: no `await` from here until the writer has been retargeted.
  const moved = relocateSessionLog(fromFile, toFile, newCwd)
  writer.header = headerWithCwd(writer.header, newCwd)

  // The artifact left an empty session directory behind. Left in place it reads as an
  // unrecognizable session entry under the OLD project key, so drop it — and the old
  // project key directory itself when nothing else lives there. Both are best-effort; a
  // leftover empty directory is untidy, not corrupt.
  removeIfEmpty(dirname(fromFile))
  removeIfEmpty(dirname(dirname(fromFile)))

  // The live Session's own header keeps the UI and future reads honest — built so the host
  // still recognizes it as its own plain JSON record. The property is writable at runtime on
  // this build; if a build makes it read-only we simply skip it, because the writer is what
  // determines the file.
  let liveHeaderUpdated = false
  try {
    session.header = headerWithCwd(session.header, newCwd)
    liveHeaderUpdated = true
  } catch {
    liveHeaderUpdated = false
  }

  return {
    fromFile,
    toFile,
    previousCwd,
    frameCount: moved.frameCount,
    bytes: moved.bytes,
    writerRebound: true,
    liveHeaderUpdated,
  }
}

/** Undo one `relocateLiveSession` after a later layer failed. */
export function undoRelocateLiveSession(services, session, sessionId, relocation, sessionsRoot) {
  const persistence = services.get('sessionPersistence')
  const writer = liveWriterOf(persistence, sessionId)
  const restored = relocateSessionLog(relocation.toFile, relocation.fromFile, relocation.previousCwd)
  if (isRebindable(writer)) {
    writer.header = headerWithCwd(writer.header, relocation.previousCwd)
  }
  if (session !== undefined && session !== null) {
    try {
      session.header = headerWithCwd(session.header, relocation.previousCwd)
    } catch {
      /* best effort */
    }
  }
  void sessionsRoot
  return restored
}

/** Compare two filesystem paths the way the host does: case-insensitively on Windows. */
export function pathEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const strip = (value) => value.replace(/[\\/]+$/, '')
  const left = strip(a)
  const right = strip(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** A workspace entity's path, tolerating both the entity and its `record` shape. */
export function entityPath(entity) {
  if (entity === null || entity === undefined) return undefined
  const fromRecord = attempt(() => entity.record && entity.record.path, undefined)
  if (typeof fromRecord === 'string') return fromRecord
  return typeof entity.path === 'string' ? entity.path : undefined
}

/** A workspace entity's session ids, tolerating both shapes. */
export function entitySessionIds(entity) {
  if (entity === null || entity === undefined) return []
  const fromRecord = attempt(() => entity.record && entity.record.sessionIds, undefined)
  const list = Array.isArray(fromRecord) ? fromRecord : attempt(() => entity.sessionIds, undefined)
  if (!Array.isArray(list)) return []
  return list.filter((id) => typeof id === 'string' && id.length > 0)
}

function entityTitle(entity) {
  const value = attempt(() => entity.title, undefined)
  if (typeof value === 'string' && value.length > 0) return value
  const fromRecord = attempt(() => entity.record && entity.record.title, undefined)
  return typeof fromRecord === 'string' ? fromRecord : undefined
}

/**
 * Move a project directory. Cross-volume moves on Windows are a robocopy job; robocopy
 * exit codes 0-7 are success, 8+ is failure.
 *
 * @param options.replaceEmptyDestination - take over a destination that exists but holds
 *   nothing. `robocopy /E /MOVE` leaves the source ROOT directory behind once it has moved
 *   everything, so undoing such a move finds the original path occupied by an empty husk;
 *   without this the rollback fails and the project is left half-moved. A destination with
 *   any content in it is still refused, whatever the flag says.
 * @returns `{ ok, mode }` or `{ ok: false, error, detail }`.
 */
export function moveProjectDirectory(from, to, { replaceEmptyDestination = false } = {}) {
  if (typeof from !== 'string' || from.length === 0 || typeof to !== 'string' || to.length === 0) {
    return { ok: false, error: 'moveProjectDirectory needs both a source and a destination' }
  }
  if (!fs.existsSync(from)) return { ok: false, error: `the source project directory does not exist: ${from}` }
  if (fs.existsSync(to)) {
    if (!replaceEmptyDestination || !isEmptyDirectory(to)) {
      return { ok: false, error: `the destination already exists: ${to}` }
    }
    try {
      fs.rmdirSync(to)
    } catch (error) {
      return { ok: false, error: `the destination already exists and could not be removed: ${to} (${messageOf(error)})` }
    }
  }

  if (process.platform === 'win32') {
    const args = [from, to, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:2', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/MOVE']
    const result = spawnSync('robocopy', args, { windowsHide: true, encoding: 'utf8' })
    if (result.error !== undefined && result.error !== null) {
      return { ok: false, error: `robocopy could not start: ${messageOf(result.error)}` }
    }
    const code = result.status ?? -1
    if (code < 0 || code >= 8) {
      return { ok: false, error: `robocopy failed with exit code ${code}`, detail: `${result.stdout ?? ''}`.slice(-2000) }
    }
    // `/MOVE` empties the source but routinely leaves its root directory behind. It is empty
    // by now, so removing it keeps "the project is now at <to>" literally true — and keeps a
    // later rollback from finding the original path already occupied.
    removeIfEmpty(from)
    return { ok: true, mode: 'robocopy /E /MOVE' }
  }

  try {
    fs.cpSync(from, to, { recursive: true })
    fs.rmSync(from, { recursive: true, force: true })
    return { ok: true, mode: 'cp + rm' }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

/** Run one engine invocation and return its parsed JSON verdict. */
function spawnEngine(argv) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(process.execPath, [ENGINE, ...argv], {
        cwd: homedir(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, error: `could not start the engine: ${messageOf(error)}` })
      return
    }
    const stdout = []
    const stderr = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      attempt(() => child.kill())
      resolve({ ok: false, error: `the engine did not finish within ${ENGINE_TIMEOUT_MS} ms` })
    }, ENGINE_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, error: `engine process error: ${messageOf(error)}` })
    })
    child.on('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const out = Buffer.concat(stdout).toString('utf8')
      const err = Buffer.concat(stderr).toString('utf8')
      let json
      try {
        json = JSON.parse(out)
      } catch {
        json = undefined
      }
      if (json === undefined) {
        resolve({ ok: false, exitCode, error: `the engine returned no parsable JSON (exit ${String(exitCode)})`, stderr: err.slice(0, 4000) })
        return
      }
      resolve({ ok: true, exitCode, json, stderr: err.slice(0, 2000) })
    })
  })
}

/**
 * Read-only precondition report for a live relocation. Exposed separately so the UI can
 * show exactly why a move would be refused before the user commits to it.
 * @param services - anything with `get(name)` (a cordis ctx, or a test double).
 * @param options - `{ fromPath, toPath, sessionIds?, moveProject? }`.
 */
export async function inspectLiveMove(services, options) {
  const from = options.fromPath
  const to = options.toPath
  const blockers = []
  const notes = []

  const project = {
    willMove: options.moveProject === true,
    sourceExists: typeof from === 'string' ? fs.existsSync(from) : false,
    destinationExists: typeof to === 'string' ? fs.existsSync(to) : false,
  }
  if (project.willMove) {
    if (!project.sourceExists) blockers.push(`the source project directory does not exist: ${from}`)
    if (project.destinationExists) {
      blockers.push(`the destination already exists: ${to} — remove it, or leave the project where it is and move it yourself`)
    }
  }

  const registry = services.get('workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') {
    return { ok: false, blockers: blockers.concat('the workspaceRegistry service is unavailable in this Host'), notes, source: null, sessionIds: [], project, from, to }
  }
  const entities = attempt(() => registry.list(), [])
  if (!Array.isArray(entities)) {
    return { ok: false, blockers: blockers.concat('the workspace registry could not be listed'), notes, source: null, sessionIds: [], project, from, to }
  }

  const source = entities.find((entity) => pathEquals(entityPath(entity), from))
  if (source === undefined) {
    return { ok: false, blockers: blockers.concat(`no registered workspace has the path ${from}`), notes, source: null, sessionIds: [], project, from, to }
  }

  const targetExisting = entities.find((entity) => pathEquals(entityPath(entity), to))
  if (targetExisting !== undefined) {
    notes.push(`a workspace is already registered at ${to}; its registration will be reused, not duplicated`)
  } else if (!project.destinationExists && !project.willMove) {
    // `registry.create()` realpaths its argument, so the directory must already exist.
    // With moveProject the directory is created by the move; without it the user is
    // expected to have moved the project themselves, and a missing path here is a
    // misunderstanding worth naming rather than a raw realpath error later.
    blockers.push(
      `the destination ${to} neither exists on disk nor is a registered workspace — move the project there first, or turn on the option that moves the project directory too`,
    )
  }

  const indexed = entitySessionIds(source)

  // The workspace entity's `sessionIds` is an index projection, not the source of truth: a
  // session created after startup — or one whose index entry was lost — is absent from it
  // while still being stored with this cwd. Verified against a live host: a session created
  // through `sessionPersistence.create({ cwd })` never appears in the entity's list. So the
  // registry index is unioned with persistence, which lists every stored session + header.
  const discovered = []
  const persistence = services.get('sessionPersistence')
  if (persistence !== undefined && typeof persistence.list === 'function') {
    try {
      const all = await persistence.list()
      for (const entry of Array.isArray(all) ? all : []) {
        const header = entry === null || entry === undefined ? undefined : entry.header
        if (header === undefined || header === null) continue
        if (typeof header.id === 'string' && typeof header.cwd === 'string' && pathEquals(header.cwd, from)) {
          discovered.push(header.id)
        }
      }
    } catch (error) {
      notes.push(`sessionPersistence.list() failed, so only the registry index was searched: ${messageOf(error)}`)
    }
  } else {
    notes.push('the sessionPersistence service is unavailable, so only the registry index was searched')
  }

  const all = [...new Set([...indexed, ...discovered])]
  const unindexed = discovered.filter((id) => !indexed.includes(id))
  if (unindexed.length > 0) {
    notes.push(`${unindexed.length} session(s) with this cwd are stored but not indexed on the workspace; they are included`)
  }

  const requested =
    Array.isArray(options.sessionIds) && options.sessionIds.length > 0 ? all.filter((id) => options.sessionIds.includes(id)) : all
  if (requested.length === 0) {
    blockers.push('the source workspace has no sessions to move')
  }

  const sessions = services.get('sessions')
  const agents = services.get('agents')

  // A session can be live for two independent reasons: a Session object exists in this
  // process (opened in the UI / being driven), and/or a write handle exists. Either way it
  // must be relocated in process rather than by the spawned engine, and that is only safe
  // when this build exposes a rebindable writer.
  const liveIds = []
  const notRelocatable = []
  for (const id of requested) {
    const liveSession = sessions !== undefined && typeof sessions.get === 'function' ? attempt(() => sessions.get(id), undefined) : undefined
    const liveAgent = agents !== undefined && typeof agents.get === 'function' ? attempt(() => agents.get(id), undefined) : undefined
    const writer = liveWriterOf(persistence, id)
    const isLive = liveSession !== undefined || liveAgent !== undefined || (writer !== undefined && writer !== null)
    if (!isLive) continue
    if (isRebindable(writer)) {
      liveIds.push(id)
      continue
    }
    notRelocatable.push({
      id,
      reason:
        writer === undefined || writer === null
          ? 'running, and this DSH build exposes no live persistence writer to retarget'
          : 'its live writer cannot be retargeted on this DSH build',
    })
  }
  for (const entry of notRelocatable) {
    blockers.push(`${entry.id}: ${entry.reason}`)
  }
  if (notRelocatable.length > 0) {
    blockers.push(
      'refusing the whole move because at least one running session cannot be relocated safely — close those conversations first',
    )
  }
  if (liveIds.length > 0) {
    notes.push(`${liveIds.length} session(s) are running and will be relocated in process, without interrupting them`)
  }
  if (sessions === undefined || typeof sessions.get !== 'function') {
    notes.push('the sessions service is unavailable, so the cold-session check could not be performed')
  }
  if (agents === undefined || typeof agents.get !== 'function') {
    notes.push('the agents service is unavailable, so the live-agent check could not be performed')
  }

  return { ok: blockers.length === 0, blockers, notes, source, targetExisting, sessionIds: requested, liveIds, project, from, to }
}

/**
 * Relocate a workspace onto another path, live.
 *
 * The four layers run in dependency order and unwind in reverse on any failure:
 *   1. project directory (optional)   2. destination workspace registration
 *   3. session artifacts (the engine) 4. the in-memory workspace registry
 *
 * @param services - anything with `get(name)`.
 * @param options - `{ fromPath, toPath, title?, sessionIds?, moveProject? }`.
 * @returns a structured result naming every mutation it made and how it undid them.
 */
/**
 * Persist the report of one live move, then hand it back unchanged.
 *
 * A live move rewrites artifacts, the workspace registry and the host's in-memory writer, so
 * when a later layer fails the report is the only durable account of what was done and what
 * was unwound. Writing is best-effort on purpose — a failed write must never turn a finished
 * move into a failed one — and the path is handed back only when the file is really there,
 * so a printed "report" path always names a real file.
 */
function writeLiveReport(result) {
  if (result === null || result === undefined || typeof result.reportFile !== 'string') return result
  const written = attempt(() => {
    fs.mkdirSync(dirname(result.reportFile), { recursive: true })
    fs.writeFileSync(result.reportFile, JSON.stringify(result, null, 2))
    return true
  }, false)
  return written === true ? result : Object.assign({}, result, { reportFile: undefined })
}

/**
 * Move a workspace, its project directory and its sessions to a new path without stopping DSH.
 *
 * @see runLiveMove for the layers and the undo stack.
 */
export async function liveMoveSessions(services, options) {
  return writeLiveReport(await runLiveMove(services, options))
}

async function runLiveMove(services, options) {
  const pre = await inspectLiveMove(services, options)
  if (!pre.ok) {
    return { ok: false, stage: 'precondition', blockers: pre.blockers, notes: pre.notes }
  }

  const registry = services.get('workspaceRegistry')
  const entities = attempt(() => registry.list(), [])
  const source = entities.find((entity) => pathEquals(entityPath(entity), pre.from))
  const existingTarget = entities.find((entity) => pathEquals(entityPath(entity), pre.to))
  const sessionIds = pre.sessionIds
  const notes = [...pre.notes]
  const reportFile = join(dshHome(), 'migration-runs', `live-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)

  // The inspection just proved these exist, but the registry is live state: re-check
  // rather than dereference a possibly-stale result.
  if (source === undefined) {
    return {
      ok: false,
      stage: 'precondition',
      blockers: [`the source workspace ${pre.from} left the registry between the check and the move`],
      reportFile,
      notes,
    }
  }

  /** Each entry undoes one completed mutation. Unwound newest-first. */
  const undo = []
  let filesRestored = null

  const rollback = async () => {
    const errors = []
    for (const entry of undo.splice(0).reverse()) {
      try {
        await entry.run()
      } catch (error) {
        errors.push(`${entry.name}: ${messageOf(error)}`)
      }
    }
    return errors
  }

  // ── layer 1: the project directory ────────────────────────────────────────
  if (pre.project.willMove) {
    const moved = moveProjectDirectory(pre.from, pre.to)
    if (!moved.ok) {
      return { ok: false, stage: 'project-directory', blockers: [moved.error], detail: moved.detail, reportFile, notes }
    }
    undo.push({
      name: 'project-directory',
      run: () => {
        // The forward move leaves the original path as an empty directory on Windows, so the
        // undo must be allowed to take it over — otherwise the rollback fails and the project
        // ends up half-moved.
        const back = moveProjectDirectory(pre.to, pre.from, { replaceEmptyDestination: true })
        if (!back.ok) throw new Error(back.error)
      },
    })
    notes.push(`project directory moved (${moved.mode}): ${pre.from} -> ${pre.to}`)
  }

  // ── layer 2: the destination registration ────────────────────────────────
  let target = existingTarget
  let createdWorkspace = false
  if (target === undefined) {
    try {
      target = await registry.create(pre.to, options.title)
    } catch (error) {
      const undoErrors = await rollback()
      return {
        ok: false,
        stage: 'create-workspace',
        blockers: [`could not register a workspace at ${pre.to}: ${messageOf(error)}`],
        undoErrors,
        reportFile,
        notes,
      }
    }
    if (target === undefined) {
      const undoErrors = await rollback()
      return { ok: false, stage: 'create-workspace', blockers: [`registry.create(${pre.to}) returned nothing`], undoErrors, reportFile, notes }
    }
    createdWorkspace = true
    const createdId = attempt(() => target.id, undefined)
    undo.push({
      name: 'workspace-registration',
      run: async () => {
        if (createdId !== undefined && typeof registry.delete === 'function') await registry.delete(createdId)
      },
    })
  } else {
    notes.push(`reusing the workspace already registered at ${pre.to}`)
  }

  // ── layer 3: the session artifacts ───────────────────────────────────────
  //
  // Two mechanisms, chosen per session:
  //   · COLD sessions go to the spawned engine. A separate process is safe here precisely
  //     because a cold session has no writer that could append mid-move.
  //   · RUNNING sessions must be relocated in process: the artifact move has to be
  //     interleaved with the live writer on this same event loop, and the writer's header
  //     has to be retargeted in the same uninterrupted stretch (see relocateLiveSession).
  const liveIdSet = new Set(Array.isArray(pre.liveIds) ? pre.liveIds : [])
  const liveSessionIds = sessionIds.filter((id) => liveIdSet.has(id))
  const coldIds = sessionIds.filter((id) => !liveIdSet.has(id))

  let engine = null
  if (coldIds.length > 0) {
    engine = await spawnEngine([
      'relocate-sessions',
      '--from', pre.from,
      '--to', pre.to,
      '--sessions', coldIds.join(','),
      '--yes',
      '--allow-running',
      '--report', reportFile,
      '--json',
    ])

    if (!(engine.ok === true && engine.json !== undefined && engine.json.status === 'ok')) {
      const undoErrors = await rollback()
      const engineErrors = Array.isArray(engine.json?.errors) ? engine.json.errors : []
      const engineBlockers = Array.isArray(engine.json?.blockers) ? engine.json.blockers : []
      const reported = [...engineErrors, ...engineBlockers].join('; ')
      const stderrTail =
        typeof engine.stderr === 'string' && engine.stderr.trim() !== '' ? engine.stderr.trim().split('\n').slice(-6).join('\n') : undefined
      // The engine reports a refusal as `errors: []` and a crash as `error: "..."`; neither
      // should ever degrade into "the engine refused the relocation" with no reason at all.
      const reason =
        engine.error ??
        engine.json?.error ??
        (reported !== '' ? reported : undefined) ??
        (engine.json === undefined
          ? `the engine produced no parsable JSON (exit ${String(engine.exitCode)})${stderrTail === undefined ? '' : `: ${stderrTail}`}`
          : `the engine reported status "${String(engine.json?.status)}" with no reason (exit ${String(engine.exitCode)})`)
      return {
        ok: false,
        stage: 'file-layer',
        blockers: [reason],
        engineReport: engine.json,
        engineDetail: [...engineErrors, ...engineBlockers],
        reportFile,
        registrationUndone: createdWorkspace && !undoErrors.some((entry) => entry.startsWith('workspace-registration')),
        undoErrors,
        notes,
      }
    }
    undo.push({
      name: 'session-artifacts',
      run: async () => {
        const result = await spawnEngine(['relocate-sessions', '--rollback', '--report', reportFile, '--yes', '--json'])
        filesRestored = result.ok === true && result.json?.ok === true
        if (!filesRestored) throw new Error('the engine rollback did not report success')
      },
    })
  } else {
    notes.push('every session is running, so the spawned engine was not used at all')
  }

  const liveRelocations = []
  if (liveSessionIds.length > 0) {
    const sessionsService = services.get('sessions')
    const root = sessionsRootFrom(services)
    for (const id of liveSessionIds) {
      const liveSession =
        sessionsService !== undefined && typeof sessionsService.get === 'function' ? attempt(() => sessionsService.get(id), undefined) : undefined
      try {
        const relocation = await relocateLiveSession({
          services,
          session: liveSession,
          sessionId: id,
          newCwd: pre.to,
          sessionsRoot: root,
        })
        liveRelocations.push({ id, session: liveSession, relocation })
      } catch (error) {
        // Undo the running sessions already relocated, then everything else, in the usual
        // order (files and project first, then re-attach to the source).
        const liveUndoErrors = []
        for (const done of [...liveRelocations].reverse()) {
          try {
            undoRelocateLiveSession(services, done.session, done.id, done.relocation)
          } catch (undoError) {
            liveUndoErrors.push(`${done.id}: ${messageOf(undoError)}`)
          }
        }
        const undoErrors = await rollback()
        return {
          ok: false,
          stage: 'live-file-layer',
          blockers: [messageOf(error)],
          rollback: { memoryErrors: liveUndoErrors, filesRestored: liveRelocations.length === 0 ? null : true, undoErrors },
          reportFile,
          notes,
        }
      }
    }
    undo.push({
      name: 'live-session-artifacts',
      run: async () => {
        for (const done of [...liveRelocations].reverse()) {
          undoRelocateLiveSession(services, done.session, done.id, done.relocation)
        }
      },
    })
  }

  // A relocated running session keeps its projection-cache row keyed by the OLD identity
  // until something checkpoints it. The cache's `write(session)` is the service's own
  // durable checkpoint, so ask for one now that the session's header carries the new cwd.
  const projectionCache = services.get('sessionProjectionCache')
  if (projectionCache !== undefined && typeof projectionCache.write === 'function') {
    for (const done of liveRelocations) {
      if (done.session === undefined) continue
      const written = await attemptAsync(() => projectionCache.write(done.session), undefined)
      if (written === undefined) notes.push(`the projection cache could not be checkpointed for ${done.id}; it self-heals on the next write`)
    }
  }

  // ── layer 4: the in-memory workspace registry ────────────────────────────
  //
  // FIRST invalidate the registry's cached header for each session. Verified in
  // `dsh-workspace/lib/index.js`:
  //
  //   attachSession(id) → this.host.readSessionHeader(id)
  //   readSessionHeader(id) → const cached = this.headers.get(id)
  //                           if (cached !== undefined) return cached          // cache hit
  //                           ...await this.listStoredHeaders() /* disk */     // cache miss
  //   attachSession then does realpathNormalize(header.cwd) and requires it to equal
  //   the target workspace path.
  //
  // So a stale `registry.headers` entry makes the validation resolve the OLD cwd (which the
  // project-directory move has just removed) and the attach fails — which is exactly what a
  // live run reproduced. Deleting the entry is both necessary and sufficient: the miss path
  // re-reads the truth from disk, which the engine has already rewritten. Deleting is also
  // more honest than retargeting, because it never has to guess the header's shape.
  const invalidated = new Map()
  const headerIndex = attempt(() => registry.headers, undefined)
  if (headerIndex !== undefined && typeof headerIndex.get === 'function' && typeof headerIndex.delete === 'function') {
    for (const id of sessionIds) {
      const previous = attempt(() => headerIndex.get(id), undefined)
      if (previous !== undefined) {
        invalidated.set(id, previous)
        headerIndex.delete(id)
      }
    }
    if (invalidated.size > 0) {
      undo.push({
        name: 'header-index-invalidation',
        run: async () => {
          for (const [id, previous] of invalidated) headerIndex.set(id, previous)
        },
      })
    }
  } else {
    notes.push('the registry exposes no header index to invalidate; validation will read from disk')
  }

  const detached = []
  const attached = []
  // A session discovered through persistence may never have been attached to the source
  // workspace; detaching it would be pointless, and on a strict implementation an error.
  const sourceIndexed = new Set(entitySessionIds(source))
  const move = async () => {
    for (const id of sessionIds) {
      if (sourceIndexed.has(id)) {
        await source.detachSession(id)
        detached.push(id)
      }
      // attachSession validates the (now uncached) header against the target path and
      // records the session's new path itself, so sessionPaths needs no hand-maintenance.
      await target.attachSession(id)
      attached.push(id)
    }
  }

  let memoryError = null
  try {
    if (typeof registry.enqueueOperation === 'function') await registry.enqueueOperation(move)
    else await move()
  } catch (error) {
    memoryError = messageOf(error)
  }

  if (memoryError !== null) {
    const memoryErrors = []
    for (const id of attached) {
      try {
        await target.detachSession(id)
      } catch (error) {
        memoryErrors.push(messageOf(error))
      }
    }
    // Order matters: restore the files and the project directory FIRST, because
    // re-attaching to the source validates realpath(header.cwd) — which cannot resolve
    // until the project directory is back where it started.
    const undoErrors = await rollback()
    for (const id of detached) {
      try {
        await source.attachSession(id)
      } catch (error) {
        memoryErrors.push(messageOf(error))
      }
    }
    return {
      ok: false,
      stage: 'memory-layer',
      blockers: [`the workspace registry refused the re-point: ${memoryError}`],
      rollback: { memoryErrors, filesRestored: filesRestored === true, undoErrors },
      reportFile,
      notes,
    }
  }

  // ── opportunistic index repair ───────────────────────────────────────────
  // Host-internal maps with no public contract. Their shapes were verified against a live
  // host by a read-only probe:
  //   registry.headers          : Map<sessionId, SessionHeader>  — a BARE header, so its
  //                               `cwd` sits at the top level, not under a `header` key.
  //   registry.sessionPaths     : Map<sessionId, canonical cwd>  — the workspace path, NOT
  //                               a log file path. Maintained by the registry itself:
  //                               `attachSession` calls `rememberSessionPath(id, cwd)`, so
  //                               this module never writes it by hand.
  //   registry.invalidSessionPaths : Map<sessionId, ...>         — entries are dropped.
  //
  // The header cache was already invalidated before the attach (see layer 4), which is the
  // one repair that is actually load-bearing.
  const repaired = invalidated.size > 0 ? [...invalidated.keys()].map((id) => `headers:${id}`) : []
  const skipped = []
  if (invalidated.size === 0 && headerIndex === undefined) skipped.push('headers')

  const invalidIndex = attempt(() => registry.invalidSessionPaths, undefined)
  if (invalidIndex !== undefined && typeof invalidIndex.delete === 'function') {
    for (const id of sessionIds) {
      invalidIndex.delete(id)
      repaired.push(`invalidSessionPaths:${id}`)
    }
  } else {
    skipped.push('invalidSessionPaths')
  }

  if (skipped.length > 0) {
    notes.push(
      `host index maps not touched (${[...new Set(skipped.map((entry) => entry.split(':')[0]))].join(', ')}); the sidebar may keep the old grouping until the next DSH restart`,
    )
  }

  return {
    ok: true,
    stage: 'done',
    from: pre.from,
    to: pre.to,
    workspaceId: attempt(() => target.id, undefined),
    workspaceTitle: entityTitle(target),
    workspaceCreated: createdWorkspace,
    projectMoved: pre.project.willMove,
    sessionIds,
    movedCount: attached.length,
    reportFile,
    engineReport: engine === null ? null : engine.json,
    liveRelocated: liveRelocations.map((done) => ({
      sessionId: done.id,
      artifactFrom: done.relocation.fromFile,
      artifactTo: done.relocation.toFile,
      frames: done.relocation.frameCount,
      liveHeaderUpdated: done.relocation.liveHeaderUpdated,
    })),
    notes,
    indexRepaired: repaired,
    indexSkipped: skipped,
  }
}

/** Mirror of the engine's projectKey, used only for reporting paths. */
export function projectKeyOf(cwd) {
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
