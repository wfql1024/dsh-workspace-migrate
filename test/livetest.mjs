/**
 * Orchestration tests for lib/live-move.mjs.
 *
 * These drive the memory layer — the workspace registry, the live-session/agent
 * checks, the rollback paths — against fakes, and drive the FILE layer against a real
 * synthetic DSH home so the engine really runs. Nothing here touches the live store:
 * each case gets its own temporary DSH_HOME.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { strict as assert } from 'node:assert'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''))
const { liveMoveSessions, inspectLiveMove, moveProjectDirectory, projectKeyOf, pathEquals, entityPath, entitySessionIds } = await import(
  '../lib/live-move.mjs'
)

const NODE = process.execPath
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

let checks = 0
let failures = 0
const ok = (label, condition, detail = '') => {
  checks++
  if (condition) console.log(`  pass  ${label}`)
  else {
    failures++
    console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`)
  }
}

// ── fixtures ────────────────────────────────────────────────────────────────
function splitFrames(buf) {
  const offsets = []
  let i = 0
  while ((i = buf.indexOf(MAGIC, i)) >= 0) {
    offsets.push(i)
    i++
  }
  return offsets.map((s, k) => buf.subarray(s, k + 1 < offsets.length ? offsets[k + 1] : buf.length))
}

function frame(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'))
}

function buildLog(id, cwd, version) {
  const header =
    version === 0
      ? { type: 'session', version: 0, id, createdAt: 1786000000000, cwd, delegationDepth: 0, agentPreset: 'standard' }
      : { type: 'session', version: 3, id, createdAt: 1786000000000, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
  return Buffer.concat([
    frame(`${JSON.stringify(header)}\n`),
    frame(`${JSON.stringify({ type: 'message', role: 'user', text: 'hi' })}\n`),
    frame(`${JSON.stringify({ type: 'message', role: 'assistant', text: 'yo' })}\n`),
  ])
}

/** A synthetic DSH home with one workspace holding the given session ids. */
function makeHome(label, sessionIds, options = {}) {
  // Real `registry.create()` realpaths its argument, so a destination workspace can only
  // be registered once its directory exists. The default fixture therefore models the
  // "I moved the project myself, now register it" workflow; tests that ask the plugin to
  // move the project pass `destinationExists: false` so the destination is still free.
  const destinationExists = options.destinationExists !== false
  const root = path.join(os.tmpdir(), `dwsm-live-${label}-${crypto.randomUUID().slice(0, 8)}`)
  fs.rmSync(root, { recursive: true, force: true })
  const dshHome = path.join(root, 'dsh-home')
  const sessionsRoot = path.join(dshHome, 'sessions')
  const storagesRoot = path.join(dshHome, 'storages')
  const projects = path.join(root, 'projects')
  const from = path.join(projects, 'old', 'Demo')
  const to = path.join(projects, 'new', 'Demo')
  fs.mkdirSync(sessionsRoot, { recursive: true })
  fs.mkdirSync(storagesRoot, { recursive: true })
  fs.mkdirSync(from, { recursive: true })
  fs.writeFileSync(path.join(from, 'readme.txt'), 'x\n')
  if (destinationExists) {
    fs.mkdirSync(to, { recursive: true })
    fs.writeFileSync(path.join(to, 'readme.txt'), 'y\n')
  }

  const oldKey = projectKeyOf(from)
  const oldKeyDir = path.join(sessionsRoot, oldKey)
  const before = {}
  const beforeGenerations = {}
  // DSH can hold several generation logs for one session in the same directory: it writes a new
  // generation when it upgrades the log format and keeps the older file as history. `locate()`
  // hands out the newest, so that is the one a live writer appends to.
  const generations = Array.isArray(options.generations) ? [...options.generations].sort((a, b) => a - b) : [3]
  for (const id of sessionIds) {
    const dir = path.join(oldKeyDir, id)
    fs.mkdirSync(dir, { recursive: true })
    beforeGenerations[id] = {}
    for (const version of generations) {
      const name = version === 0 ? 'session.jsonl.zstd' : `session.v${version}.jsonl.zstd`
      fs.writeFileSync(path.join(dir, name), buildLog(id, from, version))
      beforeGenerations[id][name] = splitFrames(fs.readFileSync(path.join(dir, name)))
    }
    const newest = generations[generations.length - 1]
    const newestName = newest === 0 ? 'session.jsonl.zstd' : `session.v${newest}.jsonl.zstd`
    before[id] = beforeGenerations[id][newestName]
  }

  const workspaceId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const doc = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [] },
    tables: {
      workspaces: {
        [workspaceId]: { path: from, title: 'Demo', sessionIds: [...sessionIds], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      },
    },
  }
  fs.writeFileSync(path.join(storagesRoot, 'workspace.json'), JSON.stringify(doc, null, 2))
  const cacheSessions = {}
  for (const id of sessionIds) cacheSessions[id] = { identity: { createdAt: 1786000000000, cwd: from }, rows: {} }
  fs.writeFileSync(
    path.join(storagesRoot, 'session_projcache.json'),
    JSON.stringify({ unit: { name: 'session_projcache', version: 3 }, global: null, tables: { sessions: cacheSessions } }, null, 2),
  )
  const perDir = path.join(storagesRoot, 'session_projcache', 'sessions')
  fs.mkdirSync(perDir, { recursive: true })
  for (const id of sessionIds) {
    fs.writeFileSync(path.join(perDir, `${id}.json`), JSON.stringify({ version: 7, record: { identity: { cwd: from }, rows: {} } }, null, 2))
  }
  return { root, dshHome, sessionsRoot, storagesRoot, from, to, oldKey, oldKeyDir, workspaceId, before, beforeGenerations }
}

/**
 * Read a session's header from disk, preferring the newest generation. Mirrors what
 * `dsh-workspace`'s `listStoredHeaders()` does on a header-cache miss.
 */
function readHeaderFromDisk(home, sessionId) {
  const keys = [projectKeyOf(home.to), projectKeyOf(home.from), home.oldKey]
  for (const key of keys) {
    const dir = path.join(home.sessionsRoot, key, sessionId)
    if (!fs.existsSync(dir)) continue
    const names = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl.zstd'))
      .sort()
    if (names.length === 0) continue
    const frames = splitFrames(fs.readFileSync(path.join(dir, names[names.length - 1])))
    const text = zlib.zstdDecompressSync(frames[0]).toString('utf8')
    return JSON.parse(text.slice(0, text.indexOf('\n')))
  }
  return undefined
}

/**
 * A fake workspace entity that mirrors both shapes the host has used — and, critically,
 * mirrors the REAL attachSession validation:
 *
 *   dsh-workspace/lib/index.js:111
 *     const header = await this.host.readSessionHeader(sessionId)   // prefers the cache
 *     cwd = await realpathNormalize(header.cwd)
 *     if (cwd !== this.record.path) throw ...
 *
 * An earlier, permissive fake accepted any attach — which is exactly why the stale
 * header-cache bug passed every offline test and only surfaced against the live host.
 */
