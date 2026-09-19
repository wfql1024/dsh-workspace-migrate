# 设计：不停机完整自动化迁移

> 状态：**已完成，并在真实宿主上端到端跑通**（346 项断言 + 一次含"运行中会话"的真机迁移）。
> 本文既是实施依据，也是**实测契约记录** —— 下面标注"实测"的结论都是在**运行中的真实 DSH** 上量出来的，
> 不是读源码推断的。最后更新时间见文件修改时间。

---

## 一、目标

一条龙完成，**全程不关闭 DSH**：

1. 搬项目目录（`D:\...` → `E:\...`）
2. 在新路径创建 / 复用并注册工作区
3. 把旧工作区的会话迁到新工作区（改 header cwd + 移动会话工件 + 同步内存态）
4. **正在对话的会话也要能迁** —— 否则对话标题栏上那个「迁移工作区」按钮就没有存在意义

这正是用户手工做法（自己搬目录 → 新建工作区 → 用 dsh-session-manager 迁会话）的自动化。

---

## 二、端到端实测

### 2.1 冷会话夹具（第一轮）

夹具：注册一个临时工作区，并用 `sessionPersistence.create` 创建一条**没有 attach 到工作区**的会话，
同时验证"并集发现"（工作区索引里没有，也能找到并迁走）。

```
live move complete: 1 session(s) re-homed
workspace: registered new
project directory: moved
note: 1 session(s) with this cwd are stored but not indexed on the workspace; they are included
```

| 核对项 | 结果 |
|---|---|
| 项目目录 | 旧路径消失、新路径有 marker |
| 会话目录 | 旧 projectKey 消失、新 projectKey 存在 |
| 日志 header | `cwd` 已是新路径，frame 0 仍是**恰好一行** |
| 新工作区 | 已注册且 `sessionIds` 含该会话 |
| persistence | 该会话 cwd 已是新路径 |
| 并集发现 | 工作区索引为空仍然找到了会话 |

### 2.2 运行中会话夹具（第二轮，**最关键的一次**）

夹具这次造的是**最难的那种会话**：`sessions.create(id, { meta: { cwd } })` 造出**真正在 store 里的
live Session**，再 `persistence.create(...)` 造出**保持打开的写句柄** —— 也就是"你正在打字的那条对话"
的形状（有 Session 对象、有 agent 之外的写句柄），全程不跑模型、不产生任何真实对话内容。

一次 `workspace_migrate live {from, to, moveProject: true}` 的结果：

```
live move complete: 1 session(s) re-homed
workspace: registered new
project directory: moved
note: 1 session(s) are running and will be relocated in process, without interrupting them
note: every session is running, so the spawned engine was not used at all
```

| 核对项 | 实测值 |
|---|---|
| live Session 的 `header.cwd` | 新路径，且**原型仍是宿主 realm 的 `Object.prototype`**（没被沙箱 realm 污染） |
| live writer 的 `header.cwd` | 新路径，`writerIsTheHandle: true`（`tracker.writers` 里就是那个句柄本身） |
| 项目目录 | 旧路径消失，`marker.txt` / `src\nested.txt` 都在新路径 |
| 会话目录 | 旧 projectKey 目录消失，新 projectKey 下有工件 |
| frame 0 | `indexOf(10) === length - 1` 成立（宿主自己的断言，逐字节核对） |
| 投影缓存 | 迁移瞬间来不及 checkpoint，**在下一次写入时自愈**（实测：dispose 后新的 projcache 里 cwd 已是新路径） |
| 旧工作区记录 | 保留、`sessionIds` 变空（见"已知取舍"） |
| 清理 | 夹具工作区、写句柄、会话工件、projcache 全部移除；`tracker.writers` 回到 4 = live 会话数 |

---

## 三、实测契约（用只读探测插件在运行中的真实 DSH 上确认）

