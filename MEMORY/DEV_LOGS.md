# DEV_LOGS — 开发流水账

> 按时间顺序。每条写清 **现象 / 根因 / 修复 / 验证** —— 只写"改了什么"的日志等于没有日志。
> 三次真机翻车（多 generation、路径重复声明、停机脚本 fail-open）都有完整记录，别删。

## 2026-09-17 上午 — 起点：停机方案

- **背景**：交接文档的结论是"DSH 运行中不能迁移"，因为工作区注册表把 path 存在内存里并会回写。
- **做法**：把危险文件操作做成独立引擎 `lib/dsh-workspace-migrate.mjs`：`plan` 生成自包含运行目录
  （`1-apply-migration.cmd` / `2-verify.cmd` / `3-rollback.cmd` + plan.json + 引擎副本），
  退出 DSH 后执行；`apply` 全程有备份，失败自动回滚并校验回滚结果。
- **验证**：`selftest.mjs` 在合成 DSH_HOME 上跑 计划→执行→回滚，帧逐字节校验。

## 2026-09-17 晚 — 真机只读探测，抓出三个真 bug

- **手段**：临时动态 Host 插件（只读）：取服务、抽标量，不序列化活对象。
- **抓到 1**：`registry.sessionPaths` 的值是**规范化 cwd**（工作区路径），我把它当成了日志文件路径，
  修复时做 projectKey 段替换 —— 语义完全错。守卫条件不成立所以**静默跳过**（没写坏数据），
  但"修复"等于没生效。→ 改为直接写目标工作区的规范化路径。
- **抓到 2**：`attachSession` 校验路径时**优先读 `registry.headers` 缓存**。所以"先 attach 再改缓存"必然失败。
  → **先失效缓存条目，再 attach**（DECISION D4）。
- **抓到 3**：`sessions.flush(undefined)` 会在 DSH 内部读 `session.id` 抛错 —— 因为存在
  "只有 writer、没有 live Session"的会话（`tracker.writers` 5 条 vs live 会话 4 条）。
  → 有 Session 才 `sessions.flush(session)`，否则 `writer.flush()`。
- **教训**：那时的离线假服务**太宽松**（`attachSession` 来者不拒、`delete` 是空操作），所以三个问题全漏了。
  现在假服务按真实行为建模 + 变异测试兜底（DECISION D14）。

## 2026-09-17 深夜 — 用户纠正：必须支持"正在对话的那条会话"

- **反馈**：第一版把"运行中的会话"当前置检查硬拒 —— 那对话标题栏上那个「迁移工作区」按钮就没有意义了。
- **做法**：参考 `dsh-session-manager` 的私有面用法，在 `persistence.tracker.writers` 里找到写句柄，
  改写 `handle.header` 重定向后续写入；文件搬迁与 header 改写放在**同一段无 `await` 的同步代码**里（DECISION D2）。
- **验证（真机 E2E 第一轮，冷会话夹具）**：注册临时工作区 + `sessionPersistence.create` 造一条**未 attach** 的会话
  （同时验证"并集发现"）。结果：旧 projectKey 消失、新 projectKey 有工件、header cwd 已是新路径、
  frame 0 仍恰好一行、新工作区 `sessionIds` 含该会话。
- **验证（真机 E2E 第二轮，最关键的形状）**：`sessions.create(meta.cwd)` 造**真在 store 里的 live Session**，
  再用 `persistence.create` 造**保持打开的写句柄** —— "你正在打字的那条对话"的形状。结果：
  live Session 与 writer 的 `header.cwd` 都变成新路径、`writerIsTheHandle: true`、
  旧 projectKey 目录消失、frame 0 满足宿主断言。
- **清理**：夹具工作区/写句柄/工件/projcache 全部移除，`tracker.writers` 回到 4 = live 会话数。
  （当时发现上一轮夹具留了一个孤儿 writer，后来用一个显式工具删掉了。）

## 2026-09-18 凌晨 — realm 原型与"报路径但不写文件"

- **发现**：`session.header` 是宿主 realm 里 `deepFreeze` 的纯 JSON，而插件在 Cordis 沙箱 realm。
  `Object.assign({}, header, {cwd})` 造出来的对象会带**沙箱 realm** 的 `Object.prototype`，
  而 DSH 的 `validateRestoredSessionHeader` 明确拒绝这种形状。
  → `headerWithCwd()`：`Object.create(原原型)` + 拷贝字段 + freeze（DECISION D3）。真机写同值 header 验证过。