function fakeEntity(id, titleValue, entityPathValue, sessionIds, log, host) {
  return {
    id,
    title: titleValue,
    path: entityPathValue,
    sessionIds: [...sessionIds],
    record: { path: entityPathValue, title: titleValue, sessionIds: [...sessionIds] },
    async attachSession(sessionId) {
      if (log !== undefined) log.push(`attach:${id}:${sessionId}`)
      if (!this.sessionIds.includes(sessionId)) {
        const header = host === undefined ? undefined : host.readSessionHeader(sessionId)
        if (header === undefined) {
          throw new Error(`cannot validate session '${sessionId}': session persistence holds no such session`)
        }
        if (header.cwd === undefined) {
          throw new Error(`cannot attach session '${sessionId}' to workspace '${this.record.path}': its stored header carries no cwd to validate against`)
        }
        if (!fs.existsSync(header.cwd)) {
          throw new Error(
            `cannot attach session '${sessionId}' to workspace '${this.record.path}': its cwd '${header.cwd}' does not resolve, so it cannot be validated`,
          )
        }
        if (!pathEquals(header.cwd, this.record.path)) {
          throw new Error(`cannot attach session '${sessionId}' to workspace '${this.record.path}': its cwd resolves to '${header.cwd}'`)
        }
        if (host !== undefined && typeof host.rememberSessionPath === 'function') host.rememberSessionPath(sessionId, header.cwd)
      }
      if (!this.sessionIds.includes(sessionId)) this.sessionIds.push(sessionId)
      this.record.sessionIds = [...this.sessionIds]
    },
    async detachSession(sessionId) {
      if (log !== undefined) log.push(`detach:${id}:${sessionId}`)
      this.sessionIds = this.sessionIds.filter((value) => value !== sessionId)
      this.record.sessionIds = [...this.sessionIds]
    },
  }
}

/** A fake workspaceRegistry over a real synthetic home. */
function fakeRegistry(home, { log = [], failAttach = false, onAttachFail = undefined, indexMaps = true, seedHeaderCache = true, extraDestinationClaim = false } = {}) {
  const headers = new Map()
  const sessionPaths = new Map()
  const invalid = new Set()
  for (const id of Object.keys(home.before)) {
    // A real registry can legitimately hold no cached header for a stored session (it only
    // indexes what it has read); `seedHeaderCache: false` models that cache-miss path.
    if (seedHeaderCache) headers.set(id, { id, cwd: home.from, isSeeded: false, delegationLevel: 0 })
    // Verified against a live host: `sessionPaths` maps a session id to its canonical cwd
    // (the workspace path), NOT to a log file path. The fixture mirrors that.
    sessionPaths.set(id, home.from)
  }
  // The registry's own header-cache-then-disk read, as `dsh-workspace` implements it. With
  // `indexMaps: false` the host has no cache at all, so every validation reads from disk —
  // which is why that scenario must not be modelled with a hidden cache.
  const host = {
    readSessionHeader: (sessionId) => (indexMaps ? headers.get(sessionId) : undefined) ?? readHeaderFromDisk(home, sessionId),
    rememberSessionPath: (sessionId, cwd) => sessionPaths.set(sessionId, cwd),
  }
  const entities = [fakeEntity(home.workspaceId, 'Demo', home.from, Object.keys(home.before), log, host)]
  // Two records claiming the destination path: the state DSH refuses to boot on, and the one a
  // live move must not paper over by picking whichever record it happens to find first.
  if (extraDestinationClaim === true) {
    entities.push(fakeEntity('id-dup-1', 'Demo', home.to, [], log, host))
    entities.push(fakeEntity('id-dup-2', 'Demo', home.to, [], log, host))
  }
  const registry = {
    list: () => [...entities],
    get: (id) => entities.find((entity) => entity.id === id),
    async create(targetPath, title) {
      log.push(`create:${targetPath}`)
      const entity = fakeEntity(`id-${entities.length}`, title ?? path.basename(targetPath), targetPath, [], log, host)
      if (failAttach) {
        entity.attachSession = async (sessionId) => {
          log.push(`attach-fail:${sessionId}`)
          // A hook so a test can put the world into whatever state the failure should be
          // unwound from (for example: robocopy left the original path as an empty husk).
          if (typeof onAttachFail === 'function') onAttachFail()
          throw new Error('simulated attachSession rejection')
        }
      }
      entities.push(entity)
      return entity
    },
    async delete(id) {
      log.push(`delete:${id}`)
      const at = entities.findIndex((entity) => entity.id === id)
      if (at >= 0) entities.splice(at, 1)
      return true
    },
    async enqueueOperation(operation) {
      log.push('enqueueOperation')
      return await operation()
    },
    entities,
  }
  if (indexMaps) {
    registry.headers = headers
    registry.sessionPaths = sessionPaths
    registry.invalidSessionPaths = invalid
  }
  return registry
}

/**
 * Stand-in for the prototype a live header carries.
 *
 * A live Session header is a plain frozen JSON record built inside DSH's own realm, and this
 * module's `Object.prototype` is NOT that object. Reproducing the difference is what makes the
 * prototype assertions below real guards: a plain `Object.assign({}, header, { cwd })` copy
 * silently adopts THIS module's prototype, and DSH rejects exactly that shape on its restore
 * path (`dsh-session/lib/types/index.js:68-76`, "session header is not a plain JSON record").
 */
const HOST_REALM_OBJECT_PROTOTYPE = Object.freeze({ __hostRealmObjectPrototype: true })

/** A live header in the shape the host hands out: foreign prototype, own fields, frozen. */
function liveHeader(id, cwd) {
  const header = Object.create(HOST_REALM_OBJECT_PROTOTYPE)
  Object.assign(header, { id, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'cordis' })
  return Object.freeze(header)
}

/**
 * Fake service bag.
 *
 * `liveSessions` models sessions that are open in this process. `rebindableWriters` models
 * the host's live write handles: when true, each live session also gets a
 * `sessionPersistence.tracker.writers` entry whose `header` is a writable property, which
 * is exactly the surface a running-session relocation needs.
 */
function fakeServices({ registry, liveSessions = [], liveAgents = [], rebindableWriters = false, sessionsRoot, cwdBySession = {} }) {
  const map = new Map()
  if (registry !== undefined) map.set('workspaceRegistry', registry)

  const live = new Map()
  for (const id of liveSessions) {
    // A real Session exposes `header` as a writable property holding a frozen header object.
    live.set(id, { id, header: liveHeader(id, cwdBySession[id]) })
  }
  let flushes = 0
  map.set('sessions', {
    get: (id) => live.get(id),
    list: () => [...live.values()],
    flush: async () => {
      flushes++
    },
  })
  map.set('agents', { get: (id) => (liveAgents.includes(id) ? { id } : undefined) })

  if (rebindableWriters) {
    const writers = new Map()
    for (const id of liveSessions) {
      writers.set(id, { id, access: 'write', header: liveHeader(id, cwdBySession[id]) })
    }
    map.set('sessionPersistence', {
      root: sessionsRoot,
      tracker: { writers },
      locate: (header) => ({ path: path.join(sessionsRoot, projectKeyOf(header.cwd), header.id, 'session.v3.jsonl.zstd') }),
    })
  }
  const bag = { get: (name) => map.get(name) }
  Object.defineProperty(bag, 'flushCount', { get: () => flushes })
  Object.defineProperty(bag, 'writers', { get: () => (rebindableWriters ? map.get('sessionPersistence').tracker.writers : undefined) })
  Object.defineProperty(bag, 'live', { get: () => live })
  return bag
}

/** Run a case with DSH_HOME pointed at the synthetic home so the engine uses it. */
async function withHome(home, fn) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home.dshHome
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

