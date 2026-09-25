/**
 * dsh-workspace-migrate — host face.
 *
 * Re-homes one DSH workspace: moves the project directory, rewrites the `cwd`
 * inside every session log header WITHOUT breaking the DSH zstd frame invariant
 * (frame 0 stays exactly one header line; every later frame is copied
 * byte-for-byte), relocates the session directories under the new projectKey,
 * and patches `storages/workspace.json` plus the session projection cache.
 *
 * The actual mutation runs in `lib/dsh-workspace-migrate.mjs` — the same engine
 * verified by its own 69-check sandbox suite. It is spawned as a child process
 * so this file keeps zero runtime imports beyond node builtins (a symlinked
 * pnpm `link:` install resolves ESM by real path, so external imports would be
 * fragile here).
 *
 * Why `apply` is refused from inside DSH: this process holds workspace.json,
 * session_projcache and the session log append paths in memory and checkpoints
 * them back to disk, so a migration performed underneath a live DSH is either
 * overwritten or corrupts the logs. `plan` and `verify` are read-only and safe
 * at any time; `apply` must run in the stopped window.
 *
 * The HTTP surface is loopback-fenced (session data is destructive to migrate),
 * matching the trust fence the other local-data plugins use.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectLiveMove, liveMoveSessions } from './lib/live-move.mjs'

/**
 * Development escape hatch for the live-move module.
 *
 * The cordis loader reuses an already-imported module for an unchanged entry name
 * (`cordis-plugin-loader`: `diff.includes("name") ? tree.import(...) : previous.runtime.callback`),
 * and that `import()` carries no cache-busting query — so Node's ESM cache pins whatever
 * `lib/live-move.mjs` looked like at boot for the whole process lifetime. Iterating on that
 * module would otherwise cost a full DSH restart per change.
 *
 * While `<package>/DEV_RELOAD` exists it is re-imported with a fresh query on every call.
 * The marker is never shipped, and without it this is a plain static import, so a normal
 * install behaves exactly as before. Delete this block and the two wrappers to remove it.
 */
const DEV_RELOAD_MARKER = new URL('./DEV_RELOAD', import.meta.url)
const LIVE_MOVE_URL = new URL('./lib/live-move.mjs', import.meta.url)

async function liveMoveModule() {
  if (existsSync(DEV_RELOAD_MARKER)) {
    return await import(`${LIVE_MOVE_URL.href}?t=${String(Date.now())}`)
  }
  return { inspectLiveMove, liveMoveSessions }
}

/** @see liveMoveModule for why these go through a loader instead of the static import. */
async function inspectLive(services, options) {
  return await (await liveMoveModule()).inspectLiveMove(services, options)
}

/** @see liveMoveModule for why these go through a loader instead of the static import. */
async function runLiveMove(services, options) {
  return await (await liveMoveModule()).liveMoveSessions(services, options)
}

const name = 'dsh-workspace-migrate'
const inject = ['webServer']

/** Absolute path of the migration engine shipped inside this package. */
const ENGINE = fileURLToPath(new URL('./lib/dsh-workspace-migrate.mjs', import.meta.url))

/** Route namespace owned by this plugin. */
const API = '/api/dsh-workspace-migrate'

/**
 * Reveal a directory in the OS file manager.
 *
 * On Windows this goes through `cmd /c start "" <dir>` — the same shell hand-off the Run box
 * uses. `explorer.exe <dir>` also works, but it is also the form that quietly does nothing
 * (and reports nothing) when Explorer already has that folder open.
 *
 * The answer waits for the `spawn`/`error` event rather than trusting `spawn()` to have
 * worked, so a missing `xdg-open` is reported instead of silently claimed as success. The
 * child is detached and unreferenced because DSH must not hold the file manager open, nor
 * wait for it to close.
 *
 * `DSH_WORKSPACE_MIGRATE_DRY_OPEN=1` reports what would be launched without launching it;
 * only the test suite and the diagnostic tool set it, so a test run never pops a window.
 */
async function revealDirectory(directory) {
  const windows = process.platform === 'win32'
  const command = windows ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = windows ? ['/c', 'start', '', directory] : [directory]
  if (process.env.DSH_WORKSPACE_MIGRATE_DRY_OPEN === '1') {
    return { ok: true, command, args, path: directory, launched: false }
  }
  // The DSH terminal is the only place that can confirm a GUI hand-off, so say it out loud
  // there as well as in the UI.
  console.log(`[dsh-workspace-migrate] opening ${directory}`)
  return await new Promise((settle) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      settle(value)
    }
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
      child.once('error', (error) => done({ ok: false, error: `could not open ${directory}: ${String((error && error.message) || error)}` }))
      child.once('spawn', () => {
        child.unref()
        done({ ok: true, command, path: directory })
      })
      // A file manager that never signals must not hold the request open.
      const timer = setTimeout(() => done({ ok: true, command, path: directory, unconfirmed: true }), 1500)
      if (typeof timer.unref === 'function') timer.unref()
    } catch (error) {
      done({ ok: false, error: `could not open ${directory}: ${String((error && error.message) || error)}` })
    }
  })
}