| 事实 | 实测值 | 对实现的影响 |
|---|---|---|
| `workspaceRegistry` / `sessions` / `agents` / `sessionProjectionCache` / `sessionPersistence` / `dshHomePath` | **全部存在** | 设计假设成立 |
| `registry.headers` | `Map`，值是**裸 header**（`version,id,createdAt,cwd,isSeeded,delegationDepth,agentPreset`），`cwd` 在**顶层** | 走"顶层 `cwd`"分支；**且 attach 时缓存优先于磁盘** |
| `registry.sessionPaths` | `Map`，值是被**规范化过的 cwd**（如 `"E:\\<某项目根>"`），**不是日志文件路径** | **曾猜错**，见 4.1 |
| `registry.invalidSessionPaths` | `Map` | 删条目（可选修复） |
| 实体 `attachSession` / `detachSession` | 全部可用，`attachSession` 会**真的 realpath + 路径相等校验** | 必须先改好 header 再 attach |
| `entity.path === entity.record.path` | 成立 | `entityPath` 两种形状都能读 |
| `sessionPersistence` | 有 `locate`；**没有 `readRaw`，没有 `coordinator`** | 文件层交给引擎；锁只能靠"无 `await` 的同步段" |
| `persistence.tracker.writers` | `Map<SessionId, handle>`，**handle.header 是可写数据属性**（TS 里是 readonly，运行时 writable/data/configurable） | 运行中会话可迁的**根因** |
| writer 数 vs live 会话数 | 5 vs 4 —— **存在没有 live Session 的写句柄**（标签页关了但句柄还在） | `flush` 必须兼容"只有 writer 没有 Session" |
| `session.header` | **instance 数据属性、writable、configurable**；值本身 `deepFreeze` 且原型是**宿主 realm**的 `Object.prototype` | 可以改；但必须**保留原型**地重建（见 4.2） |
| `sessions.flush(session)` | 传真实 Session → 返回 `true`；传 `undefined` → 在 DSH 内部读 `session.id` 抛错 | `flush` 只在有 Session 时调用，否则退到 `writer.flush()` |
| **一个会话目录可以有多个 generation 日志** | 实测 `session-43de0fbd-…/` 下同时有 `session.jsonl.zstd`(v0, 7.1 MB, 17324 帧) 和 `session.v3.jsonl.zstd`(v3, 2.2 MB, 208 帧)；`locate()` 给的是 writer 正在写的那一代 | **搬迁必须把整个目录的所有 generation 一起搬**，只搬一代会让会话 id 同时出现在两个 projectKey，DSH 直接拒绝（见 3.3） |
| `listArtifacts()` 的重扫描 | `dsh-session-persistence-jsonl/lib/index.js:2878`：**遍历整个 sessions 根目录**，同 id 出现在两个 projectKey 就 `throw duplicate JSONL session id` | `attachSession` 缓存 miss 时走它；所以"旧目录残留一代"必然在内存层炸 |
| `sessionProjectionCache` 实际布局 | 读的是 `<root>/session_projcache/sessions/<id>.json`（per-record）；`identityMatches` 对不上就把记录当**不存在**（缓存 miss → 重建） | 迁移时不做 checkpoint 是安全的；实测迁移后每条会话的文档已自愈成新 cwd，旧版单文件表 `session_projcache.json` 里的死条目被忽略 |
| `sessionProjectionCache` 方法 | `cachedSnapshot / cachedPredecessorTitle / hydratePrepared / write / coldSnapshot` 全在 | 公开契约要整个事件日志，故**不调用**；依赖其 fail-soft 自愈 |
| `dshHomePath` | 是 **function** 不是字符串 | 用 env / homedir，不受影响 |

### 3.1 探测抓出的真 bug

`sessionPaths` 的值被当成日志路径，修复时做 projectKey 段替换 —— 语义完全错了。
好在守卫 `current.includes(oldKey)` 不成立，代码**静默跳过**（没有写坏数据），但**修复等于没生效**。
已改为：直接把值设为**目标工作区的规范化路径**（优先取 registry 自己记录的 canonical 值）。

### 3.2 只有真机才暴露的两个 bug

1. `sessions.flush(undefined)`：只有 writer 没有 Session 的会话让 DSH 内部抛错。
   现在：有 Session 才 `sessions.flush(session)`，否则 `writer.flush()`。
2. 搬完在旧 projectKey 下留一个**空会话目录**，侧栏会读成一个不认识的会话条目。
   现在：`removeIfEmpty` 清掉会话目录，再清掉空的 projectKey 目录（best-effort）。

离线假服务当时**太宽松**（`attachSession` 来者不拒、`delete` 是空操作），所以两个 bug 全漏了。
现在假服务按真实行为建模（realpath 校验、缓存优先于磁盘、真的 splice），并配变异测试兜底。

