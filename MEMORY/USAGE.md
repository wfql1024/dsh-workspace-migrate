# USAGE — 使用与排错细节（README 之外的完整版）

> 这份文件是 [`README.md`](../README.md) 的**细节仓库**：README 只留"能一眼看完"的部分，
> 完整安装写法、排错表、安全与行为说明的全文、报告位置等都收在这里。
> 面向使用者的入口仍然是 README；这里写给"想知道到底做了什么、出问题怎么查"的人。

## 1. 安装与升级

### 1.1 完整安装写法（三种 shell）

`~` 只在 bash / Git Bash 里有意义，**cmd.exe 不会展开 `~`**（会被 pnpm 当成 GitHub 的 `owner/repo`，
报 `is not a valid repository name`），所以下面按 shell 分开写：

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

一条命令的 GitHub 安装（pnpm 会克隆到 profile 自己的 `node_modules`）：

```powershell
dsh plugin --profile web add github:wfql1024/dsh-workspace-migrate
```

**不需要** `npm install`：本包没有任何运行时依赖。

### 1.2 装完必须重启，怎么确认装上了

**完全退出 DSH 再启动**（不是刷新页面）——宿主插件树是启动时合成的。启动日志出现这行说明挂上了：

```
[dsh-workspace-migrate] mounted — 10/10 routes at /api/dsh-workspace-migrate, engine at <...>/lib/dsh-workspace-migrate.mjs
```

装好后浏览器若仍是旧界面，按 `Ctrl+Shift+R` 强制刷新。

### 1.3 升级 / 卸载

```powershell
# 升级：github: 安装重新执行一次 add；克隆安装 git pull —— 然后都要重启 DSH
dsh plugin --profile web add github:wfql1024/dsh-workspace-migrate

# 卸载（然后重启 DSH）
dsh plugin --profile web remove dsh-workspace-migrate
```

卸载**不会**动你的会话、工作区或迁移记录；已生成的 `migration-runs` / `migration-backups` 需要自己删。

## 2. 排错表

| 现象 | 原因 / 处理 |
|---|---|
| `is not a valid repository name`（`git ls-remote git+ssh://git@github.com/~/...`） | 你在 **cmd.exe** 里用了 `~/…`。cmd 不展开 `~`，pnpm 把它当成 GitHub 的 `owner/repo`。改用绝对路径，或用 `github:` 那条 |
| 装完界面没变化 | 没重启 DSH。宿主插件树是启动时合成的 |
| 启动日志里 `could not register /api/…` | 有别的插件占了同名路由；插件会跳过那一条并继续挂载，把日志贴出来即可 |
| 按钮点了没反应 / 行为是旧的 | 客户端半体刷新页面就更新，**宿主半体只有重启才更新**；两者不一致时对话框会直接说明 |
| `remove` 之后 `node_modules` 里还有目录 | pnpm 会留下链接本身。删链接用 `cmd /c rmdir <路径>`，**不要**用 `Remove-Item -Recurse`（可能连链接指向的真实目录内容一起删） |
| 报"目标路径已被 N 条工作区记录声明" | 同一路径被两条记录声明时 DSH 无法启动；先去侧栏删掉多余那条工作区记录 |
| 报"目标目录不是空的" | 目标里已经有文件夹或文件（**空文件夹也算**）。**先自己清空它**，或改用「仅修改目录」只把工作区指过去 |
| 暂存记录显示「无法使用」 | 该计划的源工作区已经不在了（多半是已经迁过或被删）。用「清理无法使用的暂存」删掉即可 |
| 点「开始迁移」后说 `Check` 未通过 | 看 `Check` 行展开的原因；它在写任何东西之前就拦住了 |

## 3. 用法细节

### 3.1 不停机迁移（默认）的完整流程

1. 在**工作区下拉框**里选「从」（这个框不能手输，来源必须是已注册的工作区），填「到」。
2. 选「方式」：
   - **连同文件迁移**（默认）：项目文件也搬到新路径。目标目录的判定只有三条 ——
     1. **不存在**：自动创建，然后迁移（合法路径即可）；
     2. **存在，且内部没有任何文件夹和文件**：直接用它迁移；
     3. **存在，且内部已经有文件夹或文件**：`Check` 直接失败，并在 `Check` 行写明是哪个目录、里面有哪几项
        （**文件夹也算内容，空文件夹同样算** —— 有些项目会拿一个空文件夹当标记），
        提醒你自己清空，或者改用「仅修改目录」。
     插件**不会**动目标目录里的任何东西，也不会把它搬到别处。
   - **仅修改目录**：不动任何文件，只把工作区指向目标路径。**路径不存在时自动创建**（只建目录，不写任何文件，
     父目录一并创建；所在盘不存在则检查失败）；路径已存在且有内容也没关系，那正是"指向它"的意思。
3. 点 **「开始迁移」**。它会**先做只读检查**，检查不通过就一行不改，并在 `Check` 行告诉你为什么；
   通过则继续完成迁移。
