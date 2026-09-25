# tools

开发/验证用脚本。它们**不是**插件的一部分：`npm pack` 不会带上这个目录，插件运行时不加载任何文件。

| 脚本 | 用途 |
|---|---|
| `run-mutations.mjs` | 变异测试总控：对每个变异跑对应套件，**必须变红**才算被守住。未被抓住的变异会让退出码非 0 |
| `mutations.mjs` | 变异清单：每个变异只破坏一个机制，并指明该由哪个套件发现 |
| `inspect-artifact.mjs` | 按引擎的方式解析一个会话工件：帧数 + 第 0 帧是否为「恰好一行 header」（逐字节核对宿主启动时的断言） |
| `dump-frame0.mjs` | 打印第 0 帧的原始字节、换行符数量等细节，排查 zstd 帧问题时用 |
| `probe.mjs` | 用真实 DSH 日志验证 zstd 帧长度解析（RFC 8878 语法，不扫魔数） |
| `dsh-patches/` | **与本插件无关**：当初为了排查 Windows 子进程窗口问题给 `dsh-subprocess-local` 打的补丁及其还原脚本/原始文件 |

## 常用命令

```bash
node tools/run-mutations.mjs                 # 全部变异
node tools/run-mutations.mjs writer-rebind   # 只跑一个
node tools/inspect-artifact.mjs <session.v3.jsonl.zstd>
```

`run-mutations.mjs` 会先确认各套件在未变异时全绿，逐个变异、逐个还原，最后再确认还原后仍然全绿，
并检查没有留下 `.mutbak` 备份文件。

开工前它还会检查**工作区里是否残留上一次的变异**（`.mutbak` 还在，或某个文件里还留着 `MUTATION:` 那个替换串）：
被 Ctrl-C / 超时杀掉的那一轮跑不到 `finally`，还原就丢了。这种情况直接以退出码 2 指出问题，
免得把"上一次留下的变异"当成真实回归去查。

也因为这个，**不要在跑变异的时候改 `index.js` / `client.js` / `lib/*.mjs`** —— 变异就是在这几个文件上做替换、跑完再写回，
你的并发编辑可能被覆盖掉。