/** Request bodies are small JSON documents; this bound covers every action. */
const BODY_MAX_BYTES = 512 * 1024

/** How long one engine invocation may take before it is reported as stuck. */
const ENGINE_TIMEOUT_MS = 300000

// ─────────────────────────────────────────────────────────────────────────────
// small HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

function writeJson(res, status, value, headers = {}) {
  let body
  try {
    body = JSON.stringify(value)
  } catch {
    body = JSON.stringify({ ok: false, error: 'response was not JSON-serializable' })
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(body)
}

/** IPv4 127/8 predicate (four decimal octets, first == 127). */
function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * Request-level trust fence: loopback socket AND loopback Host header, plus the
 * browser same-origin markers. `X-Forwarded-For` is never trusted.
 */
function isLoopbackRequest(req) {
  if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Read a bounded JSON request body; an empty or invalid body reads as `{}`. */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_MAX_BYTES) {
        finish({})
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim().length === 0) {
        finish({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        finish(typeof parsed === 'object' && parsed !== null ? parsed : {})
      } catch {
        finish({})
      }
    })
    req.on('error', () => finish({}))
  })
}

function asString(value) {
  return typeof value === 'string' ? value : ''
}

/** Accept an optional list of session ids from a JSON body, dropping anything unusable. */
function asStringArray(value) {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 200)
  return out.length > 0 ? out : undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// engine bridge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the migration engine and return its parsed JSON verdict.
 * @param argv - engine arguments, e.g. `['plan', '--from', a, '--to', b, '--json']`.
 * @returns `{ ok, exitCode, json, stderr }`; `ok` is false only when the engine
 * could not be run or produced no JSON at all — a refused plan is still `ok`
 * with `json.ok === false`, so the caller can show its errors.
 */
function runEngine(argv) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(process.execPath, [ENGINE, ...argv], {
        cwd: homedir(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, error: 'could not start the engine: ' + String((error && error.message) || error) })
      return
    }

    const stdout = []
    const stderr = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      resolve({ ok: false, error: `the engine did not finish within ${ENGINE_TIMEOUT_MS} ms` })
    }, ENGINE_TIMEOUT_MS)

    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, error: 'engine process error: ' + String((error && error.message) || error) })
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
        resolve({
          ok: false,
          exitCode,
          error: 'the engine returned no parsable JSON (exit ' + String(exitCode) + ')',
          stderr: err.slice(0, 4000),
          stdout: out.slice(0, 4000),
        })
        return
      }
      resolve({ ok: true, exitCode, json, stderr: err.slice(0, 2000) })
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// environment discovery
// ─────────────────────────────────────────────────────────────────────────────

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}

async function pathKind(target) {
  try {
    const info = await stat(target)
    return info.isDirectory() ? 'directory' : 'file'
  } catch {
    return 'missing'
  }
}

/**
 * Workspace registry rows, decorated with on-disk facts.
 *
 * Defined once, below (`readWorkspaces(ctx)`), where it prefers the live registry over the file.
 */

/**
 * Resolve a Session's workspace path without decoding its log. The projection cache
 * is the only plain-JSON record of a session's identity `cwd`, and unlike the session
 * log it stays readable for cold and archived sessions alike. Used to preselect the
 * workspace when the user clicks the conversation-header entry.
 * @param sessionId - a bare session id (validated by the caller).
 * @returns `{ cwd, workspaceId, workspaceTitle, source }`; `cwd` is null when unknown.
 */
