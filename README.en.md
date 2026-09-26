# dsh-workspace-migrate — move a DSH workspace to a new path

[中文](README.md) | English

[![GitHub](https://img.shields.io/badge/GitHub-repository-blue)](https://github.com/wfql1024/dsh-workspace-migrate)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.1.7--rc.2-blue)](#compatibility)

Move a DeepSeek Harness (DSH) Web **workspace to a new path as a whole**: the project directory, the
workspace registration and every stored session — **including the conversation you are chatting in** —
without quitting DSH. Issues and pull requests are welcome on GitHub.

## Features

- **Live migration (default)**: moves the project directory, rewrites the `cwd` in every session log
  header, relocates the session artifacts to the new `projectKey`, and updates the workspace registry
  plus the in-memory state. A running session (the current conversation included) is handled by
  **retargeting its live write handle**, so the conversation is never interrupted.
- **Every log generation moves together**: when DSH upgrades the log format it leaves both
  `session.jsonl.zstd` and `session.v3.jsonl.zstd` in one session directory, and the plugin moves each
  generation — moving only one would leave the same session id under two project keys, which DSH
  refuses outright.
- **Frame-safe**: only frame 0 (the header) of each log is recompressed; every other zstd frame is
  copied back **byte for byte**, preserving the invariant DSH asserts at startup (frame 0 must be
  exactly one line).
- **Automatic rollback on failure**: project directory, workspace registration, session artifacts and
  the in-memory registry run in dependency order; a failure in any layer rolls the completed ones back
  newest-first (artifacts restored byte for byte, a just-created registration removed).
- **Two ways to land**: *move the files too* (default, the project files move as well) and *only change
  the path* (re-points the workspace; a missing destination is created as an empty directory).
- **The panel follows DSH**: the workspace list comes from the **live registry**, not the on-disk
  `workspace.json`, so a path changed by another plugin shows up after a refresh — no restart.
- **Every run leaves an account**: a success/failure report is always written; the stop-DSH mode also
  writes a full backup.
- **Stop-DSH plan mode (optional)**: tick *manual migration* to only generate scripts and run them
  yourself with DSH stopped — the fallback route. Staged runs whose source workspace no longer exists
  are marked *unusable* and can be pruned in one click.
- **Model tool**: `workspace_migrate` (`live` / `plan` / `status` / `verify` / `apply`) — tell the agent
  "move workspace X to Y".

## UI entry points

- **Sidebar foot**: `⇄ 迁移` opens the dialog; **when the sidebar is collapsed to its rail only the
  `⇄` glyph remains** (a 36×36 icon button — the name stays in `title` / `aria-label`, visible on hover).
- **Conversation title bar**: `迁移工作区` **preselects the workspace of the current conversation** —
  you can migrate while chatting.
- **Settings → 工作区迁移**: the same panel, any time.
- **In the modal**: `Check` / `Migrate` / `Plan` / `Verify` / `暂存的手动迁移` (staged manual runs) are
  one summary row each — click to expand, a failure expands itself. The `i` next to a staged run
  explains the manual flow.

## Usage

### Live migration (default)

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

### Manual migration (stop-DSH fallback)

1. Tick **manual migration**; the button becomes **Generate plan** — click it. That click **checks
   first** (the same three destination rules, plus whether the source exists); a failed check tells you
   why in the `Check` row and **does not generate a plan**.
   > That check covers **only what holds with DSH stopped** (source path, destination). Live-only
   > preconditions (the registry, running sessions) are not consulted — a fallback route must not be
   > blocked by something it does not need.
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

### Install

The plugin is **not published to npm**; install it from GitHub by either route below. **No**
`npm install` is needed (the package has no runtime dependencies).

#### From GitHub (one command)

```powershell
dsh plugin --profile web add github:wfql1024/dsh-workspace-migrate
```

#### From source (easy `git pull` upgrades)

`~` is only meaningful in bash / Git Bash — **cmd.exe does not expand it**, so use absolute paths:

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

**A full DSH restart is required after installing** (not a page refresh). This line in the startup log
means it mounted:

```
[dsh-workspace-migrate] mounted — 10/10 routes at /api/dsh-workspace-migrate, engine at <...>/lib/dsh-workspace-migrate.mjs
```

If the browser still shows the old UI after installing, force a refresh with `Ctrl+Shift+R`.

#### Upgrade / uninstall

```powershell
# Upgrade: re-run add for a github: install; git pull for a clone — then restart DSH either way
dsh plugin --profile web add github:wfql1024/dsh-workspace-migrate

# Uninstall (then restart DSH)
dsh plugin --profile web remove dsh-workspace-migrate
```

Uninstalling does **not** touch your sessions, workspaces or migration records; the `migration-runs` /
`migration-backups` already written are yours to delete.

#### If it will not install

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

## Safety and behaviour notes

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
  `MEMORY/DEV_LOGS.md`).
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
- **Reports and backups**: `<DSH_HOME>/migration-runs/live-<timestamp>.json` (every live move),
  `<DSH_HOME>/migration-runs/<timestamp>-<project>/` (stop-DSH plan),
  `<DSH_HOME>/migration-backups/<timestamp>/` (the stop-DSH backup + manifest).
- HTTP routes have a **loopback fence** (non-loopback address or cross-origin ⇒ 403) and
  `/open-directory` only opens directories under `<DSH_HOME>/migration-runs`.

## Compatibility

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

The private surfaces it relies on (`sessionPersistence.tracker.writers`, `workspaceRegistry.headers` /
`sessionPaths`, `sessions.flush`) are all behind `typeof` guards: when one is missing the plugin
**refuses to migrate a running session** and says so, instead of writing bad data. Only a web client
half is provided (`dsh.client.platform: "web"`).

## Development

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
  scripts (see [`tools/README.md`](tools/README.md)).
- Run `npm run test:all` before committing: a mutation nobody catches makes it exit non-zero.

## Documentation

The developer-facing long-term memory lives in [`MEMORY/`](MEMORY/MEMORY.md) (Chinese):

| File | Content |
|---|---|
| [`FACTS.md`](MEMORY/FACTS.md) | Measured DSH contracts and invariants (private surfaces, file layout, host behaviour) — only what was verified first hand |
| [`DECISION.md`](MEMORY/DECISION.md) | Design decisions and their reasoning (context / decision / why / cost) |
| [`DEV_LOGS.md`](MEMORY/DEV_LOGS.md) | Dated incident log: symptom, root cause, fix, verification |
| [`TODOS.md`](MEMORY/TODOS.md) | Open items and known gaps |

## Credits

Thanks to everyone who installs and uses this plugin, and to everyone who files issues and pull
requests.

The private-surface usage follows the practice of
[dsh-session-manager](https://github.com/hkkz9522/dsh-session-manager) — it moves sessions between
workspaces, this plugin re-homes a whole workspace; the two are complementary.

## License

[MIT](LICENSE)