// ── pure helpers ────────────────────────────────────────────────────────────
console.log('\n[1] helpers')
ok('pathEquals tolerates a trailing separator', pathEquals('C:/a/b/', 'C:/a/b'))
ok('pathEquals is case-insensitive on Windows', process.platform !== 'win32' || pathEquals('C:/A/B', 'c:/a/b'))
ok('entityPath prefers record.path', entityPath({ path: 'X', record: { path: 'Y' } }) === 'Y')
ok('entitySessionIds reads record.sessionIds', JSON.stringify(entitySessionIds({ record: { sessionIds: ['a'] } })) === '["a"]')
ok('projectKeyOf matches the engine grammar', projectKeyOf('D:\\work\\demo') === '--D-work-demo--', projectKeyOf('D:\\work\\demo'))

// ── preconditions ───────────────────────────────────────────────────────────
console.log('\n[2] inspectLiveMove refuses what it must')
{
  const home = makeHome('pre', ['session-1', 'session-2'])
  const registry = fakeRegistry(home)

  const unknown = await inspectLiveMove(fakeServices({ registry }), { fromPath: 'Z:/nope', toPath: home.to })
  ok('an unregistered source path is refused', unknown.ok === false && /no registered workspace/.test(unknown.blockers[0]), JSON.stringify(unknown.blockers))

  const live = await withHome(home, () =>
    inspectLiveMove(fakeServices({ registry, liveSessions: ['session-2'] }), { fromPath: home.from, toPath: home.to }),
  )
  ok('a live Session with no rebindable writer is refused', live.ok === false && /no live persistence writer/.test(live.blockers[0]), JSON.stringify(live.blockers))
  ok('the refusal names the live session', JSON.stringify(live.blockers).includes('session-2'))
  ok('the refusal says the whole move is refused', /refusing the whole move/.test(live.blockers.join(' ')))

  const liveAgent = await inspectLiveMove(fakeServices({ registry, liveAgents: ['session-1'] }), { fromPath: home.from, toPath: home.to })
  ok('a live Agent with no rebindable writer is refused', liveAgent.ok === false && /no live persistence writer/.test(liveAgent.blockers[0]))

  // The capability this plugin exists for: a RUNNING session is movable when the host
  // exposes a rebindable writer.
  const rebindable = await inspectLiveMove(
    fakeServices({ registry, liveSessions: ['session-2'], rebindableWriters: true, sessionsRoot: home.sessionsRoot, cwdBySession: { 'session-2': home.from } }),
    { fromPath: home.from, toPath: home.to },
  )
  ok('a live Session WITH a rebindable writer is allowed', rebindable.ok === true, JSON.stringify(rebindable.blockers))
  ok('it is reported as a running session to relocate in process', JSON.stringify(rebindable.liveIds) === JSON.stringify(['session-2']), JSON.stringify(rebindable.liveIds))
  ok('and that is surfaced as a note', rebindable.notes.some((note) => /running and will be relocated in process/.test(note)), JSON.stringify(rebindable.notes))

  const good = await inspectLiveMove(fakeServices({ registry }), { fromPath: home.from, toPath: home.to })
  ok('an all-cold workspace passes', good.ok === true, JSON.stringify(good.blockers))
  ok('it reports the session ids it would move', JSON.stringify(good.sessionIds) === JSON.stringify(['session-1', 'session-2']))

  const subset = await inspectLiveMove(fakeServices({ registry }), { fromPath: home.from, toPath: home.to, sessionIds: ['session-1'] })
  ok('an explicit subset is honoured', JSON.stringify(subset.sessionIds) === JSON.stringify(['session-1']))

  const missing = await inspectLiveMove(fakeServices({ registry }), { fromPath: home.from, toPath: home.to, sessionIds: ['nope'] })
  ok('an empty intersection is refused', missing.ok === false && /no sessions to move/.test(missing.blockers[0]), JSON.stringify(missing.blockers))

  fs.rmSync(home.root, { recursive: true, force: true })
}

// ── the happy path ──────────────────────────────────────────────────────────
console.log('\n[3] a real live move (file layer really runs)')
{
  const home = makeHome('ok', ['session-1', 'session-2'])
  const log = []
  const registry = fakeRegistry(home, { log })
  const result = await withHome(home, () => liveMoveSessions(fakeServices({ registry }), { fromPath: home.from, toPath: home.to, title: 'Demo2' }))

  ok('reports success', result.ok === true, JSON.stringify(result.blockers ?? result))
  ok('stage is done', result.stage === 'done')
  ok('moved both sessions', result.movedCount === 2, String(result.movedCount))
  ok('registered a new workspace', result.workspaceCreated === true)
  ok('created the destination registration once', log.filter((entry) => entry.startsWith('create:')).length === 1, JSON.stringify(log.filter((e) => e.startsWith('create:'))))
  ok('serialized the registry mutation when the host exposes it', log.includes('enqueueOperation'))
  ok('detached from the source before attaching', log.indexOf('detach:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:session-1') < log.indexOf('attach:id-1:session-1'), JSON.stringify(log))
  ok('the source entity no longer lists the moved sessions', JSON.stringify(registry.entities[0].sessionIds) === '[]', JSON.stringify(registry.entities[0].sessionIds))
  ok('the target entity lists them', JSON.stringify(registry.entities[1].sessionIds) === JSON.stringify(['session-1', 'session-2']), JSON.stringify(registry.entities[1].sessionIds))

  // the file layer really moved them, frame-safely
  const newKeyDir = path.join(home.sessionsRoot, projectKeyOf(home.to))
  for (const id of ['session-1', 'session-2']) {
    const file = path.join(newKeyDir, id, 'session.v3.jsonl.zstd')
    ok(`${id}: artifact is at the new projectKey`, fs.existsSync(file))
    const after = splitFrames(fs.readFileSync(file))
    const original = home.before[id]
    ok(`${id}: frame count preserved`, after.length === original.length)
    ok(`${id}: frames after 0 are byte-identical`, after.slice(1).every((f, i) => f.equals(original[i + 1])))
    const text = zlib.zstdDecompressSync(after[0]).toString('utf8')
    ok(`${id}: header cwd is the new path`, JSON.parse(text.slice(0, -1)).cwd === home.to)
  }

  // workspace.json belongs to the registry, so the engine must not have touched it
  const onDisk = JSON.parse(fs.readFileSync(path.join(home.storagesRoot, 'workspace.json'), 'utf8'))
  ok('the engine never rewrote workspace.json', onDisk.tables.workspaces[home.workspaceId].path === home.from, onDisk.tables.workspaces[home.workspaceId].path)

  // index maps retargeted in place
  // index maps: the header cache is INVALIDATED (not retargeted) before the attach, because
  // a cache hit would otherwise make the validation resolve the old cwd.
  ok('the stale header cache entry was invalidated', registry.headers.get('session-1') === undefined, JSON.stringify(registry.headers.get('session-1')))
  ok('the invalidation is reported', result.indexRepaired.some((entry) => entry.startsWith('headers:')), JSON.stringify(result.indexRepaired))
  ok('sessionPaths was left to the registry, which recorded the new cwd', registry.sessionPaths.get('session-1') === home.to, registry.sessionPaths.get('session-1'))
  ok('index repair is reported', Array.isArray(result.indexRepaired) && result.indexRepaired.length > 0, JSON.stringify(result.indexRepaired))

  fs.rmSync(home.root, { recursive: true, force: true })
}