async function resolveSessionCwd(sessionId, ctx) {
  const perSession = join(dshHome(), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  const aggregate = join(dshHome(), 'storages', 'session_projcache.json')

  let cwd = null
  let source = null
  try {
    const doc = JSON.parse(await readFile(perSession, 'utf8'))
    const value = doc && doc.record && doc.record.identity ? doc.record.identity.cwd : undefined
    if (typeof value === 'string' && value.length > 0) {
      cwd = value
      source = 'projcache-session'
    }
  } catch {
    /* fall through to the aggregate document */
  }
  if (cwd === null) {
    try {
      const doc = JSON.parse(await readFile(aggregate, 'utf8'))
      const entry = doc && doc.tables && doc.tables.sessions ? doc.tables.sessions[sessionId] : undefined
      const value = entry && entry.identity ? entry.identity.cwd : undefined
      if (typeof value === 'string' && value.length > 0) {
        cwd = value
        source = 'projcache-aggregate'
      }
    } catch {
      /* leave cwd null */
    }
  }

  let workspaceId = null
  let workspaceTitle = null
  if (cwd !== null) {
    const registry = await readWorkspaces(ctx)
    const key = cwd.replace(/[\\/]+$/, '').toLowerCase()
    const match = registry.workspaces.find((workspace) => workspace.path.replace(/[\\/]+$/, '').toLowerCase() === key)
    if (match !== undefined) {
      workspaceId = match.id
      workspaceTitle = match.title
    }
  }
  return { cwd, workspaceId, workspaceTitle, source }
}

// ─────────────────────────────────────────────────────────────────────────────
// the model-visible tool
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_DESCRIPTION = [
  'DSH 工作区迁移 / workspace migration. Two modes:',
  '',
  '  live  — relocate WITHOUT stopping DSH. This is the preferred path and the one to try',
  '          first. It moves the project directory (optional), registers a workspace at the',
  '          new path, relocates the session artifacts frame-safely, and re-points the',
  '          in-memory workspace registry through DSH\'s own services.',
  '',
  '          RUNNING sessions are supported, including the conversation you are in: their',
  '          artifact is rewritten and moved in process and their live write handle is',
  '          retargeted to the new path, so nothing has to be closed first. That in-process',
  '          path needs a rebindable write handle from the host; when a build does not expose',
  '          one, the move is refused rather than attempted. Run it with dryRun:true first —',
  '          that reports every blocker without touching anything.',
  '',
  '  plan  — the stop-DSH flow, for cases live cannot cover (a session that cannot be closed,',
  '          or a change you would rather perform in a guaranteed-quiet window). Read-only dry',
  '          run that stages a self-contained runner directory with plan.json and one-click',
  '          .cmd files, to be executed while DSH is stopped.',
  '',
  'Actions: live (preferred) · plan · status · verify · apply.',
  '  status — lists previously staged runs and whether they were applied.',
  '  verify — re-runs the read-only invariant checks against a staged plan (needs `planFile`).',
  '  apply  — always REFUSED from inside DSH, with the exact commands to run instead.',
  '',
  'In both modes only frame 0 of each session log is recompressed; every later zstd frame is',
  'copied byte-for-byte, preserving the invariant DSH asserts at startup. Every mutation is',
  'backed up first, and a failure unwinds every layer it had already applied. A live move',
  'writes its own account to <DSH_HOME>/migration-runs/live-<timestamp>.json, on failure too.',
  'Windows paths may use either separator.',
].join('\n')

function createTool(ctx) {
  // `ctx` is optional so the tool stays constructible in tests; every service read
  // degrades to undefined rather than throwing.
  const services = ctx !== undefined && typeof ctx.get === 'function' ? ctx : { get: () => undefined }

  const inspectLines = (report) => {
    const out = []
    out.push(report.ok === true ? 'verdict: OK — this can run without stopping DSH' : 'verdict: REFUSED')
    for (const blocker of report.blockers ?? []) out.push('  blocker: ' + blocker)
    for (const note of report.notes ?? []) out.push('  note: ' + note)
    if (report.project) {
      out.push(`project dir: ${report.project.willMove ? 'will be moved' : 'left in place'} (source ${report.project.sourceExists ? 'exists' : 'missing'}, destination ${report.project.destinationExists ? 'EXISTS' : 'free'})`)
    }
    out.push(`sessions: ${(report.sessionIds ?? []).length}`)
    return out.join('\n')
  }

  const liveLines = (result) => {
    const out = []
    if (result.ok !== true) {
      out.push(`stage: ${result.stage}`)
      for (const blocker of result.blockers ?? []) out.push('  blocker: ' + blocker)
      if (result.rollback) {
        out.push(`  files restored: ${result.rollback.filesRestored === true}`)
        for (const error of result.rollback.memoryErrors ?? []) out.push('  memory rollback error: ' + error)
        for (const error of result.rollback.undoErrors ?? []) out.push('  undo error: ' + error)
      }
      if (result.engineDetail) out.push('  engine: ' + JSON.stringify(result.engineDetail))
      return out.join('\n')
    }
    out.push(`moved ${result.movedCount} session(s): ${result.from}  ->  ${result.to}`)
    out.push(`workspace: ${result.workspaceCreated ? 'registered' : 'reused'} ${result.workspaceTitle ?? ''}`.trim())
    out.push(`project directory: ${result.projectMoved ? 'moved' : 'left in place'}`)
    for (const id of result.sessionIds) out.push('  - ' + id)
    for (const note of result.notes ?? []) out.push('note: ' + note)
    if ((result.indexSkipped ?? []).length > 0) out.push('index maps skipped: ' + result.indexSkipped.join(', '))
    if (result.reportFile) out.push('engine report: ' + result.reportFile)
    return out.join('\n')
  }

  return {
    name: 'workspace_migrate',
    description: TOOL_DESCRIPTION,
    timeoutMs: 300000,
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        action: {
          type: 'string',
          enum: ['live', 'plan', 'status', 'verify', 'apply'],
          description:
            'live = relocate WITHOUT stopping DSH (cold sessions only; add dryRun:true to preview) — this is the fastest path and the one to prefer; plan = the stop-DSH flow (read-only dry run + staged runner); status = list staged runs; verify = re-check a staged plan; apply = refused inside DSH and explains the manual step',
        },
        from: { type: 'string', description: 'Current absolute workspace path (required for live and plan)' },
        to: { type: 'string', description: 'Target absolute workspace path (required for live and plan)' },
        title: { type: 'string', description: 'Optional new workspace title (default: keep the existing title)' },
        dryRun: { type: 'boolean', description: 'For action "live": report what would happen and why it might be refused, changing nothing' },
        moveProject: {
          type: 'boolean',
          description: 'For action "live": also move the project directory itself. A destination that already holds files fails the check and is never touched.',
        },
        sessions: { type: 'string', description: 'For action "live": comma-separated session ids to restrict the move to (default: every session in the source workspace)' },
        project: {
          type: 'string',
          enum: ['auto', 'move', 'copy', 'keep'],
          description: 'What to do with the project directory itself: auto (default) moves it when it exists, keep leaves the files alone and creates the destination when it is missing',
        },
        planFile: { type: 'string', description: 'Path to a staged plan.json (required for verify)' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        const summary = value && typeof value.summary === 'string' ? value.summary : 'workspace_migrate'
        const details = value && typeof value.details === 'string' ? value.details : ''
        return [{ type: 'text', text: details.length > 0 ? summary + '\n\n' + details : summary }]
      },
    },
    async execute(args) {
      const action = asString(args && args.action)
      const argv = []
      if (action === 'plan') {
        const from = asString(args.from)
        const to = asString(args.to)
        if (from.length === 0 || to.length === 0) {
          return { ok: false, action: 'plan', summary: 'plan needs both `from` and `to`', details: '' }
        }
        argv.push('plan', '--from', from, '--to', to, '--json')
        if (asString(args.title).length > 0) argv.push('--title', asString(args.title))
        if (asString(args.project).length > 0) argv.push('--project', asString(args.project))
      } else if (action === 'status') {
        argv.push('list', '--json')
      } else if (action === 'verify') {
        const planFile = asString(args.planFile)
        if (planFile.length === 0) {
          return { ok: false, action: 'verify', summary: 'verify needs `planFile`', details: 'Pass the plan.json produced by action "plan".' }
        }
        argv.push('verify', '--plan', planFile, '--json')
      } else if (action === 'live') {
        const from = asString(args.from)
        const to = asString(args.to)
        if (from.length === 0 || to.length === 0) {
          return { ok: false, action: 'live', summary: 'live needs both `from` and `to`', details: '' }
        }
        const sessionIds = asString(args.sessions)
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
        const liveOptions = {
          fromPath: from,
          toPath: to,
          title: asString(args.title).length > 0 ? asString(args.title) : undefined,
          sessionIds: sessionIds.length > 0 ? sessionIds : undefined,
          moveProject: args.moveProject === true,
        }
        const inspect = await inspectLive(services, liveOptions)
        if (args.dryRun === true) {
          return {
            ok: inspect.ok === true,
            action: 'live',
            summary:
              inspect.ok === true
                ? 'live preview: this relocation can run without stopping DSH'
                : 'live preview: it would be refused',
            details: inspectLines(inspect),
          }
        }
        if (inspect.ok !== true) {
          return { ok: false, action: 'live', summary: 'live refused before making any change', details: inspectLines(inspect) }
        }
        const result = await runLiveMove(services, liveOptions)
        return {
          ok: result.ok === true,
          action: 'live',
          summary:
            result.ok === true
              ? `live move complete: ${String(result.movedCount)} session(s) re-homed to ${String(result.to)}`
              : `live move failed at stage "${String(result.stage)}" and was rolled back`,
          details: liveLines(result),
        }
      } else if (action === 'apply') {
        const planFile = asString(args.planFile)
        return {
          ok: false,
          action: 'apply',
          summary: 'apply is refused from inside DSH — run the staged runner after quitting DSH',
          details: [
            'A workspace migration MUST run while DSH is stopped: this process holds workspace.json,',
            'session_projcache and the session log append paths in memory and checkpoints them back to disk.',
            '',
            'engine: ' + ENGINE,
            '',
            'Steps:',
            '  1. quit DSH completely (web server and every session process)',
            planFile.length > 0
              ? '  2. run: node "' + ENGINE + '" apply --plan "' + planFile + '" --yes'
              : '  2. run the 1-apply-migration.cmd of the staged run (see action "status")',
            planFile.length > 0
              ? '  3. run: node "' + ENGINE + '" verify --plan "' + planFile + '"'
              : '  3. run its 2-verify.cmd and require every check to PASS',
            '  4. start DSH again and confirm the workspace and its sessions are grouped',
          ].join('\n'),
        }
      } else {
        return { ok: false, action, summary: 'unknown action "' + action + '"', details: 'Use one of: live, plan, status, verify, apply.' }
      }

      const result = await runEngine(argv)
      if (!result.ok) {
        return { ok: false, action, summary: 'the migration engine could not run', details: [result.error, result.stderr, result.stdout].filter(Boolean).join('\n') }
      }
      const data = result.json

      if (action === 'plan') {
        if (data.from === undefined || data.to === undefined) {
          return { ok: false, action, summary: 'plan could not be built', details: [...(data.errors || []), ...(data.warnings || [])].join('\n') }
        }
        const lines = []
        lines.push('projectKey  ' + data.oldKey)
        lines.push('         -> ' + data.newKey)
        lines.push('sessions    ' + data.sessions.toMigrate.length + ' to migrate, ' + data.sessions.foreign.length + ' skipped, ' + data.sessions.alreadyAtNew.length + ' already at destination')
        for (const session of data.sessions.toMigrate) {
          lines.push('   - ' + session.id + '  (' + session.generations.length + ' generation file(s))')
        }
        lines.push('metadata    ' + data.metadata.patches.length + ' patch(es)')
        lines.push('project     ' + data.project.action)
        lines.push('DSH running ' + (data.running.dshProcesses.length > 0 ? 'YES — quit DSH before applying' : 'no'))
        for (const warning of data.warnings || []) lines.push('warning: ' + warning)
        for (const error of data.errors || []) lines.push('ERROR: ' + error)
        if (data.stage) {
          lines.push('')
          lines.push('staged run  ' + data.stage.dir)
          lines.push('apply with  ' + data.stage.applyCmd)
        }
        return {
          ok: data.ok === true,
          action,
          summary: 'Workspace migration plan: ' + data.from + '  ->  ' + data.to + (data.ok ? '  [READY]' : '  [BLOCKED]'),
          details: lines.join('\n'),
        }
      }

      if (action === 'status') {
        const runs = Array.isArray(data.runs) ? data.runs : []
        const lines = ['run root    ' + data.runRoot, 'backup root ' + data.backupRoot, 'staged runs ' + runs.length]
        for (const run of runs) {
          lines.push('   - ' + run.dir)
          lines.push('     ' + String(run.from || '?') + ' -> ' + String(run.to || '?') + '  sessions=' + String(run.sessions) + '  report=' + (run.report ? String(run.report.status) : 'not applied yet'))
        }
        return { ok: true, action, summary: 'staged migration runs: ' + runs.length, details: lines.join('\n') }
      }

      // verify
      const lines = []
      for (const check of data.checks || []) lines.push((check.ok ? 'PASS  ' : 'FAIL  ') + check.name + '  ' + String(check.detail === undefined ? '' : check.detail))
      for (const note of data.notes || []) lines.push('note  ' + note)
      lines.push('result: ' + (data.ok ? 'ALL CHECKS PASS' : String((data.failures || []).length) + ' FAILURE(S)'))
      return {
        ok: data.ok === true,
        action,
        summary: data.ok
          ? 'verify: all ' + String(data.checked) + ' checks passed (state: ' + String(data.detectedState) + ')'
          : 'verify: ' + String((data.failures || []).length) + ' failure(s)',
        details: lines.join('\n'),
      }
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// routes
// ─────────────────────────────────────────────────────────────────────────────

function fenced(req, res) {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
    return false
  }
  return true
}

function requirePost(req, res) {
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: 'method not allowed' })
    return false
  }
  return true
}

