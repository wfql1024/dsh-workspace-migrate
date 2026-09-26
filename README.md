# dsh-workspace-migrate — DSH 工作区迁移

[![GitHub](https://img.shields.io/badge/GitHub-仓库-blue)](https://github.com/wfql1024/dsh-workspace-migrate)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.1.5--rc.1-blue)](#兼容性)

用于在 DeepSeek Harness（DSH）Web 中**把一个工作区整体搬到新路径**：项目本体目录、工作区注册记录、
全部历史会话一起迁走 —— **包括你正在对话的那一条**，全程不用退出 DSH。欢迎至 GitHub 提意见。

## 功能

- **不停机迁移（默认）**：搬项目目录 + 改会话日志 header 里的 `cwd` + 把会话工件挪到新 `projectKey` +
  同步工作区注册表与内存态。运行中的会话（含当前对话）通过**重定向它的写句柄**实现，不会中断对话。
- **多代日志一起搬**：DSH 升级日志格式时会在同一会话目录里留下 `session.jsonl.zstd` 与 `session.v3.jsonl.zstd`
  两代文件，插件逐代搬迁 —— 只搬一代会让会话 id 同时出现在两个 projectKey，DSH 会直接拒绝。
- **帧安全**：只重压每条日志的**第 0 帧**（header），其余 zstd 帧**逐字节原样拷回**，
  保持 DSH 启动时断言的不变量（第 0 帧必须恰好是一行）。
- **失败自动回滚**：项目目录、工作区注册、会话工件、内存注册表四层按依赖顺序执行，
  任何一层失败都从新到旧回滚（工件按字节还原、刚注册的工作区被撤销）。
- **两种落地方式**：「连同文件迁移」（默认，把项目文件也搬过去）、「仅修改目录」（只把工作区指向目标路径，
  路径不存在就自动建一个空目录）。
- **面板跟着 DSH 走**：工作区列表读的是**运行中的 registry**，不是磁盘上的 `workspace.json`，
  所以别的插件改了路径，这里刷新一下就能看到，不用重启。
- **每次迁移都留账**：成功/失败都写一份报告；停机模式另有整目录备份。
- **停机计划模式（可选）**：勾选「手动迁移」后只生成脚本，退出 DSH 自己执行 —— 兜底路线。
  暂存记录里源工作区已经不存在的，会标成「无法使用」并提供一键清理。
- **模型工具**：`workspace_migrate`（`live` / `plan` / `status` / `verify` / `apply`），
  可以直接对 Agent 说"把 X 工作区迁到 Y"。

## UI 入口

- **左侧侧栏底部**：「⇄ 迁移」，打开迁移对话框；**侧栏收起成窄条时只剩「⇄」图标**（按钮变成 36×36 的方形图标钮，
  名称仍在 `title` / `aria-label` 里，鼠标悬停可见）。
- **对话标题栏右侧**：「迁移工作区」，**预选当前对话所在的工作区** —— 正在对话也可以迁。
- **设置 → 工作区迁移**：同一个面板，随时进来看看。
- **模态框里**：`Check` / `Migrate` / `Plan` / `Verify` / `暂存的手动迁移` 各占一行摘要，
  点一下展开细节；失败会自动展开。暂存项旁边的「i」按钮写着手动流程的用法。

## 用法

### 不停机迁移（默认）

1. 在**工作区下拉框**里选「从」（这一个框不能手输，来源必须是已注册的工作区），填「到」。
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

### 手动迁移（停机兜底）

1. 勾选 **「手动迁移」**，按钮变成 **「生成计划」**，点它。点下去**先做检查**（同样是上面那三条目标目录规则，
   外加源路径是否存在）、检查不通过就在 `Check` 行告诉你原因并**不生成计划**。
   > 这里的检查**只查"停机时也成立"的规则**（源路径、目标目录），不查实时前置条件（注册表、运行中的会话）——
   > 兜底路线不该被它自己不需要的东西挡住。
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

## 安装

插件**没有发布到 npm**，按下面任一方式从 GitHub 安装即可。**不需要** `npm install`（本包没有任何运行时依赖）。

### 从 GitHub 安装（一条命令）

```powershell
dsh plugin --profile web add github:wfql1024/dsh-workspace-migrate
```

### 从源码安装（便于 `git pull` 升级）

`~` 只在 bash / Git Bash 里有意义，**cmd.exe 不会展开 `~`**，所以用绝对路径：

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

**装完必须完全退出 DSH 再启动**（不是刷新页面）。启动日志出现下面这行就说明挂上了：

```
[dsh-workspace-migrate] mounted — 9/9 routes at /api/dsh-workspace-migrate, engine at <...>/lib/dsh-workspace-migrate.mjs
```

装好后浏览器如果还是旧界面，按 `Ctrl+Shift+R` 强制刷新。

### 升级 / 卸载

```powershell
# 升级：github: 安装重新执行一次 add；克隆安装 git pull —— 然后都要重启 DSH
dsh plugin --profile web add github:wfql1024/dsh-workspace-migrate

# 卸载（然后重启 DSH）
dsh plugin --profile web remove dsh-workspace-migrate
```

卸载**不会**动你的会话、工作区或迁移记录；已生成的 `migration-runs` / `migration-backups` 需要自己删。

### 装不上时先看这里

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

## 安全与行为说明

- **只改该改的**：项目目录（可选）、会话日志的 header `cwd`、会话工件所在的 `projectKey` 目录、
  `workspace.json` 与投影缓存里指向旧路径的字段。**不改**会话历史内容。
- **目标目录的处理**（「连同文件迁移」）：三条规则，没有例外 ——
  **不存在** → 搬迁时创建；**存在且内部没有任何文件夹和文件** → 直接用；
  **存在且内部有文件夹或文件**（空文件夹也算）→ `Check` 失败，写明目录、项数与条目名，提示你自己清空或改用
  「仅修改目录」。插件**绝不**移动、覆盖或备份目标目录里的东西。
- **目标目录的处理**（「仅修改目录」）：不存在 → 执行时**创建一个空目录**（父目录一并创建；所在盘不存在则 `Check` 失败）；
  存在 → 直接用（有内容也没关系，文件一律不碰）。
- **"空"的定义是顶层列表为空**：判定看的是目标目录**第一层有没有条目**，不是"有没有文件、递归数了几个文件"。
  早先按文件数判定时，只有空文件夹的目标会被放行然后被合并进去（用户实测报回，见 `MEMORY/DEV_LOGS.md`）。
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
- **报告与备份**：`<DSH_HOME>/migration-runs/live-<时间戳>.json`（每次不停机迁移）、
  `<DSH_HOME>/migration-runs/<时间戳>-<项目名>/`（停机计划）、
  `<DSH_HOME>/migration-backups/<时间戳>/`（停机执行的备份 + manifest）。
- HTTP 路由有**回环防护**（非回环地址 / 跨源一律 403），`/open-directory` 只允许打开
  `<DSH_HOME>/migration-runs` 下的目录。

## 兼容性

| 插件版本 | 已验证 DSH 版本 | Node |
|---|---|---|
| 1.0.0 | v0.1.5-rc.1、v0.1.7-rc.2 | ≥ 20 |

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

依赖 DSH 的私有面（`sessionPersistence.tracker.writers`、`workspaceRegistry.headers` / `sessionPaths`、
`sessions.flush`），全部带 `typeof` 守卫：拿不到就**拒绝迁移运行中的会话**并说明原因，而不是写坏数据。
只提供 web 平台半体（`dsh.client.platform: "web"`）。

## 开发

```bash
npm test                  # 四个套件（hosttest / clienttest / livetest / selftest）
npm run test:mutations    # 变异测试：每个关键机制都必须能被测出来
npm run test:all          # 两者都跑
npm pack --dry-run        # 看会发布哪些文件
```

- `index.js` 是宿主半体（cordis 插件 + HTTP 路由 + `workspace_migrate` 工具），`client.js` 是浏览器半体
  （手写 lazy-CJS），`lib/` 是引擎与不停机编排 —— 全部 ESM，**没有编译步骤**。
- 测试不需要浏览器、不碰真实 DSH_HOME；`tools/` 下是开发与诊断脚本（见 [`tools/README.md`](tools/README.md)）。
- 提交前建议跑 `npm run test:all`：有变异没被抓到，它的退出码会非 0。

## 文档

开发者视角的长期记忆在 [`MEMORY/`](MEMORY/MEMORY.md)：

| 文件 | 内容 |
|---|---|
| [`FACTS.md`](MEMORY/FACTS.md) | DSH 的实测契约与不变量（私有面、文件布局、宿主行为），只写亲自量过的 |
| [`DECISION.md`](MEMORY/DECISION.md) | 设计决定与理由（背景 / 决定 / 理由 / 代价） |
| [`DEV_LOGS.md`](MEMORY/DEV_LOGS.md) | 按日期的事故记录：三次真机翻车的现象、根因、修复、验证 |
| [`TODOS.md`](MEMORY/TODOS.md) | 待办与已知缺口 |

## 致谢

感谢每一位安装和使用本插件的用户，也感谢提交 Issue 与 Pull Request 帮助改进的朋友。

私有面用法参考了 [dsh-session-manager](https://github.com/hkkz9522/dsh-session-manager) 的实践 ——
它做的是"会话跨工作区移动"，本插件做的是"整个工作区换路径"，两者互补。

## 开源许可

[MIT](LICENSE)