### 3.3 多 generation：只有"运行中的会话"会踩的坑（真机上第二次翻车）

现象：把一条**正在对话**的会话迁到新工作区，项目目录已搬完、文件层也没报错，停在内存层：

```
迁移失败（阶段：memory-layer）
阻止: the workspace registry refused the re-point: duplicate JSONL session id
      "session-c13da96f-…" appears in multiple project directories
文件已还原: 是
```

根因：那个会话目录里有**两代**日志（`session.jsonl.zstd` v0 + `session.v3.jsonl.zstd` v3，DSH 升级格式时保留旧一代作为历史）。
不停机路径按 `persistence.locate()` 只搬了 **writer 正在写的那一代**，旧一代留在旧 projectKey 下；
到内存层时 `attachSession` 缓存 miss → `listArtifacts()` **重扫整个 sessions 根目录** → 同 id 出现在两个 projectKey → 拒绝。
冷会话路径没有这个问题，因为引擎是 `moveDirectory(session.dir, target)` 整目录搬、并遍历每一代改 header ——
这也解释了为什么只有"运行中的对话"失败。

修复：不停机路径枚举源目录里**所有** generation，逐个搬（每个只重压第 0 帧），全在同一段无 `await` 里完成；
搬完检查旧目录是否残留 generation，残留就当场抛错回滚；回滚同样逐代搬回。

真机验证（用户实测，迁移 `Mine\JhiFengMultiChat → My\JhiFengMultiChat`，2 条会话、1 条运行中）：
4 个日志文件 frame 0 都是"恰好一行"且 cwd 已是新路径（其中 17324 帧的大日志只重压了第 0 帧）、
旧 projectKey 目录消失、全库无重复 id、项目目录已随迁、
**运行中会话的 v3 日志在迁移后 3 分 43 秒仍有写入**（13:43:12 迁移 → 13:46:55 追加）——
writer 确实被重定向到了新文件。

### 3.4 同一路径被两条工作区记录声明：让 DSH 起不来（真机上第三次翻车）

现象：用户跑完一次**手动迁移**（`Mine\JhiFengMultiChat → My\JhiFengMultiChat`），之后 `dsh web` 直接启动失败：

```
workspace domain is inconsistent: path 'E:\SpaceDev\Projects\My\JhiFengMultiChat' is claimed by
both workspace '03d2457c-…' and workspace '224b28fb-…'
```

真实时间线（用 `migration-runs/live-*.json`、`migration-backups/*`、`report.json` 和文件时间戳复原）：

1. 11:16 一次**不停机**迁移把 `My → Mine`：新建记录 `224b28fb`（Mine，挂着 2 条会话），
   源记录 `03d2457c` 被留下、变成 My 上的空记录（这是文档里写明的"旧记录自己删"行为）。
2. 11:20 用户又生成一次**手动**计划，方向是 `Mine → My`。计划里的 `workspace.json` 补丁
   把 `224b28fb` 的 path 从 Mine 改写成 My —— 但 My 已经被 `03d2457c` 声明着。
3. 11:21 用户没退 DSH 就跑了 `1-apply-migration.cmd`：补丁生效 → **两条记录声明同一个 My** → DSH 起不来。
4. 之后还活着的那个 DSH 进程把它内存里的状态回写（path 又变回 Mine），于是"重复声明"消失了，
   但注册表变成**路径与会话错位**：`224b28fb` 指向 Mine（空目录）却挂着 cwd 已经是 My 的两条会话。

修复分三处：

- **计划阶段**（`buildPlan`）：目标路径已被声明时 —— 占用者是**空**记录（就是上一次搬迁留下的壳）→
  连补丁一起计划删除它（`metadata.removals`，apply 时删记录并同步 `global.workspaceIds`）；
  占用者**还有会话** → 直接报错拒绝，让用户自己决定怎么合。源路径若已被两条记录声明，同样拒绝。
- **不停机路径**（`inspectLiveMove`）：`registry.create()` 对同一路径是幂等的，所以它不会制造重复声明，
  但会**静默挑一条**、留下另一条 —— 因此源/目标任一被多条记录声明就直接拒绝，并在提示里点名记录 id。
- **verify**：把"一条路径只能被一条记录声明"作为 DSH 的启动不变量加入校验，
  并核对计划里的每个 removal 是否真的生效。这个不变量以前完全没查，正是这次翻车的直接原因。