/**
 * The workspace list, preferring the LIVE registry over `workspace.json`.
 *
 * The durable file is a projection the registry rewrites when it checkpoints, so a change another
 * plugin made in memory — moving a session with dsh-session-manager, say — shows up in the sidebar
 * immediately while the file still holds the old path. Reading only the file therefore reports a
 * stale path until DSH restarts; the registry is asked first and the file is the fallback.
 */
async function readWorkspaces(ctx) {
  const file = join(dshHome(), 'storages', 'workspace.json')
  let doc = null
  try {
    doc = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    doc = null
    if (!ctx) return { file, workspaces: [], error: String((error && error.message) || error), source: 'file' }
  }
  const archived =
    doc !== null && Array.isArray(doc.global && doc.global.archivedSessionIds)
      ? doc.global.archivedSessionIds.filter((value) => typeof value === 'string')
      : []

  const registry = ctx === undefined || ctx === null || typeof ctx.get !== 'function' ? undefined : ctx.get('workspaceRegistry')
  if (registry !== undefined && registry !== null && typeof registry.list === 'function') {
    try {
      const entities = registry.list()
      if (Array.isArray(entities)) {
        const workspaces = []
        for (const entity of entities) {
          const record = entity && entity.record !== undefined && entity.record !== null ? entity.record : entity
          const pathValue = asString((entity && entity.path) ?? (record && record.path))
          const sessionIds = Array.isArray(record && record.sessionIds) ? record.sessionIds : []
          workspaces.push({
            id: asString(entity && entity.id),
            title: asString(record && record.title),
            path: pathValue,
            sessionIds: sessionIds.filter((value) => typeof value === 'string'),
            pathState: pathValue.length > 0 ? await pathKind(pathValue) : 'missing',
            archived,
          })
        }
        return { file, workspaces, error: null, source: 'registry' }
      }
    } catch (error) {
      // Fall through to the file: a registry mid-update must not break the panel.
    }
  }
  if (doc === null) {
    return { file, workspaces: [], error: `could not read ${file}`, source: 'file' }
  }
  const table = (doc.tables && doc.tables.workspaces) || {}
  const workspaces = []
  for (const [id, value] of Object.entries(table)) {
    if (value === null || typeof value !== 'object') continue
    const pathValue = asString(value.path)
    workspaces.push({
      id,
      title: asString(value.title),
      path: pathValue,
      sessionIds: Array.isArray(value.sessionIds) ? value.sessionIds.filter((x) => typeof x === 'string') : [],
      pathState: pathValue.length > 0 ? await pathKind(pathValue) : 'missing',
      archived,
    })
  }
  return { file, workspaces, error: null, source: 'file' }
}

