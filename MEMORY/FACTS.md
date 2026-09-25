# FACTS — 实测契约与不变量

> 本文件只记录**在真实 DSH 上量过**的事实，以及由此推出的不变量。
> 探测方式一律是**只读的动态 Host 插件**：取服务、抽标量、不序列化任何活对象。
> 标 `（源码推断）` 的是读源码得到的结论，尚未升级为实测。

## 0. 环境

| 项 | 值 |
|---|---|
| 已验证 DSH 版本 | `0.1.5-rc.1`（`dsh --version`） |
| Node | v24.14.0（`engines.node >= 20`） |
| plugin 安装方式 | `dsh plugin --profile web <pnpm 参数>` —— 这条命令就是把参数交给 **profile 目录里的 pnpm**；本地路径装成 `link:`，`github:owner/repo` 装成一份拷贝 |
| 插件被加载的位置 | profile 的 `dsh.profile.bundles` 决定宿主侧组合顺序；客户端半体由 `dsh.client.platform` 决定 |

## 1. 宿主服务面（全部实测存在）

`workspaceRegistry` / `sessions` / `agents` / `sessionProjectionCache` / `sessionPersistence` / `dshHomePath` 全部存在。

| 事实 | 实测值 | 对实现的影响 |
|---|---|---|
| `registry.headers` | `Map<SessionId, 裸 header>`，值是 `version,id,createdAt,cwd,isSeeded,delegationDepth,agentPreset` —— **`cwd` 在顶层** | 读 cwd 走"顶层字段"分支 |
| `registry.headers` 的读取时机 | `attachSession` 校验路径时**优先读这个缓存**，只有 miss 才回落磁盘 `listStoredHeaders()` | **必须先失效缓存再 attach**（见 DECISION D4） |
| `registry.sessionPaths` | `Map<SessionId, 规范化 cwd>`，值是**工作区路径**，**不是**日志文件路径 | 曾猜成日志路径并做 projectKey 段替换 —— 语义完全错，见 DEV_LOGS |
| `registry.invalidSessionPaths` | `Map` | 迁移后删条目（可选修复） |
| 实体 `attachSession` / `detachSession` | 可用；`attachSession` 会**真的做 realpath + 路径相等校验** | 必须先改好 header 再 attach |
| `entity.path` / `entity.record.path` | 两者相等 | `entityPath()` 两种形状都读 |
| `dshHomePath` | 是 **function**，不是字符串 | 用 `DSH_HOME` / homedir，不依赖它 |
| `sessionPersistence` | 有 `locate(header) -> {path}`；**没有 `readRaw`，没有 `coordinator`** | 文件层交给引擎；"锁"不存在，只能靠同步段（D2） |
| `persistence.tracker.writers` | `Map<SessionId, handle>` | 找到 live writer 的唯一入口 |
| `handle.header` | **可写的实例数据属性**（TS 里是 `readonly`，运行时 `writable/configurable`） | 运行中会话能迁的**根因**：改它即可重定向后续写入 |
| writer 数 vs live 会话数 | 实测 5 vs 4 —— **存在没有 live Session 的写句柄**（标签页关了但句柄还在） | `flush` 必须兼容"只有 writer 没有 Session" |
| `session.header` | instance 数据属性，`writable/configurable`；值本身 `deepFreeze`，且原型是**宿主 realm** 的 `Object.prototype` | 可以改；但必须保留原型重建（D3） |
| `sessions.flush(session)` | 传真实 Session → 返回 `true`；传 `undefined` → 在 DSH 内部读 `session.id` 抛错 | 只在有 Session 时调用，否则退到 `writer.flush()` |

## 2. 会话工件的布局与不变量

