# Batch 43

  - **被运行中的图占用的模型不能删，daemon 保留绑定**（第 1 条，新 Go E2E）：master 真的提出一张图（节点钉着 `local`），用户真的确认，节点真的停在 idle；把 `local` 从配置里拿掉这件事被**指名拒绝**（400 `config_in_use`，理由里点着那个模型名）；**daemon 保留它已经有的绑定**——节点还是 idle，**图的修订里仍然写着 `local`**（用 master 自己的 `graph_inspect` 工具读出来的），磁盘上的配置一个字节没动（版本号仍是 0）；**等那张图停掉之后**，同一份改动就通过了（版本号前进到 1，模型换成了 `replacement`）。TypeScript 那条测试直接读内部运行时，同一套语义现在走的是公开面：HTTP 提案确认 + 公开的图检查工具。
  - **这一批逼出了 Go 侧一个真 bug**：**daemon 重启后，已经打开的控制台全线 401**。会话 cookie 是**每进程随机**的（`CreateSession()` 每次启动都换一张），而 daemon 被换掉之后——升级会换、桌面端在**同一个端口**上重启它也会换——浏览器手里还是旧进程的那张 cookie，于是控制台的每个请求都被拒，页面变成一片空白（`configured-models` 根本没渲染出来）。TypeScript 那边是**同样的设计**，只是 Node 每次恰好拿到不同端口，才没有暴露出来。修法：**会话令牌属于这份安装，不属于这个进程**——它落在状态目录里（0600，目录本身 0700），daemon 重启之后还是同一张 cookie，已经打开的控制台继续工作。
  - **两次回退验证证明这些断言咬得住**：把令牌改回每进程随机 → 新用例变红（旧 cookie 拿到 401 而不是 200）；把受控厂商改成对所有请求回 500 → 「验证成功」变成「验证失败：ROLLBACK vendor refused」。
  - **与 TypeScript 的差异**：会话令牌的持久化是 Go 侧**多出来**的一次修复（TypeScript 那边同样有这个毛病），其余语义两边同构。
- **Batch 43（已完成）**：应用外壳的浏览器轨。`tests/m8/app-shell-ux.test.ts` 的 **32 条里有 12 条改由 Go daemon 驱动**（断言一个字都没改），另外 20 条**留在 TypeScript 的进程内服务器上**——它们要靠 `server.runtime.*` 造状态（提案、目录发布、会话创建），那是 TS 运行时的内部面，随实现一起退休：
  - **12 条搬过去的原因很朴素**：它们本来就是在浏览器里 stub API 响应（`page.route`）来测控制台的渲染，daemon 只负责把控制台壳子端出来。于是驱动方换成真实的 Go daemon 之后，**断言一个字都没改**就成立了：项目选择器真的把项目加进侧边栏（配置真的落盘）、Agent 的 Markdown 真的渲染成表格、工具活动真的折在答案后面、流式增量真的逐步显影、重试流真的被清掉、模型与思考档位真的作为一次选择被记住、收件箱真的把已解决的问题留在历史里、新会话的斜杠菜单真的不越界、设置页真的是独立的一页。
  - **这一批没有逼出 Go 侧的真 bug**：控制台这一层本来就与后端实现无关，Go 侧的 API 面足够。
  - **一次回退验证证明这些断言咬得住**：让 Go 的配置保存直接报错 → 「项目选择器把项目加进侧边栏」那条变红（项目根本没进侧边栏）——那条断言真的在读 daemon 落盘的结果，不是自己画的界面。
  - **仍留在案的 20 条**：它们的状态是用 TS 运行时的内部面造的（`runtime.conversations.create`、`runtime.supervisor().propose()`、`runtime.catalog.publishDefinition()`、`runtime.modelsInUse()`……）。要迁到 Go，得先给它们找到公开面的造状态路径（受控 provider + HTTP 提案确认），这是 Batch 44 的活。