- **修掉**：`live` 模式**报出报告路径却没写文件**。→ 成功/失败都落盘；写不成功就不再回传路径（DECISION D7）。

## 2026-09-18 — 第一次真机翻车：多 generation 日志

- **现象**：用户迁移**正在对话**的会话，项目目录已搬完、文件层没报错，停在内存层：
  `duplicate JSONL session id "session-c13da96f-…" appears in multiple project directories`，文件已还原。
- **根因**：那个会话目录里有**两代**日志（`session.jsonl.zstd` v0 + `session.v3.jsonl.zstd` v3）。
  不停机路径按 `persistence.locate()` 只搬了 **writer 正在写的那一代**，旧一代留在旧 projectKey；
  到内存层 `attachSession` 缓存 miss → `listArtifacts()` **重扫整个 sessions 根目录** → 同 id 出现在两个 projectKey → 拒绝。
  冷会话路径没这个问题，因为引擎是 `moveDirectory(session.dir, target)` 整目录搬、并逐代改 header ——
  所以**只有"运行中的对话"会踩**。
- **修复**：不停机路径枚举源目录里**所有** generation 逐个搬（每个只重压第 0 帧），全在同一段无 `await` 里完成；
  搬完检查旧目录是否残留 generation，残留就当场抛错回滚；回滚逐代搬回。
- **验证**：`livetest` [17]（双 generation 的 live 会话）+ [14]（双 generation 的回滚）+ 变异 `companions-left-behind`；
  用户真机复测通过。

## 2026-09-18 下午 — 用户真机成功 + "参考项目更简单？"

- **用户实测**：`Mine\JhiFengMultiChat → My\JhiFengMultiChat`，2 条会话、1 条运行中，成功；
  4 个日志文件 frame 0 都是"恰好一行"且 cwd 已是新路径（17324 帧的大日志只重压了第 0 帧）。
  **运行中会话的 v3 日志在迁移后 3 分 43 秒仍有写入**（13:43:12 迁移 → 13:46:55 追加）——
  writer 确实被重定向到了新文件。
- **用户的疑问**：参考项目 `dsh-session-manager` 看起来很简单。
- **核对结论（写下来避免重复争论）**：那个项目 **2631 行**（index 1182 + client 1169 + compat 280），
  只做"在已存在的工作区之间搬单条会话"，用的私有面和本插件**完全相同**
  （`tracker.writers` + `writer.header` + `sessions.flush` + `registry.headers/sessionPaths` + `attachSession`），
  它甚至自带一份 `compat/zstd-frames.js`。它**没有** `robocopy`/`moveProject`/`registry.create`/`plan.json`/`backup`。
  差别在**范围**：本插件还要搬项目目录、建工作区、支持停机兜底。
  它那个 79 行的 `heal-v2-sessions.ps1` 做的事是"文件名是 v2 但 header 写 v0 就改名"，和会话搬迁无关。

## 2026-09-19 上午 — 第二次真机翻车：同一路径被两条记录声明，DSH 起不来

- **现象**：`dsh web` 启动失败：
  `workspace domain is inconsistent: path 'E:\SpaceDev\Projects\My\JhiFengMultiChat' is claimed by both workspace '03d2457c-…' and workspace '224b28fb-…'`。
- **时间线（用 `live-*.json`、`migration-backups/*`、`report.json`、文件时间戳复原）**：
  1. 11:16 一次**不停机**迁移 `My → Mine`：新建 `224b28fb`（Mine，挂 2 条会话），源记录 `03d2457c` 变成 My 上的空记录。
  2. 11:20 又生成一次**手动**计划，方向 `Mine → My`；计划里的 `workspace.json` 补丁把 `224b28fb` 的 path 从 Mine 改成 My。
  3. 11:21 **没退 DSH** 就跑了 `1-apply-migration.cmd`：补丁生效 → 两条记录声明同一个 My → DSH 起不来。
  4. 之后还活着的 DSH 进程把内存状态回写，path 又变回 Mine —— "重复声明"消失，但注册表变成
     **路径与会话错位**（`224b28fb` 指向空的 Mine，却挂着 cwd 已经是 My 的两条会话）。