// ── reusing an existing destination workspace ───────────────────────────────
console.log('\n[4] an existing destination workspace is reused, not duplicated')
{
  const home = makeHome('reuse', ['session-1'])
  const log = []
  const registry = fakeRegistry(home, { log })
  // Register the destination through the real path so it gets a proper host binding.
  const preexisting = await registry.create(home.to, 'Already')

  const result = await withHome(home, () => liveMoveSessions(fakeServices({ registry }), { fromPath: home.from, toPath: home.to }))
  ok('succeeds', result.ok === true, JSON.stringify(result.blockers ?? result))
  ok('did not create a workspace', result.workspaceCreated === false)
  ok('no extra create call was made beyond the fixture', log.filter((entry) => entry.startsWith('create:')).length === 1, JSON.stringify(log.filter((e) => e.startsWith('create:'))))
  ok('attached into the existing one', result.workspaceId === preexisting.id, String(result.workspaceId))
  fs.rmSync(home.root, { recursive: true, force: true })
}

// ── memory-layer failure rolls the file layer back ──────────────────────────
console.log('\n[5] a memory-layer failure rolls everything back')
{
  const home = makeHome('fail', ['session-1'])
  const log = []
  const registry = fakeRegistry(home, { log, failAttach: true })
  const result = await withHome(home, () => liveMoveSessions(fakeServices({ registry }), { fromPath: home.from, toPath: home.to }))

  ok('reports failure', result.ok === false)
  ok('blames the memory layer', result.stage === 'memory-layer', String(result.stage))
  ok('reports that the files were restored', result.rollback && result.rollback.filesRestored === true, JSON.stringify(result.rollback))
  ok('the session is back under the old projectKey', fs.existsSync(path.join(home.oldKeyDir, 'session-1')))
  ok('the new projectKey directory is gone', !fs.existsSync(path.join(home.sessionsRoot, projectKeyOf(home.to), 'session-1')))
  const restored = splitFrames(fs.readFileSync(path.join(home.oldKeyDir, 'session-1', 'session.v3.jsonl.zstd')))
  ok('the restored log is byte-identical', restored.length === home.before['session-1'].length && restored.every((f, i) => f.equals(home.before['session-1'][i])))
  ok('the created registration was undone', !registry.entities.some((entity) => entity.id === 'id-1'), JSON.stringify(registry.entities.map((e) => e.id)))
  fs.rmSync(home.root, { recursive: true, force: true })
}

// ── a session with no cached header still attaches from disk ───────────────
console.log('\n[6] a session the registry has not cached still moves (disk fallback)')
{
  const home = makeHome('nocache', ['session-1'])
  const registry = fakeRegistry(home, { seedHeaderCache: false })
  const result = await withHome(home, () => liveMoveSessions(fakeServices({ registry }), { fromPath: home.from, toPath: home.to }))
  ok('still succeeds', result.ok === true, JSON.stringify(result.blockers ?? result))
  ok('the move really happened', fs.existsSync(path.join(home.sessionsRoot, projectKeyOf(home.to), 'session-1')))
  ok('nothing needed invalidating, so nothing was reported as invalidated', !result.indexRepaired.some((entry) => entry.startsWith('headers:')), JSON.stringify(result.indexRepaired))
  ok('the registry recorded the new path itself', registry.sessionPaths.get('session-1') === home.to, String(registry.sessionPaths.get('session-1')))
  ok('it notes that persistence was not searched for extra sessions', result.notes.some((note) => /sessionPersistence service is unavailable/.test(note)), JSON.stringify(result.notes))
  fs.rmSync(home.root, { recursive: true, force: true })
}

// ── a host that hides the index maps degrades, never throws ────────────────
console.log('\n[6b] a host with no exposed index maps still moves')
{
  const home = makeHome('nomaps', ['session-1'])
  const registry = fakeRegistry(home, { indexMaps: false })
  const result = await withHome(home, () => liveMoveSessions(fakeServices({ registry }), { fromPath: home.from, toPath: home.to }))
  ok('succeeds without the maps', result.ok === true, JSON.stringify(result.blockers ?? result))
  ok('the move really happened', fs.existsSync(path.join(home.sessionsRoot, projectKeyOf(home.to), 'session-1')))
  ok('it says the grouping may need a restart', result.notes.some((note) => /restart/.test(note)), JSON.stringify(result.notes))
  ok('nothing was written into the absent maps', registry.headers === undefined)
  fs.rmSync(home.root, { recursive: true, force: true })
}

// ── an engine refusal leaves the registry untouched ────────────────────────
console.log('\n[7] an engine refusal leaves no trace')
{
  const home = makeHome('enginefail', ['session-1'])
  const log = []
  const registry = fakeRegistry(home, { log })
  // Point the move at a destination whose session artifact already exists, which the
  // engine refuses; the memory layer must not have run at all.
  const clash = path.join(home.sessionsRoot, projectKeyOf(home.to), 'session-1')
  fs.mkdirSync(clash, { recursive: true })
  fs.writeFileSync(path.join(clash, 'session.v3.jsonl.zstd'), buildLog('session-1', home.to, 3))

  const result = await withHome(home, () => liveMoveSessions(fakeServices({ registry }), { fromPath: home.from, toPath: home.to }))
  ok('reports failure', result.ok === false)
  ok('blames the file layer', result.stage === 'file-layer', String(result.stage))
  ok('no attach/detach ran', !log.some((entry) => entry.startsWith('attach') || entry.startsWith('detach')), JSON.stringify(log))
  ok('the created registration was undone', !registry.entities.some((entity) => entity.id === 'id-1'), JSON.stringify(registry.entities.map((e) => e.id)))
  ok('the source session is untouched', fs.existsSync(path.join(home.oldKeyDir, 'session-1')))
  fs.rmSync(home.root, { recursive: true, force: true })
}

// ── a missing service is reported, never thrown ────────────────────────────
console.log('\n[8] a host without workspaceRegistry is a clean failure')
{
  const result = await liveMoveSessions({ get: () => undefined }, { fromPath: 'C:/a', toPath: 'C:/b' })
  ok('reports failure', result.ok === false)
  ok('names the missing service', /workspaceRegistry/.test(result.blockers[0]), result.blockers[0])
}

assert.ok(checks > 0)
// ── the full one-shot: project directory moves too ─────────────────────────
console.log('\n[9] the full one-shot: project directory + workspace + sessions')
{
  const home = makeHome('oneshot', ['session-1', 'session-2'], { destinationExists: false })
  const log = []
  const registry = fakeRegistry(home, { log })
  const result = await withHome(home, () =>
    liveMoveSessions(fakeServices({ registry }), { fromPath: home.from, toPath: home.to, title: 'Moved', moveProject: true }),
  )
  ok('succeeds', result.ok === true, JSON.stringify(result.blockers ?? result))
  ok('reports that the project moved', result.projectMoved === true)
  ok('the project directory is at the new path', fs.existsSync(path.join(home.to, 'readme.txt')))
  ok('the project directory is gone from the old path', !fs.existsSync(home.from))
  ok('sessions sit under the new projectKey', fs.existsSync(path.join(home.sessionsRoot, projectKeyOf(home.to), 'session-1')))
  ok('the workspace got registered at the new path', registry.entities.some((entity) => pathEquals(entityPath(entity), home.to)))
  ok('the new registration is titled', registry.entities.some((entity) => entity.title === 'Moved'))
  fs.rmSync(home.root, { recursive: true, force: true })
}

