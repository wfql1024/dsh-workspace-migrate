# USAGE — usage and troubleshooting detail (the full version behind the README)

> This file is the **detail store** for [`README.en.md`](../README.en.md): the README keeps only what
> reads in one sitting, while the full install commands, the troubleshooting table, the complete safety
> notes and the report locations live here.
> The Chinese counterpart is [`USAGE.md`](USAGE.md); both carry the same content.

## 1 Install and upgrade

### 1.1 Full install commands (three shells)

`~` is only meaningful in bash / Git Bash — **cmd.exe does not expand it** (pnpm then reads it as the
GitHub `owner/repo` pair and reports `is not a valid repository name`), so each shell is spelled out:

```powershell
# PowerShell
git clone https://github.com/wfql1024/dsh-workspace-migrate.git "$HOME\dsh-workspace-migrate"
dsh plugin --profile web add "$HOME\dsh-workspace-migrate"
```

```cmd
:: cmd.exe
git clone https://github.com/wfql1024/dsh-workspace-migrate.git "%USERPROFILE%\dsh-workspace-migrate"
dsh plugin --profile web add "%USERPROFILE%\dsh-workspace-migrate"
```

```bash
# bash / Git Bash
git clone https://github.com/wfql1024/dsh-workspace-migrate.git ~/dsh-workspace-migrate
dsh plugin --profile web add ~/dsh-workspace-migrate
```

