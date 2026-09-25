/**
 * Host-half integration test for dsh-workspace-migrate.
 *
 * Mounts the plugin against a fake cordis context, then drives its real HTTP
 * route handlers — so the loopback fence, the JSON bodies, the engine bridge and
 * the tool definition are all exercised for real without booting DSH.
 *
 * Read-only: it only ever runs `plan` / `list` / `verify` / the `apply` refusal.
 */
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const plugin = (await import('../index.js')).default
const { createTool } = await import('../index.js')

// ── fake cordis context ─────────────────────────────────────────────────────
const routes = []
let tool = null
const ctx = {
  effect(fn) {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  get(name) {
    if (name === 'tools') {
      return {
        register(definition) {
          tool = definition
          return () => {}
        },
      }
    }
    return undefined
  },
}

plugin.apply(ctx)

let checks = 0
let failures = 0
const ok = (label, condition, detail = '') => {
  checks++
  if (condition) {
    console.log(`  pass  ${label}`)
  } else {
    failures++
    console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`)
  }
}

// ── fake HTTP plumbing ──────────────────────────────────────────────────────
function fakeRequest({ method = 'GET', body, remoteAddress = '127.0.0.1', host = '127.0.0.1:3080', headers = {} } = {}) {
  const handlers = new Map()
  const req = {
    method,
    socket: { remoteAddress },
    headers: { host, ...headers },
    on(event, listener) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(listener)
      return req
    },
    emit(event, value) {
      for (const listener of handlers.get(event) ?? []) listener(value)
    },
  }
  req.__body = body
  return req
}

function fakeResponse() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = typeof body === 'string' ? body : ''
    },
  }
}

/** Drive one route the way the webserver would, delivering a JSON body if present. */
async function call(path, { method = 'GET', body, ...rest } = {}) {
  const route = routes.find((entry) => entry.path === path)
  assert.ok(route, `route ${path} is registered`)
  const req = fakeRequest({ method, ...rest })
  const res = fakeResponse()
  const promise = route.handler(req, res)
  if (body !== undefined) {
    req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
  }
  req.emit('end')
  await promise
  let payload = null
  try {
    payload = JSON.parse(res.body)
  } catch {
    payload = null
  }
  return { status: res.status, payload }
}

// ── tests ───────────────────────────────────────────────────────────────────
console.log('\n[1] mounting')
ok('plugin exposes a name', plugin.name === 'dsh-workspace-migrate', plugin.name)
ok('plugin injects webServer', Array.isArray(plugin.inject) && plugin.inject.includes('webServer'))
ok('registers ten routes', routes.length === 10, `got ${routes.length}: ${routes.map((r) => r.path).join(', ')}`)
ok('every route is exact-kind', routes.every((route) => route.kind === 'exact'))
ok('registers the workspace_migrate tool', tool !== null && tool.name === 'workspace_migrate', tool ? tool.name : 'none')
ok('tool declares all five actions', JSON.stringify(tool.parameters.properties.action.enum) === JSON.stringify(['live', 'plan', 'status', 'verify', 'apply']), JSON.stringify(tool.parameters.properties.action.enum))
ok('tool renders content blocks', Array.isArray(tool.output.render({}, { summary: 's', details: 'd' })))

console.log('\n[2] loopback trust fence')
{
  const remote = await call('/api/dsh-workspace-migrate/state', { remoteAddress: '192.168.1.5' })
  ok('rejects a non-loopback socket with 403', remote.status === 403, `status ${remote.status}`)
  const hostHeader = await call('/api/dsh-workspace-migrate/state', { host: 'evil.example.com' })
  ok('rejects a non-loopback Host header with 403', hostHeader.status === 403, `status ${hostHeader.status}`)
  const crossSite = await call('/api/dsh-workspace-migrate/state', { headers: { 'sec-fetch-site': 'cross-site' } })
  ok('rejects a cross-site request with 403', crossSite.status === 403, `status ${crossSite.status}`)
  const crossOrigin = await call('/api/dsh-workspace-migrate/state', { headers: { origin: 'http://evil.example.com' } })
  ok('rejects a foreign Origin with 403', crossOrigin.status === 403, `status ${crossOrigin.status}`)
}

console.log('\n[3] GET /state against the real DSH home')
{
  const { status, payload } = await call('/api/dsh-workspace-migrate/state')
  ok('answers 200', status === 200, `status ${status}`)
  ok('reports ok', payload && payload.ok === true)
  ok('reports the DSH home', typeof payload.dshHome === 'string' && payload.dshHome.length > 0, payload && payload.dshHome)
  ok('exposes the engine path', typeof payload.engine === 'string' && payload.engine.endsWith('dsh-workspace-migrate.mjs'), payload && payload.engine)
  ok('lists registered workspaces', Array.isArray(payload.workspaces) && payload.workspaces.length >= 1, `${payload.workspaces && payload.workspaces.length} workspace(s)`)
  ok(
    'every workspace has an id, title, path and pathState',
    payload.workspaces.every((w) => typeof w.id === 'string' && typeof w.title === 'string' && typeof w.path === 'string' && typeof w.pathState === 'string'),
  )
  const kinds = new Set(payload.workspaces.map((w) => w.pathState))
  ok('pathState values are from the known set', [...kinds].every((k) => ['directory', 'file', 'missing'].includes(k)), [...kinds].join(','))
  ok('lists session project keys', Array.isArray(payload.projectKeys) && payload.projectKeys.length >= 1, `${payload.projectKeys && payload.projectKeys.length} key(s)`)
  ok('lists staged runs', Array.isArray(payload.runs))
  console.log('        workspaces:')
  for (const workspace of payload.workspaces) console.log(`          - ${workspace.title}  [${workspace.pathState}]  ${workspace.path}  (${workspace.sessionIds.length} sessions)`)

  // cross-check the workspace rows against a direct read of workspace.json
  const direct = JSON.parse(await (await import('node:fs/promises')).readFile(payload.workspaceFile, 'utf8'))
  const expected = Object.keys(direct.tables.workspaces).length
  ok('workspace count matches workspace.json', payload.workspaces.length === expected, `api=${payload.workspaces.length} file=${expected}`)
}

console.log('\n[4] POST validation')
{
  const missing = await call('/api/dsh-workspace-migrate/plan', { method: 'POST', body: { from: 'C:/x' } })
  ok('plan without `to` answers 400', missing.status === 400, `status ${missing.status}`)
  const wrongMethod = await call('/api/dsh-workspace-migrate/plan', { method: 'GET' })
  ok('GET on a mutating route answers 405', wrongMethod.status === 405, `status ${wrongMethod.status}`)
  const noPlan = await call('/api/dsh-workspace-migrate/verify', { method: 'POST', body: {} })
  ok('verify without planFile answers 400', noPlan.status === 400, `status ${noPlan.status}`)
}

console.log('\n[5] the apply refusal')
{
  const { status, payload } = await call('/api/dsh-workspace-migrate/apply', { method: 'POST', body: { planFile: 'C:/tmp/plan.json' } })
  ok('answers 409 Conflict', status === 409, `status ${status}`)
  ok('marks itself refused', payload && payload.refused === true)
  ok('explains the shutdown requirement', typeof payload.reason === 'string' && /DSH is stopped/i.test(payload.reason), payload && payload.reason)
  ok('hands back the exact commands', Array.isArray(payload.steps) && payload.steps.length >= 3)
  ok('names the engine in the steps', payload.steps.join('\n').includes('dsh-workspace-migrate.mjs'))
}

console.log('\n[6] plan round-trip against a path that cannot exist')
{
  const bogusFrom = 'Z:/definitely-not-here/dwsm-probe'
  const bogusTo = 'Z:/definitely-not-here/dwsm-target'
  // noStage: this test must not litter the real migration-runs directory.
  const { payload } = await call('/api/dsh-workspace-migrate/plan', { method: 'POST', body: { from: bogusFrom, to: bogusTo, noStage: true } })
  ok('the engine ran and answered with JSON', payload && payload.ok === true && payload.json)
  ok('a non-existent source is NOT reported as ready', payload.json.ok === false)
  ok('the block reason is reported', Array.isArray(payload.json.errors) && payload.json.errors.length > 0, JSON.stringify(payload.json.errors))
  ok('the block reason is the "nothing to migrate" one', /nothing to migrate/.test(payload.json.errors.join(' ')), payload.json.errors.join(' | '))
  ok('noStage really suppressed staging', payload.json.stage === undefined)
  console.log('        engine said: ' + payload.json.errors.join(' | '))
}

console.log('\n[6b] POST /session resolves a session id to its workspace')
{
  const bad = await call('/api/dsh-workspace-migrate/session', { method: 'POST', body: { sessionId: '../../etc/passwd' } })
  ok('a path-shaped session id is rejected with 400', bad.status === 400, `status ${bad.status}`)
  const empty = await call('/api/dsh-workspace-migrate/session', { method: 'POST', body: {} })
  ok('a missing session id is rejected with 400', empty.status === 400, `status ${empty.status}`)

  // Resolve a real session that the projection cache knows about.
  const { readdir: readDir } = await import('node:fs/promises')
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  let realId = null
  try {
    const names = await readDir(`${home}/storages/session_projcache/sessions`)
    realId = names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length))[0] ?? null
  } catch {
    realId = null
  }
  if (realId === null) {
    console.log('  skip  no projection-cache entries to resolve')
  } else {
    const { status, payload } = await call('/api/dsh-workspace-migrate/session', { method: 'POST', body: { sessionId: realId } })
    ok('a real session id answers 200', status === 200, `status ${status}`)
    ok('reports a cwd', payload && payload.ok === true && typeof payload.cwd === 'string' && payload.cwd.length > 0, JSON.stringify(payload && payload.cwd))
    ok('names the source it resolved from', payload && typeof payload.source === 'string', payload && payload.source)
    console.log(`        ${realId} -> ${payload.cwd}${payload.workspaceTitle ? '  [' + payload.workspaceTitle + ']' : '  [no matching workspace]'}`)
  }
}

console.log('\n[7] the tool drives the engine too')
{
  const status = await tool.execute({ action: 'status' })
  ok('status action succeeds', status.ok === true, status.summary)
  ok('status action has a summary', typeof status.summary === 'string' && status.summary.length > 0, status.summary)
  const refusal = await tool.execute({ action: 'apply' })
  ok('apply action refuses', refusal.ok === false)
  ok('apply refusal names the engine', String(refusal.details).includes('dsh-workspace-migrate.mjs'))
  const bad = await tool.execute({ action: 'nonsense' })
  ok('unknown action is reported', bad.ok === false && /unknown action/.test(bad.summary), bad.summary)
  const noArgs = await tool.execute({ action: 'plan' })
  ok('plan without paths is reported', noArgs.ok === false && /needs both/.test(noArgs.summary), noArgs.summary)

  // The live action must refuse cleanly in a Host with no workspaceRegistry (this fake
  // ctx), never throw — that is the headless / minimal-profile case.
  const liveNoPaths = await tool.execute({ action: 'live' })
  ok('live without paths is reported', liveNoPaths.ok === false && /needs both/.test(liveNoPaths.summary), liveNoPaths.summary)
  const liveDry = await tool.execute({ action: 'live', from: 'C:/a', to: 'C:/b', dryRun: true })
  ok('live dryRun answers with a verdict', typeof liveDry.summary === 'string' && /live preview/.test(liveDry.summary), liveDry.summary)
  ok('live dryRun names the missing registry', /workspaceRegistry/.test(String(liveDry.details)), String(liveDry.details))
  ok('live dryRun changed nothing', liveDry.ok === false)
  const liveReal = await tool.execute({ action: 'live', from: 'C:/a', to: 'C:/b' })
  ok('live refuses before mutating when preconditions fail', liveReal.ok === false && /refused before making any change/.test(liveReal.summary), liveReal.summary)
}

console.log('\n[8] a colliding route must not take down the plugin')
{
	const partial = []
	const colliding = {
		effect: (fn) => fn(),
		webServer: {
			register(route) {
				if (route.path.endsWith('/state')) throw new Error('simulated duplicate (kind, path)')
				partial.push(route.path)
				return () => {}
			},
		},
		get: () => undefined,
	}
	let threw = null
	try {
		plugin.apply(colliding)
	} catch (error) {
		threw = error
	}
	ok('apply() survives a colliding route', threw === null, threw && threw.message)
	ok('the remaining routes still mounted', partial.length === 9, `${partial.length}: ${partial.join(', ')}`)
	ok('the colliding route is the only one missing', !partial.some((p) => p.endsWith('/state')))
}

console.log('\n[9] the live-move routes')
{
  const missing = await call('/api/dsh-workspace-migrate/live-inspect', { method: 'POST', body: { from: 'C:/a' } })
  ok('live-inspect without `to` answers 400', missing.status === 400, `status ${missing.status}`)

  // This fake ctx exposes no workspaceRegistry, so the inspection must fail cleanly
  // rather than throw — exactly what a headless/host-without-registry profile sees.
  const inspect = await call('/api/dsh-workspace-migrate/live-inspect', { method: 'POST', body: { from: 'C:/a', to: 'C:/b' } })
  ok('live-inspect answers 200 with a verdict', inspect.status === 200, `status ${inspect.status}`)
  ok('live-inspect reports the missing service', inspect.payload && inspect.payload.ok === false && /workspaceRegistry/.test(String(inspect.payload.blockers)), JSON.stringify(inspect.payload && inspect.payload.blockers))

  const noConfirm = await call('/api/dsh-workspace-migrate/live-move', { method: 'POST', body: { from: 'C:/a', to: 'C:/b' } })
  ok('live-move without confirm is refused with 409', noConfirm.status === 409, `status ${noConfirm.status}`)
  ok('the refusal explains the confirm requirement', noConfirm.payload && noConfirm.payload.refused === true && /confirm/.test(String(noConfirm.payload.reason)), JSON.stringify(noConfirm.payload))

  // The manual/stop-DSH flow asks for the narrow verdict: the source path and the destination
  // directory, nothing live. On this ctx (no workspaceRegistry at all) that must come back usable
  // rather than reporting the missing service — the fallback route must not be blocked by a service
  // it never needs. The full check on the SAME paths still demands the registry, which is what makes
  // the two calls different rather than one of them merely lax.
  const narrowRoot = path.join(os.tmpdir(), `dwsm-projectonly-${crypto.randomUUID().slice(0, 8)}`)
  const narrowFrom = path.join(narrowRoot, 'old')
  const narrowTo = path.join(narrowRoot, 'new')
  fs.mkdirSync(narrowFrom, { recursive: true })
  const narrow = await call('/api/dsh-workspace-migrate/live-inspect', {
    method: 'POST',
    body: { from: narrowFrom, to: narrowTo, moveProject: true, projectOnly: true },
  })
  ok('projectOnly answers without the registry', narrow.payload && narrow.payload.ok === true, JSON.stringify(narrow.payload && narrow.payload.blockers))
  ok('and says the missing destination will be created', (narrow.payload?.notes ?? []).some((note) => /does not exist yet/.test(note)), JSON.stringify(narrow.payload && narrow.payload.notes))
  const fullCheck = await call('/api/dsh-workspace-migrate/live-inspect', {
    method: 'POST',
    body: { from: narrowFrom, to: narrowTo, moveProject: true },
  })
  ok('the full check on the same paths still demands the registry', fullCheck.payload && fullCheck.payload.ok === false && /workspaceRegistry/.test(String(fullCheck.payload.blockers)), JSON.stringify(fullCheck.payload && fullCheck.payload.blockers))
  fs.rmSync(narrowRoot, { recursive: true, force: true })

  const wrongMethod = await call('/api/dsh-workspace-migrate/live-move', { method: 'GET' })
  ok('GET on live-move answers 405', wrongMethod.status === 405, `status ${wrongMethod.status}`)
}

console.log('\n[10] the live action forwards every documented option to the registry')
{
  // A live move against a fake registry: the project move really happens on temp dirs, the
  // destination registration really happens, and the file layer then fails (there is no
  // session stored at the source), so the run rolls back. What matters here is that the
  // tool forwarded the caller's options, not that the move completed.
  const root = path.join(os.tmpdir(), `dwsm-hosttest-${crypto.randomUUID().slice(0, 8)}`)
  fs.rmSync(root, { recursive: true, force: true })
  const oldPath = path.join(root, 'old')
  const newPath = path.join(root, 'new')
  fs.mkdirSync(oldPath, { recursive: true })

  const created = []
  const entities = [
    {
      id: 'ws-1',
      title: 'Source',
      path: oldPath,
      sessionIds: ['session-probe'],
      record: { path: oldPath, title: 'Source', sessionIds: ['session-probe'] },
      async attachSession() {},
      async detachSession() {},
    },
  ]
  const registry = {
    list: () => [...entities],
    get: (id) => entities.find((entity) => entity.id === id),
    headers: new Map([['session-probe', { id: 'session-probe', cwd: oldPath }]]),
    sessionPaths: new Map([['session-probe', oldPath]]),
    invalidSessionPaths: new Map(),
    async create(targetPath, title) {
      created.push({ path: targetPath, title })
      const entity = {
        id: 'ws-2',
        title,
        path: targetPath,
        sessionIds: [],
        record: { path: targetPath, title, sessionIds: [] },
        async attachSession() {},
        async detachSession() {},
      }
      entities.push(entity)
      return entity
    },
    async delete(id) {
      // Must really remove the record, as the live registry does — a no-op stub here would
      // hide a rollback that failed to undo the registration.
      const at = entities.findIndex((entity) => entity.id === id)
      if (at >= 0) entities.splice(at, 1)
      return at >= 0
    },
    async enqueueOperation(operation) {
      return await operation()
    },
  }
  const liveServices = { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }

  const result = await createTool(liveServices).execute({
    action: 'live',
    from: oldPath,
    to: newPath,
    moveProject: true,
    title: 'Forwarded Title',
  })

  ok('the live action ran far enough to register the destination', created.length === 1, JSON.stringify(created))
  ok('it forwarded the title', created[0] !== undefined && created[0].title === 'Forwarded Title', JSON.stringify(created))
  ok('it forwarded the destination path', created[0] !== undefined && created[0].path === newPath, JSON.stringify(created))
  ok('it reports the later file-layer failure rather than claiming success', result.ok === false, result.summary)
  ok('the register/rollback cycle left no destination registration behind', !entities.some((entity) => entity.id === 'ws-2'), JSON.stringify(entities.map((e) => e.id)))
  fs.rmSync(root, { recursive: true, force: true })
}

console.log('\n[10] the open-directory route')
{
  // The UI's「打开目录」must not become a way for the page to open an arbitrary path: only
  // directories this plugin stages under <DSH_HOME>/migration-runs may be revealed.
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const runsRoot = path.join(home, 'migration-runs')

  const outside = await call('/api/dsh-workspace-migrate/open-directory', { method: 'POST', body: { path: os.tmpdir() } })
  ok('a path outside the run root is refused', outside.status === 403, `status ${outside.status}`)
  ok('the refusal names the run root', JSON.stringify(outside.payload).includes('migration-runs'), JSON.stringify(outside.payload))

  const missing = await call('/api/dsh-workspace-migrate/open-directory', { method: 'POST', body: {} })
  ok('a request without a path is refused', missing.status === 400, `status ${missing.status}`)

  const absent = await call('/api/dsh-workspace-migrate/open-directory', { method: 'POST', body: { path: path.join(runsRoot, 'no-such-run') } })
  ok('a directory that does not exist is a 404', absent.status === 404, `status ${absent.status}`)

  const traversal = await call('/api/dsh-workspace-migrate/open-directory', { method: 'POST', body: { path: path.join(runsRoot, '..', 'storages') } })
  ok('a traversal out of the run root is refused', traversal.status === 403, `status ${traversal.status}`)

  // A real staged directory is accepted. The launch seam keeps a test run from opening a file
  // manager on the developer's screen, and makes the launch itself observable.
  process.env.DSH_WORKSPACE_MIGRATE_DRY_OPEN = '1'
  const staged = path.join(runsRoot, 'run-for-test')
  const previous = fs.existsSync(staged)
  fs.mkdirSync(staged, { recursive: true })
  const accepted = await call('/api/dsh-workspace-migrate/open-directory', { method: 'POST', body: { path: staged } })
  ok('a staged directory is accepted', accepted.status === 200 && accepted.payload.ok === true, JSON.stringify(accepted.payload))
  ok('the answer names the directory', accepted.payload.path === staged, JSON.stringify(accepted.payload))
  ok('the launch is only reported, never performed, under the test seam', accepted.payload.launched === false, JSON.stringify(accepted.payload))
  // On Windows the hand-off goes through the shell: `explorer.exe <dir>` is also the form that
  // quietly does nothing when Explorer already shows that folder.
  if (process.platform === 'win32') {
    ok(
      'the Windows launch uses the shell hand-off',
      accepted.payload.command === 'cmd.exe' && Array.isArray(accepted.payload.args) && accepted.payload.args[1] === 'start',
      JSON.stringify(accepted.payload),
    )
  }
  if (!previous) fs.rmSync(staged, { recursive: true, force: true })
  delete process.env.DSH_WORKSPACE_MIGRATE_DRY_OPEN
}

console.log('\n[11] the state route prefers the live registry, and stale runs can be pruned')
{
  // Two facts are checked here. First: a workspace path another plugin changed in memory must show
  // up immediately, so the route reads the registry before workspace.json. Second: a staged run
  // whose source is no longer a registered workspace is unusable, and only those may be pruned.
  const home = path.join(os.tmpdir(), `dwsm-hosttest-runs-${crypto.randomUUID().slice(0, 8)}`)
  const runsRoot = path.join(home, 'migration-runs')
  const staleDir = path.join(runsRoot, '2026-01-01T00-00-00-000Z-stale')
  const liveDir = path.join(runsRoot, '2026-01-02T00-00-00-000Z-live')
  fs.mkdirSync(staleDir, { recursive: true })
  fs.mkdirSync(liveDir, { recursive: true })
  fs.writeFileSync(path.join(staleDir, 'plan.json'), JSON.stringify({ from: 'C:\\gone\\Workspace', to: 'C:\\new\\Workspace' }))
  fs.writeFileSync(path.join(liveDir, 'plan.json'), JSON.stringify({ from: 'C:\\kept\\Workspace', to: 'C:\\new2\\Workspace' }))
  fs.mkdirSync(path.join(home, 'storages'), { recursive: true })
  fs.writeFileSync(
    path.join(home, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: [] },
      tables: { workspaces: { w1: { path: 'C:/stale/Workspace', title: 'Stale', sessionIds: [] } } },
    }),
  )

  const previousHome = process.env.DSH_HOME
  const originalGet = ctx.get
  process.env.DSH_HOME = home
  ctx.get = (name) =>
    name === 'workspaceRegistry'
      ? {
          list: () => [
            { id: 'w1', path: 'C:\\kept\\Workspace', record: { path: 'C:\\kept\\Workspace', title: 'Kept', sessionIds: [] } },
          ],
        }
      : originalGet.call(ctx, name)
  try {
    const stated = await call('/api/dsh-workspace-migrate/state')
    ok('state answers 200', stated.status === 200, `status ${stated.status}`)
    ok('the workspace list comes from the live registry', stated.payload.workspaceSource === 'registry', JSON.stringify(stated.payload.workspaceSource))
    ok('the path is the live one, not the one on disk', stated.payload.workspaces[0]?.path === 'C:\\kept\\Workspace', JSON.stringify(stated.payload.workspaces))
    const stale = stated.payload.runs.find((run) => run.dir.endsWith('stale'))
    const live = stated.payload.runs.find((run) => run.dir.endsWith('live'))
    ok('a run whose source is gone is marked unusable', stale !== undefined && stale.usable === false, JSON.stringify(stale))
    ok('a run whose source is registered stays usable', live !== undefined && live.usable === true, JSON.stringify(live))

    const pruned = await call('/api/dsh-workspace-migrate/prune-runs', { method: 'POST', body: {} })
    ok('prune answers 200', pruned.status === 200 && pruned.payload.ok === true, JSON.stringify(pruned.payload))
    ok('it removed exactly the unusable run', pruned.payload.removed?.length === 1 && pruned.payload.removed[0].dir.endsWith('stale'), JSON.stringify(pruned.payload.removed))
    ok('the unusable run directory is gone', !fs.existsSync(staleDir))
    ok('the usable run directory is untouched', fs.existsSync(liveDir) && fs.existsSync(path.join(liveDir, 'plan.json')))
    ok('it reports what it kept', pruned.payload.kept === 1, JSON.stringify(pruned.payload.kept))

    const again = await call('/api/dsh-workspace-migrate/prune-runs', { method: 'POST', body: {} })
    ok('a second prune removes nothing', again.payload.removed?.length === 0, JSON.stringify(again.payload.removed))
    ok('and the usable run is still there', fs.existsSync(liveDir))
  } finally {
    ctx.get = originalGet
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : 'FAILURES'}: ${checks - failures}/${checks} checks passed`)
process.exitCode = failures === 0 ? 0 : 1
