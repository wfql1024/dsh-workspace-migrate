// Mutation run: prove the suites actually guard the mechanisms they claim to.
//
// For every entry in tools/mutations.mjs this breaks one mechanism, runs the suite that is
// supposed to notice, and requires that suite to FAIL. A mutation nobody catches is reported
// as UNCAUGHT and makes this process exit non-zero — an uncaught mutation means the suite has
// a hole, not that the mutation is harmless.
//
//   node tools/run-mutations.mjs [name ...]
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { MUTATIONS } from './mutations.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const only = process.argv.slice(2)
const selected = only.length === 0 ? MUTATIONS : MUTATIONS.filter((mutation) => only.includes(mutation.name))

if (selected.length === 0) {
  console.error(`no mutation matched ${JSON.stringify(only)}; known: ${MUTATIONS.map((m) => m.name).join(', ')}`)
  process.exit(2)
}

function runSuite(relative) {
  const result = spawnSync(process.execPath, [path.join(ROOT, relative)], { encoding: 'utf8', cwd: ROOT })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const failures = output.split('\n').filter((line) => /^\s+FAIL\b/.test(line)).length
  const verdict = (output.split('\n').find((line) => /^(ALL PASS|FAILURES):/.test(line)) ?? '(no verdict line)').trim()
  return { status: result.status, failures, verdict }
}

/** Replace `from` exactly once, refusing to guess when the anchor is not unique. */
function mutate(source, mutation) {
  if (mutation.from instanceof RegExp) {
    if (!mutation.from.test(source)) throw new Error(`anchor regex did not match in ${mutation.file}`)
    return source.replace(mutation.from, mutation.to)
  }
  const occurrences = source.split(mutation.from).length - 1
  if (occurrences !== 1) throw new Error(`anchor appears ${occurrences} time(s) in ${mutation.file}; expected exactly 1`)
  return source.replace(mutation.from, mutation.to)
}

console.log('baseline check')
const baseline = new Map()
for (const suite of [...new Set(selected.map((mutation) => mutation.suite))]) {
  const result = runSuite(suite)
  baseline.set(suite, result)
  console.log(`  ${result.status === 0 ? 'pass' : 'FAIL'}  ${suite}  ${result.verdict}`)
  if (result.status !== 0) {
    console.error(`\n${suite} does not pass unmutated — fix that before trusting any mutation result`)
    process.exit(2)
  }
}

console.log('\nmutations (each one must be caught)')
let uncaught = 0
for (const mutation of selected) {
  const file = path.join(ROOT, mutation.file)
  const backup = `${file}.mutbak`
  const original = fs.readFileSync(file, 'utf8')
  let result
  try {
    fs.writeFileSync(backup, original)
    fs.writeFileSync(file, mutate(original, mutation))
    result = runSuite(mutation.suite)
  } finally {
    fs.writeFileSync(file, original)
    if (fs.existsSync(backup)) fs.unlinkSync(backup)
  }
  const caught = result.status !== 0 && result.failures > 0
  if (!caught) uncaught += 1
  console.log(
    `  ${caught ? 'caught ' : 'UNCAUGHT'}  ${mutation.name.padEnd(22)} ${mutation.suite.padEnd(20)} ${result.failures} failing check(s)  ${result.verdict}`,
  )
}

// The suites must still be green after every revert: a mutation harness that leaves the tree
// dirty is worse than no harness at all.
console.log('\npost-revert check')
let dirty = 0
for (const suite of [...new Set(selected.map((mutation) => mutation.suite))]) {
  const result = runSuite(suite)
  if (result.status !== 0) dirty += 1
  console.log(`  ${result.status === 0 ? 'pass' : 'FAIL'}  ${suite}  ${result.verdict}`)
}

const leftovers = MUTATIONS.map((mutation) => path.join(ROOT, `${mutation.file}.mutbak`)).filter((file) => fs.existsSync(file))
if (leftovers.length > 0) console.error(`leftover backups: ${leftovers.join(', ')}`)

console.log(`\n${selected.length - uncaught}/${selected.length} mutations caught`)
process.exitCode = uncaught === 0 && dirty === 0 && leftovers.length === 0 ? 0 : 1