- **根因**：计划只按"源路径"找记录改 path，**没有检查目标路径已被别的记录声明**，也没有查过这条启动不变量。
- **修复**：DECISION D8（计划阶段删除空的占用记录 / 拒绝有会话的占用记录；不停机预检拒绝；verify 查不变量）。
- **数据修复**：**没有**直接编辑 `workspace.json` —— 它是 registry 的内存投影，运行中的 DSH 会盖回去（第 4 步就是证据）。
  改用一个临时动态 Host 插件，通过 `detachSession`/`attachSession`/`delete` 把两条会话并到 `03d2457c`、
  删掉 `224b28fb`，让 **DSH 自己**写出正确文件；随后核对：一条 My 记录、挂着 2 条会话、没有任何路径被声明两次。
  顺手删掉空的 `Mine\JhiFengMultiChat` 壳目录。修复插件用完即 undefine。

## 2026-09-19 — 第三次翻车：停机脚本的 DSH 检查是 fail-open 的

- **现象**：上面 11:21 那次 apply 明明有"检测到 DSH 就拒绝"的逻辑，却照样建了备份、打了补丁。
- **根因**：`preflightForApply` 只在 `processes.matches.length > 0` 时拒绝；而
  `detectDshProcesses()` 探测失败时返回 `{checked:false, matches:[]}` —— **失败被当成"没有 DSH"**。
- **修复**：DECISION D9（探测失败重试一次，仍失败则拒绝；脚本加 `check-quiescent` 前置守卫）。
- **验证**：`selftest` Test K 断言生成的 cmd 里有 `check-quiescent` 且它在 `apply` 之前；变异 `staged-guard-dropped`。
  真机实测（DSH 开着）`node lib/dsh-workspace-migrate.mjs check-quiescent` → 退出码 1 并列出命中的进程。

## 2026-09-19 — 界面几轮打磨（用户逐条提，逐条改）

信号前缀 `[√]/[!]/[×]/[i]`（否则"降级但已处理"的提示看起来像报错）→ 一个动作按钮（检查内嵌）→
结果折叠成带状态色的摘要行（失败默认展开）→ 手动迁移从模式开关改成复选框 → 「生成计划」→
暂存项只留"路径 + 打开目录" + 行头「i」用法提示 → 计划区把回滚单独列为「若遇到错误，可以回滚」。
细节与理由见 DECISION D10/D11。

## 2026-09-19 12:00 — 用户实测手动迁移的各种组合（**仅记录，未据此改动**）

| 场景 | 观测结果 |
|---|---|
| 3-1-1 工作区**有**已打开会话，不退 DSH 直接跑 `1-xxx.cmd` | 网页刷新后左侧只剩工作区、工作区里的会话不显示；**重启 DSH 后发现迁移其实成功了** |
| 3-1-2 工作区**无**已打开会话，不退 DSH 直接跑 | 刷新后工作区与会话都正常显示，但**悬浮显示的仍是迁移前的路径**；重启后发现迁移成功 |
| 3-1-3 在 3-1-2 基础上，重启前在该工作区新建会话并聊天 | 表面像是在旧路径对话，**重启后发现在新路径** |
| 3-2-1 有已打开会话 + **先退 DSH** 再执行 | 重启后迁移成功 ✅ |
| 3-2-2 无已打开会话 + **先退 DSH** 再执行 | 重启后迁移成功 ✅ |

结论（用户自己给的）：**在 DSH 运行中执行停机脚本其实也能迁成功**，只是界面要么异常、要么显示旧路径；
重启后一切正常。这与"DSH 会把内存状态回写"的模型一致 —— 脚本现在已经会拦这种情况（D9），
但这组观测说明**数据层面对回写有韧性**（文件层先落盘、DSH 回写的是它自己的旧内存态）。是否进一步利用这点是开放问题，见 [`TODOS.md`](TODOS.md)。

## 2026-09-20 — 用户实测后的 7 项优化

用户先给了两轮真机测试结果（见上面 2026-09-19 12:00 那张表：不停机迁移全部通过；手动迁移在 DSH 运行时其实也能迁成功，
只是界面异常、重启后正常），然后提了 7 条优化：

1. **面板里的工作区路径不实时**：别的插件迁完会话后侧栏是新的，本插件面板还是旧的，刷新不行、只能重启。
   **根因**：`/state` 读的是 `storages/workspace.json`，而它只是 registry 的 checkpoint 投影。
   **修复**：D16（先问活 registry）。**验证**：hosttest [11] 用"文件旧、registry 新"的夹具断言面板取到新路径；
   变异 `state-reads-file-only` 必须让它变红。
