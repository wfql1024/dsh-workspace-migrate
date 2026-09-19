# dsh-workspace-migrate

DSH（DeepSeek Harness）插件：把一个工作区**整体搬到新路径**，历史会话跟过去，**包括你正在对话的那一条**，全程不用退出 DSH。

> Move a DSH workspace — its project directory, its registration and every session, including the
> conversation you are chatting in — to a new path without stopping the harness.

一次完整的迁移做四件事，缺一不可：

1. 搬项目本体目录（`D:\...` → `E:\...`）
2. 在新路径注册（或复用）工作区
3. 改写每条会话日志 header 里的 `cwd`，并把会话工件搬到新 `projectKey` 下
4. 同步内存态：把会话 attach 到新工作区、重定向运行中会话的写句柄

做完之后，会话历史完整、仍然归属目标工作区，而不是掉进"未分组"。

---

## 界面入口

| 位置 | 说明 |
|---|---|
| **左侧侧栏底部** | 「⇄ 迁移」按钮（「设置」旁边），点击弹出迁移对话框 |
| **对话标题栏右侧** | 「迁移工作区」按钮，**预选当前对话所在的工作区** —— 正在对话也可以迁 |
| **设置 → 工作区迁移** | 同一个面板，方便随时进来看看 |

三个入口都是**加法式**注册（`replaceRisk: none`），不会遮蔽任何原生 UI。
特别地，**不会**注册 `sidebar.workspaces` —— 那是个 `single` 插槽，注册它会替换整个原生会话列表，并和 `dsh-better-sidebar` 冲突。

界面只有一个动作按钮：**「开始迁移」**。它先做只读检查、检查通过才真正动手 —— 两步合成一步，检查不通过时不会有任何写入，
并在 `Check` 那一行告诉你为什么。勾选 **「手动迁移」** 后同一个按钮变成 **「生成计划」**，只生成脚本供你退出 DSH 后执行。

结果不再铺一屏文字，而是每条一行摘要（`Check` / `Migrate` / `Plan` / `Verify` / `暂存的手动迁移`），
带颜色状态标签（成功 / 失败 / 可执行 / 被阻止），点一下才展开细节；**失败会自动展开**，不需要你再点。

模型工具：`workspace_migrate`，动作 `live` / `plan` / `status` / `verify` / `apply`。
可以直接对我说「把 X 工作区迁到 Y」，我会先跑只读预检再动手。

> 「打开目录」由宿主新增的 `/open-directory` 路由实现，且**只允许打开 `<DSH_HOME>/migration-runs` 下的目录**。
> 如果你点它没反应：先看提示行 —— 客户端半体刷新页面就会更新，**宿主半体（路由）必须重启 DSH 才会更新**，
> 两者版本不匹配时插件会直接告诉你"宿主半体还是旧版本"，而不是丢一个 404 给你猜。

---

## 两种模式

### 不停机迁移（`live`）—— 默认

原地完成，不需要退出 DSH，**运行中的会话（含当前对话）也能迁**：

- 项目目录：`robocopy /E /MOVE`（失败不删源目录）
- 会话工件：插件进程内搬迁 + 重压第 0 帧
- 内存态：`detachSession` / `attachSession`，并重定向 live writer

四层按依赖顺序执行，任何一层失败都会**从新到旧自动回滚**（项目目录会被搬回来、工件按字节还原、刚注册的工作区被撤销）。
无论成功还是失败，都会在 `<DSH_HOME>/migration-runs/live-<时间戳>.json` 留下一份报告。

### 手动迁移（勾选后走 `plan`）—— 保守路线

生成一个自包含的运行目录，等 DSH 完全退出后双击执行。结果行里的 **「打开目录」** 按钮可以直接跳到那个目录；
`暂存的手动迁移` 里每一条也只显示 `源 -> 目标` 加一个「打开目录」（脚本固定是 `1-apply-migration.cmd`，
路径不用重复显示；`2-verify.cmd` 是退出 DSH 之后才跑的一步，放在这里点不到，所以不给按钮）：

```
<DSH_HOME>/migration-runs/<时间戳>-<项目名>/
    1-apply-migration.cmd   ← 退出 DSH 后双击
    2-verify.cmd            ← 必须全 PASS
    3-rollback.cmd          ← 出问题就双击
    plan.json
    dsh-workspace-migrate.mjs
    README.txt
```