// ── a late failure unwinds every layer, project directory included ─────────
console.log('\n[10] a late failure moves the project directory back')
{
  const home = makeHome('undoall', ['session-1'], { destinationExists: false })
  const registry = fakeRegistry(home, { failAttach: true })
  const result = await withHome(home, () =>
    liveMoveSessions(fakeServices({ registry }), { fromPath: home.from, toPath: home.to, moveProject: true }),
  )
  ok('fails', result.ok === false)
  ok('blames the memory layer', result.stage === 'memory-layer', String(result.stage))
  ok('the project directory is back at the source', fs.existsSync(path.join(home.from, 'readme.txt')))
  ok('the destination project directory is gone', !fs.existsSync(home.to))
  ok('the session artifact is back under the old projectKey', fs.existsSync(path.join(home.oldKeyDir, 'session-1')))
  ok('the restored artifact is byte-identical', (() => {
    const frames = splitFrames(fs.readFileSync(path.join(home.oldKeyDir, 'session-1', 'session.v3.jsonl.zstd')))
    return frames.length === home.before['session-1'].length && frames.every((f, i) => f.equals(home.before['session-1'][i]))
  })())
  ok('the created registration was undone', !registry.entities.some((entity) => entity.id === 'id-1'), JSON.stringify(registry.entities.map((e) => e.id)))
  ok('every undone layer is reported', Array.isArray(result.rollback?.undoErrors) && result.rollback.undoErrors.length === 0, JSON.stringify(result.rollback))
  fs.rmSync(home.root, { recursive: true, force: true })
}

// ── moveProject refuses a destination that is not empty ────────────────────
console.log('\n[11] moveProject refuses a destination that is not empty')
{
  const home = makeHome('destexists', ['session-1'])
  fs.mkdirSync(home.to, { recursive: true })
  const registry = fakeRegistry(home)
  const inspect = await inspectLiveMove(fakeServices({ registry }), { fromPath: home.from, toPath: home.to, moveProject: true })
  ok('is refused', inspect.ok === false, JSON.stringify(inspect.blockers))
  ok('says the destination is not empty', /is not empty/.test(inspect.blockers.join(' ')), JSON.stringify(inspect.blockers))
  ok('reports the project facts', inspect.project.sourceExists === true && inspect.project.destinationExists === true && inspect.project.willMove === true, JSON.stringify(inspect.project))

  const move = await withHome(home, () =>
    liveMoveSessions(fakeServices({ registry }), { fromPath: home.from, toPath: home.to, moveProject: true }),
  )
  ok('the move itself is refused too', move.ok === false && move.stage === 'precondition', String(move.stage))
  ok('the source project was not touched', fs.existsSync(path.join(home.from, 'readme.txt')))
  ok('the session was not touched', fs.existsSync(path.join(home.oldKeyDir, 'session-1')))
  fs.rmSync(home.root, { recursive: true, force: true })
}

// ── 仅修改目录 into a destination that does not exist yet ──────────────────
console.log('\n[12] 「仅修改目录」creates a missing destination instead of refusing')
{
  const home = makeHome('nodest', ['session-1'], { destinationExists: false })
  const registry = fakeRegistry(home)
  const services = fakeServices({ registry, sessionsRoot: home.sessionsRoot, cwdBySession: { 'session-1': home.from } })

  // `home.to` deliberately does not exist on disk, and moveProject is off: nothing is copied,
  // but the workspace still has to point at a real directory, so the move creates an empty one.
  const inspect = await inspectLiveMove(services, { fromPath: home.from, toPath: home.to })
  ok('is allowed', inspect.ok === true, JSON.stringify(inspect.blockers))
  ok('is reported as "to be created"', inspect.project.createDestination === true, JSON.stringify(inspect.project))
  ok('the check says so before anything happens', inspect.notes.some((note) => /does not exist yet; it will be created/.test(note)), JSON.stringify(inspect.notes))

  const result = await withHome(home, () => liveMoveSessions(services, { fromPath: home.from, toPath: home.to }))
  ok('the move succeeds', result.ok === true, JSON.stringify(result.blockers ?? result))
  ok('the destination directory now exists', fs.existsSync(home.to) && fs.statSync(home.to).isDirectory(), home.to)
  ok('it is empty, because only the path changed', fs.existsSync(home.to) && fs.readdirSync(home.to).length === 0, JSON.stringify(fs.existsSync(home.to) ? fs.readdirSync(home.to) : null))
  ok('the source project is untouched', fs.readFileSync(path.join(home.from, 'readme.txt'), 'utf8') === 'x\n')
  ok('the report says the directory was created', result.destinationCreated === true, JSON.stringify(result.destinationCreated))
  ok('the workspace is registered at the new path', registry.entities.some((entity) => entity.path === home.to), JSON.stringify(registry.entities.map((entity) => entity.path)))
  ok('the session artifact moved to the new projectKey', fs.existsSync(path.join(home.sessionsRoot, projectKeyOf(home.to), 'session-1', 'session.v3.jsonl.zstd')))
  ok('the old artifact is gone', !fs.existsSync(path.join(home.oldKeyDir, 'session-1')))
  fs.rmSync(home.root, { recursive: true, force: true })
}

// ── a destination on a drive that does not exist ───────────────────────────
console.log('\n[12b] a destination whose drive does not exist is named at check time')
{
  const home = makeHome('nodrive', ['session-1'], { destinationExists: false })
  const missingDrive = ['A:\\', 'B:\\'].find((root) => !fs.existsSync(root))
  if (missingDrive === undefined) {
    console.log('  (skipped: no absent drive letter to test with)')
  } else {
    const target = path.join(missingDrive, 'dsh-workspace-migrate-nodrive', 'Demo')
    const inspect = await inspectLiveMove(fakeServices({ registry: fakeRegistry(home) }), { fromPath: home.from, toPath: target })
    ok('the check refuses it', inspect.ok === false, JSON.stringify(inspect.blockers))
    ok('and names the missing drive', /drive does not exist/.test(inspect.blockers.join(' ')), JSON.stringify(inspect.blockers))
  }
  fs.rmSync(home.root, { recursive: true, force: true })
}

