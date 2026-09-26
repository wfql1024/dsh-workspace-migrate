# dsh-workspace-migrate — DSH 工作区迁移

中文 | [English](README.en.md)

[![GitHub](https://img.shields.io/badge/GitHub-仓库-blue)](https://github.com/wfql1024/dsh-workspace-migrate)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.1.7--rc.2-blue)](#6-兼容性)

## 0 简介

把 DSH 的一个工作区**整体搬到新路径**：项目目录、工作区注册、全部历史会话一起走 —— **包括你正在对话的那一条**，全程不用退出 DSH。欢迎至 GitHub 提意见。

## 1 功能

### 1.1 不停机迁移

- **边聊边迁**：运行中的会话（含当前对话）通过**重定向它的写句柄**迁移，对话不中断；冷会话交给引擎子进程处理。
- **多代日志一起搬**：DSH 升级日志格式后同一目录里会留下 `session.jsonl.zstd` 与 `session.v3.jsonl.zstd`，插件逐代搬迁 —— 只搬一代会让会话 id 同时出现在两个 `projectKey`，DSH 直接拒绝加载。
- **帧安全**：只重压每条日志的**第 0 帧**（header），其余 zstd 帧逐字节原样拷回，保持 DSH 启动时断言的不变量（第 0 帧必须恰好一行）。
- **失败自动回滚**：项目目录 → 工作区注册 → 会话工件 → 内存注册表四层按依赖顺序执行，任一层失败都从新到旧回滚。

### 1.2 目标目录的三条规则

- **不存在** → 迁移时创建（合法路径即可）；**存在且顶层没有任何条目** → 直接用它。
- **存在且已有文件或文件夹** → `Check` 失败，写明目录与条目（**空文件夹也算内容**），提示自己清空或改用「仅修改目录」。
- 「仅修改目录」不动任何文件，只把工作区指向目标路径；路径不存在就自动建一个空目录。插件**绝不**移动、覆盖或备份目标目录里的东西。

### 1.3 留账与兜底

- **每次迁移都留账**：成功/失败都写报告；停机模式另有整目录备份。
- **停机计划模式**：勾选「手动迁移」只生成脚本，退出 DSH 自己执行；暂存记录里源工作区已不存在的会标「无法使用」，支持一键清理。

### 1.4 模型工具

`workspace_migrate`（`live` / `plan` / `status` / `verify` / `apply`）—— 直接对 Agent 说"把 X 工作区迁到 Y"。

## 2 UI入口

### 2.1 三个入口

- **左侧侧栏底部**：「⇄ 迁移」；侧栏收起成窄条时只剩「⇄」图标。
- **对话标题栏右侧**：「迁移工作区」，**预选当前对话所在的工作区**。
- **设置 → 工作区迁移**：同一个面板。

### 2.2 面板

`Check` / `Migrate` / `Plan` / `Verify` / `暂存的手动迁移` 各占一行摘要，点开看细节，失败自动展开；暂存行旁的「i」写着手动流程的用法。

## 3 用法

### 3.1 不停机迁移（默认）

1. 在**工作区下拉框**选「从」（不能手输，必须是已注册的工作区），填「到」。
2. 选「方式」：**连同文件迁移**（默认）或**仅修改目录** —— 目标目录规则见 [1.2](#12-目标目录的三条规则)。
3. 点 **「开始迁移」**：它**先做只读检查**，不通过就一行不改并在 `Check` 行说明原因；通过则继续完成迁移。
4. 结果看 `Migrate` 行；失败会自动展开，且**已经做过的每一步都按新到旧还原**。

> 搬完旧的空工作区记录会留在侧栏（`sessionIds` 为空）：DSH 没有改工作区 path 的公开 API，右键删掉即可。

### 3.2 手动迁移（停机兜底）

1. 勾选 **「手动迁移」**，按钮变成 **「生成计划」**，点它（同样**先检查**，不通过就不生成计划）。
2. 得到一行 `Plan`（点「打开目录」可直接跳到那个目录）。
3. **完全退出 DSH**，双击 `1-apply-migration.cmd` → `2-verify.cmd`（必须全 PASS），出错则 `3-rollback.cmd`。
4. 重新启动 DSH，确认工作区下仍挂着原来的会话。

> 两个 `.cmd` 会**自己先确认 DSH 已退出**（进程列表 + 计划里记下的端口，两个独立信号），拿不到结论时拒绝执行。

## 4 安装

### 4.1 从 GitHub（一条命令）

```powershell
dsh plugin --profile web add github:wfql1024/dsh-workspace-migrate
```

### 4.2 从源码（便于 `git pull` 升级）

```bash
git clone https://github.com/wfql1024/dsh-workspace-migrate.git ~/dsh-workspace-migrate
dsh plugin --profile web add ~/dsh-workspace-migrate
```

**装完必须完全退出 DSH 再启动**；启动日志出现 `[dsh-workspace-migrate] mounted — 10/10 routes …` 即为成功，浏览器残留旧界面按 `Ctrl+Shift+R`。cmd.exe 不展开 `~`，在 cmd 里请用绝对路径。

### 4.3 升级 / 卸载

```powershell
dsh plugin --profile web add github:wfql1024/dsh-workspace-migrate   # 升级，然后重启 DSH
dsh plugin --profile web remove dsh-workspace-migrate                # 卸载，然后重启 DSH
```

> 三种 shell 的完整写法、卸载说明与**排错表**见 [`MEMORY/USAGE.md`](MEMORY/USAGE.md#1-安装与升级)。

## 5 安全说明

- **只改该改的**：项目目录（可选）、会话日志 header 的 `cwd`、工件所在的 `projectKey` 目录、`workspace.json` 与投影缓存里指向旧路径的字段；**不改**会话历史内容。
- **不碰目标目录**：任何情况下都不移动、覆盖或备份目标目录里的东西（规则见 [1.2](#12-目标目录的三条规则)）。
- **会拒绝而不是硬来**：目标被另一条有会话的记录声明、源/目标被多条记录声明、拿不到可重定向的写句柄、目标目录不是空的、目标盘不存在、源路径不存在 —— 都拒绝并说明原因。
- **运行中的会话**：先 `flush` 保证旧工件完整，再在**一段没有 `await` 的同步代码**里重压第 0 帧、移动工件、改写写句柄 header —— 追加写插不进这一段，日志不会被写坏。
- **依赖 DSH 私有面**（`sessionPersistence.tracker.writers`、`workspaceRegistry.headers` / `sessionPaths`、`sessions.flush`）：全部带 `typeof` 守卫，拿不到就**拒绝迁移运行中的会话**，而不是写坏数据。
- HTTP 路由有**回环防护**（非回环地址 / 跨源一律 403）；`/open-directory` 只能打开 `<DSH_HOME>/migration-runs` 下的目录。

> 完整说明（帧安全的完整约束、重启语义、"空=顶层列表为空"的历史原因、报告与备份的落盘位置）见 [`MEMORY/USAGE.md`](MEMORY/USAGE.md#4-安全与行为说明)。

## 6 兼容性

| 插件版本 | 已验证 DSH 版本 | Node |
|---|---|---|
| 0.2.0 | v0.1.5-rc.1、v0.1.7-rc.2 | ≥ 20 |

本包是 Cordis 插件，只提供 web 平台半体（`dsh.client.platform: "web"`），没有声明 DSH 的 peer 依赖。
在 v0.1.7-rc.2 上的逐项核对（路由、四个座位、私有面、两条不变量）见 [`MEMORY/FACTS.md`](MEMORY/FACTS.md) §9 或 [`MEMORY/USAGE.md`](MEMORY/USAGE.md#5-兼容性细节)。

## 7 开发

```bash
npm test                  # 四个套件（hosttest / clienttest / livetest / selftest）
npm run test:mutations    # 变异测试：每个关键机制都必须能被测出来
npm run test:all          # 两者都跑
```

- `index.js` 宿主半体（cordis 插件 + HTTP 路由 + `workspace_migrate` 工具）、`client.js` 浏览器半体（手写 lazy-CJS）、`lib/` 引擎与不停机编排 —— 全 ESM，**没有编译步骤**；测试不需要浏览器、不碰真实 DSH_HOME。
- 提交前跑 `npm run test:all`：有变异没被抓到，退出码会非 0。

开发者视角的长期记忆在 [`MEMORY/`](MEMORY/MEMORY.md)：实测契约（FACTS）、设计决定（DECISION）、事故记录（DEV_LOGS）、待办（TODOS）、使用与排错细节（USAGE）。

## 8 致谢

感谢每一位安装和使用本插件的用户，也感谢提交 Issue 与 Pull Request 的朋友。

私有面用法参考了 [dsh-session-manager](https://github.com/hkkz9522/dsh-session-manager) 的实践 —— 它做"会话跨工作区移动"，本插件做"整个工作区换路径"，两者互补。

## 9 开源许可

[MIT](LICENSE)
