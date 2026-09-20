# DECISION — 设计决定与理由

> 只增不改：推翻旧决定时**新增一条**并注明取代了哪一条。
> 每条写"背景 / 决定 / 理由 / 代价"，理由尽量指向 [`FACTS.md`](FACTS.md) 里的实测事实或测试。

## D1 文件层交给引擎，内存层留在插件进程内

- **背景**：第 0 帧不变量是最危险的一段代码（见 FACTS §2），而工作区注册表只活在宿主进程里。
- **决定**：危险的文件操作只有**一份实现** —— `lib/zstd-frames.mjs`；冷会话由子进程引擎
  `relocate-sessions` 执行，运行中的会话由插件进程内调用同一份原语。
- **理由**：单份实现 + 单份测试，避免把最容易写坏的一段代码复制成两份。
- **代价**：多一个 CLI 入口和一套 JSON 协议；引擎的失败原因必须如实转发（否则用户只看到
  "the engine refused the relocation"）。

## D2 运行中会话靠"无 `await` 的同步段"，不靠锁

- **背景**：本部署的 `sessionPersistence` **没有 `coordinator`**（FACTS §1），没有 per-id 锁可用。
- **决定**：顺序固定为
  `await sessions.flush(session)` →（此段**无任何 await**：重压第 0 帧 → 移动工件 → 改写 `writer.header`）
  → 清理空目录 → 改 `session.header`。
- **理由**：Node 单线程事件循环下，无 `await` 的代码段不可能被已排队的追加写插入 —— 比"再上一把锁"更强。
- **代价**：这段代码以后**不能**随手加 `await`（加进去就出现窗口）；回滚必须把 writer 和 Session 的 header 都指回旧路径。

## D3 header 必须"保留原型"地重建

- **背景**：`session.header` 是**宿主 realm** 里 `deepFreeze` 过的纯 JSON 记录，而插件跑在 Cordis 沙箱 realm。
- **决定**：`headerWithCwd()` 用 `Object.create(原原型)` + 拷贝字段 + `freeze`，
  **不用** `Object.assign({}, header, { cwd })`。
- **理由**：普通拷贝会带上**沙箱 realm** 的 `Object.prototype`，而
  `dsh-session/lib/types/index.js:68-76` 明确拒绝这种形状（"session header is not a plain JSON record"）。
  真机实测：保留原型法写被接受、`persistence.stat(id)` 仍可读、registry 仍读得到，且能原样还原。
- **代价**：多一层间接；用变异测试（`plain-header-copy`）钉住这条规则，防止有人"顺手简化"回去。

## D4 先失效 header 缓存，再 attach

- **背景**：`attachSession` 校验路径时优先读 `registry.headers` 缓存（FACTS §1）。
- **决定**：内存层的顺序是"**删掉缓存条目** → `detachSession` → `attachSession`"，而不是"先 attach 再把缓存改成新值"。
- **理由**：缓存里还是旧 cwd，先 attach 必然校验失败。`sessionPaths` 由 `attachSession` 自己维护。
- **代价**：这个 bug 离线测试测不出来（当时的假 `attachSession` 不做校验）——
  现在假服务按真实行为建模，并配变异测试。

## D5 私有索引只做原地更新，绝不新建条目

- **背景**：`registry.headers` / `sessionPaths` / `invalidSessionPaths` 都是私有面。
- **决定**：只对**已存在**的条目做"保留原形状、只改身份"的更新；不存在就跳过并记入 `indexSkipped`，
  降级为"重启后分组才正确"，不抛错。`registry.headers` 那条是唯一 load-bearing 的修复（**失效**即可，不需要写值）。
- **理由**：新建条目/重建结构最容易写坏别人的状态；降级比报错安全。
- **代价**：极端情况下要重启 DSH 才看到正确的侧栏分组，报告里会说明。

## D6 四层迁移 + 撤销栈，第 4 层顺序是踩出来的

- **决定**：`1 项目目录（可选）→ 2 目标工作区注册 → 3 会话工件 → 4 内存 registry`，任何一步失败从新到旧回滚。
  第 4 层撤销时：**先反向撤销目标 attach → 再回滚文件/项目 → 最后 attach 回源**。
- **理由**：反过来会把会话从源工作区弄丢（曾实测）。
- **代价**：撤销栈本身要测：`livetest` [10] 专测"最内层失败"、[14] 专测运行中会话的撤销。

## D7 报告一定落盘

- **决定**：`live` 模式无论成功还是失败都写 `<DSH_HOME>/migration-runs/live-<时间戳>.json`；
  写失败不升级为迁移失败（best-effort），但那时**不再回传报告路径** —— 报出来的路径一定真有文件。
- **理由**：迁移是破坏性操作，失败时这份报告是唯一的账本。

## D8 一条路径只能被一条工作区记录声明

- **背景**：DSH 启动时校验这条不变量，违反就**起不来**（FACTS §3）。而计划里的
  `workspace.json` 补丁是"把源路径那条记录改写成目标路径"，如果目标已被别的记录声明，就会制造违反。
- **决定**：
  - 计划阶段：目标被**空**记录占用 → 连补丁一起**计划删除**那条记录（`metadata.removals`）；
    目标被**还有会话**的记录占用 → **拒绝**（合并两个工作区不是工具该替用户决定的事）；源路径已被两条声明 → 也拒绝。
  - 不停机预检：源/目标任一被多条记录声明 → 拒绝并点名记录 id（`create()` 对同一路径幂等，会静默挑一条）。
  - `verify`：把这条不变量作为 DSH 的启动不变量来查，并核对每个 removal 是否生效。