// ── a RUNNING session is relocated in process ──────────────────────────────
console.log('\n[13] a running session is relocated in process and its writer retargeted')
{
  const home = makeHome('live', ['session-1'])
  const registry = fakeRegistry(home)
  const services = fakeServices({
    registry,
    liveSessions: ['session-1'],
    rebindableWriters: true,
    sessionsRoot: home.sessionsRoot,
    cwdBySession: { 'session-1': home.from },
  })

  const result = await withHome(home, () => liveMoveSessions(services, { fromPath: home.from, toPath: home.to }))

  ok('succeeds without closing anything', result.ok === true, JSON.stringify(result.blockers ?? result))
  // Every user-visible line says what it is: `[√]` done, `[!]` degraded but handled, `[×]`
  // failed, `[i]` context. Without that, a handled warning reads like a failure.
  ok('every note carries a signal marker', Array.isArray(result.notes) && result.notes.every((note) => /^\[[√×!i]\] /.test(note)), JSON.stringify(result.notes))
  ok('the running-session note is marked done', result.notes.some((note) => /^\[√\] /.test(note) && /are running and will be relocated/.test(note)), JSON.stringify(result.notes))
  ok('a degraded note is marked as a warning, not a failure', result.notes.some((note) => /^\[!\] /.test(note) && /only the registry index was searched/.test(note)), JSON.stringify(result.notes))
  ok('it reports one live relocation', Array.isArray(result.liveRelocated) && result.liveRelocated.length === 1, JSON.stringify(result.liveRelocated))
  ok('the spawned engine was not used at all', result.engineReport === null, JSON.stringify(result.engineReport))
  ok('it notes that the engine was skipped', result.notes.some((note) => /every session is running/.test(note)), JSON.stringify(result.notes))
  ok('the session was flushed before the move', services.flushCount >= 1, String(services.flushCount))

  const movedFile = path.join(home.sessionsRoot, projectKeyOf(home.to), 'session-1', 'session.v3.jsonl.zstd')
  ok('the artifact is at the new projectKey', fs.existsSync(movedFile))
  ok('the old artifact is gone, so no duplicate id can exist', !fs.existsSync(path.join(home.oldKeyDir, 'session-1')))
  const after = splitFrames(fs.readFileSync(movedFile))
  const original = home.before['session-1']
  ok('frames after 0 are byte-identical', after.length === original.length && after.slice(1).every((frame, i) => frame.equals(original[i + 1])))
  const head = zlib.zstdDecompressSync(after[0]).toString('utf8')
  ok('frame 0 is still exactly one header line', head.length > 0 && head.indexOf('\n') === head.length - 1)
  ok('the header cwd is the new path', JSON.parse(head.slice(0, -1)).cwd === home.to)

  ok('the live writer was retargeted', services.writers.get('session-1').header.cwd === home.to, JSON.stringify(services.writers.get('session-1').header))
  // The replacement header must be indistinguishable from one the host built itself.
  const writerHeader = services.writers.get('session-1').header
  const sessionHeader = services.live.get('session-1').header
  ok('the live Session header was retargeted too', sessionHeader.cwd === home.to, JSON.stringify(sessionHeader))
  ok('the writer header kept the host-realm prototype', Object.getPrototypeOf(writerHeader) === HOST_REALM_OBJECT_PROTOTYPE, Object.getPrototypeOf(writerHeader) === Object.prototype ? 'adopted this module\'s Object.prototype' : 'other prototype')
  ok('the live Session header kept the host-realm prototype', Object.getPrototypeOf(sessionHeader) === HOST_REALM_OBJECT_PROTOTYPE, Object.getPrototypeOf(sessionHeader) === Object.prototype ? 'adopted this module\'s Object.prototype' : 'other prototype')
  ok('the replacement headers are still frozen', Object.isFrozen(writerHeader) && Object.isFrozen(sessionHeader))
  ok('every field other than cwd survived', writerHeader.agentPreset === 'cordis' && writerHeader.isSeeded === false && writerHeader.delegationDepth === 0 && writerHeader.id === 'session-1', JSON.stringify(writerHeader))
  ok('the registry recorded the new path', registry.sessionPaths.get('session-1') === home.to, String(registry.sessionPaths.get('session-1')))
  // A printed report path must name a real file: a live move is exactly the case where the
  // user has no other durable record of what was touched.
  ok('the announced report file exists', typeof result.reportFile === 'string' && fs.existsSync(result.reportFile), String(result.reportFile))
  ok('the report is valid JSON describing the move', (() => {
    const written = JSON.parse(fs.readFileSync(result.reportFile, 'utf8'))
    return written.ok === true && written.to === home.to && written.sessionIds.includes('session-1')
  })())
  ok('the target workspace lists the session', JSON.stringify(registry.entities[1].sessionIds) === JSON.stringify(['session-1']), JSON.stringify(registry.entities.map((e) => e.sessionIds)))
  fs.rmSync(home.root, { recursive: true, force: true })
}

// ── a running session's relocation is undone when a later layer fails ───────
console.log('\n[14] a failed memory layer puts a RUNNING session back where it was')
{
  const home = makeHome('liveundo', ['session-1'], { destinationExists: false, generations: [0, 3] })
  // failAttach makes the last layer fail, so every earlier layer must be unwound — including
  // the live writer, whose routing would otherwise keep pointing at a file that moved back.
  const registry = fakeRegistry(home, { failAttach: true })
  const services = fakeServices({
    registry,
    liveSessions: ['session-1'],
    rebindableWriters: true,
    sessionsRoot: home.sessionsRoot,
    cwdBySession: { 'session-1': home.from },
  })

  const result = await withHome(home, () => liveMoveSessions(services, { fromPath: home.from, toPath: home.to, moveProject: true }))

  ok('fails', result.ok === false, JSON.stringify(result.stage))
  ok('blames the memory layer', result.stage === 'memory-layer', String(result.stage))
  ok('the artifact is back under the old projectKey', fs.existsSync(path.join(home.oldKeyDir, 'session-1')))
  ok('a live undo brings every generation back', (() => {
    const dir = path.join(home.oldKeyDir, 'session-1')
    if (!fs.existsSync(dir)) return false
    const names = fs.readdirSync(dir).sort()
    return names.join(',') === 'session.jsonl.zstd,session.v3.jsonl.zstd'
  })())
  ok('the restored artifact is byte-identical', (() => {
    const frames = splitFrames(fs.readFileSync(path.join(home.oldKeyDir, 'session-1', 'session.v3.jsonl.zstd')))
    return frames.length === home.before['session-1'].length && frames.every((f, i) => f.equals(home.before['session-1'][i]))
  })())
  const writerHeader = services.writers.get('session-1').header
  const sessionHeader = services.live.get('session-1').header
  ok('the live writer points at the old path again', writerHeader.cwd === home.from, JSON.stringify(writerHeader))
  ok('the live Session header points at the old path again', sessionHeader.cwd === home.from, JSON.stringify(sessionHeader))
  ok('the undone writer header kept the host-realm prototype', Object.getPrototypeOf(writerHeader) === HOST_REALM_OBJECT_PROTOTYPE)
  ok('the undone Session header kept the host-realm prototype', Object.getPrototypeOf(sessionHeader) === HOST_REALM_OBJECT_PROTOTYPE)
  ok('every undone layer is reported', Array.isArray(result.rollback?.undoErrors) && result.rollback.undoErrors.length === 0, JSON.stringify(result.rollback))
  // A failed move is the case that most needs a durable account of what was unwound.
  ok('a failed move still writes its report', typeof result.reportFile === 'string' && fs.existsSync(result.reportFile), String(result.reportFile))
  ok('the failure report records the stage', (() => {
    const written = JSON.parse(fs.readFileSync(result.reportFile, 'utf8'))
    return written.ok === false && written.stage === 'memory-layer'
  })())
  fs.rmSync(home.root, { recursive: true, force: true })
}

// ── the project-directory rollback survives an empty husk at the original path ──
//
// Found on a real host: the rollback reported
//   project-directory: the destination already exists: E:\...\main
// because the original path still existed (empty) by the time the undo ran. An empty leftover
// is not a reason to leave a project half-moved.
console.log('\n[15] the project directory rolls back over an empty husk')
{
  const home = makeHome('husk', ['session-1'], { destinationExists: false })
  let huskCreated = false
  const registry = fakeRegistry(home, {
    failAttach: true,
    // Recreate the original path, empty, exactly as a partially-completed move leaves it.
    onAttachFail: () => {
      fs.mkdirSync(home.from, { recursive: true })
      huskCreated = true
    },
  })

  const result = await withHome(home, () => liveMoveSessions(fakeServices({ registry }), { fromPath: home.from, toPath: home.to, moveProject: true }))

  ok('the failure happened after the husk was created', huskCreated === true)
  ok('fails', result.ok === false, JSON.stringify(result.stage))
  ok('the project content came back', fs.existsSync(path.join(home.from, 'readme.txt')))
  ok('the destination is gone', !fs.existsSync(home.to))
  ok('the rollback reported no undo error', Array.isArray(result.rollback?.undoErrors) && result.rollback.undoErrors.length === 0, JSON.stringify(result.rollback))
  ok('the session is back under the old projectKey', fs.existsSync(path.join(home.oldKeyDir, 'session-1')))
  fs.rmSync(home.root, { recursive: true, force: true })
}