2. **`1-xxx.cmd` 说"DSH 没在运行"**：用户在 DSH 运行时跑那个脚本，守卫却放行了。
   **根因**：进程探测会漏报（`checked:true` 但 `matches:[]`），而守卫只信这一个信号。
   **修复**：D9 的扩展 —— 计划里记下 DSH 当时服务的 `host:port`，用 TCP 连接做第二个独立信号；两个都拿不到结论就拒绝执行。
   **验证**：selftest [Test L] 起一个真的 TCP server，断言"有人应答 → 拒绝且提示里点名 http 端口"；
   变异 `origin-probe-never-listens` 必须让"拒绝里点名 http 端口"这条失败。
3. **「目标目录还不存在」那句话让用户先去确认目录状态** → D17：滑块「连同文件迁移 / 仅修改目录」+
   勾选后「自动备份目标并覆盖」（目标内容搬到桌面，回滚时搬回）。**验证**：selftest [Test M]、livetest [19]/[20]
   （在测试里把 `USERPROFILE` 指向临时目录，所以不会真的往用户桌面写东西）；变异 `backup-target-ignored` / `live-backup-skipped`。
4. **暂存记录里源已经不是工作区的没法用了** → D18：标「无法使用」+ 行头「清理无法使用的暂存」。
   **验证**：hosttest [11]（只删不可用的；第二次清理什么都不删）；变异 `prune-ignores-usability`。
5. **手动迁移的说明不该塞在复选框标签里** → D19（标签旁边「i」按钮）。
6. **`Check` 行的「成功」改成「通过」** → D19。
7. **「从」输入框禁用输入，只能从下拉框选** → D19。

顺带把测试基线推到 **500 项断言 / 18 个变异**（hosttest 85、clienttest 99、livetest 166、selftest 150）。

## 2026-09-19 12:20 — 安装文档的 `~` 事故

- **现象**：用户在 **cmd.exe** 里按文档执行 `dsh plugin --profile web add ~/dsh-workspace-migrate`，
  pnpm 报 `git ls-remote git+ssh://git@github.com/~/dsh-workspace-migrate.git` → `is not a valid repository name`。
- **根因**：cmd 不展开 `~`；pnpm 把 `~/dsh-workspace-migrate` 当成 GitHub 的 `owner/repo` 去解析。
  （克隆那一步也把仓库建到了字面量目录 `C:\Users\25359\~\dsh-workspace-migrate`。）
- **修复**：README 安装章节改成按 **cmd / PowerShell / bash** 分别给绝对路径写法，
  补 `github:wfql1024/dsh-workspace-migrate` 一条命令路线，并加排错表。
- **附带确认**：profile 没被写脏（pnpm 在解析阶段就失败）；用户 profile 里
  `dsh-client-liang-intensity-skin -> github:kingOfSoySauce/dsh-liang-skin` 证明 `github:` 形式在其环境可用。

## 2026-09-25 — 用户否掉"备份目标目录"，并要求自动创建目标目录

用户拿到上一版（D17 的「自动备份目标并覆盖」）后直接提了两条：

1. **修复**：带文件迁移时**去掉备份逻辑**与那个复选框。"如果目标目录下有内容则 Check 失败，在 Check 输出中提醒用户目标目录下有内容。"
2. **优化**：「仅修改目录」时目标路径不存在 → **默认自动创建**，"只要路径是合法的"。

**改动**（D20）：桌面备份整条链路删除（`desktopRoot` / `desktopBackupDir` / `--backup-target` / 面板复选框 /
回滚里的"搬回" / `plan.project.backupDir` / `moveProjectDirectory` 的 `parked` 返回值）；
「连同文件迁移」+ 目标有内容 ⇒ `Check` 失败，文案给两条出路；「仅修改目录」+ 目标不存在 ⇒ `Check` 通过并在
**执行时**建一个空目录（live 的 layer 0 / 引擎 apply 的 project 步骤各一次，压 `destination-directory` 撤销项）；
盘符不存在 ⇒ `Check` 失败。

**踩到的坑**：`verifyPlan` 里我一度把"目标目录存在"改成无条件断言，结果 livetest [10] 红了 ——
回滚时 `relocate-sessions --rollback` 跑在"项目目录已经搬走、还没搬回"的中间态，
`expectMigrated: false` 去查 `plan.to` 当然不存在（而 `keep` 计划原本会跳过这条）。
**修复**：`expectMigrated || plan.project.action !== 'keep'` 才断言 —— 前向必须存在，原始态对 `keep` 不作要求。