备份写在 `<DSH_HOME>/migration-backups/<时间戳>/`，包含整个会话目录 + 每个被改动的 storage 文件 + manifest；任何一步失败会自动回滚并校验回滚结果。

> **`1-apply-migration.cmd` 和 `3-rollback.cmd` 会先自己确认 DSH 已经退出**：只要还探测到 DSH 进程，
> 脚本就打印命中的进程并直接退出，不会动任何文件。**在 DSH 还开着的时候跑迁移会丢改动** ——
> DSH 会把内存里的工作区状态回写，盖掉迁移结果（这条路上真的翻过车）。
> 如果进程探测本身失败，脚本同样拒绝执行而不是"当作已经退出"。

---

## 运行中的会话是怎么迁的

难点只有一句话：**会话日志是追加写流，文件在磁盘上搬家时，进程里那个写句柄还指着旧路径。**

插件在 `sessionPersistence.tracker.writers` 里找到这条会话的写句柄（这是 DSH 私有面，全部带 `typeof` 守卫，缺失就明确报错而不是硬来），然后：

1. `sessions.flush(session)`：先把缓冲事件落到**旧**工件里，旧文件是完整记录；
2. 中间**一个 `await` 都没有**：重压第 0 帧 → 移动工件 → 用保留原型的对象改写 `writer.header`。
   Node 单线程事件循环意味着无 `await` 的这段代码**不可能被追加写插入** —— 这比"再上一把锁"更强，
   而且本版本根本没有 `persistence.coordinator` 可锁。
3. 之后再更新内存 registry（`registry.headers` 缓存要先失效再 attach，见 `DESIGN-live-move.md`）。

回滚同样处理：把 writer 和 Session 的 header 指回旧路径，工件搬回去。

### 一个会话目录可能有好几代日志

DSH 升级会话日志格式时会写新一代、把旧一代留作历史，所以一个会话目录里可能同时有
`session.jsonl.zstd`（v0）和 `session.v3.jsonl.zstd`（v3）。搬迁必须**把每一代都搬走**：
只搬 writer 正在写的那一代，旧 key 下就还留着一份，同一个 session id 出现在两个 projectKey，
DSH 会直接拒绝加载（`duplicate JSONL session id ... appears in multiple project directories`）。
所以不停机路径逐个 generation 处理，搬完还会检查旧目录有没有残留，有就报错回滚。

### 为什么 header 要"保留原型"地重建

`session.header` 是宿主 realm 里 `deepFreeze` 过的纯 JSON 记录，而插件代码跑在 Cordis 沙箱 realm。
`Object.assign({}, header, { cwd })` 造出来的对象会带上**沙箱 realm** 的 `Object.prototype`，
而 DSH 自己的校验明确拒绝这种形状：

```js
// dsh-session/lib/types/index.js:68-76
if (prototype !== Object.prototype && prototype !== null)
  throw new Error('session header is not a plain JSON record')
```

所以 `headerWithCwd()` 用 `Object.create(原 header 的原型)` 再拷贝字段，产出的 header 与宿主自己造的**无法区分**。
这是拿真实运行中的会话实测出来的（写被接受、原型保持、`persistence.stat(id)` 仍可读、registry 仍能读到）。

---

## 帧安全（最关键的一点）

`session*.jsonl.zstd` 是**多帧** zstd 串联流。DSH 在启动时断言：

```js
// dsh-session-persistence-jsonl/lib/index.js:2185
if (plaintext.length === 0 || plaintext.indexOf(10) !== plaintext.length - 1)
  throw new Error("corrupt Zstandard session log: first frame is not exactly one header line")
```

即**第 0 帧解压后必须恰好是一行以 `\n` 结尾的 header**。

因此本插件：

- **只重压第 0 帧**，其余帧**逐字节原样拷回**
- 帧切分按 RFC 8878 解析帧头/块头算长度，**不扫魔数**（压缩数据里偶然出现 `28 B5 2F FD` 不会误切）
- 改完立刻用同一套解析重新读回校验（帧数不变、header 一行、cwd 正确）

绝不能做"整文件解压 → 改 → 重压"：那会塌成单帧，`dsh web` 启动直接崩。

---

## 安装 / 卸载

```bash
# 安装（会自动把本包追加进 dsh.profile.bundles）
dsh plugin --profile web add <本目录路径>

# 卸载
dsh plugin --profile web remove dsh-workspace-migrate
```

