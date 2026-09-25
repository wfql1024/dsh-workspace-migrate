#!/usr/bin/env node
/**
 * Self-test for dsh-workspace-migrate against a synthetic DSH home.
 * Never touches the real $DSH_HOME. Proves plan/apply/verify/rollback and, above all,
 * that only frame 0 of each session log changes and every later frame stays byte-identical.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

// The engine under the package's lib/, one level up from this test.
const candidates = [
  new URL('../lib/dsh-workspace-migrate.mjs', import.meta.url),
]
const ENGINE =
  process.argv[2] ?? fileURLToPath(candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[1])
const NODE = process.execPath
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

let failures = 0
let checks = 0
const ok = (name, condition, detail = '') => {
  checks++
  if (!condition) {
    failures++
    console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    console.log(`  pass  ${name}${detail ? `  ${detail}` : ''}`)
  }
}

// ── independent frame splitter (byte scan), deliberately a DIFFERENT algorithm from the
//    engine's header-grammar parser, so agreement is real evidence.
function splitFramesByScan(buf) {
  const offsets = []
  let i = 0
  while ((i = buf.indexOf(MAGIC, i)) >= 0) {
    offsets.push(i)
    i++
  }
  return offsets.map((s, k) => buf.subarray(s, k + 1 < offsets.length ? offsets[k + 1] : buf.length))
}

function projectKey(cwd) {
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

function frame(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'))
}

/** Build a realistic multi-frame session log: header frame + one frame per event batch. */
function buildLog(id, cwd, { version, events }) {
  const header =
    version === 0
      ? { type: 'session', version: 0, id, createdAt: 1786000000000, cwd, delegationDepth: 0, agentPreset: 'standard' }
      : { type: 'session', version: 3, id, createdAt: 1786000000000, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
  const parts = [frame(`${JSON.stringify(header)}\n`)]
  for (const batch of events) {
    parts.push(frame(batch.map((event) => JSON.stringify(event)).join('\n') + '\n'))
  }
  return Buffer.concat(parts)
}

function run(args) {
  const result = spawnSync(NODE, [ENGINE, ...args], { encoding: 'utf8', windowsHide: true })
  let json
  try {
    json = JSON.parse(result.stdout)
  } catch {
    json = undefined
  }
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', json }
}

function freshRoot(label) {
  const dir = path.join(os.tmpdir(), `dsh-migrate-selftest-${label}-${crypto.randomUUID().slice(0, 8)}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ── scenario construction ────────────────────────────────────────────────────
function scenario(root, { sessions, foreignSession = false, duplicate = false, locks = false, destinationClaim = undefined }) {
  const dshHome = path.join(root, 'dsh-home')
  const sessionsRoot = path.join(dshHome, 'sessions')
  const storagesRoot = path.join(dshHome, 'storages')
  const projectRoot = path.join(root, 'projects')
  const from = path.join(projectRoot, 'old', 'DemoProject')
  const to = path.join(projectRoot, 'new', 'DemoProject')
  fs.mkdirSync(sessionsRoot, { recursive: true })
  fs.mkdirSync(storagesRoot, { recursive: true })
  fs.mkdirSync(from, { recursive: true })
  fs.writeFileSync(path.join(from, 'readme.txt'), 'hello\n')
  fs.mkdirSync(path.join(from, 'src', 'nested'), { recursive: true })
  fs.writeFileSync(path.join(from, 'src', 'nested', 'a.txt'), 'a\n'.repeat(500))

  const oldKey = projectKey(from)
  const newKey = projectKey(to)
  const oldKeyDir = path.join(sessionsRoot, oldKey)
  fs.mkdirSync(oldKeyDir, { recursive: true })

  const built = []
  for (const spec of sessions) {
    const dir = path.join(oldKeyDir, spec.id)
    fs.mkdirSync(dir, { recursive: true })
    const events = [
      [{ type: 'message', role: 'user', text: 'first prompt' }],
      [
        { type: 'message', role: 'assistant', text: 'reply one' },
        { type: 'tool', name: 'read', arg: 'from' },
      ],
      [{ type: 'message', role: 'user', text: 'second prompt WITH a path ' + from }],
    ]
    for (const version of spec.versions) {
      fs.writeFileSync(path.join(dir, version === 0 ? 'session.jsonl.zstd' : `session.v${version}.jsonl.zstd`), buildLog(spec.id, spec.cwd ?? from, { version, events }))
    }
    built.push({ ...spec, dir })
  }

  if (foreignSession) {
    const foreignId = 'session-foreign-0000-0000-000000000001'
    const dir = path.join(oldKeyDir, foreignId)
    fs.mkdirSync(dir, { recursive: true })
    const elsewhere = path.join(projectRoot, 'elsewhere')
    fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), buildLog(foreignId, elsewhere, { version: 3, events: [[]] }))
    built.push({ id: foreignId, dir, foreign: true })
  }

  if (duplicate) {
    const dupId = sessions[0].id
    const newKeyDir = path.join(sessionsRoot, newKey)
    fs.mkdirSync(path.join(newKeyDir, dupId), { recursive: true })
    fs.writeFileSync(path.join(newKeyDir, dupId, 'session.v3.jsonl.zstd'), buildLog(dupId, to, { version: 3, events: [[]] }))
  }

  if (locks) {
    // A lease lock lives inside the session directory it protects.
    fs.writeFileSync(path.join(oldKeyDir, sessions[0].id, 'session.lock'), 'lease')
  }

  // storages
  const workspaceId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const workspaces = {
    [workspaceId]: {
      path: from,
      title: 'DemoProject',
      sessionIds: sessions.map((s) => s.id),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
  }
  const workspaceIds = [workspaceId]
  // A second record claiming the destination path — the husk a previous move leaves behind, or
  // a real second workspace. DSH refuses to boot when a path is claimed twice, so the plan has
  // to deal with it either way.
  if (destinationClaim !== undefined) {
    const claimId = 'dddddddd-1111-2222-3333-444444444444'
    workspaces[claimId] = {
      path: to,
      title: 'Claimed',
      sessionIds: destinationClaim === 'occupied' ? [sessions[0]?.id ?? 'session-other'] : [],
      createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    }
    workspaceIds.unshift(claimId)
  }
  const workspaceDoc = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds, archivedSessionIds: [] },
    tables: { workspaces },
  }
  fs.writeFileSync(path.join(storagesRoot, 'workspace.json'), JSON.stringify(workspaceDoc, null, 2))

  const cacheSessions = {}
  for (const spec of sessions) {
    cacheSessions[spec.id] = {
      identity: { createdAt: 1786000000000, cwd: from },
      rows: { title: { ver: 1, seq: 4, val: 'A title' }, sessionStats: { ver: 1, seq: 4, val: { turns: 3 } } },
    }
  }
  const cacheDoc = { unit: { name: 'session_projcache', version: 3 }, global: null, tables: { sessions: cacheSessions } }
  fs.writeFileSync(path.join(storagesRoot, 'session_projcache.json'), JSON.stringify(cacheDoc, null, 2))

  const perSessionDir = path.join(storagesRoot, 'session_projcache', 'sessions')
  fs.mkdirSync(perSessionDir, { recursive: true })
  for (const spec of sessions) {
    fs.writeFileSync(
      path.join(perSessionDir, `${spec.id}.json`),
      JSON.stringify({ version: 7, record: { identity: { formatVersion: 3, createdAt: 1786000000000, cwd: from, isSeeded: false }, rows: { title: { ver: 1, seq: 4, val: null } } } }, null, 2),
    )
    // A document that legitimately mentions the old path as CONTENT must not be rewritten
    // anywhere except the identified identity field.
    fs.writeFileSync(
      path.join(perSessionDir, `${spec.id}.unrelated.json`),
      JSON.stringify({ note: `history mentions ${from} as text`, record: { identity: { cwd: 'C:\\somewhere\\else' } } }, null, 2),
    )
  }

  return { root, dshHome, sessionsRoot, storagesRoot, from, to, oldKey, newKey, oldKeyDir, workspaces, workspaceId, built, destinationClaimId: destinationClaim === undefined ? undefined : 'dddddddd-1111-2222-3333-444444444444' }
}

function framesOf(file) {
  return splitFramesByScan(fs.readFileSync(file))
}

// ── Test A: full happy path ─────────────────────────────────────────────────
console.log('\n[Test A] full migration: plan -> apply -> verify -> rollback')
{
  const root = freshRoot('A')
  const env = scenario(root, {
    sessions: [
      { id: 'session-11111111-1111-1111-1111-111111111111', versions: [0, 3] },
      { id: 'session-22222222-2222-2222-2222-222222222222', versions: [3] },
    ],
  })
  const base = ['--dsh-home', env.dshHome, '--json']
  const plan = run(['plan', '--from', env.from, '--to', env.to, ...base])
  ok('plan exits 0', plan.code === 0, plan.stderr.trim())
  ok('plan is ok', plan.json?.ok === true)
  ok('plan finds 2 sessions', plan.json?.sessions.toMigrate.length === 2)
  ok('plan finds 5 metadata patches', plan.json?.metadata.patches.length === 5, `got ${plan.json?.metadata.patches.length}`)
  ok('plan does not rewrite the unrelated cwd', !(plan.json?.metadata.patches ?? []).some((p) => p.file.includes('unrelated')))
  ok('plan stages a runner', typeof plan.json?.stage?.applyCmd === 'string' && fs.existsSync(plan.json.stage.applyCmd))

  const before = {}
  for (const spec of env.built) {
    for (const name of fs.readdirSync(spec.dir)) before[`${spec.id}/${name}`] = framesOf(path.join(spec.dir, name))
  }

  // verify BEFORE applying must read as "intact at the original path", never as damage
  const preVerify = run(['verify', '--plan', plan.json.stage.planFile, ...base])
  ok('verify before apply exits 0', preVerify.code === 0, JSON.stringify(preVerify.json?.failures))
  ok('verify before apply auto-detects the original state', preVerify.json?.detectedState === 'original', preVerify.json?.detectedState)
  ok('verify before apply explains it is not yet applied', (preVerify.json?.notes ?? []).some((n) => n.includes('NOT been applied')))
  ok('verify before apply changes nothing', fs.existsSync(env.from) && fs.existsSync(env.oldKeyDir))

  // apply must refuse while a DSH process is detectable (it is: this very node process is
  // not dsh, but the real check is exercised through the lock below)
  const apply = run(['apply', '--plan', plan.json.stage.planFile, '--yes', '--allow-running', ...base])
  ok('apply exits 0', apply.code === 0, apply.stderr.trim() || JSON.stringify(apply.json?.error))
  ok('apply status ok', apply.json?.status === 'ok', apply.json?.error ?? '')
  ok('apply wrote a backup', fs.existsSync(apply.json?.backup?.dir ?? ''))
  ok('apply verification passed', apply.json?.verification?.ok === true, JSON.stringify(apply.json?.verification?.failures))

  const newKeyDir = path.join(env.sessionsRoot, env.newKey)
  ok('old project key directory removed', !fs.existsSync(env.oldKeyDir))
  ok('new project key directory exists', fs.existsSync(newKeyDir))
  ok('both sessions under the new key', fs.readdirSync(newKeyDir).filter((n) => n.startsWith('session-')).length === 2)

  // frame-level assertions
  for (const spec of env.built) {
    for (const name of fs.readdirSync(path.join(newKeyDir, spec.id))) {
      const after = framesOf(path.join(newKeyDir, spec.id, name))
      const originalFrames = before[`${spec.id}/${name}`]
      ok(`${spec.id}/${name}: frame count preserved`, after.length === originalFrames.length, `${originalFrames.length} -> ${after.length}`)
      const tailSame = after.slice(1).every((f, i) => f.equals(originalFrames[i + 1]))
      ok(`${spec.id}/${name}: every frame after frame 0 is byte-identical`, tailSame)
      const text = zlib.zstdDecompressSync(after[0]).toString('utf8')
      ok(`${spec.id}/${name}: frame 0 is exactly one header line`, text.length > 0 && text.indexOf('\n') === text.length - 1)
      const header = JSON.parse(text.slice(0, -1))
      ok(`${spec.id}/${name}: header cwd updated`, header.cwd === env.to, header.cwd)
      ok(`${spec.id}/${name}: header key order preserved`, Object.keys(header).join(',') === Object.keys(JSON.parse(zlib.zstdDecompressSync(originalFrames[0]).toString('utf8').slice(0, -1))).join(','))
    }
  }

  // metadata
  const ws = JSON.parse(fs.readFileSync(path.join(env.storagesRoot, 'workspace.json'), 'utf8'))
  ok('workspace.json path updated', ws.tables.workspaces[env.workspaceId].path === env.to)
  ok('workspace.json title untouched', ws.tables.workspaces[env.workspaceId].title === 'DemoProject')
  ok('workspace.json sessionIds untouched', JSON.stringify(ws.tables.workspaces[env.workspaceId].sessionIds) === JSON.stringify(env.built.map((b) => b.id)))
  const cache = JSON.parse(fs.readFileSync(path.join(env.storagesRoot, 'session_projcache.json'), 'utf8'))
  ok('aggregate projcache cwd updated', cache.tables.sessions['session-11111111-1111-1111-1111-111111111111'].identity.cwd === env.to)
  const perSession = JSON.parse(fs.readFileSync(path.join(env.storagesRoot, 'session_projcache', 'sessions', 'session-11111111-1111-1111-1111-111111111111.json'), 'utf8'))
  ok('per-session projcache cwd updated', perSession.record.identity.cwd === env.to)
  ok('per-session projcache rows preserved', perSession.record.rows.title.val === null)
  const unrelated = JSON.parse(fs.readFileSync(path.join(env.storagesRoot, 'session_projcache', 'sessions', 'session-11111111-1111-1111-1111-111111111111.unrelated.json'), 'utf8'))
  ok('unrelated document untouched (content path kept, foreign cwd kept)', unrelated.note.includes(env.from) && unrelated.record.identity.cwd === 'C:\\somewhere\\else')

  // project moved
  ok('project moved to destination', fs.existsSync(path.join(env.to, 'src', 'nested', 'a.txt')))
  ok('project removed from source', !fs.existsSync(env.from))

  // verify
  const verify = run(['verify', '--plan', plan.json.stage.planFile, ...base])
  ok('verify exits 0 after migration', verify.code === 0, JSON.stringify(verify.json?.failures))
  ok('verify reports all checks pass', verify.json?.ok === true)
  ok('verify ran a meaningful number of checks', (verify.json?.checked ?? 0) >= 10, `checked=${verify.json?.checked}`)

  // rollback
  const rollback = run(['rollback', '--plan', plan.json.stage.planFile, '--yes', ...base])
  ok('rollback exits 0', rollback.code === 0, JSON.stringify(rollback.json?.verification?.failures))
  ok('rollback verification passed (original state)', rollback.json?.verification?.ok === true)
  ok('rollback restored the old key directory', fs.existsSync(env.oldKeyDir))
  ok('rollback removed the new key directory', !fs.existsSync(newKeyDir))
  ok('rollback moved the project back', fs.existsSync(path.join(env.from, 'src', 'nested', 'a.txt')))

  for (const spec of env.built) {
    for (const name of fs.readdirSync(path.join(env.oldKeyDir, spec.id))) {
      const restored = framesOf(path.join(env.oldKeyDir, spec.id, name))
      const original = before[`${spec.id}/${name}`]
      ok(`${spec.id}/${name}: rollback restored the frames byte-for-byte`, restored.length === original.length && restored.every((f, i) => f.equals(original[i])))
    }
  }
  const wsBack = JSON.parse(fs.readFileSync(path.join(env.storagesRoot, 'workspace.json'), 'utf8'))
  ok('rollback restored workspace.json', wsBack.tables.workspaces[env.workspaceId].path === env.from)
  const verifyOriginal = run(['verify', '--plan', plan.json.stage.planFile, '--expect', 'original', ...base])
  ok('verify --expect original passes after rollback', verifyOriginal.json?.ok === true, JSON.stringify(verifyOriginal.json?.failures))
}

// ── Test B: a foreign session sharing the key directory is never moved ──────
console.log('\n[Test B] foreign session in the same project key directory')
{
  const root = freshRoot('B')
  const env = scenario(root, { sessions: [{ id: 'session-33333333-3333-3333-3333-333333333333', versions: [3] }], foreignSession: true })
  const base = ['--dsh-home', env.dshHome, '--json']
  const plan = run(['plan', '--from', env.from, '--to', env.to, ...base])
  ok('plan still ok with a foreign session', plan.json?.ok === true, JSON.stringify(plan.json?.errors))
  ok('foreign session reported, not queued', plan.json?.sessions.toMigrate.length === 1 && plan.json?.sessions.foreign.length === 1)
  const apply = run(['apply', '--plan', plan.json.stage.planFile, '--yes', '--allow-running', ...base])
  ok('apply exits 0', apply.code === 0, apply.json?.error ?? apply.stderr.trim())
  ok('foreign session left in the old key directory', fs.existsSync(path.join(env.oldKeyDir, 'session-foreign-0000-0000-000000000001')))
  ok('old key directory kept because it is not empty', fs.existsSync(env.oldKeyDir))
  ok('target session moved to the new key', fs.existsSync(path.join(env.sessionsRoot, env.newKey, 'session-33333333-3333-3333-3333-333333333333')))
}

// ── Test C: a duplicated session id is refused before any mutation ─────────
console.log('\n[Test C] duplicate session id refuses safely')
{
  const root = freshRoot('C')
  const env = scenario(root, { sessions: [{ id: 'session-44444444-4444-4444-4444-444444444444', versions: [3] }], duplicate: true })
  const base = ['--dsh-home', env.dshHome, '--json']
  const plan = run(['plan', '--from', env.from, '--to', env.to, ...base])
  ok('plan is blocked by the duplicate', plan.json?.ok === false && plan.json?.errors.some((e) => e.includes('duplicated')))
  ok('plan still exits 1', plan.code === 1)
  const apply = run(['apply', '--plan', plan.json.stage.planFile, '--yes', '--allow-running', ...base])
  ok('apply refuses', apply.code === 1)
  ok('nothing was mutated', fs.existsSync(path.join(env.oldKeyDir, 'session-44444444-4444-4444-4444-444444444444')) && fs.existsSync(env.from))
}

// ── Test D: a live session.lock blocks apply ───────────────────────────────console.log('\n[Test D] a live session.lock blocks apply')
{
  const root = freshRoot('D')
  const env = scenario(root, { sessions: [{ id: 'session-55555555-5555-5555-5555-555555555555', versions: [3] }], locks: true })
  const base = ['--dsh-home', env.dshHome, '--json']
  const plan = run(['plan', '--from', env.from, '--to', env.to, ...base])
  const apply = run(['apply', '--plan', plan.json.stage.planFile, '--yes', '--allow-running', ...base])
  ok('apply exits 1', apply.code === 1)
  ok('apply blames the lease lock', (apply.json?.blockers ?? []).some((b) => b.includes('session.lock')), JSON.stringify(apply.json?.blockers))
  ok('nothing was mutated', fs.existsSync(path.join(env.oldKeyDir, 'session-55555555-5555-5555-5555-555555555555')))
  const forced = run(['apply', '--plan', plan.json.stage.planFile, '--yes', '--allow-running', '--allow-lock', ...base])
  ok('apply succeeds with --allow-lock', forced.code === 0, forced.json?.error ?? forced.stderr.trim())
  ok('the lease file moved with its session directory', fs.existsSync(path.join(env.sessionsRoot, env.newKey, 'session-55555555-5555-5555-5555-555555555555', 'session.lock')))
}

// ── Test E: relocate-sessions (the live-caller entry point) ────────────────
console.log('\n[Test E] relocate-sessions: scoped, frame-safe, and workspace.json is left alone')
{
  const root = freshRoot('E')
  const movedId = 'session-66666666-6666-6666-6666-666666666666'
  const keptId = 'session-77777777-7777-7777-7777-777777777777'
  const env = scenario(root, { sessions: [{ id: movedId, versions: [0, 3] }, { id: keptId, versions: [3] }] })
  const base = ['--dsh-home', env.dshHome, '--json']
  const reportFile = path.join(root, 'relocate-report.json')

  // snapshot every session log BEFORE, plus workspace.json
  const before = {}
  for (const spec of env.built) {
    for (const name of fs.readdirSync(spec.dir)) before[`${spec.id}/${name}`] = framesOf(path.join(spec.dir, name))
  }
  const workspacePath = path.join(env.storagesRoot, 'workspace.json')
  const workspaceBefore = fs.readFileSync(workspacePath, 'utf8')

  // The project directory is NOT moved by this command (the caller owns it), so
  // keep it in place: `--from` must still exist for the plan to be meaningful.
  const result = run([
    'relocate-sessions',
    '--from', env.from,
    '--to', env.to,
    '--sessions', movedId,
    '--yes',
    '--allow-running',
    '--report', reportFile,
    ...base,
  ])
  ok('exits 0', result.code === 0, result.json?.error ?? result.stderr.trim())
  ok('report status ok', result.json?.status === 'ok', result.json?.error ?? '')
  ok('a report file was written', fs.existsSync(reportFile))
  ok('the report carries a plan snapshot for rollback', JSON.parse(fs.readFileSync(reportFile, 'utf8')).planData !== undefined)

  const newKeyDir = path.join(env.sessionsRoot, env.newKey)
  ok('the selected session moved to the new project key', fs.existsSync(path.join(newKeyDir, movedId)))
  ok('the unselected session did NOT move', fs.existsSync(path.join(env.oldKeyDir, keptId)))
  ok('the old project key directory survives (it still holds a session)', fs.existsSync(env.oldKeyDir))

  // frame-level assertions on the moved session only
  for (const name of fs.readdirSync(path.join(newKeyDir, movedId))) {
    const after = framesOf(path.join(newKeyDir, movedId, name))
    const original = before[`${movedId}/${name}`]
    ok(`${name}: frame count preserved`, after.length === original.length, `${original.length} -> ${after.length}`)
    ok(`${name}: every frame after frame 0 is byte-identical`, after.slice(1).every((f, i) => f.equals(original[i + 1])))
    const text = zlib.zstdDecompressSync(after[0]).toString('utf8')
    ok(`${name}: frame 0 is still exactly one header line`, text.length > 0 && text.indexOf('\n') === text.length - 1)
    ok(`${name}: header cwd updated`, JSON.parse(text.slice(0, -1)).cwd === env.to)
  }
  // the kept session must be untouched, byte for byte
  for (const name of fs.readdirSync(path.join(env.oldKeyDir, keptId))) {
    const after = framesOf(path.join(env.oldKeyDir, keptId, name))
    const original = before[`${keptId}/${name}`]
    ok(`${keptId}/${name}: left byte-identical`, after.length === original.length && after.every((f, i) => f.equals(original[i])))
  }

  // the whole point of this command: workspace.json belongs to the live caller
  ok('workspace.json is byte-identical (never touched)', fs.readFileSync(workspacePath, 'utf8') === workspaceBefore)
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
  ok('the plan records that workspace.json patches were deferred', report.planData.metadata.skipWorkspaceJson === true)
  ok('the deferred patches are reported, not silently dropped', Array.isArray(report.planData.metadata.workspaceJsonSkipped))

  // projcache: moved session updated, kept session untouched
  const cache = JSON.parse(fs.readFileSync(path.join(env.storagesRoot, 'session_projcache.json'), 'utf8'))
  ok('projcache cwd updated for the moved session', cache.tables.sessions[movedId].identity.cwd === env.to, cache.tables.sessions[movedId].identity.cwd)
  ok('projcache cwd untouched for the kept session', cache.tables.sessions[keptId].identity.cwd === env.from, cache.tables.sessions[keptId].identity.cwd)
  const perMoved = JSON.parse(fs.readFileSync(path.join(env.storagesRoot, 'session_projcache', 'sessions', `${movedId}.json`), 'utf8'))
  ok('per-session projcache updated for the moved session', perMoved.record.identity.cwd === env.to)

  // ── rollback ──
  const rollback = run(['relocate-sessions', '--rollback', '--report', reportFile, '--yes', ...base])
  ok('rollback exits 0', rollback.code === 0, rollback.json?.error ?? JSON.stringify(rollback.json?.verification?.failures))
  ok('rollback verification passed', rollback.json?.verification?.ok === true)
  ok('rollback returned the session to the old key', fs.existsSync(path.join(env.oldKeyDir, movedId)))
  for (const name of fs.readdirSync(path.join(env.oldKeyDir, movedId))) {
    const restored = framesOf(path.join(env.oldKeyDir, movedId, name))
    const original = before[`${movedId}/${name}`]
    ok(`${movedId}/${name}: rollback restored the frames byte-for-byte`, restored.length === original.length && restored.every((f, i) => f.equals(original[i])))
  }
  ok('rollback left workspace.json alone too', fs.readFileSync(workspacePath, 'utf8') === workspaceBefore)
  const verifyOriginal = run(['verify', '--plan', reportFile.replace('relocate-report.json', 'x.json'), '--expect', 'original', ...base])
  void verifyOriginal
}

console.log('\n[Test F] relocate-sessions refuses bad input without mutating anything')
{
  const root = freshRoot('F')
  const env = scenario(root, { sessions: [{ id: 'session-88888888-8888-8888-8888-888888888888', versions: [3] }] })
  const base = ['--dsh-home', env.dshHome, '--json']
  const reportFile = path.join(root, 'r.json')
  const missing = run([
    'relocate-sessions', '--from', env.from, '--to', env.to,
    '--sessions', 'session-does-not-exist', '--yes', '--allow-running', '--report', reportFile, ...base,
  ])
  ok('an unknown session id is refused', missing.code === 1)
  ok('the refusal names the missing id', JSON.stringify(missing.json?.errors ?? []).includes('session-does-not-exist'))
  ok('nothing was mutated', fs.existsSync(path.join(env.oldKeyDir, 'session-88888888-8888-8888-8888-888888888888')))
  const noYes = run(['relocate-sessions', '--from', env.from, '--to', env.to, '--sessions', 'session-88888888-8888-8888-8888-888888888888', ...base])
  ok('without --yes it refuses with the usage code', noYes.code === 2, `exit ${noYes.code}`)
}

// ── Test G: pre-existing damage elsewhere must not block this migration ────
//
// Found on a real host: one session id sat under two project keys, and an interrupted
// relocation of an older build had left an EMPTY session directory under a third key. The
// global uniqueness check called that a violation and refused an unrelated migration —
// "post-migration verification failed: no session id appears under two project keys".
console.log('\n[Test G] unrelated pre-existing damage does not block a migration')
{
  const root = freshRoot('G')
  const target = 'session-99999999-9999-9999-9999-999999999999'
  const env = scenario(root, { sessions: [{ id: target, versions: [3] }] })
  const elsewhere = path.join(root, 'projects', 'elsewhere')

  // An empty orphan: a session directory with no generation log at all.
  const orphanId = 'session-7b63fd23-3b90-4b3f-b854-bd121785e8a9'
  const orphanDir = path.join(env.sessionsRoot, '--stale-project-key--', orphanId)
  fs.mkdirSync(orphanDir, { recursive: true })

  // A real duplicate between two project keys this migration does not touch.
  const twinId = 'session-0abcdef0-0000-0000-0000-000000000000'
  const twinDirs = ['--unrelated-one--', '--unrelated-two--'].map((key) => path.join(env.sessionsRoot, key, twinId))
  for (const dir of twinDirs) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), buildLog(twinId, elsewhere, { version: 3, events: [[]] }))
  }

  const base = ['--dsh-home', env.dshHome, '--json']
  const plan = run(['plan', '--from', env.from, '--to', env.to, ...base])
  ok('plan is not blocked by unrelated damage', plan.json?.ok === true, JSON.stringify(plan.json?.errors))
  const apply = run(['apply', '--plan', plan.json.stage.planFile, '--yes', '--allow-running', ...base])
  ok('apply exits 0', apply.code === 0, apply.json?.error ?? apply.stderr.trim())

  const notes = (apply.json?.verification?.notes ?? []).join(' | ')
  ok('the unrelated duplicate is reported, not enforced', /pre-existing duplicate session id/.test(notes), notes)
  ok('the empty orphan is reported, not enforced', /hold no session log/.test(notes), notes)
  ok('the empty orphan was registered as nothing', apply.json?.verification?.ok === true, JSON.stringify(apply.json?.verification?.failures))
  ok('the empty orphan was left alone', fs.existsSync(orphanDir))
  ok('the unrelated twin was left alone', twinDirs.every((dir) => fs.existsSync(path.join(dir, 'session.v3.jsonl.zstd'))))
  ok('the real migration still happened', fs.existsSync(path.join(env.sessionsRoot, env.newKey, target)))
}

// ── Test H: a duplicate this run IS responsible for still fails ────────────
//
// The scoping above must not excuse a duplicate the migration itself created, or one that
// involves the session being moved.
console.log('\n[Test H] a duplicate this migration is responsible for still fails')
{
  const root = freshRoot('H')
  const env = scenario(root, { sessions: [{ id: 'session-aaaaaaaa-1111-1111-1111-111111111111', versions: [3] }] })
  // The migrated id also exists, with content, under a third key.
  const third = path.join(env.sessionsRoot, '--third-key--', 'session-aaaaaaaa-1111-1111-1111-111111111111')
  fs.mkdirSync(third, { recursive: true })
  fs.writeFileSync(
    path.join(third, 'session.v3.jsonl.zstd'),
    buildLog('session-aaaaaaaa-1111-1111-1111-111111111111', path.join(root, 'projects', 'elsewhere'), { version: 3, events: [[]] }),
  )

  const base = ['--dsh-home', env.dshHome, '--json']
  const plan = run(['plan', '--from', env.from, '--to', env.to, ...base])
  const apply = run(['apply', '--plan', plan.json.stage.planFile, '--yes', '--allow-running', ...base])
  ok('apply fails', apply.code === 1, `exit ${apply.code}`)
  ok('the failure names the two project keys', JSON.stringify(apply.json?.error ?? '').includes('two project keys'), apply.json?.error)
}

// ── Test I: the destination path must not end up claimed twice ─────────────
//
// Found on a real host: a manual apply re-pointed the source record onto a path an empty
// leftover record already claimed, and DSH then refused to boot —
// "path ... is claimed by both workspace A and B".
console.log('\n[Test I] an empty record on the destination path is removed, not duplicated')
{
  const root = freshRoot('I')
  const movedId = 'session-bbbbbbbb-1111-1111-1111-111111111111'
  const env = scenario(root, { sessions: [{ id: movedId, versions: [3] }], destinationClaim: 'empty' })
  const base = ['--dsh-home', env.dshHome, '--json']

  const plan = run(['plan', '--from', env.from, '--to', env.to, '--project', 'keep', ...base])
  ok('the plan is still ok', plan.json?.ok === true, JSON.stringify(plan.json?.errors))
  ok('it plans to remove the empty record', (plan.json?.metadata.removals ?? []).length === 1, JSON.stringify(plan.json?.metadata.removals))
  ok('it says why', (plan.json?.warnings ?? []).some((w) => /already claimed/.test(w)), JSON.stringify(plan.json?.warnings))

  const apply = run(['apply', '--plan', plan.json.stage.planFile, '--yes', '--allow-running', ...base])
  ok('apply exits 0', apply.code === 0, apply.json?.error ?? apply.stderr.trim())
  const doc = JSON.parse(fs.readFileSync(path.join(env.storagesRoot, 'workspace.json'), 'utf8'))
  const claiming = Object.entries(doc.tables.workspaces).filter(([, w]) => w.path === env.to)
  ok('exactly one record claims the destination', claiming.length === 1, JSON.stringify(claiming.map(([id, w]) => `${id}:${w.path}`)))
  ok('the surviving record is the migrated one', claiming[0]?.[0] === env.workspaceId, String(claiming[0]?.[0]))
  ok('the empty record is gone from the order too', !doc.global.workspaceIds.includes(env.destinationClaimId), JSON.stringify(doc.global.workspaceIds))
  const verify = run(['verify', '--plan', plan.json.stage.planFile, ...base])
  ok('verify passes', verify.json?.ok === true, JSON.stringify(verify.json?.failures))
  ok('verify checks the boot invariant', (verify.json?.checks ?? []).some((c) => c.name === 'no workspace path is claimed by two records'), JSON.stringify((verify.json?.checks ?? []).map((c) => c.name)))
}

// ── Test J: a destination claim that holds sessions is refused ─────────────
console.log('\n[Test J] a populated destination claim is refused, not merged')
{
  const root = freshRoot('J')
  const env = scenario(root, { sessions: [{ id: 'session-cccccccc-1111-1111-1111-111111111111', versions: [3] }], destinationClaim: 'occupied' })
  const base = ['--dsh-home', env.dshHome, '--json']
  const plan = run(['plan', '--from', env.from, '--to', env.to, '--project', 'keep', ...base])
  ok('the plan is refused', plan.json?.ok === false, JSON.stringify(plan.json?.errors))
  ok('the refusal names the claiming record', JSON.stringify(plan.json?.errors ?? []).includes(env.destinationClaimId), JSON.stringify(plan.json?.errors))
  ok('it explains that merging is not its call', JSON.stringify(plan.json?.errors ?? []).includes('merging two workspaces'), JSON.stringify(plan.json?.errors))
  // The refused plan is still staged (so it can be inspected), but applying it must be blocked.
  const apply = run(['apply', '--plan', plan.json.stage.planFile, '--yes', '--allow-running', ...base])
  ok('applying the refused plan is blocked', apply.code === 1 && /plan is not ok/.test(`${apply.json?.error ?? ''}${apply.stderr ?? ''}`), `exit ${apply.code}: ${apply.json?.error ?? apply.stderr?.trim()}`)
  const doc = JSON.parse(fs.readFileSync(path.join(env.storagesRoot, 'workspace.json'), 'utf8'))
  ok('the store is untouched', Object.keys(doc.tables.workspaces).length === 2, JSON.stringify(Object.keys(doc.tables.workspaces)))
}

// ── Test K: the staged scripts refuse to run while DSH is up ───────────────
console.log('\n[Test K] the staged scripts guard against a running DSH')
{
  const root = freshRoot('K')
  const env = scenario(root, { sessions: [{ id: 'session-dddddddd-1111-1111-1111-111111111111', versions: [3] }] })
  const base = ['--dsh-home', env.dshHome, '--json']
  const plan = run(['plan', '--from', env.from, '--to', env.to, '--project', 'keep', ...base])
  const applyCmd = fs.readFileSync(plan.json.stage.applyCmd, 'utf8')
  const rollbackCmd = fs.readFileSync(plan.json.stage.rollbackCmd, 'utf8')
  const verifyCmd = fs.readFileSync(plan.json.stage.verifyCmd, 'utf8')
  ok('1-apply-migration.cmd checks for a running DSH first', applyCmd.includes('check-quiescent'), applyCmd)
  ok('and it refuses with an explanation', /if errorlevel 1/.test(applyCmd) && /Quit DSH completely/.test(applyCmd), applyCmd)
  ok('the check runs before the migration', applyCmd.indexOf('check-quiescent') < applyCmd.indexOf('apply --plan'), 'the guard must come first')
  ok('the check is given the plan, so it can probe the recorded origin', applyCmd.includes('check-quiescent --plan'), applyCmd)
  ok('the rollback script is guarded too', rollbackCmd.includes('check-quiescent'), rollbackCmd)
  ok('the read-only verify script needs no guard', !verifyCmd.includes('check-quiescent'), verifyCmd)

  // The command itself: it must answer, and it must never claim safety without being sure.
  const guard = run(['check-quiescent', ...base])
  ok('check-quiescent answers with 0 or 1', guard.code === 0 || guard.code === 1, `exit ${guard.code}`)
  const said = `${guard.stdout}${guard.stderr}`
  ok('it says which way it decided', /safe to continue|still running|could not determine/.test(said), said.trim())
}

// ── Test L: the recorded origin is probed, and it can decide on its own ─────
//
// The process probe alone once said "no DSH" while DSH was running. A plan now records the origin
// DSH was serving; if that port answers, the guard refuses no matter what the process list says.
console.log('\n[Test L] a plan remembers where DSH was serving, and the guard probes it')
{
  const root = freshRoot('L')
  const env = scenario(root, { sessions: [{ id: 'session-eeeeeeee-1111-1111-1111-111111111111', versions: [3] }] })
  const base = ['--dsh-home', env.dshHome, '--json']

  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const origin = `127.0.0.1:${port}`
  try {
    const plan = run(['plan', '--from', env.from, '--to', env.to, '--project', 'keep', '--dsh-origin', origin, ...base])
    ok('the plan records the origin', plan.json?.running?.origin === origin, JSON.stringify(plan.json?.running))
    ok('and warns that DSH is answering there', (plan.json?.warnings ?? []).some((w) => /is answering on/.test(w)), JSON.stringify(plan.json?.warnings))

    const listening = run(['check-quiescent', '--dsh-origin', origin, ...base])
    ok('a listening origin is a refusal', listening.code === 1, `exit ${listening.code}`)
    ok('and the refusal names the http origin', listening.stderr.includes(origin) && /http:/.test(listening.stderr), listening.stderr.trim())

    const viaPlan = run(['check-quiescent', '--plan', plan.json.stage.planFile, ...base])
    ok('reading the origin from the plan refuses too', viaPlan.code === 1, `exit ${viaPlan.code}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  const silent = run(['check-quiescent', '--dsh-origin', origin, ...base])
  const said = `${silent.stdout}${silent.stderr}`
  ok('a port nobody answers on is never reported as listening', !/http:/.test(said) || !said.includes(origin), said.trim())
  ok('and the guard still answers 0 or 1', silent.code === 0 || silent.code === 1, `exit ${silent.code}`)
}

// ── Test M: moving the files into a destination that holds files ────────────
console.log('\n[Test M] a non-empty destination fails the check and is left exactly as it was')
{
  const root = freshRoot('M')
  const env = scenario(root, { sessions: [{ id: 'session-ffffffff-1111-1111-1111-111111111111', versions: [3] }] })
  const base = ['--dsh-home', env.dshHome, '--json']
  // The destination already holds a file: nothing may be moved in over it, and nothing may be
  // parked anywhere either — the user decides what that directory is for.
  fs.mkdirSync(env.to, { recursive: true })
  fs.writeFileSync(path.join(env.to, 'occupant.txt'), 'old destination file\n')

  const plan = run(['plan', '--from', env.from, '--to', env.to, '--project', 'move', ...base])
  ok('the plan is refused', plan.json?.ok === false, JSON.stringify(plan.json?.errors))
  ok('and it names the reason', JSON.stringify(plan.json?.errors ?? []).includes('already holds'), JSON.stringify(plan.json?.errors))
  ok('it names the directory', (plan.json?.errors ?? []).some((error) => error.includes(env.to)), JSON.stringify(plan.json?.errors))
  ok('it offers emptying it or only changing the path', (plan.json?.errors ?? []).some((error) => /empty it yourself/.test(error) && /only change the path/.test(error)), JSON.stringify(plan.json?.errors))
  ok('it promises nothing about a backup', !/back ?up|Desktop|parked/i.test(JSON.stringify(plan.json?.errors ?? [])), JSON.stringify(plan.json?.errors))
  ok('the staged plan carries the refusal', (() => {
    const staged = JSON.parse(fs.readFileSync(plan.json.stage.planFile, 'utf8'))
    return staged.ok === false && (staged.errors ?? []).length > 0
  })(), JSON.stringify(plan.json?.stage))
  ok('the occupying file is untouched', fs.readFileSync(path.join(env.to, 'occupant.txt'), 'utf8') === 'old destination file\n')
  ok('the source is untouched', fs.existsSync(path.join(env.from, 'src', 'nested', 'a.txt')))

  // The same destination is fine for "only change the path": nothing is copied over it.
  const keep = run(['plan', '--from', env.from, '--to', env.to, '--project', 'keep', ...base])
  ok('the same destination is accepted by --project keep', keep.json?.ok === true, JSON.stringify(keep.json?.errors))
}

// ── Test M2: an empty or missing destination for a project move ─────────────
console.log('\n[Test M2] an empty destination is fine; "only change the path" creates a missing one')
{
  const root = freshRoot('M2')
  const env = scenario(root, { sessions: [{ id: 'session-ffffffff-2222-2222-2222-222222222222', versions: [3] }] })
  const base = ['--dsh-home', env.dshHome, '--json']

  // An existing but empty destination: the move may use it.
  fs.mkdirSync(env.to, { recursive: true })
  const intoEmpty = run(['plan', '--from', env.from, '--to', env.to, '--project', 'move', ...base])
  ok('an empty destination is accepted', intoEmpty.json?.ok === true, JSON.stringify(intoEmpty.json?.errors))

  // A missing destination for "only change the path": the plan says it will be created, and apply
  // creates exactly that one empty directory.
  const missingTo = path.join(root, 'brand', 'new', 'Place')
  const keep = run(['plan', '--from', env.from, '--to', missingTo, '--project', 'keep', ...base])
  ok('a missing destination is accepted', keep.json?.ok === true, JSON.stringify(keep.json?.errors))
  ok('the plan marks it for creation', keep.json?.project?.createDestination === true, JSON.stringify(keep.json?.project))
  ok('and says so in the warnings', (keep.json?.warnings ?? []).some((w) => /does not exist yet; apply creates it/.test(w)), JSON.stringify(keep.json?.warnings))
  ok('nothing was created at plan time', !fs.existsSync(missingTo))

  const apply = run(['apply', '--plan', keep.json.stage.planFile, '--yes', '--allow-running', ...base])
  ok('apply exits 0', apply.code === 0, apply.json?.error ?? apply.stderr.trim())
  ok('the destination directory now exists', fs.existsSync(missingTo) && fs.statSync(missingTo).isDirectory(), missingTo)
  ok('it is empty', fs.readdirSync(missingTo).length === 0, JSON.stringify(fs.readdirSync(missingTo)))
  ok('the source project was not touched', fs.existsSync(path.join(env.from, 'src', 'nested', 'a.txt')))
  const verify = run(['verify', '--plan', keep.json.stage.planFile, ...base])
  ok('verify passes', verify.json?.ok === true, JSON.stringify(verify.json?.failures))

  // A path on a drive that is not there is refused rather than attempted.
  const missingDrive = ['A:\\', 'B:\\'].find((candidate) => !fs.existsSync(candidate))
  if (missingDrive === undefined) {
    console.log('  (skipped: no absent drive letter to test with)')
  } else {
    const impossible = run(['plan', '--from', env.from, '--to', path.join(missingDrive, 'nope', 'Place'), '--project', 'keep', ...base])
    ok('a destination on a missing drive is still refused', impossible.json?.ok === false, JSON.stringify(impossible.json?.errors))
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : 'FAILURES'}: ${checks - failures}/${checks} checks passed`)
process.exitCode = failures === 0 ? 0 : 1