/** Normalized path key for comparing a staged run's source against the registry. */
function pathKey(value) {
  return asString(value)
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * Mark every staged run as usable or not.
 *
 * A staged plan whose source path is no longer a registered workspace cannot be used for anything:
 * either it has already been applied (the record moved to the destination) or the workspace was
 * deleted. The panel shows those rows as「无法使用」and offers to clean them up.
 */
function markRunUsability(runs, workspaces) {
  const registered = new Set(workspaces.map((workspace) => pathKey(workspace.path)))
  return runs.map((run) => Object.assign({}, run, { usable: registered.has(pathKey(run.from)) }))
}

function makeRoutes(ctx) {
  return [
    {
      kind: 'exact',
      path: `${API}/state`,
      handler: async (req, res) => {
        if (!fenced(req, res)) return
        try {
          const [registry, runs] = await Promise.all([readWorkspaces(ctx), runEngine(['list', '--json'])])
          let sessionsRoot = join(dshHome(), 'sessions')
          let projectKeys = []
          try {
            projectKeys = (await readdir(sessionsRoot, { withFileTypes: true }))
              .filter((entry) => entry.isDirectory())
              .map((entry) => entry.name)
          } catch {
            projectKeys = []
          }
          const runList = runs.ok && runs.json && Array.isArray(runs.json.runs) ? runs.json.runs : []
          writeJson(res, 200, {
            ok: true,
            dshHome: dshHome(),
            engine: ENGINE,
            api: API,
            workspaceFile: registry.file,
            workspaceFileError: registry.error,
            workspaceSource: registry.source,
            workspaces: registry.workspaces,
            sessionsRoot,
            projectKeys,
            runs: markRunUsability(runList, registry.workspaces),
            runsError: runs.ok ? null : String(runs.error),
          })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API}/plan`,
      handler: async (req, res) => {
        if (!fenced(req, res) || !requirePost(req, res)) return
        const body = await readJsonBody(req)
        const from = asString(body.from)
        const to = asString(body.to)
        if (from.length === 0 || to.length === 0) {
          writeJson(res, 400, { ok: false, error: 'from and to are both required' })
          return
        }
        const argv = ['plan', '--from', from, '--to', to, '--json']
        if (asString(body.title).length > 0) argv.push('--title', asString(body.title))
        if (asString(body.project).length > 0) argv.push('--project', asString(body.project))
        // Record where DSH was answering, so a later `check-quiescent` from the staged .cmd can
        // detect a running DSH without relying on the process probe alone.
        const origin = asString(req.headers && req.headers.host)
        if (origin.length > 0) argv.push('--dsh-origin', origin)
        // A pure preview must not litter the run root with staged directories.
        if (body.noStage === true) argv.push('--no-stage')
        const result = await runEngine(argv)
        writeJson(res, result.ok ? 200 : 500, result)
      },
    },
    {
      kind: 'exact',
      path: `${API}/session`,
      handler: async (req, res) => {
        if (!fenced(req, res) || !requirePost(req, res)) return
        const body = await readJsonBody(req)
        const sessionId = asString(body.sessionId)
        // The id becomes part of a file name below, so anything path-shaped is refused.
        if (sessionId.length === 0 || sessionId.length > 200 || /[\\/]/.test(sessionId) || sessionId.includes('..')) {
          writeJson(res, 400, { ok: false, error: 'a plain session id is required' })
          return
        }
        try {
          const resolved = await resolveSessionCwd(sessionId, ctx)
          writeJson(res, 200, Object.assign({ ok: resolved.cwd !== null, sessionId }, resolved))
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API}/live-inspect`,
      handler: async (req, res) => {
        if (!fenced(req, res) || !requirePost(req, res)) return
        const body = await readJsonBody(req)
        const fromPath = asString(body.from)
        const toPath = asString(body.to)
        if (fromPath.length === 0 || toPath.length === 0) {
          writeJson(res, 400, { ok: false, error: 'from and to are both required' })
          return
        }
        try {
          const report = await inspectLive(ctx, {
            fromPath,
            toPath,
            sessionIds: asStringArray(body.sessionIds),
            moveProject: body.moveProject === true,
            // The manual/stop-DSH flow asks the same destination questions without the live-only
            // preconditions (see inspectLiveMove): it must not be blocked by a registry it never
            // needs.
            projectOnly: body.projectOnly === true,
          })
          writeJson(res, 200, report)
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API}/live-move`,
      handler: async (req, res) => {
        if (!fenced(req, res) || !requirePost(req, res)) return
        const body = await readJsonBody(req)
        const fromPath = asString(body.from)
        const toPath = asString(body.to)
        if (fromPath.length === 0 || toPath.length === 0) {
          writeJson(res, 400, { ok: false, error: 'from and to are both required' })
          return
        }
        if (body.confirm !== true) {
          writeJson(res, 409, {
            ok: false,
            refused: true,
            reason: 'live-move needs confirm: true — it rewrites session logs on disk',
            hint: 'call /live-inspect first, then repeat with confirm: true',
          })
          return
        }
        try {
          const result = await runLiveMove(ctx, {
            fromPath,
            toPath,
            title: asString(body.title).length > 0 ? asString(body.title) : undefined,
            sessionIds: asStringArray(body.sessionIds),
            moveProject: body.moveProject === true,
          })
          writeJson(res, result.ok === true ? 200 : 409, result)
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API}/open-directory`,
      handler: async (req, res) => {
        if (!fenced(req, res) || !requirePost(req, res)) return
        const body = await readJsonBody(req)
        const requested = asString(body.path)
        if (requested.length === 0) {
          writeJson(res, 400, { ok: false, error: 'path is required' })
          return
        }
        // Only directories this plugin itself stages may be revealed: the browser must not be
        // able to ask the host to open an arbitrary path from the user's machine.
        const runsRoot = resolve(join(dshHome(), 'migration-runs'))
        const target = resolve(requested)
        if (target !== runsRoot && !target.startsWith(runsRoot + sep)) {
          writeJson(res, 403, {
            ok: false,
            error: `only directories under ${runsRoot} can be opened`,
          })
          return
        }
        try {
          const info = await stat(target)
          if (!info.isDirectory()) {
            writeJson(res, 400, { ok: false, error: `not a directory: ${target}` })
            return
          }
        } catch {
          writeJson(res, 404, { ok: false, error: `no such directory: ${target}` })
          return
        }
        const revealed = await revealDirectory(target)
        writeJson(res, revealed.ok === true ? 200 : 500, revealed)
      },
    },
    {
      kind: 'exact',
      path: `${API}/prune-runs`,
      handler: async (req, res) => {
        if (!fenced(req, res) || !requirePost(req, res)) return
        try {
          const [registry, listed] = await Promise.all([readWorkspaces(ctx), runEngine(['list', '--json'])])
          const runs = listed.ok && listed.json && Array.isArray(listed.json.runs) ? listed.json.runs : []
          const unusable = markRunUsability(runs, registry.workspaces).filter((run) => run.usable !== true)
          const runsRoot = resolve(join(dshHome(), 'migration-runs'))
          const removed = []
          const refused = []
          for (const run of unusable) {
            // Re-derive the target from the run root and check containment again: the engine's list
            // is trusted, but a recursive delete deserves its own fence.
            const target = resolve(join(runsRoot, basename(asString(run.dir))))
            if (!target.startsWith(runsRoot + sep)) {
              refused.push({ dir: asString(run.dir), reason: 'outside the run root' })
              continue
            }
            try {
              await rm(target, { recursive: true, force: true })
              removed.push({ dir: target, from: asString(run.from) })
            } catch (error) {
              refused.push({ dir: target, reason: String((error && error.message) || error) })
            }
          }
          writeJson(res, 200, {
            ok: true,
            removed,
            refused,
            kept: runs.length - removed.length,
            runsRoot,
          })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API}/verify`,
      handler: async (req, res) => {
        if (!fenced(req, res) || !requirePost(req, res)) return
        const body = await readJsonBody(req)
        const planFile = asString(body.planFile)
        if (planFile.length === 0) {
          writeJson(res, 400, { ok: false, error: 'planFile is required' })
          return
        }
        const result = await runEngine(['verify', '--plan', planFile, '--json'])
        writeJson(res, result.ok ? 200 : 500, result)
      },
    },
    {
      kind: 'exact',
      path: `${API}/rollback`,
      handler: async (req, res) => {
        if (!fenced(req, res) || !requirePost(req, res)) return
        const body = await readJsonBody(req)
        const planFile = asString(body.planFile)
        if (planFile.length === 0) {
          writeJson(res, 400, { ok: false, error: 'planFile is required' })
          return
        }
        const result = await runEngine(['rollback', '--plan', planFile, '--yes', '--json'])
        writeJson(res, result.ok ? 200 : 500, result)
      },
    },
    {
      kind: 'exact',
      path: `${API}/apply`,
      handler: async (req, res) => {
        if (!fenced(req, res) || !requirePost(req, res)) return
        const body = await readJsonBody(req)
        const planFile = asString(body.planFile)
        writeJson(res, 409, {
          ok: false,
          refused: true,
          reason: 'a workspace migration must run while DSH is stopped',
          planFile,
          engine: ENGINE,
          steps: [
            'quit DSH completely (web server and every session process)',
            planFile.length > 0
              ? 'node "' + ENGINE + '" apply --plan "' + planFile + '" --yes'
              : 'run the 1-apply-migration.cmd of the staged run',
            planFile.length > 0
              ? 'node "' + ENGINE + '" verify --plan "' + planFile + '"'
              : 'run its 2-verify.cmd and require every check to PASS',
            'start DSH again and confirm the workspace and its sessions are grouped',
          ],
        })
      },
    },
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
// plugin
// ─────────────────────────────────────────────────────────────────────────────

const plugin = {
  name,
  inject,
  apply(ctx) {
    const routes = makeRoutes(ctx)
    let mounted = 0
    for (const route of routes) {
      try {
        ctx.effect(() => ctx.webServer.register(route), `${name}: ${route.path}`)
        mounted++
      } catch (error) {
        // A colliding route path is a composition-level misconfiguration, but it must
        // never take down the whole plugin tree: log it and keep the remaining seats.
        console.error(`[${name}] could not register ${route.path}:`, error)
      }
    }
    // The tool is a bonus: the UI must load even when no tool registry is in
    // scope, so this is read optionally rather than declared as a hard inject.
    const tools = ctx.get('tools')
    if (tools !== undefined && typeof tools.register === 'function') {
      try {
        ctx.effect(() => tools.register(createTool(ctx)), `${name}: workspace_migrate tool`)
      } catch (error) {
        console.error(`[${name}] could not register the workspace_migrate tool:`, error)
      }
    }
    console.log(`[${name}] mounted — ${mounted}/${routes.length} routes at ${API}, engine at ${ENGINE}`)
  },
}

export { createTool, makeRoutes, runEngine, resolveSessionCwd, ENGINE, API }
export default plugin