数据修复没有直接编辑 `workspace.json`：那个文件是 registry 的内存投影，运行中的 DSH 会把它盖回去
（上面第 4 步就是证据）。改用一个临时动态 Host 插件，通过 `detachSession`/`attachSession`/`delete`
把会话并到 `03d2457c`、删掉 `224b28fb`，让 **DSH 自己**写出正确文件；随后确认
`workspace.json` 只剩一条 My 记录、挂着 2 条会话，并且没有任何路径被声明两次。

### 3.5 停机脚本必须自己检查 DSH 是否退出

`preflightForApply` 一直有"检测到 DSH 就拒绝"的逻辑，但它是 **fail-open** 的：
`detectDshProcesses()` 返回 `checked:false`（WMI/PowerShell 探测失败）时 `matches` 为空，
于是照常执行——上面那 11:21 的手动 apply 就是这么过去的：备份建了、补丁打了，
用户以为"脚本自己会拦"。现在：

- 探测失败重试一次；仍失败 → **拒绝执行**（"无法确认 DSH 已退出"），要求显式 `--allow-running`。
- 生成的 `1-apply-migration.cmd` / `3-rollback.cmd` 里加了一个前置步骤
  `dsh-workspace-migrate.mjs check-quiescent`：有 DSH 就打印命中的进程并 `exit /b 1`，
  在动手之前就把人挡下来（`2-verify.cmd` 只读，不加）。

---

## 四、关键设计决定

### 4.1 文件层继续交给已验证的引擎

第 0 帧不变量是本项目最危险的一段代码，已有 101 项断言覆盖。插件不再写第二份实现：
冷会话走 `engine relocate-sessions`（只做文件层，**不写 workspace.json**，避免和 registry 双写），
运行中会话走进程内 `relocateSessionLog`（同一份 `lib/zstd-frames.mjs` 原语）。

### 4.2 运行中会话：靠"无 `await` 的同步段"，不靠锁

```
relocateLiveSession:
  1. await sessions.flush(session)          ← 让旧工件成为完整记录
  2. ── 从这里到 writer.header 改写完，中间没有任何 await ──
       relocateSessionLog(fromFile, toFile, newCwd)      只重压第 0 帧
       writer.header = headerWithCwd(writer.header, newCwd)
  3. removeIfEmpty(旧会话目录 / 旧 projectKey 目录)
  4. session.header = headerWithCwd(session.header, newCwd)   （try/catch，失败只降级）
  5. registry 更新交给调用方（第 4 层）
```

Node 单线程事件循环 + 全程无 `await` ⇒ 已经排队的追加写**不可能**插进这段代码中间，
它醒来时读到的已经是新 header，会落到新文件。这比 per-id 锁更强，而且本版本根本没有 coordinator 可锁。

**`headerWithCwd(header, cwd)`**：`Object.create(原原型)` + 拷贝字段 + `freeze`。
不能用 `Object.assign({}, header, { cwd })` —— 插件跑在 Cordis 沙箱 realm，普通拷贝会带上**沙箱 realm** 的
`Object.prototype`，而 DSH 的 `validateRestoredSessionHeader` 明确拒绝这种形状：

```js
// dsh-session/lib/types/index.js:68-76
if (prototype !== Object.prototype && prototype !== null)
  throw new Error('session header is not a plain JSON record')
```

实测（在正在对话的那条会话上写同值 header）：普通拷贝 `prototypeSameAsOriginal === false`，
保留原型法 `true`，写被接受、`persistence.stat(id)` 仍可读、registry 仍读得到，最后能原样还原。

### 4.3 四层迁移 + 撤销栈

```
1. 项目目录（可选，robocopy /E /MOVE）
2. 目标工作区注册（create 或复用）
3. 会话工件（冷 → 引擎；热 → 进程内）
4. 内存 registry：先让 header 缓存失效，再 detach/attach
```

任何一步失败都从新到旧回滚。第 4 层的顺序是踩出来的：**先让目标 attach 反向撤销、再回滚文件/项目、
最后 attach 回源**；反过来会把会话从源工作区弄丢。

