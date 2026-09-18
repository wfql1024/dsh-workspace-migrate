// The mutation registry: each entry breaks exactly one mechanism the plugin depends on, names
// the file it edits and the suite that is supposed to catch it. A mutation that NO suite
// catches means the suite is not really guarding that behaviour.
//
// `from` may be a string (exact, unique anchor) or a RegExp (for anchors whose surrounding
// whitespace is generated). `file` is relative to the project root.
export const MUTATIONS = [
  {
    name: 'writer-rebind',
    file: 'lib/live-move.mjs',
    suite: 'test/livetest.mjs',
    breaks: 'the live writer is never retargeted, so later appends land in the old project key',
    from: 'writer.header = headerWithCwd(writer.header, newCwd)',
    to: 'void 0 /* MUTATION: writer not retargeted */',
  },
  {
    name: 'route-to-engine',
    file: 'lib/live-move.mjs',
    suite: 'test/livetest.mjs',
    breaks: 'running sessions are handed to the spawned engine, so the file move races the writer',
    from: 'liveIds.push(id)',
    to: 'void id /* MUTATION: running session left to the engine */',
  },
  {
    name: 'leave-old-dir',
    file: 'lib/live-move.mjs',
    suite: 'test/livetest.mjs',
    breaks: 'the emptied session directory is left under the old project key',
    from: 'removeIfEmpty(fromDir)\n  removeIfEmpty(dirname(fromDir))',
    to: 'void 0 /* MUTATION: old directories left behind */',
  },
  {
    name: 'plain-header-copy',
    file: 'lib/live-move.mjs',
    suite: 'test/livetest.mjs',
    breaks: 'the replacement header adopts this module realm\'s Object.prototype, which DSH rejects',
    from: '  const next = Object.create(prototype === undefined ? null : prototype)\n  Object.assign(next, source, { cwd })\n  return Object.freeze(next)',
    to: '  return Object.freeze(Object.assign({}, source, { cwd })) /* MUTATION: realm-losing copy */',
  },
  {
    name: 'note-markers-dropped',
    file: 'lib/live-move.mjs',
    suite: 'test/livetest.mjs',
    breaks: 'result notes lose their signal marker, so a handled warning reads like a failure',
    from: '  const notes = [...pre.notes]\n  const noteOk = (value) => notes.push(`${MARK.ok} ${value}`)',
    to: '  const notes = [...pre.notes]\n  const noteOk = (value) => notes.push(String(value)) /* MUTATION: marker dropped */',
  },
  {
    name: 'companions-left-behind',
    file: 'lib/live-move.mjs',
    suite: 'test/livetest.mjs',
    breaks: 'only the generation the live writer holds is moved, so the session id stays in two project directories',
    from: '  for (const name of companions) {\n    const movedCompanion = relocateSessionLog(join(fromDir, name), join(toDir, name), newCwd)\n    alsoMoved.push({ name, frameCount: movedCompanion.frameCount, bytes: movedCompanion.bytes })\n  }',
    to: '  void companions /* MUTATION: only the writer\'s generation is moved */',
  },
  {
    name: 'undo-session-header',
    file: 'lib/live-move.mjs',
    suite: 'test/livetest.mjs',
    breaks: 'a rolled-back live Session keeps pointing at the destination',
    from: '      session.header = headerWithCwd(session.header, relocation.previousCwd)',
    to: '      void 0 /* MUTATION: Session header left at the destination */',
  },
  {
    name: 'undo-writer-header',
    file: 'lib/live-move.mjs',
    suite: 'test/livetest.mjs',
    breaks: 'a rolled-back live writer keeps pointing at the destination',
    from: '    writer.header = headerWithCwd(writer.header, relocation.previousCwd)',
    to: '    void 0 /* MUTATION: writer header left at the destination */',
  },
  {
    name: 'report-not-written',
    file: 'lib/live-move.mjs',
    suite: 'test/livetest.mjs',
    breaks: 'the announced report path names a file that was never written',
    from: '    fs.writeFileSync(result.reportFile, JSON.stringify(result, null, 2))',
    to: '    void result /* MUTATION: report never written */',
  },
  {
    name: 'orphan-blocks-migration',
    file: 'lib/dsh-workspace-migrate.mjs',
    suite: 'test/selftest.mjs',
    breaks: 'an empty orphan session directory counts as a session, so it blocks an unrelated move',
    from: '        if (empty) {\n          emptyOrphans.push(dir)\n          continue\n        }',
    to: '        void empty /* MUTATION: empty orphans counted as sessions */',
  },
  {
    name: 'picker-not-preselected',
    file: 'client.js',
    suite: 'test/clienttest.mjs',
    breaks: 'the per-conversation entry stops preselecting the current workspace',
    from: /value: workspaces\.reduce\([\s\S]*?\n\t+\),/,
    to: 'value: "",',
  },
]
