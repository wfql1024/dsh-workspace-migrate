// Controlled experiment: does a child spawned with DSH's exact runner stdio shape
// (['ignore','ignore','ignore','ipc','pipe','pipe']) and no windowsHide get its own
// visible console window — and does windowsHide:true prevent it?
//
// Four children, two parents:
//   A / B : spawned from THIS process (which inherits the pwsh runner's console)
//   C / D : spawned from a DETACHED intermediate (no console of its own), which is the
//           same situation DSH's host is in
// A and C omit windowsHide (the suspected bug); B and D set it (the proposed fix).
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const node = process.execPath
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''))
const shapeFile = path.join(here, 'detached-pids.json')

// exactly runnerStdio(spec, true, 'pipe') from dsh-subprocess-local
const SHAPE = ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe']
const alive = 'setTimeout(()=>{}, 22000)'

const mk = (windowsHide) =>
  spawn(node, ['-e', alive], { cwd: process.cwd(), stdio: SHAPE, windowsHide })

const a = mk(false) // no windowsHide  — suspected bug
const b = mk(true) //  windowsHide:true — proposed fix

// detached => DETACHED_PROCESS => the intermediate owns no console, like DSH's host
const detachedScript = `
  const { spawn } = require('node:child_process')
  const fs = require('node:fs')
  const SHAPE = ['ignore','ignore','ignore','ipc','pipe','pipe']
  const alive = 'setTimeout(()=>{}, 18000)'
  const c = spawn(process.execPath, ['-e', alive], { cwd: process.cwd(), stdio: SHAPE, windowsHide: false })
  const d = spawn(process.execPath, ['-e', alive], { cwd: process.cwd(), stdio: SHAPE, windowsHide: true })
  fs.writeFileSync(process.argv[1], JSON.stringify({ c: c.pid, d: d.pid }))
  setTimeout(() => process.exit(0), 20000)
`
const intermediate = spawn(node, ['-e', detachedScript, shapeFile], {
  cwd: process.cwd(),
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
})
intermediate.unref()

// wait for the intermediate to report its children
const deadline = Date.now() + 8000
while (!fs.existsSync(shapeFile) && Date.now() < deadline) {
  spawnSync(node, ['-e', 'setTimeout(()=>{},150)'])
}
const nested = fs.existsSync(shapeFile) ? JSON.parse(fs.readFileSync(shapeFile, 'utf8')) : { c: 0, d: 0 }

const pids = [a.pid, b.pid, nested.c, nested.d].filter((pid) => typeof pid === 'number' && pid > 0)
const query = `
$ErrorActionPreference='SilentlyContinue'
'--- children (win = MainWindowHandle; non-zero and titled == a visible console window) ---'
foreach ($id in @(${pids.join(',')})) {
  $p = Get-Process -Id $id
  if ($null -eq $p) { "pid=$id  GONE" }
  else { "pid=$id  win=$($p.MainWindowHandle)  title=[$($p.MainWindowTitle)]" }
}
'--- this process tree ---'
"probe(me)=$PID  parent=$((Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId)"
foreach ($id in @(${pids.join(',')})) {
  $pp = (Get-CimInstance Win32_Process -Filter "ProcessId=$id").ParentProcessId
  "pid=$id  parent=$pp"
}
'--- everyone in the tree ---'
Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='conhost.exe'" |
  ForEach-Object { "$($_.Name) $($_.ProcessId) parent=$($_.ParentProcessId)" }
`
const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
  encoding: 'utf8',
  windowsHide: true,
})
console.log(result.stdout ?? result.stderr)
console.log('legend: A=no-hide/console-parent  B=hide/console-parent  C=no-hide/CONSOLELESS-parent  D=hide/CONSOLELESS-parent')
console.log(`A=${a.pid} B=${b.pid} C=${nested.c} D=${nested.d}`)
try {
  fs.unlinkSync(shapeFile)
} catch {}