`livetest.mjs` [10] 让最内层（内存层）失败，断言项目目录被搬回、工件字节级还原、新建注册被撤销、
`undoErrors` 为空；[14] 专测**运行中会话**的撤销（writer 和 Session 的 header 都指回旧路径）。

### 4.4 attachSession 的坑：缓存优先

`attachSession` 校验路径时 `this.host.readSessionHeader(id)` **优先读 `registry.headers` 缓存**，
只有缓存 miss 才回落到磁盘 `listStoredHeaders()`。所以"先 attach 再把缓存改成新路径"必然失败
（缓存里还是旧 cwd）。正确顺序：**先让缓存条目失效（删掉），再 attach** ——
`attachSession` 自己会维护 `sessionPaths`。

这个 bug 离线测试完全测不出来，因为假服务的 `attachSession` 当时不做校验。

### 4.5 关于私有索引的最终决定

**绝不新建条目，也不重建结构**，只对**已存在**的条目做"保留原形状、只改路径身份"的原地更新。
条目不存在就跳过并记入 `indexSkipped`，降级为"重启后分组才正确"而不是抛错。
`registry.headers` 那条是唯一 load-bearing 的修复（失效即可，不需要写值）。

### 4.6 报告一定要落盘

`live` 模式无论成功还是失败都会写 `<DSH_HOME>/migration-runs/live-<时间戳>.json`。
写失败不升级为迁移失败（best-effort），但那时**不再回传报告路径** —— 报出来的路径一定真的有文件。

### 4.7 开发期热加载（仅运行中调试用）

`index.js` 里有个 `DEV_RELOAD` 开关：只要包目录下存在 `<package>/DEV_RELOAD` 文件，
`lib/live-move.mjs` 就会带破缓存参数重新 import，改完立刻生效、不用重启。

**它不是产品行为，发布包里不存在该文件，默认关闭。** 原因：`cordis-plugin-loader` 会复用已加载模块的回调，
且它的 `import()` 不带破缓存参数，所以 `index.js` / `client.js` 的改动**永远**需要重启 DSH；
只有这个显式开关能让 `lib/live-move.mjs` 在开发时免重启。用完要删掉标记文件。

### 4.8 界面：一个动作按钮 + 可折叠的结果行

- **只留一个「开始迁移」**。只读检查不再是独立按钮：它先跑、通过才继续动手，不通过就零写入并在
  `Check` 行给出原因。"不停机"不进按钮文案 —— 它是标准做法，不是高级选项。
- **勾选「手动迁移」**（原「停机计划」模式开关）后，同一个按钮变成「生成计划」，只生成脚本。
- 结果按阶段各占**一行摘要**（`Check` / `Migrate` / `Plan` / `Verify` / `暂存的手动迁移`），
  带颜色状态标签；细节放在 `hidden` 的正文里，点开才看。**失败默认展开**，成功/计划默认折叠。
  默认值写成渲染期判断（`rowOpen(key, defaultOpen)`），用户的显式点击优先 —— 这样"默认折叠"这条规则
  可以被测试直接断言，而不是埋在某个点击处理函数里。
- 行头是 `div[role=button]` 而不是 `<button>`：行里还要放「打开目录」按钮，按钮套按钮是非法 HTML。
- **启动文件管理器在页面里没有可见变化**，所以请求的成败必须显示在**刚刚点击的那一行**上（`banner`，
  折叠状态下也可见）：成功写「已请求系统打开（若窗口没弹出，请看运行 DSH 的终端）：<路径>」，失败写清原因。
  宿主侧同时 `console.log` 一行 —— 否则"按钮坏了"和"窗口没弹出来"从用户视角完全一样，没法排查。
- 「打开目录」走宿主新增的 `/open-directory` 路由，**只允许打开 `<DSH_HOME>/migration-runs` 下的目录**
  （浏览器不能让宿主去开用户机器上任意路径）。Windows 上用 `cmd /c start "" <目录>` 交给 shell，
  不用 `explorer.exe <目录>`：后者在 Explorer 已经打开那个目录时会**静默什么都不做**。
  只等 `spawn`/`error` 事件、不看退出码。测试通过 `DSH_WORKSPACE_MIGRATE_DRY_OPEN=1` 让这一步只报告不启动。