// ── moving a real directory leaves no husk, and only takes over an EMPTY one ──
console.log('\n[16] a real project-directory move leaves nothing behind at the source')
{
  const root = path.join(os.tmpdir(), `dwsm-move-${crypto.randomUUID().slice(0, 8)}`)
  const from = path.join(root, 'old')
  const to = path.join(root, 'new')
  fs.mkdirSync(path.join(from, 'src'), { recursive: true })
  fs.writeFileSync(path.join(from, 'marker.txt'), 'x\n')
  fs.writeFileSync(path.join(from, 'src', 'nested.txt'), 'y\n')

  const moved = moveProjectDirectory(from, to)
  ok('the move reports success', moved.ok === true, JSON.stringify(moved))
  ok('the content is at the destination', fs.existsSync(path.join(to, 'marker.txt')) && fs.existsSync(path.join(to, 'src', 'nested.txt')))
  ok('the original path is gone, so no rollback can hit a husk', !fs.existsSync(from))

  // Even if something recreates an empty original path, the undo must be able to proceed.
  fs.mkdirSync(from, { recursive: true })
  const back = moveProjectDirectory(to, from)
  ok('the rollback takes over an empty destination', back.ok === true, JSON.stringify(back))
  ok('the content came back', fs.existsSync(path.join(from, 'marker.txt')))

  // An existing but EMPTY destination is accepted without any flag: that is the whole point of
  // "empty is fine" (D21) — the user may have prepared the folder themselves.
  const emptyDestination = path.join(root, 'prepared')
  fs.mkdirSync(emptyDestination, { recursive: true })
  const intoEmpty = moveProjectDirectory(from, emptyDestination)
  ok('an existing empty destination is taken over', intoEmpty.ok === true, JSON.stringify(intoEmpty))
  ok('the content landed in it', fs.existsSync(path.join(emptyDestination, 'marker.txt')))

  // A destination holding only FOLDERS is not empty: a bare folder is content (D21).
  const foldersOnly = path.join(root, 'foldersonly')
  fs.mkdirSync(path.join(foldersOnly, 'an-empty-folder'), { recursive: true })
  const refusedFolders = moveProjectDirectory(emptyDestination, foldersOnly)
  ok('a destination holding only folders is refused', refusedFolders.ok === false, JSON.stringify(refusedFolders))
  ok('and the refusal says it is not empty', /is not empty/.test(String(refusedFolders.error)), String(refusedFolders.error))

  // A destination holding anything else is refused too, and nothing is touched.
  const occupied = path.join(root, 'occupied')
  fs.mkdirSync(occupied, { recursive: true })
  fs.writeFileSync(path.join(occupied, 'occupied.txt'), 'z\n')
  const refused = moveProjectDirectory(emptyDestination, occupied)
  ok('a non-empty destination is refused', refused.ok === false && /is not empty/.test(String(refused.error)), JSON.stringify(refused))
  ok('the refused move changed nothing', fs.existsSync(path.join(emptyDestination, 'marker.txt')) && fs.existsSync(path.join(occupied, 'occupied.txt')))
  fs.rmSync(root, { recursive: true, force: true })
}

// ── a live session whose directory holds SEVERAL generations ────────────────
//
// Found on a real host: a running conversation whose directory held both
// `session.jsonl.zstd` (v0) and `session.v3.jsonl.zstd` (v3). Moving only the generation the
// writer held left the other one under the old project key, and DSH then refused the session
// with "duplicate JSONL session id ... appears in multiple project directories" the moment the
// registry re-read its headers — at the memory layer, after the project directory had moved.
console.log('\n[17] a live session with several generation logs moves them all')
{
  const home = makeHome('gens', ['session-1'], { generations: [0, 3] })
  const registry = fakeRegistry(home)
  const services = fakeServices({
    registry,
    liveSessions: ['session-1'],
    rebindableWriters: true,
    sessionsRoot: home.sessionsRoot,
    cwdBySession: { 'session-1': home.from },
  })

  const result = await withHome(home, () => liveMoveSessions(services, { fromPath: home.from, toPath: home.to }))

  ok('succeeds', result.ok === true, JSON.stringify(result.blockers ?? result))
  // The invariant DSH itself enforces on every scan: one id, one project directory.
  const keysHolding = (id) =>
    fs.existsSync(home.sessionsRoot)
      ? fs
          .readdirSync(home.sessionsRoot)
          .filter((key) => fs.existsSync(path.join(home.sessionsRoot, key, id)))
      : []
  ok('the session id appears under exactly one project key', keysHolding('session-1').length === 1, JSON.stringify(keysHolding('session-1')))
  ok('and it is the new one', keysHolding('session-1')[0] === projectKeyOf(home.to), JSON.stringify(keysHolding('session-1')))

  const toDir = path.join(home.sessionsRoot, projectKeyOf(home.to), 'session-1')
  ok('both generations moved', fs.existsSync(path.join(toDir, 'session.jsonl.zstd')) && fs.existsSync(path.join(toDir, 'session.v3.jsonl.zstd')), JSON.stringify(fs.existsSync(toDir) ? fs.readdirSync(toDir) : 'missing dir'))
  ok('the old session directory is gone', !fs.existsSync(path.join(home.oldKeyDir, 'session-1')))

  for (const name of ['session.jsonl.zstd', 'session.v3.jsonl.zstd']) {
    const frames = splitFrames(fs.readFileSync(path.join(toDir, name)))
    const beforeFrames = home.beforeGenerations['session-1'][name]
    ok(`${name}: frames after 0 are byte-identical`, frames.length === beforeFrames.length && frames.slice(1).every((f, i) => f.equals(beforeFrames[i + 1])))
    ok(`${name}: the header cwd is the new path`, zlib.zstdDecompressSync(frames[0]).toString('utf8').includes(home.to.replace(/\\/g, '\\\\')))
  }
  fs.rmSync(home.root, { recursive: true, force: true })
}

// ── a path claimed by two records is refused, not papered over ──────────────
//
// Found on a real host: a manual apply re-pointed a record onto a path an empty leftover
// record already claimed, and DSH could not boot afterwards. `create()` is idempotent per
// path, so the live path would silently pick one of the two and leave the other in place.
console.log('\n[18] two records claiming the destination is refused')
{
  const home = makeHome('claim', ['session-1'])
  const registry = fakeRegistry(home, { extraDestinationClaim: true })
  const inspect = await inspectLiveMove(fakeServices({ registry }), { fromPath: home.from, toPath: home.to })
  ok('the precheck refuses', inspect.ok === false, JSON.stringify(inspect.blockers))
  ok('it names the reason', /claimed by 2 workspace records/.test(inspect.blockers.join(' ')), JSON.stringify(inspect.blockers))
  ok('it says what to do', /delete the extra one in the sidebar/.test(inspect.blockers.join(' ')), JSON.stringify(inspect.blockers))

  const move = await withHome(home, () => liveMoveSessions(fakeServices({ registry }), { fromPath: home.from, toPath: home.to }))
  ok('the move itself is refused too', move.ok === false && move.stage === 'precondition', JSON.stringify(move.stage))
  ok('nothing was touched', fs.existsSync(path.join(home.oldKeyDir, 'session-1')) && registry.entities.length === 3, JSON.stringify(registry.entities.map((entity) => entity.id)))
  fs.rmSync(home.root, { recursive: true, force: true })
}