4. 结果看 `Migrate` 行（`[√] 成功` / `[×] 失败`）；失败会展开细节，并且**已经做过的每一步都按新到旧还原**
   （工件按字节还原、刚注册的工作区撤销、刚建的空目录删掉、项目目录搬回原位）。

> 那三条规则对目标目录的状态是**唯一**标准：没有第二个"要不要覆盖"的开关，插件不会替你清空、覆盖或备份任何东西。

> 搬完之后**旧的空工作区记录会留在侧栏**（`sessionIds` 为空），这是有意为之（DSH 没有改工作区 path 的公开 API），
> 右键删掉即可；项目里所有会话都已属于新工作区。

### 3.2 手动迁移（停机兜底）的完整流程

1. 勾选 **「手动迁移」**，按钮变成 **「生成计划」**，点它。点下去**先做检查**（同样是上面那三条目标目录规则，
   外加源路径是否存在）、检查不通过就在 `Check` 行告诉你原因并**不生成计划**。
   - 这里的检查**只查"停机时也成立"的规则**（源路径、目标目录），不查实时前置条件（注册表、运行中的会话）——
     兜底路线不该被它自己不需要的东西挡住。实现上是 `/live-inspect` 的 `projectOnly: true`。
2. 结果是一行 `Plan`（点「打开目录」可直接跳到那个目录）。
3. **完全退出 DSH**（Web 服务 + 所有会话进程）。
4. 双击 `1-apply-migration.cmd` → `2-verify.cmd`（必须全 PASS）→ 出错则 `3-rollback.cmd`。
5. 重新启动 DSH，确认工作区下仍挂着原来的会话。

> `1-apply-migration.cmd` 和 `3-rollback.cmd` **会自己先确认 DSH 已经退出**：命令有两个独立信号 ——
> 进程列表，以及**计划里记下的 DSH 端口**（生成计划时从浏览器请求里取到的）。任一说"DSH 还在"就直接退出、不动任何文件；
> 两个都拿不到结论时也拒绝执行（而不是当作已经退出）。
> 在 DSH 运行时执行迁移会丢改动（DSH 会把内存里的工作区状态回写，盖掉迁移结果）。

> 「暂存的手动迁移」里，**源工作区已经不存在的记录会标上「无法使用」**（这类计划已经没有意义了），
> 行头的「i」旁边会出现「清理无法使用的暂存」——它只删这些，不会碰还能用的记录。

### 3.3 模型工具

`workspace_migrate`：`live`（不停机迁移，可先 `dryRun: true` 只报告）/ `plan`（生成停机计划）/
`status`（列出暂存计划）/ `verify`（只读复核）/ `apply`（在 DSH 内一律拒绝，并给出该手工执行的命令）。
`moveProject` 与 `project` 两个参数分别对应「方式」和「目标目录规则」，说明见工具自身 schema。

## 4. 安全与行为说明

- **只改该改的**：项目目录（可选）、会话日志的 header `cwd`、会话工件所在的 `projectKey` 目录、
  `workspace.json` 与投影缓存里指向旧路径的字段。**不改**会话历史内容。
- **目标目录的处理**（「连同文件迁移」）：三条规则，没有例外 ——
  **不存在** → 搬迁时创建；**存在且内部没有任何文件夹和文件** → 直接用；
  **存在且内部有文件夹或文件**（空文件夹也算）→ `Check` 失败，写明目录、项数与条目名，提示你自己清空或改用
  「仅修改目录」。插件**绝不**移动、覆盖或备份目标目录里的东西。
- **目标目录的处理**（「仅修改目录」）：不存在 → 执行时**创建一个空目录**（父目录一并创建；所在盘不存在则 `Check` 失败）；
  存在 → 直接用（有内容也没关系，文件一律不碰）。
- **"空"的定义是顶层列表为空**：判定看的是目标目录**第一层有没有条目**，不是"有没有文件、递归数了几个文件"。
  早先按文件数判定时，只有空文件夹的目标会被放行然后被合并进去（用户实测报回，见 [`DEV_LOGS.md`](DEV_LOGS.md)，
  设计理由见 [`DECISION.md`](DECISION.md) 的 D20 / D21）。
- **帧安全**：只重压第 0 帧，其余帧逐字节拷贝；改完立刻用同一套解析读回校验（帧数不变、header 一行、cwd 正确）。
  绝不做"整文件解压 → 改 → 重压"（那会塌成单帧，DSH 直接崩）。
- **会拒绝而不是硬来**：目标路径已被另一条**有会话的**工作区记录声明、源/目标路径被多条记录声明、
  拿不到可重定向的写句柄、**「连同文件迁移」但目标目录不是空的**、目标路径不在任何存在的盘上、源路径不存在
  —— 都会拒绝并说明原因。