- **暂存的手动迁移**里每条只留 `源 -> 目标` 加一个「打开目录」：脚本固定是 `1-apply-migration.cmd`，
  路径是冗余；`2-verify.cmd` 要在退出 DSH 之后跑，放在面板里点不到。用法写在行头的「i」按钮后面
  （`hint`，紧贴摘要行、与折叠无关）。计划区域把回滚单独列为「若遇到错误，可以回滚」，不再和 1/2 并排。

---

## 五、界面安全约束

- 执行按钮**只在预检通过后才出现** —— 默认渲染里没有「执行不停机迁移」，客户端测试对此有断言。
- 输入框任何改动都会作废上一次预检结论，避免对着陈旧结论点执行。
- 对话标题栏按钮会把**当前对话所在工作区**预选进来源下拉框（用规范化比较选中，而不是显示占位符）。

---

## 六、测试

| 层 | 状态 | 覆盖 |
|---|---|---|
| 引擎 `plan/apply/verify/rollback/relocate-sessions` | ✅ | `selftest.mjs`（101） |
| `lib/live-move.mjs` 编排（预检 / 四层 / 撤销栈 / 运行中会话） | ✅ | `livetest.mjs`（122） |
| 宿主路由 + 工具 action | ✅ | `hosttest.mjs`（64） |
| 浏览器半体（双模式渲染 / 预选 / 回环防护提示） | ✅ | `clienttest.mjs`（59） |
| 真机端到端（冷会话） | ✅ | 见 2.1 |
| 真机端到端（**运行中会话 + 当前对话形状**） | ✅ | 见 2.2 |

变异测试（`livetest`）：`writer-rebind` / `route-to-engine` / `leave-old-dir` / `plain-header-copy` /
`undo-session-header` / `undo-writer-header` / `report-not-written` —— 7/7 都能让测试变红；
不打断时 122/122 全过。

---

## 七、风险与对策

| 风险 | 对策 |
|---|---|
| 私有索引名变了（`registry.headers` 等） | 全部 `?.` / `typeof` 守卫；缺失就跳过，只降级为"重启后分组才正确" |
| 拿不到可重定向的 live writer | **明确拒绝**迁移运行中的会话并说明原因，不硬来 |
| `attachSession` 的 path 校验不过 | 先改 header 再 attach；先失效 header 缓存；attach 失败则回滚文件层 |
| 搬目录时文件被占用 | robocopy 失败即中止并回滚；不删源目录 |
| header 形状被宿主拒绝 | `headerWithCwd` 保留原原型（见 4.2），并在真机上验证过 |
| 出错留下半成品 | 文件层有备份+自动回滚；内存层有反向 attach/detach 与 header 还原；报告落盘 |
| `workspace.json` 双写 | 引擎带 `--skip-workspace-json`，只让 registry 写 |
| 运行中会话的投影缓存来不及 checkpoint | 交给它自己的 fail-soft 自愈（实测确认），不硬写 |
| **同一路径被两条工作区记录声明** | 计划阶段就查：目标已被**空**记录占用 → 连补丁一起删掉那条；目标被**有会话**的记录占用 → 直接拒绝（合并两个工作区不是工具该替用户决定的事）。不停机路径同样预检（`create()` 对同一路径幂等，会静默挑一条留下另一条）。verify 也把"一条路径只能被一条记录声明"当作 DSH 的启动不变量来查 |
| 停机脚本在 DSH 还开着的时候被执行 | `1-apply-migration.cmd` / `3-rollback.cmd` 先跑 `check-quiescent` 子命令，有 DSH 就打印原因并 `exit /b 1`；这个探测本身失败（`checked:false`）也算**不安全**，不再放行 |

---

## 八、已知取舍

- **旧工作区记录会留下**（`sessionIds` 为空）：DSH 没有改工作区 path 的公开 API，
  `create/rename/delete/insertBefore` 里没有"改路径"这一项。保留旧记录让用户自己删，比伪造 id 安全。
  这也是 `plan`（停机模式）仍然存在的原因 —— 停机模式才能真正"原地换路径"。
- 运行中会话的迁移**必须在插件进程内**完成，不能交给子进程引擎：引擎动文件的同时宿主还在追加写，
  一定会撕裂。
- 依赖 DSH 私有面（`tracker.writers`、`registry.headers` / `sessionPaths` / `invalidSessionPaths`）。
  这是本插件与 DSH 版本耦合的唯一位置，全部集中在 `lib/live-move.mjs` 的守卫里。
