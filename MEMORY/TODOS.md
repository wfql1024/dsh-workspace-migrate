# TODOS — 待办与已知缺口

> 做完就删掉或移进 [`DEV_LOGS.md`](DEV_LOGS.md)。每条尽量写清"为什么值得做"和"做完怎么算完成"。

## 发布与传播

- [ ] **发布到 npm**（`npm publish`）。当前只有 GitHub 安装路径；发 npm 后可以
      `dsh plugin --profile web add npm:dsh-workspace-migrate`，README 也能加 npm 版本徽章。
      完成标准：`npm view dsh-workspace-migrate version` 有输出，README 换成 npm 安装为主。
- [ ] **英文 README**（参考项目是 `README.md`(en) + `README.zh.md`(zh) 双份）。现在只有中文，
      想进 awesome 列表/给非中文用户看会吃亏。完成标准：两份内容对齐，顶部有语言互链。
- [ ] **GitHub Actions CI**：在 clone 上跑 `npm test` + `npm run test:mutations` +
      `npm pack --dry-run`。注意 `selftest` 的 `check-quiescent` 在 CI 上应返回 0（那里没有 DSH 进程），
      所以它是跨环境安全的；`livetest`/`hosttest` 不碰真实 DSH_HOME。
- [ ] **兼容性矩阵**：README 里现在只写"`0.1.5-rc.1` 已验证"。每验证一个新 DSH 版本就加一行
      （参考项目用表格维护）。

## 功能

- [ ] **旧工作区记录的自动清理**（可选）。现在搬完会留一条空记录在侧栏，需要用户自己删（DECISION D13）。
      可以做成"迁移完成后问一句是否删除旧记录"——但要先想清楚"用户手动改过标题/顺序"的情况。
- [ ] **手动模式在 DSH 运行时执行后的界面自愈**。用户 2026-09-19 实测：脚本在 DSH 运行时也能迁成功，
      但界面要么丢会话、要么显示旧路径，重启后正常（见 [`DEV_LOGS.md`](DEV_LOGS.md)）。
      脚本已经会拦（D9），但如果用户绕过脚本直接改文件，界面就靠重启恢复。可以考虑：
      插件启动时检测"注册表里有记录指向不存在/不匹配的路径"并提示重启。
- [ ] **把真机 E2E 脚本化**。目前的真机验证是用临时动态插件 + 手工核对做的（记录在 DEV_LOGS 里）。
      可以固化成 `tools/live-e2e.mjs`：建夹具 → 迁移 → 核对 → 清理。风险是要碰真实 DSH_HOME，得加开关。
- [ ] **`workspace_migrate` 工具动作的说明同步**。工具的 action 描述要跟界面文案保持一致
      （已经加过"运行中会话支持"与报告路径的说明，之后每次改行为都要回来看一眼）。

## 已知降级（可以接受，但要知道）

- [ ] `session_projcache.json`（旧版单文件表）里迁移过的会话可能仍留着旧 `identity.cwd` **死条目**。
      实际读取用的是 per-record 文档，且 `identityMatches` 对不上就当缓存 miss，所以不影响；
      但严格说它不干净。是否清理待定。
- [ ] 索引类修复拿不到时（`registry.headers` / `sessionPaths` 缺失）只降级为"重启后分组才正确"，
      报告里会写 `indexSkipped`。不做兜底写入（DECISION D5）。
- [ ] 依赖 DSH 私有面。DSH 一改这些名字就会降级：**拒绝迁移运行中的会话**（而不是写坏数据）。
      每次 DSH 升级后建议先跑一次只读预检。
- [ ] 界面英文提示与中文标签混排（note 是英文、行标题是中文）。想让非中文用户舒服需要统一，
      但那是一次文案大改，先记账。

## 测试

- [ ] 客户端测试里 `PANEL_HOOKS` 是一份手写的 hook 顺序表（用来给 `Panel` 播种状态）。
      `Panel` 增加 hook 时必须同步更新——现在错了会**大声失败**（种子错位），但没有编译期保护。
- [ ] `tools/run-mutations.mjs` 全跑一遍约 10 分钟。可以考虑并行化，但变异是**改同一份文件**，
      要并行就得给每个变异一个临时工作副本。