安装后**必须重启 DSH**：宿主插件树和浏览器模块图都是启动时合成的
（`cordis-plugin-loader` 复用已加载模块的回调，且它的 `import()` 不带破缓存参数，改完的模块只有重启才会生效）。

---

## 测试

```bash
npm test                  # 四个套件
npm run test:mutations    # 变异测试（每个关键机制都必须能被测出来）
npm run test:all          # 两者都跑
```

```bash
node test/selftest.mjs    # 引擎沙箱全流程：计划→执行→回滚，造假 DSH_HOME，帧逐字节校验（101 项）
node test/livetest.mjs    # 不停机迁移编排：假服务按真实行为建模（122 项）
node test/hosttest.mjs    # 挂载宿主半体 + 驱动真实 HTTP 路由（64 项）
node test/clienttest.mjs  # 用最小 React 桩加载并渲染浏览器半体（59 项）
```

四个套件都不需要浏览器，也不碰真实数据（`LIVE` 相关用临时 DSH_HOME）。

**测试里的假服务是按真实宿主行为建模的**，不是"能过就行"：`attachSession` 会真的 realpath 校验、
header 缓存命中优先于磁盘、`delete` 会真的从数组里 splice、live header 带**别的 realm 的原型**。
剩下两个只有真机才暴露的 bug（`sessions.flush(undefined)`、搬完留下空目录）就是这么逼出来的。

配套的变异测试会故意打断每个关键机制，要求对应套件**必须变红**：

| 变异 | 被打断的机制 | 结果 |
|---|---|---|
| `writer-rebind` | 不重定向 live writer | livetest 失败 |
| `route-to-engine` | 把运行中会话丢给子进程引擎 | livetest 失败 |
| `leave-old-dir` | 不清空目录 | livetest 失败 |
| `plain-header-copy` | header 用普通拷贝重建（丢 realm 原型） | livetest 失败 |
| `undo-session-header` | 回滚时不管 Session header | livetest 失败 |
| `undo-writer-header` | 回滚时不管 writer header | livetest 失败 |
| `report-not-written` | 报出报告路径却不写文件 | livetest 失败 |
| `orphan-blocks-migration` | 空的孤儿会话目录被当成会话，挡住无关迁移 | selftest 失败 |
| `picker-not-preselected` | 对话标题栏不再预选当前工作区 | clienttest 失败 |

全部被抓到；不打断时各套件若干项全过。

---

## 目录

```
index.js                       宿主半体：cordis 插件 + 回环防护 HTTP 路由 + workspace_migrate 工具
client.js                      浏览器半体：手写 lazy-CJS，无打包步骤
lib/dsh-workspace-migrate.mjs  迁移引擎（plan/apply/verify/rollback/list），子进程调用
lib/live-move.mjs              不停机编排：预检 / 四层迁移 / 撤销栈 / 运行中会话重定向
lib/zstd-frames.mjs            多帧 zstd 原语（帧切分、只重压第 0 帧、原子写、projectKey）
cordis.patch.yml               把宿主行 insert 进 profile 组合
docs/DESIGN-live-move.md       设计依据 + 在真实宿主上实测到的契约事实
test/                          selftest / livetest / hosttest / clienttest
tools/                         开发与变异测试脚本（不进 npm 包），见 tools/README.md
```

---

## 安全边界与已知取舍

- HTTP 路由**回环防护**：非 127/8 或 `::1` 的 socket、非回环 Host、`sec-fetch-site: cross-site`、
  跨源 Origin 一律 403。另外整站还有浏览器鉴权闸门（未认证一律 401）。
- 所有 `plan` / `verify` / `status` 都是只读的，可以随时调用。
- `apply` 拒绝在 DSH 内执行，并返回停机后该跑的确切命令。
- 依赖的是 DSH 的私有面（`tracker.writers`、`registry.headers` / `sessionPaths`）。全部带守卫：
  拿不到就**拒绝迁移运行中的会话**并说明原因，而不是坏数据；索引类修复拿不到只降级为
  "重启后分组才正确"。
- 搬完之后**旧的空工作区记录会留在侧栏**，需要你自己右键删掉：DSH 没有改工作区 path 的公开 API，
  保留旧记录比伪造一个新 id 更安全。
- 投影缓存（`session_projcache`）在运行中会话上是 fail-soft 的：迁移时可能来不及 checkpoint，
  下一次写入会自愈（实测确认）。