| 事实 | 值 | 影响 |
|---|---|---|
| 工件路径 | `<DSH_HOME>/sessions/<projectKey(cwd)>/<sessionId>/session[.vN].jsonl.zstd` | 引擎按同一套 projectKey 规则推导 |
| **一个会话目录可以有多代日志** | 实测同一目录下同时有 `session.jsonl.zstd`（v0，7.1 MB / 17324 帧）与 `session.v3.jsonl.zstd`（v3，2.2 MB / 208 帧）；`persistence.locate()` 给的是 writer 正在写的那一代 | **搬迁必须逐代搬走**，只搬一代会让同一个 id 留在旧 projectKey，DSH 直接拒绝（DEV_LOGS 2026-09-18） |
| frame 0 不变量 | `dsh-session-persistence-jsonl/lib/index.js:2185`：`plaintext.indexOf(10) === plaintext.length - 1`，即**第 0 帧解压后必须恰好是一行以 `\n` 结尾的 header** | 只重压第 0 帧，其余帧逐字节原样拷回 |
| **帧切分方式** | 生产代码按 **RFC 8878 §3** 解析帧头/块头算长度（`lib/zstd-frames.mjs:14`），**不扫魔数**：zstd 魔数 `28 B5 2F FD` 可能刚好出现在压缩数据里，扫它会把一个帧切成两半 | 这是"帧数不变、后续帧逐字节"能成立的前提；测试里的 `splitFramesByScan()` **故意**用魔数扫描，作为**独立**的第二实现和它交叉校验（两边算出同一组帧才算过） |
| session id 唯一性 | `dsh-session-persistence-jsonl/lib/index.js:2878` `listArtifacts()`：**遍历整个 sessions 根目录**，同 id 出现在两个 projectKey 就 `throw duplicate JSONL session id ...` | 任何"旧目录残留一份"都会在 `attachSession` 缓存 miss 时炸；这是 D8/多代搬迁的直接依据 |
| 文件命名 | v0 是 `session.jsonl.zstd`，vN 是 `session.vN.jsonl.zstd`；文件名版本与 header 里的版本必须一致 | 引擎会核对，不一致拒绝 |

## 3. workspace.json 与启动不变量

| 事实 | 值 | 影响 |
|---|---|---|
| 文件位置 | `<DSH_HOME>/storages/workspace.json`，结构 `{unit, global:{initialized, workspaceIds, archivedSessionIds}, tables:{workspaces:{id:{path,title,sessionIds,createdAt,updatedAt}}}}` | 补丁就是改 `tables.workspaces.<id>.path` |
| **启动不变量** | `dsh-workspace/lib/index.js:684` `validateStoredState`：**同一个 path 不能被两条记录声明**，否则 `dsh web` 起不来：`workspace domain is inconsistent: path '…' is claimed by both workspace 'A' and workspace 'B'` | 计划/verify 都要查（D8） |
| `registry.create(path, title)` | 会对路径做 `realpathNormalize` + `stat().isDirectory()`；**同一路径重复调用返回已存在的实体**（幂等），不改标题 | 不停机路径不会制造重复声明，但会**静默挑一条**、留下另一条 —— 所以要预检拒绝 |
| 没有改路径的 API | 公开方法只有 `create / get / list / delete / insertBefore / archiveSession / resolveByPath` | 所以"旧记录变空留在侧栏"是设计取舍（D13） |
| 谁拥有这个文件 | registry 的内存投影，**每次变更都会回写** | 运行中的 DSH 会盖掉外部编辑 —— 修数据必须走 registry，不能直接改文件（DEV_LOGS 2026-09-19） |
| 读它来判断"工作区现在在哪" | **不可靠**：文件只在 registry checkpoint 时才更新，别的插件在内存里改了 path，侧栏立刻变、文件还是旧的 | 面板必须**先问活 registry**（`ctx.workspaceRegistry.list()`），文件只作兜底（D16；hosttest [11] 有断言） |

## 4. 投影缓存

| 事实 | 值 |
|---|---|
| 实际读取的布局 | `<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json`（per-record，`version: 7`） |
| `identityMatches` | 记录里的 `identity.cwd` 与调用方持有的 header 对不上时，该记录被当作**不存在**（缓存 miss → 重建） |
| 结论 | 迁移时不做 checkpoint 是安全的：下一次写入会自愈。旧版单文件表 `session_projcache.json` 里的死条目会被忽略 |
| 公开方法 | `cachedSnapshot / cachedPredecessorTitle / hydratePrepared / write / coldSnapshot` 都在，但公开契约要求传入整个事件日志，故**不调用** |