- **面板读的是活状态**：工作区列表来自运行中的 registry（磁盘上的 `workspace.json` 只是它的存档投影），
  所以别的插件改了路径，刷新页面就能看到。
- **运行中的会话**：先 `flush` 让旧工件完整，然后在**一段没有 `await` 的同步代码**里重压第 0 帧、移动工件、
  改写写句柄的 header —— 追加写不可能插进这一段，所以不会写坏日志。
- **重启语义**：`index.js` / `client.js` / `lib/live-move.mjs` 的改动需要重启 DSH 才生效
  （`lib/dsh-workspace-migrate.mjs` 引擎是每次调用起子进程，改完立即生效）。
- HTTP 路由有**回环防护**（非回环地址 / 跨源一律 403），`/open-directory` 只允许打开
  `<DSH_HOME>/migration-runs` 下的目录。

### 4.1 报告与备份的落盘位置

| 路径 | 内容 |
|---|---|
| `<DSH_HOME>/migration-runs/live-<时间戳>.json` | 每次不停机迁移的完整报告（成功与失败都写，包含四层步骤、回滚结果、索引修复情况） |
| `<DSH_HOME>/migration-runs/<时间戳>-<项目名>/` | 停机计划的暂存目录：`plan.json` + 引擎快照 + `1-apply-migration.cmd` / `2-verify.cmd` / `3-rollback.cmd` + `README.txt` |
| `<DSH_HOME>/migration-backups/<时间戳>/` | 停机执行前的整目录备份 + `backup-manifest.json`（回滚就读它） |

## 5. 兼容性细节

| 插件版本 | 已验证 DSH 版本 | Node |
|---|---|---|
| 0.2.0 | v0.1.5-rc.1、v0.1.7-rc.2 | ≥ 20 |

在 **v0.1.7-rc.2** 上重新核对过（真机，不是只跑离线测试）：

- 插件挂载正常，10 条 HTTP 路由全部应答，`workspace_migrate` 工具正常注册；
- 四个座位 `sidebar.footer.action` / `conversation.session.header.actions` / `settings.section` / `shell.overlay`
  在 **Slot 目录里都还是加法式（`replaceRisk: none`）**，本插件的四条注册都是 active；
- 用到的私有面一个没少：`sessionPersistence.tracker.writers` / `.root` / `.locate()` / `.listArtifacts()`、
  `workspaceRegistry.headers` / `.sessionPaths` / `.attachSession()` / `.create()` / `.validateStoredState()`、
  `sessions.flush()` / `.get()`；
- 两条靠别人实现的**不变量**也还在：会话日志第 0 帧必须"恰好一行"（否则 DSH 启动断言失败）、
  同一路径被两条工作区记录声明会导致启动失败（`path '…' is claimed by both workspace '…' and …`）；
- 本包**没有**声明 DSH 的 peer 依赖，所以插件管理器的版本检查不会挡住升级。

> 同一份清单也记在 [`FACTS.md`](FACTS.md) 的 §9（那里是"实测契约"的正式位置，升级 DSH 后照它做三步只读核对）。

## 6. 开发与发布细节

```bash
npm test                  # 四个套件（hosttest / clienttest / livetest / selftest）
npm run test:mutations    # 变异测试：每个关键机制都必须能被测出来
npm run test:all          # 两者都跑
npm pack --dry-run        # 看会发布哪些文件
```

- `index.js` 是宿主半体（cordis 插件 + HTTP 路由 + `workspace_migrate` 工具），`client.js` 是浏览器半体
  （手写 lazy-CJS），`lib/` 是引擎与不停机编排 —— 全部 ESM，**没有编译步骤**。
- 测试不需要浏览器、不碰真实 DSH_HOME；`tools/` 下是开发与诊断脚本（见 [`../tools/README.md`](../tools/README.md)）。
- 当前测试基线：hosttest 88 / clienttest 121 / livetest 193 / selftest 172 = **574 项断言**，
  外加 **26 个变异**（每个都必须被对应套件抓住，全绿才允许提交）。
- 提交前跑 `npm run test:all`：有变异没被抓到，它的退出码会非 0。

## 7. 开发者记忆在哪

| 文件 | 内容 |
|---|---|
| [`MEMORY.md`](MEMORY.md) | 索引：这四个文件怎么分工、什么约定 |
| [`FACTS.md`](FACTS.md) | DSH 的实测契约与不变量（私有面、文件布局、宿主行为、Slot 目录），只写亲自量过的 |
| [`DECISION.md`](DECISION.md) | 设计决定与理由（背景 / 决定 / 理由 / 代价）+ 已废止的旧设计 |
| [`DEV_LOGS.md`](DEV_LOGS.md) | 按日期的事故记录：现象、根因、修复、验证 |
| [`TODOS.md`](TODOS.md) | 待办与已知缺口 |
| `USAGE.md`（本文件） | 使用与排错的完整版：安装写法、排错表、安全说明全文、报告位置 |
