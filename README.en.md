# dsh-workspace-migrate — move a DSH workspace to a new path

[中文](README.md) | English

[![GitHub](https://img.shields.io/badge/GitHub-repository-blue)](https://github.com/wfql1024/dsh-workspace-migrate)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.1.7--rc.2-blue)](#6-compatibility)

## 0 Overview

Move a DSH workspace **to a new path as a whole**: the project directory, its registration and every stored session go together — **including the conversation you are chatting in** — without quitting DSH. Issues and pull requests are welcome on GitHub.

## 1 Features

### 1.1 Live migration

- **Migrate while chatting**: a running session (the current conversation included) is moved by **retargeting its live write handle**, so the conversation is never interrupted; cold sessions go to an engine subprocess.
- **Every log generation moves together**: once DSH upgrades the log format, one session directory holds both `session.jsonl.zstd` and `session.v3.jsonl.zstd`, and the plugin moves each generation — moving only one would leave the same session id under two project keys, which DSH refuses to load.
- **Frame-safe**: only frame 0 (the header) of each log is recompressed; every other zstd frame is copied back byte for byte, preserving the invariant DSH asserts at startup (frame 0 must be exactly one line).
- **Automatic rollback**: project directory → workspace registration → session artifacts → in-memory registry run in dependency order; a failure in any layer rolls the completed ones back newest-first.

### 1.2 Three rules for the destination

- **Missing** → created by the move (any legal path); **exists with nothing at its top level** → used as is.
- **Exists with a file or a folder inside** → `Check` fails, naming the directory and the entries (**an empty folder counts**), telling you to empty it or switch to *only change the path*.
- *Only change the path* touches no file, it just points the workspace at the destination — and creates it as an empty directory when it is missing. The plugin **never** moves, overwrites or backs up anything inside the destination.

### 1.3 An account of every run, plus a fallback

- **Every migration leaves an account**: a report is written on success and on failure; the stop-DSH mode also writes a full backup.
- **Stop-DSH plan mode**: tick *manual migration* to only generate scripts and run them with DSH stopped. Staged runs whose source workspace no longer exists are marked *unusable* and can be pruned in one click.

### 1.4 Model tool

`workspace_migrate` (`live` / `plan` / `status` / `verify` / `apply`) — tell the agent "move workspace X to Y".

## 2 UI entry points

### 2.1 Three entry points

- **Sidebar foot**: `⇄ 迁移`; when the sidebar is collapsed to its rail only the `⇄` glyph remains.
- **Conversation title bar**: `迁移工作区`, with the **workspace of the current conversation preselected**.
- **Settings → 工作区迁移**: the same panel.

### 2.2 The panel

`Check` / `Migrate` / `Plan` / `Verify` / staged manual runs are one summary row each — click to expand, a failure expands itself. The `i` next to a staged run explains the manual flow.

## 3 Usage

### 3.1 Live migration (default)

1. Pick **from** in the **workspace dropdown** (read-only: it must be a registered workspace) and fill in **to**.
2. Pick the **mode**: *move the files too* (default) or *only change the path* — see the destination rules in [1.2](#12-three-rules-for-the-destination).
3. Click **Start migration**: it runs a **read-only check first**; a failure writes nothing and says why in the `Check` row, a pass continues the migration.
4. Read the `Migrate` row; a failure expands, and **every step already done is undone newest-first**.

> The old, now empty workspace record stays in the sidebar (`sessionIds` empty): DSH exposes no public API to change a workspace path — right-click and delete it.

### 3.2 Manual migration (stop-DSH fallback)

1. Tick **manual migration**; the button becomes **Generate plan** — click it (it **checks first** too, and a failure does not generate a plan).
2. You get one `Plan` row (*open directory* jumps straight there).
3. **Quit DSH completely**, run `1-apply-migration.cmd` then `2-verify.cmd` (must be all PASS); on an error run `3-rollback.cmd`.
4. Start DSH again and confirm the sessions still hang under the workspace.

> Both `.cmd` scripts **check that DSH is really stopped** first (the process list plus the port recorded in the plan — two independent signals), and refuse to run when neither can decide.

## 4 Install

### 4.1 From GitHub (one command)

```powershell
dsh plugin --profile web add github:wfql1024/dsh-workspace-migrate
```

### 4.2 From source (easy `git pull` upgrades)

```bash
git clone https://github.com/wfql1024/dsh-workspace-migrate.git ~/dsh-workspace-migrate
dsh plugin --profile web add ~/dsh-workspace-migrate
```

**A full DSH restart is required after installing**; `[dsh-workspace-migrate] mounted — 10/10 routes …` in the startup log means it mounted, and a stale UI in the browser needs `Ctrl+Shift+R`. cmd.exe does not expand `~`, so use an absolute path there.

### 4.3 Upgrade / uninstall

```powershell
dsh plugin --profile web add github:wfql1024/dsh-workspace-migrate   # upgrade, then restart DSH
dsh plugin --profile web remove dsh-workspace-migrate                # uninstall, then restart DSH
```

> The full commands for all three shells, the uninstall notes and the **troubleshooting table** are in [`MEMORY/USAGE.en.md`](MEMORY/USAGE.en.md#1-install-and-upgrade).

## 5 Safety

- **Only what must change is changed**: the project directory (optional), the `cwd` in every session log header, the `projectKey` directory holding the artifacts, and the fields in `workspace.json` and the projection cache that point at the old path; session history content is **not** touched.
- **The destination is never touched**: nothing inside it is moved, overwritten or backed up, ever (see the rules in [1.2](#12-three-rules-for-the-destination)).
- **It refuses instead of forcing**: a destination claimed by another record **that has sessions**, a source/destination claimed by several records, no rebindable write handle, a destination that is not empty, a destination on a missing drive, a missing source — each is refused with its reason.
- **A running session** is `flush`ed first so the old artifact is complete, then, inside **one synchronous stretch with no `await`**, frame 0 is recompressed, the artifact is moved and the write handle's header is retargeted — an append cannot interleave, so the log cannot be corrupted.
- **It relies on DSH private surfaces** (`sessionPersistence.tracker.writers`, `workspaceRegistry.headers` / `sessionPaths`, `sessions.flush`), all behind `typeof` guards: when one is missing it **refuses to migrate a running session** instead of writing bad data.
- HTTP routes have a **loopback fence** (non-loopback or cross-origin ⇒ 403); `/open-directory` only opens directories under `<DSH_HOME>/migration-runs`.

> The full notes (frame-safety constraints, restart semantics, why "empty" means the top-level listing, where reports and backups land) are in [`MEMORY/USAGE.en.md`](MEMORY/USAGE.en.md#4-safety-and-behaviour-notes).

## 6 Compatibility

| Plugin | Verified DSH | Node |
|---|---|---|
| 0.2.0 | v0.1.5-rc.1, v0.1.7-rc.2 | ≥ 20 |

A Cordis plugin, web client half only (`dsh.client.platform: "web"`), with no DSH peer dependency declared.
The item-by-item check on v0.1.7-rc.2 (routes, the four seats, private surfaces, both invariants) is in [`MEMORY/FACTS.md`](MEMORY/FACTS.md) §9 and [`MEMORY/USAGE.en.md`](MEMORY/USAGE.en.md#5-compatibility-detail).

## 7 Development

```bash
npm test                  # four suites (hosttest / clienttest / livetest / selftest)
npm run test:mutations    # mutation testing: every mechanism must be catchable by a suite
npm run test:all          # both
```

- `index.js` is the host half (Cordis plugin + HTTP routes + the `workspace_migrate` tool), `client.js` the browser half (hand-written lazy-CJS) and `lib/` the engine and the live-move orchestration — all ESM, **no build step**; the suites need no browser and never touch a real DSH_HOME.
- Run `npm run test:all` before committing: a mutation nobody catches makes it exit non-zero.

The developer-facing memory lives in [`MEMORY/`](MEMORY/MEMORY.md) (Chinese): measured contracts (FACTS), decisions (DECISION), incidents (DEV_LOGS), open items (TODOS), usage and troubleshooting detail (USAGE.md / USAGE.en.md).

## 8 Acknowledgments

Thanks to everyone who installs and uses this plugin, and to everyone who files issues and pull requests.

The private-surface usage follows the practice of [dsh-session-manager](https://github.com/hkkz9522/dsh-session-manager) — it moves sessions between workspaces, this plugin re-homes a whole workspace; the two are complementary.

## 9 License

[MIT](LICENSE)