The one-command GitHub install (pnpm clones it into the profile's own `node_modules`):

```powershell
dsh plugin --profile web add github:wfql1024/dsh-workspace-migrate
```

**No** `npm install` is needed: the package has no runtime dependencies.

### 1.2 The restart is mandatory, and how to confirm the mount

**Quit DSH completely and start it again** (not a page refresh) — the host plugin tree is composed at
startup. This line in the startup log means it mounted:

```
[dsh-workspace-migrate] mounted — 10/10 routes at /api/dsh-workspace-migrate, engine at <...>/lib/dsh-workspace-migrate.mjs
```

If the browser still shows an older UI after installing, force a refresh with `Ctrl+Shift+R`.

### 1.3 Upgrade / uninstall

```powershell
# Upgrade: re-run add for a github: install; git pull for a clone — then restart DSH either way
dsh plugin --profile web add github:wfql1024/dsh-workspace-migrate

# Uninstall (then restart DSH)
dsh plugin --profile web remove dsh-workspace-migrate
```

Uninstalling does **not** touch your sessions, workspaces or migration records; the `migration-runs` /
`migration-backups` already written are yours to delete.

## 2 Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `is not a valid repository name` (`git ls-remote git+ssh://git@github.com/~/...`) | You used `~/…` in **cmd.exe**. cmd does not expand `~` and pnpm reads it as the GitHub `owner/repo` pair. Use an absolute path, or the `github:` route |
| Nothing changes in the UI after installing | DSH was not restarted. The host plugin tree is composed at startup |
| `could not register /api/…` in the startup log | Another plugin owns that route; this plugin skips it and mounts the rest — paste the log |
| A button does nothing / the behaviour is old | The client half updates on a page refresh; the **host half only on a restart**. When the two disagree the dialog says so |
| A directory is left in `node_modules` after `remove` | pnpm keeps the link itself. Remove it with `cmd /c rmdir <path>`, **not** `Remove-Item -Recurse` (which can delete the linked target's contents) |
| "path is claimed by N workspace records" | DSH cannot boot while two records claim one path; delete the extra workspace record in the sidebar first |
| "the destination is not empty" | It already holds a file or a folder (**an empty folder counts**). **Empty it yourself**, or switch to *only change the path* |
| A staged run shows *unusable* | Its source workspace is gone (usually already migrated or deleted). Prune it with *prune unusable runs* |
| `Check` failed after clicking Start migration | Expand the `Check` row for the reason; it stopped before anything was written |

## 3 Usage detail

### 3.1 Live migration (default), the full flow

1. Pick **from** in the **workspace dropdown** (this box is read-only: the source must be a registered
   workspace) and fill in **to**.
2. Pick the **mode**:
   - **Move the files too** (default): the project files move as well. The destination is judged by
     exactly three rules —
     1. **missing**: it is created, then the migration runs (any legal path);
     2. **exists and holds no file and no folder**: it is used as is;
     3. **exists and already holds a file or a folder**: `Check` fails and names the directory, the
        entries and the counts (**a folder counts as content, an empty one too** — some projects use a
        bare folder as a marker), telling you to empty it yourself or switch to *only change the path*.

     The plugin **never** touches, moves, overwrites or backs up anything inside the destination.
   - **Only change the path**: no file is touched; the workspace simply points at the destination. A
     **missing path is created** (an empty directory only — no file is written, parents included; a
     missing drive fails the check). An existing destination with content is fine — that is exactly
     what "point at it" means.
3. Click **Start migration**. It runs a **read-only check first**: if it fails, nothing is written and
   the `Check` row says why; if it passes, the migration continues.
4. Read the `Migrate` row (`[√] ok` / `[×] failed`); a failure expands and **every step already done is
   undone newest-first** (artifacts restored byte for byte, the new workspace registration removed, an
   empty directory it created deleted, the project directory moved back).

> Those three rules are the **only** standard for the destination: there is no second "overwrite?"
> switch, and the plugin never empties, overwrites or backs up anything for you.

> After a move the **old, now empty workspace record stays in the sidebar** (`sessionIds` empty). That
> is deliberate (DSH exposes no public API to change a workspace path) — right-click and delete it;
> every session in the project already belongs to the new workspace.

### 3.2 Manual migration (stop-DSH fallback), the full flow

1. Tick **manual migration**; the button becomes **Generate plan** — click it. That click **checks
   first** (the same three destination rules, plus whether the source exists); a failed check tells you
   why in the `Check` row and **does not generate a plan**.
   - That check covers **only what holds with DSH stopped** (source path, destination). Live-only
     preconditions (the registry, running sessions) are not consulted — a fallback route must not be
     blocked by something it does not need. It is `/live-inspect` with `projectOnly: true`.
2. The result is one `Plan` row (*open directory* jumps straight to that folder).
3. **Quit DSH completely** (the web server and every session process).
4. Run `1-apply-migration.cmd`, then `2-verify.cmd` (must be all PASS); on an error run
   `3-rollback.cmd`.
5. Start DSH again and confirm the sessions still hang under the workspace.

> `1-apply-migration.cmd` and `3-rollback.cmd` **check that DSH is really stopped** first: two
> independent signals — the process list and **the DSH port recorded in the plan** (captured from the
> browser request at plan time). If either says "DSH is up", the script exits without touching
> anything; if neither can decide, it refuses to run instead of assuming DSH is down.
> Running a migration while DSH is up loses information (DSH writes its in-memory workspace state back
> over the result).

> In *staged manual runs*, **a plan whose source workspace is gone is marked *unusable*** (such a plan
> is meaningless now); next to that row's `i` appears *prune unusable runs* — it deletes only those,
> never a usable one.

### 3.3 Model tool

`workspace_migrate`: `live` (migrate without stopping DSH; `dryRun: true` reports only) / `plan` (write a
stop-DSH plan) / `status` (list staged plans) / `verify` (read-only re-check) / `apply` (always refused
inside DSH, with the commands to run by hand). Its `moveProject` and `project` parameters map to the
mode and the destination rules above; the tool schema is the reference.

## 4 Safety and behaviour notes

- **Only what must change is changed**: the project directory (optional), the `cwd` in every session
  log header, the `projectKey` directory holding the session artifacts, and the fields in
  `workspace.json` and in the projection cache that point at the old path. Session history content is
  **not** touched.
- **Destination, "move the files too"**: three rules, no exception — missing → created by the move;
  exists and empty → used; exists with a file or a folder inside (an empty folder counts) → `Check`
  fails, naming the directory, the counts and the entries, and telling you to empty it or switch to
  *only change the path*. The plugin **never** moves, overwrites or backs up anything inside the
  destination.
- **Destination, "only change the path"**: missing → an empty directory is **created** when the run
  executes (parents included; a missing drive fails `Check`); exists → used as is (content is fine, no
  file is ever touched).
- **"Empty" means the top level is empty**: the test is whether the destination holds **any entry at
  its first level**, not "are there files, counted recursively". An earlier file-count test let a
  destination holding only empty folders through and merged the two trees (reported by a user; see
  [`DEV_LOGS.md`](DEV_LOGS.md), and [`DECISION.md`](DECISION.md) D20 / D21 for the reasoning).
- **Frame safety**: only frame 0 is recompressed, every other frame is copied byte for byte; the result
  is read back immediately with the same parser (frame count unchanged, header is one line, `cwd`
  correct). "Decompress the whole file → edit → recompress" is never done — it collapses the log to a
  single frame and DSH crashes.
- **It refuses rather than forces**: a destination already claimed by another workspace record **that
  has sessions**, a source/destination path claimed by several records, no rebindable write handle,
  **"move the files too" with a destination that is not empty**, a destination on a drive that does not
  exist, a missing source — each is refused with its reason.
- **The panel reads live state**: the workspace list comes from the running registry (the on-disk
  `workspace.json` is only its checkpoint projection), so a path changed by another plugin shows up
  after a refresh.
- **A running session**: it is `flush`ed first so the old artifact is complete, then, inside **one
  synchronous stretch with no `await`**, frame 0 is recompressed, the artifact is moved and the write
  handle's header is retargeted — an append cannot interleave with that stretch, so the log cannot be
  corrupted.
- **Restart semantics**: changes to `index.js` / `client.js` / `lib/live-move.mjs` need a DSH restart
  (the `lib/dsh-workspace-migrate.mjs` engine is spawned per call, so it is live immediately).
- HTTP routes have a **loopback fence** (non-loopback address or cross-origin ⇒ 403) and
  `/open-directory` only opens directories under `<DSH_HOME>/migration-runs`.

### 4.1 Where reports and backups land

| Path | Content |
|---|---|
| `<DSH_HOME>/migration-runs/live-<timestamp>.json` | The full report of every live move (written on success and on failure; carries the four layers, the rollback result and the index repair) |
| `<DSH_HOME>/migration-runs/<timestamp>-<project>/` | The staged stop-DSH plan: `plan.json` + an engine snapshot + `1-apply-migration.cmd` / `2-verify.cmd` / `3-rollback.cmd` + `README.txt` |
| `<DSH_HOME>/migration-backups/<timestamp>/` | The full pre-apply backup of the stop-DSH flow + `backup-manifest.json` (the rollback reads it) |

## 5 Compatibility detail

| Plugin | Verified DSH | Node |
|---|---|---|
| 0.2.0 | v0.1.5-rc.1, v0.1.7-rc.2 | ≥ 20 |

Re-checked on **v0.1.7-rc.2** against a live host (not only the offline suites):

- the plugin mounts, all 10 HTTP routes answer, and the `workspace_migrate` tool registers;
- the four seats `sidebar.footer.action` / `conversation.session.header.actions` / `settings.section` /
  `shell.overlay` are still **additive in the Slot catalog (`replaceRisk: none`)**, and all four
  registrations of this plugin are active;
- every private surface used is still there: `sessionPersistence.tracker.writers` / `.root` /
  `.locate()` / `.listArtifacts()`, `workspaceRegistry.headers` / `.sessionPaths` / `.attachSession()`
  / `.create()` / `.validateStoredState()`, `sessions.flush()` / `.get()`;
- both invariants owned by other packages still hold: frame 0 of a session log must be exactly one line
  (otherwise DSH's startup assertion fails), and one path claimed by two workspace records prevents
  startup (`path '…' is claimed by both workspace '…' and …`);
- the package declares **no** DSH peer dependency, so the plugin manager's version check cannot block
  an upgrade.

> The same list is recorded in [`FACTS.md`](FACTS.md) §9 (the formal home for measured contracts; follow it
> for the three read-only checks after a DSH upgrade).

## 6 Development and release detail

```bash
npm test                  # four suites (hosttest / clienttest / livetest / selftest)
npm run test:mutations    # mutation testing: every mechanism must be catchable by a suite
npm run test:all          # both
npm pack --dry-run        # which files would be published
```

- `index.js` is the host half (Cordis plugin + HTTP routes + the `workspace_migrate` tool), `client.js`
  is the browser half (hand-written lazy-CJS) and `lib/` holds the engine and the live-move
  orchestration — all ESM, **no build step**.
- The suites need no browser and never touch a real DSH_HOME; `tools/` holds development and diagnostic
  scripts (see [`../tools/README.md`](../tools/README.md)).
- Current baseline: hosttest 88 / clienttest 121 / livetest 193 / selftest 172 = **574 assertions**, plus
  **26 mutations** (each must be caught by its suite; all green before a commit).
- Run `npm run test:all` before committing: a mutation nobody catches makes it exit non-zero.

## 7 Where the developer memory lives

| File | Content |
|---|---|
| [`MEMORY.md`](MEMORY.md) | The index: how these files divide the work, and the conventions |
| [`FACTS.md`](FACTS.md) | Measured DSH contracts and invariants (private surfaces, file layout, host behaviour, the Slot catalog) — only what was verified first hand |
| [`DECISION.md`](DECISION.md) | Design decisions with their reasoning (context / decision / why / cost) + the retired designs |
| [`DEV_LOGS.md`](DEV_LOGS.md) | Dated incidents: symptom, root cause, fix, verification |
| [`TODOS.md`](TODOS.md) | Open items and known gaps |
| [`USAGE.md`](USAGE.md) / `USAGE.en.md` (this file) | Usage and troubleshooting in full: install commands, the troubleshooting table, the complete safety notes, report locations |