- **理由**：这是 2026-09-19 那次"`dsh web` 起不来"的直接原因（见 [`DEV_LOGS.md`](DEV_LOGS.md)）。
- **代价**：多一类补丁（删除记录）要写、要测、要能回滚（回滚靠整文件还原，天然支持）。

## D9 停机脚本自带 DSH 检查；探测失败也算"不安全"

- **背景**：`preflightForApply` 一直有"检测到 DSH 就拒绝"，但它是 **fail-open** 的：
  探测失败（`checked:false`）时 `matches` 为空，于是照常执行 —— 2026-09-19 那次的惨案就这么发生的。
- **决定**：
  - 探测失败**重试一次**；仍失败 → 拒绝执行，要求显式 `--allow-running`。
  - 生成的 `1-apply-migration.cmd` / `3-rollback.cmd` 第一件事是跑引擎的 `check-quiescent` 子命令：
    有 DSH 就打印命中的进程并 `exit /b 1`，在动任何文件之前挡住。`2-verify.cmd` 只读，不加。
- **理由**：在 DSH 运行时做迁移会**丢改动** —— DSH 会把内存里的工作区状态回写，盖掉迁移结果。
- **代价**：探测失败的机器需要人工确认后加 `--allow-running`；这是有意的摩擦。

## D10 界面：一个动作按钮 + 可折叠结果行

- **决定**：
  - 只留一个「**开始迁移**」：只读检查先跑、通过才动手，不通过就零写入并在 `Check` 行给出原因；
    "不停机"不进按钮文案（它是标准做法，不是高级选项）。
  - 勾选「手动迁移」后同一个按钮变成「生成计划」（去掉模式开关那一行）。
  - 结果每个阶段**一行摘要**（`Check` / `Migrate` / `Plan` / `Verify` / `暂存的手动迁移`），带颜色状态标签，
    细节放在 `hidden` 的正文里；**失败默认展开**，成功/计划默认折叠。
  - 折叠默认值写成渲染期判断（`rowOpen(key, defaultOpen)`）而不是点击处理函数里的状态写入 ——
    这样"默认折叠"这条规则可以被测试直接断言。
- **理由**：结果铺一屏文字时，用户分不清"提示"和"错误"（早期的 note 全是平铺句子）。
- **代价**：行头要用 `div[role=button]`（行里还要放按钮，按钮套按钮是非法 HTML）；
  需要维护一份 `PANEL_HOOKS` 顺序给客户端测试做状态种子。

## D11 「打开目录」走宿主路由，并限制在 migration-runs 下

- **决定**：新增 `POST /open-directory`，**只允许打开 `<DSH_HOME>/migration-runs` 下的目录**；
  Windows 上用 `cmd /c start "" <目录>`（不用 `explorer.exe <目录>`，它在目录已打开时静默失败）；
  只等 `spawn`/`error` 事件、不看退出码；`DSH_WORKSPACE_MIGRATE_DRY_OPEN=1` 让测试只报告不启动。
- **理由**：浏览器不能让宿主去开用户机器上的任意路径；而"启动文件管理器"在页面里**没有可见变化**，
  所以成败必须显示在**刚刚点击的那一行**（`banner`，折叠时也可见），宿主同时 `console.log` 一行 ——
  否则"按钮坏了"和"窗口没弹出来"从用户视角完全一样。
- **代价**：多一个路由（回环防护 + 目录边界检查都要测）。

## D12 `DEV_RELOAD` 只在开发期存在

- **决定**：`index.js` 里保留一个开关：包目录下存在 `DEV_RELOAD` 文件时，`lib/live-move.mjs`
  带破缓存参数重新 import。**发布包里没有这个文件，默认关闭。**
- **理由**：`cordis-plugin-loader` 复用已加载模块的回调、`import()` 不带破缓存参数，
  所以 `index.js` / `client.js` 的改动永远要重启；只有这个显式开关能让 `lib/live-move.mjs` 开发期免重启。
- **代价**：每次调试完要记得删标记文件（`.gitignore` 已忽略它）。

## D13 已知取舍（接受，不修）

| 取舍 | 原因 |
|---|---|
| 搬完后**旧工作区记录会留在侧栏**（`sessionIds` 为空），需要用户自己删 | DSH 没有改工作区 path 的 API；保留旧记录比伪造新 id 安全。停机模式才能真正"原地换路径" |
| 依赖 DSH 私有面（`tracker.writers`、`registry.headers`/`sessionPaths`） | 没有公开替代品；全部带 `typeof` 守卫，拿不到就拒绝而不是写坏数据 |
| `index.js`/`client.js`/`lib/live-move.mjs` 改动需要重启 DSH | 加载器语义（FACTS §5） |
| 运行中会话的投影缓存迁移时来不及 checkpoint | 交给它自己的 fail-soft 自愈（实测：迁移后 per-record 文档已变成新 cwd） |
| 手动模式在 DSH 运行时执行，界面会显示异常（迁移其实已成功） | 见 [`DEV_LOGS.md`](DEV_LOGS.md) 2026-09-19 观测；脚本已经会拦，但"用户绕过脚本手动改文件"不在防护范围 |

## D14 测试策略：假服务按真实行为建模 + 变异测试

- **决定**：
  - 假服务必须复刻真实行为：`attachSession` 真的 realpath 校验、header 缓存优先于磁盘、
    `delete` 真的 splice、live header 带**别的 realm 的原型**。
  - 每个关键机制配一个**变异**（`tools/mutations.mjs`），变异必须让对应套件**变红**；
    没被抓住的变异会让 `npm run test:mutations` 退出码非 0。
- **理由**：早期宽松的假服务让两个只有真机才暴露的 bug（`flush(undefined)`、空目录残留）全部漏过。
- **代价**：写测试比写功能慢；但真机翻车的成本更高（已经翻过三次）。
