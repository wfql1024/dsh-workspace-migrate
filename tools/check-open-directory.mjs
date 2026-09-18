// Diagnose the「打开目录」route against the real machine: drive the real handler for every
// directory the engine reports, and print the status it answers. Nothing is launched
// (`DSH_WORKSPACE_MIGRATE_DRY_OPEN=1`), so this is safe to run while DSH is up.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { makeRoutes } from '../index.js'

process.env.DSH_WORKSPACE_MIGRATE_DRY_OPEN = '1'

const home = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh')
const engine = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', 'lib', 'dsh-workspace-migrate.mjs')
const listed = spawnSync(process.execPath, [engine, 'list', '--json'], { encoding: 'utf8' })
const runs = JSON.parse(listed.stdout).runs ?? []
console.log(`engine reports ${runs.length} staged run(s); DSH home = ${home}`)

function fakeRequest(body) {
  const handlers = new Map()
  const req = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
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
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(body) {
      this.body = typeof body === 'string' ? body : ''
    },
  }
}

const route = makeRoutes({ get: () => undefined }).find((entry) => entry.path.endsWith('/open-directory'))
if (route === undefined) {
  console.error('the route is not in makeRoutes() at all')
  process.exit(1)
}

async function probe(label, target) {
  const req = fakeRequest({ path: target })
  const res = fakeResponse()
  const promise = route.handler(req, res)
  req.emit('data', Buffer.from(JSON.stringify({ path: target }), 'utf8'))
  req.emit('end')
  await promise
  console.log(`${res.status}  ${label}\n      ${target}\n      ${res.body}`)
}

await probe('a directory the engine reports', runs[0] ? runs[0].dir : path.join(home, 'migration-runs'))
await probe('the run root itself', path.join(home, 'migration-runs'))
await probe('a path outside the run root', path.join(home, 'storages'))
for (const run of runs.slice(1, 3)) {
  await probe('another reported run', run.dir)
}
if (runs.length === 0) console.log('(no staged runs on this machine)')
void fs
