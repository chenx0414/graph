# scripts/ 诊断与维护

- 提交与推送规则：[工程规范](../CODING_STANDARDS.md#验证与交付)。
- 测试环境和依赖准备：[检查操作指南](../docs/agents/checks.md)。
- Matt 阶段校验：[工作流契约](../docs/agents/matt-flow.md#阶段用途与派发)。
- 技能来源与本地适配：[harness 维护](../docs/agents/harness.md)。

## 只读诊断脚本（diag-a / diag-b / diag-c）

三个互不依赖的诊断脚本，回答三类互不相同的问题。共同契约：

- **只读**：只读取文件并打印，不写、不改名、不删除、不 spawn、不联网、不读时钟。
- **零新增依赖**：只 import `node:fs` / `node:path` / `node:url` 等内置模块。
- **不依赖当前工作目录**：仓库根来自脚本自身的 `import.meta.url`（diag-b 与 diag-c 两侧再过
  `realpathSync`），所以 `node scripts/diag-x.mjs` 在任何目录下打印的都是同一棵树。
- **退出码**：`0` = 正常/无问题；`1` = 发现问题或参数/输入不可读（错误信息写到 stderr）。

它们按路径调用，没有接进 `package.json`（保持「只新增一个文件」的边界），所以
`node --run <name>` 跑不了它们，必须用 `node scripts/...` 直接调用。

| 脚本 | 回答的问题 | 调用 | 退出码 1 的含义 |
| --- | --- | --- | --- |
| `diag-a` | 这个仓库的测试套件有多大？ | `node scripts/diag-a.mjs` | 无（只报告，不判定） |
| `diag-b` | 源码树按模块有多大？ | `node scripts/diag-b.mjs [--json] [--target <dir>]` | 参数错误 / 目标不存在或不是目录 |
| `diag-c` | `package.json` 里的脚本引用都能解析吗？ | `node scripts/diag-c.mjs [repoRoot]` | 有悬空引用、缺文件、脚本环、缺 `check`，或读不到仓库 |

---

## diag-a — 测试套件清单

统计 `tests/` 下的测试规模：按目录给出文件数与声明数，最后打印一行
`SUMMARY files=… declarations=… uncollected=…`（便于 diff 与断言）。

```sh
node scripts/diag-a.mjs
```

在 66c23ef 上的实际输出：

```
  217 test file(s), 1456 declaration(s), 1 uncollected test-like file(s)
  uncollected:
    tests/fixtures/m7/web-server.test.js
SUMMARY files=217 declarations=1456 uncollected=1
```

读法与陷阱：

- `files` 只数 `tests/**/*.test.ts`，正是 `vitest.config.ts` 的 include，所以它就是
  vitest 实际收集的套件数（同一 tip 上 `vitest list --filesOnly` 也是 217）。
- `uncollected` 是**长得像测试、但 vitest 不收**的文件。仓库里那 1 个
  `tests/fixtures/m7/web-server.test.js` 是 m7 的 fixture 载荷
  （`tests/m7/adapters.ts` 拷进沙箱后用 `node --test` 单独跑），不是套件。
  **不要把「磁盘上 test-like 文件数」当成套件数。**
- `declarations` 是 `test()/it()` 的**声明处**静态计数，`test.each` 表只算 1 条。
  它不是 vitest 运行时报的用例数：同一 tip 上 `node --run test` 实际收集 1480 个用例
  （差额来自 `.each` 展开）。要套件数用 `files`，要运行期用例数用 `node --run test`。

## diag-b — 源码规模

按模块目录统计文件数 / 行数 / 字节数，并给出总量、扩展名分布、最大的 10 个文件。

```sh
node scripts/diag-b.mjs                     # 人读表格（默认目标：本仓 src/）
node scripts/diag-b.mjs --json              # 同样的数字，JSON
node scripts/diag-b.mjs --target src/runtime # 换成别的源码树
node scripts/diag-b.mjs --help
```

在 66c23ef 上的实际输出（`src/`，196 files / 54,175 lines / 2,668,294 bytes）末尾会多一行
`2 non-source file(s) skipped.`：JSON 快照、图片、散文按设计不计入，避免
`src/catalog/models-dev.snapshot.json` 这种单行数 MB 的数据文件淹没规模数字。

注意：报告首行打印的是**目标的绝对路径**（`Source scale of /…/src`），所以输出字节
依赖 checkout 位置；除此之外所有数字只依赖被测的树。`--target` 指向不存在的路径或文件时，
脚本以 `diag-b: cannot read target: …` 退出 1。

## diag-c — npm 脚本完整性

遍历 `package.json#scripts`，报告四类问题：指向未定义脚本的 `node --run X` /
`npm|pnpm|yarn run X`、交给工具但不存在的文件路径、脚本之间的环、以及缺失的 `check` 入口。

```sh
node scripts/diag-c.mjs            # 默认检查本脚本所在的仓库
node scripts/diag-c.mjs /path/repo # 显式指定仓库根
```

在 66c23ef 上的实际输出：

```
scripts: 30 total, 5 reachable from `check`
reachable from `check`: check, typecheck, lint, test, check:evidence

`check` expands to:
  node --run typecheck && node --run lint && node --run test && node --run check:evidence

Problems: 0
OK: every referenced subcommand, file path and script chain resolves.
```

只读且不执行任何被检查的脚本，所以它是**元数据层面**的完整性检查：
`check` 展开出来的命令会不会失败，它答不了——那由 `node --run check` 回答。
指向非仓库目录时报 `diag-c: no package.json found at …`，退出 1。
入口判断两侧都过 `realpathSync`，所以经符号链接路径（`/tmp`、`$TMPDIR`、符号链接的 checkout）
调用得到的是同一个仓库的结论，不会静默变成「无输出 + 退出 0」。

---

## 历史环境证据：66c23ef 的工作树依赖问题

以下记录保留当时的实验和计数。当前环境准备以 [检查操作指南](../docs/agents/checks.md#在-git-工作树里验证)为准，不能用这份历史记录推断所有工作副本的现状。

**与这三个脚本无关，是集成/工作副本的环境问题，不要当成整合质量问题。**

实测：Graph 的工作副本把 `node_modules` 做成指向主仓的**软链**。`src/runtime/project-dependencies.ts`
会把项目 `node_modules` 的 realpath 作为沙箱读取授权交给 Agent（ADR 0027），而软链的
realpath 越出了工作副本自身，于是沙箱里的 Agent 子进程收不到模型请求，表现为
`provider.requests[0]` 为 `undefined` 一类断言失败。

A/B 证据（同一份代码，两个树各跑一次同一个文件）：

| 树 | `node_modules` | `vitest run tests/console/presets.test.ts` |
| --- | --- | --- |
| 工作副本 | 软链到 `/Users/macmini/workspace/13-Graph/node_modules` | 1 failed \| 1 passed |
| 主仓 checkout | 真实目录 | 2 passed |

全量形态：软链副本 `Test Files 42 failed | 175 passed (217)`、`Tests 128 failed`。
把副本的 `node_modules` 按 `docs/agents/checks.md`「在 Git 工作树里验证」一节换成硬链接后，
同一 tip 的整份提交（66c23ef）在另一个目录里跑到 `Test Files 217 passed (217)`、
`Tests 1480 passed (1480)`，`node --run check` 退出 0——前提是 `npm` 在 PATH 上。

修法就一条，别用手工软链：

```sh
cp -al <主仓库>/node_modules <工作树>/node_modules
```

所以：在**集成副本上跑全量检查之前**先做这一步（并保证 `npm` 在 PATH 上）；否则
`node --run check` 必红，而那不是任何一次 merge 或任何一个诊断脚本能修的。

上面那句「退出 0」有两个前提，缺一个就会看到残留失败，都属本机环境、与本交付无关：
`tests/m0/restricted-process.test.ts` 里的 `/usr/bin/which npm` 失败（npm 在
`/opt/homebrew/bin/npm`，不在本 shell 的 PATH 上；它在主仓 checkout 里同样失败，
把 `/opt/homebrew/bin` 放进 PATH 后该文件 24/24 全绿）；另外 `tests/m7/*` 需要同级目录
`../12-MediaBookmarks`，`tests/console/rsi.test.ts` 需要副本本身是 git checkout
（`git archive` 出来的拷贝没有 `.git`，`resolveRsiRoot` 会返回 undefined）。