**验证**：selftest [Test M]（拒绝 + 目标文件原样未动 + 同一目标改用 `keep` 被接受）、
selftest [Test M2]（空目标可用；缺失目标被创建且 verify 通过；缺失盘被拒）、
livetest [12]（`keep` 创建目标目录并写入注册）、[12b]（盘不存在时 `Check` 点名）、
[19]（内容 ⇒ 拒绝且目标文件按字节未动）、[20]（失败后创建的空目录被撤销）；
变异 `destination-content-allowed` / `live-destination-content-allowed` /
`keep-does-not-create-destination` / `engine-keep-does-not-create-destination` 必须让对应套件变红。
测试基线：hosttest 85、clienttest 99、livetest 178、selftest 160 = **522 项断言 / 20 个变异**（20/20 全部被抓住）。

**顺带修了变异工具的一个盲点**：第一轮 `run-mutations.mjs` 被我自己的 600s 超时杀掉，`finally` 里的还原没跑到，
于是 `lib/live-move.mjs` 一直带着 `MUTATION: writer header left at the destination`；下一轮只报 `livetest 177/178`，
看上去像真实回归（差点去查一个不存在的 bug）。现在 `run-mutations.mjs` 开工前先检查残留
（`.mutbak` 还在、或文件里仍留着 `MUTATION:` 串），命中就以退出码 2 明确指出来。
（第二次超时杀进程时又踩了同一个坑，这次是守卫先报出来的 —— 说明它有用。）

## 2026-09-25 下午 — 用户实测：手动太宽松、自动太严格

用户上手测了 D20 那一版，报回两条，并给出统一标准（不存在 → 自动创建；空 → 可以；非空 → 不允许）：

1. **手动迁移 + 目标目录下只有文件夹 ⇒ 却被判通过**（太宽松，真会合并）。
   **根因**：`buildPlan` 用 `directoryStats(to).files > 0` 判"有没有内容"，而它**递归数文件** ——
   只放空文件夹的目标 `files === 0` ⇒ 计划放行，`apply` 的二次校验用的也是同一条 ⇒ 合并进去。
2. **自动迁移 + 目标目录已存在但为空 ⇒ 迁移被拒**（太严格）。
   **根因**：`inspectLiveMove` 用的是 `readdirSync().length === 0`（本来就对，所以 `Check` 通过），
   但 layer 1 的 `moveProjectDirectory(from, to)` 没带 `replaceEmptyDestination`（那个开关当时只有撤销会用），
   于是 `occupied || !replaceEmptyDestination` 对"已存在但空"直接返回 `the destination already exists` ——
   **检查说可以、执行却拒绝**。

**修复**（D21）：引擎新增 `readEntries`/`describeEntries`，"空"= 顶层没有任何条目（文件夹也算），
`buildPlan` 与 `applyPlan` 二次校验都改用它，错误文案带上项数与条目名；
`moveProjectDirectory` 正反两个方向统一（空目标一律接管，`replaceEmptyDestination` 开关删除）；
手动模式点「生成计划」先走 `projectOnly` 的检查，不通过就不生成计划。

**验证**：selftest [Test M]（文件与文件夹两种非空、条目计数、目标原样未动）、[Test M2]（空目标可通过并真的搬进去、
缺失目标由搬迁创建、keep 的缺失目标仍由 apply 创建、缺盘仍拒）；
livetest [16]（空目标被接管、只有文件夹被拒）、[19]（非空拒绝且按字节未动）、
[19b]（只有文件夹 ⇒ 拒绝）、[19c]（空目标 ⇒ 迁移成功）、[20]（失败后撤销创建的空目录）；
clienttest [12]（手动先 Check、失败不生成计划、keep 走 `moveProject:false`、实时迁移仍是完整检查）；
hosttest [9]（`projectOnly` 在没有 registry 的宿主上也答得出来，而同一对路径的完整检查仍然要求 registry）；
变异 `engine-counts-files-only` / `live-destination-entries-not-folders` /
`live-refuses-empty-destination` / `manual-skips-check` / `destination-content-allowed` /
`live-destination-content-allowed` 必须让对应套件变红。
测试基线：hosttest 88、clienttest 111、livetest 193、selftest 172 = **564 项断言 / 24 个变异**（24/24 全部被抓住）。