## 5. 宿主/客户端更新语义

| 事实 | 值 |
|---|---|
| `index.js`（宿主半体）改动 | **必须重启 DSH**：`cordis-plugin-loader` 复用已加载模块的回调，且它的 `import()` 不带破缓存参数 |
| `client.js`（客户端半体）改动 | 刷新页面即可能生效 → 于是会出现"新 UI + 旧宿主"的错配；插件对这种情况有明确提示（`/open-directory` 返回非 JSON 时） |
| `lib/dsh-workspace-migrate.mjs`（引擎） | 每次调用起**子进程** → 改动立即生效，不需要重启 |
| `lib/live-move.mjs` | 被 `index.js` import 进宿主进程 → 需要重启；开发期可用 `DEV_RELOAD` 标记文件免重启（D12） |

## 6. 路径与文件名语法

- `projectKey(cwd)`：`/`、`\`、`:` 折叠成 `-`（连续分隔符合并成一个），`~XXXX` 转义，去掉开头的 `-`，截断到 251，两端包 `--`。例：`E:\SpaceDev\Projects\Work\main` → `--E-SpaceDev-Projects-Work-main--`。
- 会话目录名就是 session id；`<DSH_HOME>/migration-runs/` 放暂存计划与 live 报告；`<DSH_HOME>/migration-backups/<时间戳>/` 放备份。

## 7. 平台事实（踩过坑的）

| 事实 | 值 |
|---|---|
| `robocopy /E /MOVE` | 搬完**会把源根目录留成空壳**；成功退出码是 0–7，≥8 才是失败 |
| `explorer.exe <目录>` | 在 Explorer 已经打开该目录时**静默什么都不做**，且成功时也可能返回非零退出码 → 改用 `cmd /c start "" <目录>` |
| `~` 在 cmd.exe | **不展开**。`dsh plugin --profile web add ~/x` 会被 pnpm 当成 GitHub 的 `owner/repo`，报 `is not a valid repository name`（2026-09-19 实测） |
| 删 junction | 用 `cmd /c rmdir <链接>`；`Remove-Item -Recurse` 可能连链接指向的真实目录内容一起删 |
| `Get-CimInstance` 探测 DSH 进程 | 偶发失败（超时/无输出）。失败时**不能**当作"没有 DSH 在跑"（D9 就是为此） |
| 进程探测的**漏报** | 真机遇到过：DSH 明明在运行，从 `1-apply-migration.cmd` 里跑探测却返回"没找到" → 于是加了第二个信号：计划里记下 DSH 当时服务的 `host:port`，用 TCP 连接判断它是否还在（D9） |
| `fs.mkdirSync(p, { recursive: true })` | `keep`（仅修改目录）下创建目标目录用它：父目录一并建；盘符不存在时抛 `ENOENT`（所以在 `Check` 阶段先用 `path.parse(to).root` 判断，见 D20） |

## 8. 插槽与注册（客户端半体）

| 事实 | 值 | 影响 |
|---|---|---|
| 本插件用到的四个座位 | `sidebar.footer.action`、`conversation.session.header.actions`、`settings.section`、`shell.overlay` | 都是**加法式**（`replaceRisk: none`）：多个插件可共存，不遮蔽原生 UI |
| `conversation.session.header.actions` 的作用域 | `session` 作用域，标准 props 里带 `sessionId` | 对话标题栏那个入口能预选当前对话的工作区（D10） |
| **`sidebar.workspaces`** | 是 **`single`** 且 `shadows-shipped-ui` —— 注册它等于**替换整个原生会话列表** | **永不注册它**（D15）：一个搬家工具没理由接管会话列表，而且会和其它占了同一插槽的插件互相覆盖 |
| 注册被拒时的行为 | 单条注册失败会被 catch 并打日志（`could not register <path> / <slot>: …`），**其余注册继续挂载** | 启动日志里出现一条 `could not register` 不等于插件没装上 |

守这些事实的断言在 `test/clienttest.mjs`：四个座位都注册、每个注册都被 fiber effect 拥有、
`sidebar.workspaces is never registered (that single slot would shadow the shipped sidebar)`、
以及"设置页实例不做会话预选"。