// ── a destination that already holds anything is never taken over ──────────
console.log('\n[19] a destination that is not empty fails the check and is left untouched')
{
  const home = makeHome('occupied', ['session-1'])
  // `makeHome` writes readme.txt into both sides, so the destination has content already.
  const registry = fakeRegistry(home)
  const services = fakeServices({ registry, sessionsRoot: home.sessionsRoot, cwdBySession: { 'session-1': home.from } })

  const refused = await inspectLiveMove(services, { fromPath: home.from, toPath: home.to, moveProject: true })
  ok('moving the files into a destination that is not empty fails the check', refused.ok === false, JSON.stringify(refused))
  ok('the Check output names the directory', refused.blockers.join(' ').includes(home.to), JSON.stringify(refused.blockers))
  ok('and says it is not empty', /is not empty/.test(refused.blockers.join(' ')), JSON.stringify(refused.blockers))
  ok('it offers both ways forward', /empty it yourself/.test(refused.blockers.join(' ')) && /only change the path/.test(refused.blockers.join(' ')), JSON.stringify(refused.blockers))
  ok('nothing is promised about backing it up', !/back ?up|Desktop|parked/i.test([...refused.blockers, ...refused.notes].join(' ')), JSON.stringify([...refused.blockers, ...refused.notes]))

  const move = await withHome(home, () => liveMoveSessions(services, { fromPath: home.from, toPath: home.to, moveProject: true }))
  ok('the move itself is refused in the precondition stage', move.ok === false && move.stage === 'precondition', JSON.stringify(move.stage))
  ok('the destination keeps its own file, byte for byte', fs.readFileSync(path.join(home.to, 'readme.txt'), 'utf8') === 'y\n')
  ok('the source is untouched', fs.readFileSync(path.join(home.from, 'readme.txt'), 'utf8') === 'x\n')
  ok('the session stayed where it was', fs.existsSync(path.join(home.oldKeyDir, 'session-1')))
  ok('no workspace was registered at the destination', !registry.entities.some((entity) => entity.path === home.to), JSON.stringify(registry.entities.map((entity) => entity.path)))

  // The same non-empty destination is fine when nothing is copied over it: with「仅修改目录」the
  // workspace simply starts pointing at a directory that has content of its own.
  const keep = await inspectLiveMove(services, { fromPath: home.from, toPath: home.to })
  ok('「仅修改目录」accepts the very same destination', keep.ok === true, JSON.stringify(keep.blockers))
  fs.rmSync(home.root, { recursive: true, force: true })
}

// ── a destination holding only FOLDERS counts as content ───────────────────
//
// Reported by the user: a destination whose top level held only an (empty) folder was accepted and
// then merged into. A bare folder is content — some projects use one as a marker — so the rule is
// "the top-level listing must be empty", not "there must be no files".
console.log('\n[19b] a destination holding only folders is not empty')
{
  const home = makeHome('foldersonly', ['session-1'], { destinationExists: false })
  fs.mkdirSync(path.join(home.to, 'a-marker-folder'), { recursive: true })
  fs.mkdirSync(path.join(home.to, 'another', 'nested'), { recursive: true })
  const registry = fakeRegistry(home)
  const services = fakeServices({ registry, sessionsRoot: home.sessionsRoot, cwdBySession: { 'session-1': home.from } })

  const refused = await inspectLiveMove(services, { fromPath: home.from, toPath: home.to, moveProject: true })
  ok('a folder-only destination fails the check', refused.ok === false, JSON.stringify(refused.blockers))
  ok('it is reported as not empty', /is not empty/.test(refused.blockers.join(' ')), JSON.stringify(refused.blockers))

  const move = await withHome(home, () => liveMoveSessions(services, { fromPath: home.from, toPath: home.to, moveProject: true }))
  ok('the move is refused before touching anything', move.ok === false && move.stage === 'precondition', JSON.stringify(move.stage))
  ok('the folders are still the only thing there', fs.readdirSync(home.to).sort().join(',') === 'a-marker-folder,another', JSON.stringify(fs.readdirSync(home.to)))
  ok('the source is untouched', fs.readFileSync(path.join(home.from, 'readme.txt'), 'utf8') === 'x\n')
  fs.rmSync(home.root, { recursive: true, force: true })
}

// ── an existing but EMPTY destination is accepted and used ─────────────────
//
// Reported by the user: the check passed an existing empty destination, then the move refused it at
// the project layer ("the destination already exists"). A folder the user prepared is exactly what
// "empty is fine" means — and the same rule must hold for the rollback's empty husk.
console.log('\n[19c] an existing empty destination is taken over by a live move')
{
  const home = makeHome('emptydest', ['session-1'], { destinationExists: false })
  fs.mkdirSync(home.to, { recursive: true })
  const registry = fakeRegistry(home)
  const services = fakeServices({ registry, sessionsRoot: home.sessionsRoot, cwdBySession: { 'session-1': home.from } })

  const inspect = await inspectLiveMove(services, { fromPath: home.from, toPath: home.to, moveProject: true })
  ok('the check passes', inspect.ok === true, JSON.stringify(inspect.blockers))
  ok('and says the destination is usable', inspect.notes.some((note) => /exists and is empty/.test(note)), JSON.stringify(inspect.notes))

  const result = await withHome(home, () => liveMoveSessions(services, { fromPath: home.from, toPath: home.to, moveProject: true }))
  ok('the move succeeds', result.ok === true, JSON.stringify(result.blockers ?? result))
  ok('the project content is at the destination', fs.readFileSync(path.join(home.to, 'readme.txt'), 'utf8') === 'x\n')
  ok('the source path is gone', !fs.existsSync(home.from))
  ok('the session moved to the new projectKey', fs.existsSync(path.join(home.sessionsRoot, projectKeyOf(home.to), 'session-1', 'session.v3.jsonl.zstd')))
  fs.rmSync(home.root, { recursive: true, force: true })
}

// ── a failure after the destination was created takes it back ──────────────
console.log('\n[20] a rollback removes the destination directory it created')
{
  const home = makeHome('mkundir', ['session-1'], { destinationExists: false })
  const services = fakeServices({
    registry: fakeRegistry(home, { failAttach: true }),
    sessionsRoot: home.sessionsRoot,
    cwdBySession: { 'session-1': home.from },
  })
  const result = await withHome(home, () => liveMoveSessions(services, { fromPath: home.from, toPath: home.to }))

  ok('the run fails in the memory layer', result.ok === false && result.stage === 'memory-layer', JSON.stringify(result.stage))
  ok('the created destination directory is gone again', !fs.existsSync(home.to), home.to)
  ok('the rollback reported no undo error', Array.isArray(result.rollback?.undoErrors) && result.rollback.undoErrors.length === 0, JSON.stringify(result.rollback))
  ok('the source project is intact', fs.readFileSync(path.join(home.from, 'readme.txt'), 'utf8') === 'x\n')
  ok('the session artifact is back at the old projectKey', fs.existsSync(path.join(home.oldKeyDir, 'session-1')))
  fs.rmSync(home.root, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL PASS' : 'FAILURES'}: ${checks - failures}/${checks} checks passed`)
process.exitCode = failures === 0 ? 0 : 1