## 2026-09-25 晚 — DSH 升到 0.1.7-rc.2：兼容性核对 + 侧栏收起只剩图标

用户把 DSH 从 0.1.5-rc.1 升到 **0.1.7-rc.2**，并要求①核对插件兼容性 ②让侧栏收起时本插件的按钮也只剩图标。

**兼容性：只读核对，结论是"兼容"**（没有改一行代码来适配）：
- `GET /api/dsh-workspace-migrate/state` → 200，`workspaceSource: "registry"`（说明插件挂载、registry 服务在）；
- `cordis_inspect_query(client/Slots, root: …)` 四个座位都在、都是 `replaceRisk: none`，
  本插件的四条注册 `workspace-migrate` / `workspace-migrate-dialog` 全是 active；
- `Tool.listTools` 里 `workspace_migrate` 在，描述已是本轮改过的新文案 —— 顺带证明**当前运行的宿主加载的就是最新代码**；
- 源码 grep 复核私有面全部仍在：`tracker.writers`(Map，含"施工中"的 `null` 占位)/`root`/`locate`/`listArtifacts`
  （含 `duplicate JSONL session id … appears in multiple project directories`）、
  `workspaceRegistry.headers`/`sessionPaths`/`attachSession`/`create`/`validateStoredState`
  （含 `path '…' is claimed by both workspace '…' and …`）、`sessions.flush`/`get`、
  `sessionProjectionCache.write`；第 0 帧"恰好一行"的断言仍在（`plaintext.indexOf(10) !== plaintext.length - 1` 抛错）；
  `storages/` 仍是 `workspace.json` + `session_projcache.json` + `session_projcache/sessions/*.json`（本插件要改的字段都还在）；
- 本包没有声明 DSH 的 peer 依赖 → 升级不会被插件管理器的版本检查挡住；DSH 自身没有 `engines` 约束。

> 参考：`dsh-session-manager` 的注释提到 "DSH 0.1.6+ removed `ctx.sessions.open()`" —— 我们**没有**用它，
> 它用的是 `ctx.uiWorkspace.openSession()`；本插件用到的面在 0.1.7-rc.2 上没变。

**侧栏收起只剩图标**（D22）：先查座位契约，不猜 class 名（侧栏的 class 是带 hash 的 `hHd-Xa_*`，不能当接口）。
`sidebar.footer.action` 的 owner props 只有一个 `{ wide: boolean }`，`false` 就是 56px 窄条；
`dsh-session-manager` 在同一座位上的做法是 `wide` 时"14px 图标 + 标签"，非 `wide` 时"36×36、18px 图标、只留 title/aria-label"。
本插件照同一形状做：`wide === false` 去掉「迁移」标签、方形图标钮，`title`/`aria-label` 仍是「工作区迁移」；
owner 不给这个 prop 时保留标签（"标签总在"比"可能只剩一个看不懂的字形"安全）。图标继续用自带字形 `⇄`，
不引入 `@deepseek-ai/dsh-client-ui-primitives`（少一个外部依赖就少一个版本风险）。

**验证**：clienttest [5] 新增 6 条（rail 去标签、带 `dwsm-entry-rail`、字形还在、title/aria-label 还在、
宽侧栏保留标签、无 prop 时保留标签）+ 1 条 CSS 断言（`\.dwsm-entry-rail{…width:36px;height:36px`）；
变异 `sidebar-entry-ignores-wide`（把 `wide` 写死 true）必须让 clienttest 变红（实测 2 条断言失败）。
顺带修掉 `index.js` 里 `moveProject` 参数描述残留的旧文案（"already holds files" → "is not empty"）。
测试基线：hosttest 88、clienttest 118、livetest 193、selftest 172 = **571 项断言 / 25 个变异**（25/25 全部被抓住）。

**生效方式**：客户端半体（`client.js`）改完**刷新页面**即可（bundle URL 带 `rev` = 文件大小+mtime 的哈希，
宿主逐请求校验 rev，所以刷新一定拿到新字节）；`index.js` 是宿主半体，改完要**重启 DSH** 才生效（本次只是工具描述文案）。

**未做**：真正的迁移没有在 0.1.7-rc.2 上重跑（只做了只读核对 + 离线套件）；建议先在临时工作区上
`workspace_migrate { action: "live", dryRun: true }` 走一遍再动真实数据。
