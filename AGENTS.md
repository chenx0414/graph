# Agent instructions

- 探索、设计、修改或审查代码，以及提交或推送前，读取 [CODING_STANDARDS.md](CODING_STANDARDS.md)，按当前工作阶段执行。
- 找实现、追调用链、判断改动影响面，先用 CodeGraph 索引：MCP 工具 `mcp__codegraph__codegraph_explore`，或 CLI `codegraph explore "<问题>"`；细则见下文「代码导航」。
- 改状态、状态显示或状态转移前，读取 [状态机地图](docs/agent/state-machines.md)：注册表在 `backend/statemachine/machines.json`，`go -C backend run ./cmd/graphcheck machines` 判定源码与注册表是否一致。

- 测试：单元、集成、E2E 都可以，唯一前提是**先写测试再写代码**；先红后绿，回归必须先演示失败。适用于我和所有子 Agent，细则见 [测试编写规则](CODING_STANDARDS.md#测试编写规则)。

- 可验证性第一：每段代码都要有一条命令能判定它对不对，没有断言路径的代码不提交。见 [可验证性](CODING_STANDARDS.md#可验证性)。

- worktree 不遗留：在 worktree（含 subagent 的 .claude/worktrees/agent-*）里做的任务，完成时必须删除该 worktree 及其分支。它专用的 cargo target 目录一并删掉。删除前二选一：合并进 main；或不合并时先把未提交改动提交到该分支，打 archive/<worktree 名> tag 存档，再 git worktree remove + git branch -D。编排 subagent 的会话负责收尾它派生的 worktree。确需保留的（待用户裁决、有冲突待解）在最终回复里点名路径与原因，不得默默留下。

## 代码导航

仓库已建好 CodeGraph 索引（`.codegraph/`，本机数据、不入库），857 个文件、约 1.16 万符号、3.8 万条关系边。它一次调用就返回相关符号的**逐行源码 + 调用路径 + blast radius**，比 grep/read 逐文件拼结构省得多。

- 优先入口：MCP 工具 `mcp__codegraph__codegraph_explore`（会话里挂着 `codegraph serve --mcp`），或 CLI `codegraph explore "<问题>"`。
- 其它 CLI：`codegraph query <名字>`、`codegraph node <符号>`、`codegraph callers|callees <符号>`、`codegraph impact <符号>`、`codegraph affected <改动文件>`、`codegraph status`。
- 索引自动同步：MCP 服务器带文件监听；没挂 MCP 时先 `codegraph sync`（全量重建用 `codegraph index`）。
- 边界：codegraph 只回答结构和源码；对错仍以 `go -C app test`、`go -C backend test ./...`、`python3 scripts/check-queue.py` 为准。

## 门禁分层

`python3 scripts/check-queue.py` 是**激活门禁**（快层）：`go -C backend run ./cmd/graphbuild backend` 起后端起二进制，`go vet` 与 `go test` 各跑两遍（`backend/`、`app/` 是两个 module），再加静态门禁与行为门禁 `go -C backend run ./cmd/graphcheck harness`。每道门禁判定什么、失败了怎么改，看它自己的输出。

跑测试的那一半会起守护进程、用共享暂存目录，仍走 `check-queue.py` 的机器级 slot；其余只写本工作区，两个会话可以同时跑。以前整个快层都在那把锁里，所以别人一在检查，你的激活就得等——等的还不是共享资源。

`go -C backend run ./cmd/graphcheck all` 是**全量确认**（慢层）：同一批步骤再走一遍。**重载确认后它会自己跑**：`AckRestart` 确认提交生效时启动后台会全量，日志落在 `state/rsi/reports/async-full-<activationId>.log`；失败会往本会话追一条带来源标记的消息、标出「回归」还是「环境故障」，并唤醒主控——所以不再需要人记得手动跑。（守护进程在跑之前重启会丢掉这次后台确认，那就靠下一次激活补上。）判定不靠「整份日志里有没有环境故障字样」：它按 `backend/internal/graph/testdata/env-known-reds.json` 逐条匹配失败包与错误摘要，只有所有失败都命中才判「环境故障」，任何未命中的失败都算回归并在卡片里点名（包 + 错误摘要）；新增已知环境项必须写进这个文件并写清理由，不能靠口头约定。

仓库里没有自有的 TypeScript/JavaScript：界面、daemon、构建与门禁工具链都是 Go。例外只有两处——`src/runtime/` 的两个 Node 执行面 worker（扩展与模块；宿主命令与检查解析已由 Go 直接执行），以及 `.agents/skills/` 的第三方技能脚本。

## 测试只许断言确定的事实

一个测试能不能过，只能取决于产品的行为，不能取决于墙钟或机器负载。具体到写法：

- 不写 `sleep`，也不靠“等得够久”让状态变成预期的（用状态轮询，但轮询的对象必须是产品事件最终会落定的值）。
- 不比耗时、不比重试次数（`retries_used`）、不比 `workerActive` 这类随调度变化的字段，也不比整行记录。要比就比合同：同一个执行 id、同一个 submission、同一份产物的摘要。
- “没有重跑”用产物摘要与执行 id 证明，不用计数器证明。
- 拿不准就问：这条断言在慢机或高负载下会不会翻转？会翻转就换成确定的等价断言，而不是把它放进隔离名单。