- **Batch 44 起**：`m8/app-shell-ux` 剩下的 20 条（造状态改走公开面）、`e2e/project-branches` 第二条（浏览器轨）、`m3/production`（**实现耦合**，随 TS 实现退休，但其中的独立契约要逐条点算）、以及 `command-output-preservation` 第二条（原生 shell 大输出落盘，需要先把 Go 的工具结果钩子接上线）。
- **已知差异（有意保留，排在 Batch 35 处理）**：**两条传输的 `max_tokens` 字段名还没与 Pi 对齐**。Pi 对标准 OpenAI 用的是 `max_completion_tokens`（`max_tokens` 只留给 deepseek / together / moonshot / zai 这些厂商），Go 侧**一律发 `max_tokens`**；另外 Pi 还会按**上下文窗口**把上限压下来（`clampMaxTokensToContext`），Go 侧没有这一步。这两处都**没有对应的 TypeScript E2E 契约**（`tests/console/anthropic-transport.test.ts` 只断言 `max_tokens` 与 `stream`），所以不是「删测试带出来的契约」；改字段名对真实 provider 的影响不小（不少 OpenAI 兼容服务只认 `max_tokens`），所以单独立一批处理，而不是顺手改掉。
- **Batch 12 起**：按覆盖矩阵与孤儿契约清单逐条移植。孤儿清单里 101 条 `yes` 每条一条 Go E2E，按主题分簇（预算与用量 / 暂停 / 评审与验收 / 取数 / 内核存储 / 图生命周期 / 会话面 / 沉淀 / 自改进），每簇一个文件。
- **Batch 44**：把「删哪些」算清楚，并逐个处置 `scripts/`、`examples/`、`perf/` 里的 TS 工具消费者。删除集合：**102 个模块**（179 个后端模块 − 56 个 Go 运行时闭包 − 19 个仅前端可达 − 2 个启动器）。**随实现退休的测试文件是 212 个**（207 个直接依赖待删模块，5 个依赖被一并删掉的夹具）。**这里更正 Batch 44 当时的一句话**：当时的结论是「没有一个是混合的」——**不成立**。实际有大批测试**同时**依赖待删模块与保留模块（例如同时用 `src/core/task-runtime.ts` 与 `src/core/store.ts`），它们之所以跟着走，不是因为依赖纯粹，而是因为**它们证明的就是被删掉的那套实现**（直开 `openTaskRuntime` / `TaskStore`、断言私有字段、手写私有表记录）。**外部消费者只有 15 个文件**，逐个处置如下：
  - **已迁移（本批，两处）**：`scripts/interface-e2e.ts`（它本来就通过 `src/server/cli.ts` 启动器驱动 **Go daemon**；改成直接读 daemon 发布的 `console.json`，跑通：onboarding、不误发消息、项目落盘、弹窗键盘可达、4 种宽度、5 条路由全过）与 `scripts/package-app.mjs`（四个纯函数内联，**逐个与原 TS 模块比对过**：`formatBytes` 8 个边界值、`MIN_FREE_BYTES`、告警文案（含自定义阈值）、`freeBytesAt` 全等）。
  - **下一批逐个处置**（每条都有明确归属，不是「以后再说」）：

    | 消费者 | 用到的 TS 模块 | 处置 | 理由 |
    | --- | --- | --- | --- |
    | `scripts/console-ui-e2e.ts` | `server/console-address`、`runtime/tool-call-spool` | 迁移 | 它直接往 **TS 的 SQLite** 写行来造状态，要改成走 Go 的公开面；spool 的目录约定两边本来就一致 |
    | `scripts/harness-real-eval.mjs` | `server/start`、`server/console-address` | 迁移 | 它量的是 Go 侧那几个宿主开关（`GRAPH_COMPACT_DOCUMENTATION` 等），量的是 Go daemon；TS 运行时的调用要改成公开面 |
    | `scripts/harness-worker-eval.mjs` | `server/start`、`core/interface-spec` | 迁移 | 同上 |
    | `scripts/harness-eval-context.mjs` | `catalog/capability-library` | 迁移 | 冻结上下文快照的读写 |
    | `scripts/branch-edge-e2e.mjs` | `server/start`、`core/store` | 迁移或退休 | 分支边界的真实验证 |
    | `scripts/mcp-adapter-e2e.ts` | `core/task-runtime`、`core/store` | 迁移或退休 | MCP 适配器的契约由 Go 的 MCP 客户端承担（`tests/e2e/pig-mcp-session.test.ts`、`pig-kernel-mcp.test.ts`） |
    | `scripts/skill-sediment-e2e.ts` | `runtime/sediment` | 迁移或退休 | 沉淀引擎在 Go 侧有自己的实现；开关语义已由 `tests/e2e/go-sediment-settings.test.ts` 证明 |
    | ~~`scripts/state-reclaim.ts`~~ | `core/owner`、`core/state-retention` | **已退休**（批次 45） | 能力搬进 `graphd reclaim`：Go 侧本来就有 `PlanRetention` / `ApplyRetention`，但**一个调用方都没有**——回收这件事在 Go 后端里存在，却没有任何入口能触发 |
    | ~~`scripts/create-review-module.ts`~~ | `core/review-policy` | **已退休**（批次 46） | 能力搬进 `graphd review-module`：Go 侧本来就有 `ReviewPolicyCode` / `ReviewPolicyInputs`，但**一个调用方都没有**——评审模块生成这件事在 Go 后端里存在，却没有任何入口能触发 |
    | ~~`examples/assemble-matt-team.ts`~~ | `catalog/matt-team`、`catalog/capability-select`、`catalog/capability-library`、`catalog/catalog` | **已退休**（批次 47） | 能力搬进 `graphd assemble-team`：Go 侧本来就有 `AssembleMattTeam`，但**一个调用方都没有**——团队装配这件事在 Go 后端里存在，却没有任何入口能触发 |
    | `examples/m1-demo.ts` | `core/task-runtime`、`core/interface-spec` | 迁移或退休 | 演示 |
    | `examples/m7-acceptance.ts` | `core/task-runtime`、`catalog/models`、`core/graph-acceptance`、`git/git` | 迁移或退休 | m7 验收 harness |
    | `perf/bench/measure.ts` | `server/host`、`core/interface-spec` | 迁移 | 性能基准要量 Go daemon |

  - **三个「Go 侧有实现、没有入口」是最要紧的发现**：回收、评审模块生成、团队组装这三件事，Go 后端里**代码都在**，但没有 CLI/HTTP 入口能触发它们——TypeScript 脚本是它们唯一的调用方。删除实现之前，这三个入口必须先补上（否则功能就此消失），而这正好是「先迁入再删」在 Go 侧的最后一课。
  - **第一个入口已经补上（批次 45）**：**`graphd reclaim`**。回收这件事在 Go 后端里本来就有（`PlanRetention` / `ApplyRetention`），但**一个调用方都没有**——`scripts/state-reclaim.ts` 是它唯一的入口，而那个脚本用的是 TypeScript 的表结构。现在命令是 Go 后端自己的：同一个状态目录上的真数据库、真锁（daemon 正在用这个目录就拒绝）、先备份再回收再 VACUUM。**`scripts/state-reclaim.ts` 随之退休**，`src/core/owner.ts` 与 `src/core/state-retention.ts` 少了一个消费者。新的 Go E2E 证明的是 TypeScript 那份测试承载的契约：**报告时一个字节都不动**、被要求回收时删的正是报出来的那些、**任务出生与变更那两条事件永远留着**、回收前有备份、回收之后状态目录仍然起得来 daemon、对话仍然读得到。**两次回退验证证明这些断言咬得住**：让试运行顺手回收 → 报告里出现了 `applied`（断言红）；让 `--apply` 不删 → 删了 0 条而不是报出来的 7 条（断言红）。
  - **第二个入口已经补上（批次 46）**：**`graphd review-module`**。评审模块的生成规则（`ReviewPolicyCode` / `ReviewPolicyInputs` / 策略校验）本来就在 Go 后端里，但**一个调用方都没有**——`scripts/create-review-module.ts` 是它唯一的入口。现在命令是 Go 后端自己的：`graphd review-module --policy <policy.json> --entry <new-entry.mjs>` 写出隔离求值代码、打印普通 command 模块声明（`requiredInputs` / 端口协议 / `code.entry` + `code.version`）。**`scripts/create-review-module.ts` 随之退休**，`src/core/review-policy.ts` 少了一个消费者；仍需要生成器的 TS 测试（`tests/fixtures/native-patterns.ts`、`tests/m2/verification.test.ts`）改指这个 Go 命令，生成的模块两边都能跑。
    - **这一批挖出一个真 bug**：Go 的 `RunModuleContainer` 在容器**成功退出时没有写退出码**（`Code` 留空），于是宿主把每一次成功的模块求值都当成「退出码未知」的失败——`graph.module.failed` 事件写着 `module process exited with null`，模块队列被暂停。**Go 侧的 command 模块此前从来没有成功跑过一次**（没有 Go E2E 覆盖这条路径，TypeScript 那边的测试又走的 TS 运行时）。修法：成功时把退出码写成 0。
    - 新的 Go E2E（`tests/e2e/go-review-module.test.ts`，1 条）证明的是 TypeScript 那份测试承载的契约：命令写出的声明形状对、**已发布的代码入口不被覆盖**、坏策略在写文件之前就被拒；生成的模块接进**真实的图**之后在**真实的隔离容器**里求值——必填维度失败是业务返工（`rework` 输出、评审人的话、要改的文件、未归属路径），没到齐必填输入时模块等着不动。
    - **两次回退验证证明这些断言咬得住**：把退出码修复回退 → 模块永远求值不出来（断言红）；让命令可以覆盖已发布的入口 → 「入口不被覆盖」那条断言红。
  - **原生 shell 的大输出已经有 Go keeper（批次 48）**：`tests/e2e/command-output-preservation.test.ts` 的第二条一直「仍在案」，因为 Go 侧的 `runtime_tool_results.go` 整份是死代码、`ToolResultHook` 从未被调用、`GRAPH_COMPACT_SHELL_RESULTS` 只在配置里读进来无人用——**看起来是 Go 侧缺一整块实现**。实测下来不是：daemon 现在跑的是 TypeScript 侧车（运行时闭包里保留的那 56 个文件），侧车里的 `durable-tools.ts` 自己就带着那层钩子，于是**契约在 Go daemon 上本来就成立**。新的 `tests/e2e/go-native-shell-output.test.ts`（3 条）把它钉住：整份输出真的在磁盘上、模型看到的是紧凑视图加整份的路径、模型能真的读到中间那段、daemon 重启之后文件与字节都还在；不压缩时模型看到的是 shell 自己的上限；**被压缩的结果不会被后来的命令清掉**（257 次 shell 结果之后第一个仍在）。**一次回退验证证明断言咬得住**：把压缩视图关掉 → 模型看到的长度从 19965 变长（断言红）。
  - **`tests/m3/production.test.ts` 的 11 条逐条点算（批次 49）**：这份测试是实现耦合的（`openTaskRuntime` + `createApp`），随 TS 实现退休，但它承载的**独立契约**要一条一条有去处。点算结果：

    | 契约 | 处置 |
    | --- | --- |
    | production master 收到工具、提出一张图、后续用户消息能叫醒它 | 已有：`go-graph-confirmation.test.ts`（草稿→确认→图真的跑起来）+ `go-pause-resume.test.ts`（后续消息真的到达）。master 自己的 `validate_proposal` / `propose_graph` 工具面（坏提案被指名拒、旧形状被拒）由批次 51 补上：`go-master-surface.test.ts` 第 2 条 |
    | master 收到紧凑规则、没有那段被删掉的工作流提示 | 已有：`go-agent-context.test.ts`（搜索规则只点名真有的工具、宿主不改写用户规则、文档指针可压缩）+ 批次 51 的 `go-master-surface.test.ts` 第 1 条（`<rules>` 段、R14 那条文案、被删掉的工作流提示真的不在） |
    | 后续用户消息真的送到 master 的 provider | 已有：`go-pause-resume.test.ts` + `go-conversation-queue.test.ts` |
    | 一个 Pi 回合可以超过单次预留而不被挡住 | 已有：`go-harness-cost.test.ts`（账本里的请求数与 token 数对得上）+ `go-node-budget.test.ts`（预留与结算各记一次） |
    | **未知的用量挡住下一次 provider 调用** | 批次 50 补上：`go-unknown-usage.test.ts` 第 1 条 |
    | **原生对账把已知与缺失的调用各记一次，在 main 处理之前输入一直挡着** | 批次 50 补上：`go-unknown-usage.test.ts` 第 1 条（对账同一值是同一答案、不同值被拒） |
    | 超出预算的请求不能发下一次调用 | 已有：`go-main-budget.test.ts` + `go-node-budget.test.ts` |
    | 原生 worker 收到图的检查命令与验收 | 批次 49 补上：`go-node-lane.test.ts` 第 1 条 |
    | 原生 reviewer 收到并发出版本化的独立评审 schema | 批次 49 补上：`go-node-lane.test.ts` 第 2 条 |
    | 原生 worker 只写自己隔离的工作副本 | 批次 49 补上：`go-node-lane.test.ts` 第 1 条 |
    | HTTP 生产 master 能先讨论再提出 | 已有：`go-graph-confirmation.test.ts` |
    | （附带）`read_graph` 的分页与修订推进 | 批次 51 补上：`go-read-graph.test.ts`（命名对象整份读出、分页游标、修订推进） |

    **原先在案 4 条**：master 的提案工具面、`<rules>` 段的具体文案、未知用量挡住下一次调用、原生对账各记一次。
    - **批次 50 做完了后两条**：见下面的批次 50 条目。**批次 51 做完了前两条**：见下面的批次 51 条目。**`tests/m3/production.test.ts` 这 11 条至此全部有 Go keeper——仍在案 0 条。**
