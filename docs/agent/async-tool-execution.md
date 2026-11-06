# 异步工具调用：挂起 / 恢复契约与失败边界

<!-- graph:allow-large-file: 契约与独占文件清单是三条并行车道 + 两个审查节点同一次读完的同一份接口；按主题拆成两个文件会让清单里每个路径与它引用的决策分别漂移（再长就按 §9 / §1-8 拆） -->

本文是「异步 ReAct 循环」的设计契约：**长工具怎么才能不占住一轮回合**，以及**三条并行车道的独占文件清单**。文档是三条车道之间的接口；车道实现期间不改本文，契约要变就走 merge 合流节点。

## 1. 事实：卡在哪

- 忙碌时消息**已被接受并排队**：`state=queued` 落库（`core_task_runtime_conversation_chat.go:148-166`），发送按钮在 `busy` 时可用（`composerPrimaryDisabled`，`src/web/composer-state.ts:86-92`）。"不能发消息"不是问题。
- 真正的阻塞是**一轮回合被长工具占住**：工具在 durable submission 内同步执行（`runtime_pig_session.go` 的 `pigToolSpecs` → `gated(...)`），`session.Prompt` 一直等到 submission 落定（`backend/internal/pigkernel/session.go:235-355`）。工具不返回，回合不结束，排队的第二条消息只能等。
- 回合是串行队列的一项：`NodeExecutor.RunNode` 一次只 `Claim` 一条（`core_node_executor.go:83-110`），一次只有一条 execution 在跑（`core_execution_dispatch.go:113-168`）。"第二条消息晚于长工具"因此是结构性的。
- 派发要过"运行中的 execution"这道门：`KernelToolGate.Dispatch` 要求 `kernel.RunningExecution(...)` 存在（`runtime_kernel_tool_gate.go:15`），否则 `Raise("paused")`。**回合结束后才完成的工具不能在完成时再过一次这道门**——本设计最重要的边界。
- 工具失败原因**不进会话记录**：`ConversationActivityRecords` 只写 `tool`/`toolCallId`/`error:true`（`core_conversation_messages.go:39-57`），原因只进节点 entries（`runtime_pi_adapter_events.go:190-217`）。
- 回合结束会把该回合**所有工具行刷成 done**：`RecordConversationOutput` 传 `activeToolIds=nil`（`core_conversation_usage.go:134`），跨回合工具在回合结束瞬间就显示"完成"。
- `messages.state='pending'` 会被队列读走：`PendingMessages` 选 `pending`/`queued` 且不过滤角色（`core_conversation_failures.go:47`），`core_execution_nodes.go:154` 用它判滞留。**"工具在跑"不能复用 `pending`。**

## 2. 判定一：哪些工具异步 —— 显式 opt-in，不做阈值

**选择：显式 opt-in。** 两个声明点，都不看墙钟：

1. **工具声明**（`ToolDefinition.Async`）：每次调用都挂起，只给"时长天然无界"的工具（本轮不发：`agent_browser`、模块 `workspace.command`、远端 MCP、`delegate`/`send_to_peer`）。
2. **调用参数**（`async: true` 实参）：时长摆动的工具用它。本次只落 `bash`（`runtime_pig_native_handlers.go` 的 `pigBashTool`），描述写明"预计超过约 20 秒的命令（构建、测试、安装）把它设为 true，结果会作为后续消息到达"。

**为什么不做超阈值自动挂起**：

- 阈值把行为绑在墙钟上，违反"测试只断言确定事实、不依赖负载"（`AGENTS.md`）：同一条命令慢机挂起、快机同步，E2E 随负载翻面。
- 模型必须**事前**知道自己挂起了，否则只能含糊作答或假装拿到结果。声明式 opt-in 让"我发起了后台工具"成为模型自己的动作。
- 准入是**派发时刻**的事实：预算预留、权限、门禁都在调用开始时发生（`runtime_kernel_tool_gate.go:15-40`）。事后才决定挂起时这一轮已经开始，收不回来。
- 阈值需要一个"多久算慢"的常数，它随模型、机器、项目漂移，变成没人敢动的魔法值。

**快速工具为什么仍然同步**：同步路径**一行没变**。工具返回即回到同一轮 ReAct 循环，provider 请求数不变（A6：一次 `bash` + 一次最终答复 = 两次请求）。异步是加法，不是替换。

## 3. 判定二：挂起 / 恢复契约

### 3.1 一轮回合如何结束

挂起的单位是**工具调用**，不是回合；回合从头到尾不知道自己"挂起"过：

1. 模型发出 `tool_call`，`toolCallId` 已定。
2. 包装层判定本次是否异步（§2）。异步时**此刻完成准入**（工具门禁 + 预算预留，仍在运行中的 execution 内），建一条 `deferred_tool_calls` 行，把作业交给守护进程自己的作业注册表，并同步给模型一条受理结果：
   `{"status":"accepted","state":"running","toolCallId":"...","operationId":"...","text":"已在后台执行，结果会作为后续消息到达；不要重复调用。"}`
3. 模型拿着这条结果继续这一轮；回合照常结束，submission 照常落定。
4. execution 完成，节点回到可服务状态，队列里的第二条消息随即被领取并答复。

### 3.2 会话如何回到可服务状态

- 执行体**不属于这个 submission**：它在守护进程的作业注册表里，用自有上下文（不能是 `Execute` 收到的 `ctx`，那是 submission 的，回合结束即取消）。第一条硬边界。
- 回合结束后不遗留 `pending`/`queued`：工具的"在跑"用新的 `MessageStateRunning`，不进 `PendingMessages` 与滞留判定所用的集合（§8 F5）。
- 节点状态沿用现有语义：收尾后 `queuedAfter==0` 就 `succeeded`，否则 `pending`（`core_operation_settle.go:226-241`）。挂起的工具**不**让节点保持忙碌——"正在跑"属工具调用，不属回合。这正是 A5"输入框可用、新消息可发送"成立的原因。

### 3.3 结果如何回到会话（同一 `toolCallId` 的延迟观察）

- 复用**唤醒账本**：`WakeMaster(store, WakeIntent{Kind:"tool_settled", DedupeKey:"deferred:<toolCallId>", ...})`。`wake_intents` 在 `(task_id,node_id,kind,dedupe_key)` 上唯一（`core_store_schema.go` 的 `schemaV40`），`WakeMaster` 用 `INSERT OR IGNORE`，`ConsumeWake` 把唤醒绑给真正读它的那次 operation（`core_wake_ledger.go:36-70`、`core_operation_settle.go:274-290`）。**同一 `toolCallId` 只产生一条唤醒。**
- 载荷进入下一轮回合简报（`core_execution_admit.go:247` 的 `RenderWakes`），新增 `tool_settled` 分支：工具名、`toolCallId`、结果摘要或失败原因。
- **不把延迟结果做成 orphan tool result**：provider 侧会丢弃它——`controlledToolResults`/`controlledOpenAIToolMessages` 丢掉"答复不了本轮任何调用"的结果，并给缺结果的调用补 `No result provided`（`runtime_tool_flow.go:57-100`）。延迟观察走"唤醒 + 系统记录"。
- 会话里的观察记录**只有一条**：它就是工具行从 `running` 变成 `done`/`error` 的那次更新（同一 `messages.id`、同一 `toolCallId`、同一 `activityKey`），走 `PersistConversationActivity` 的 upsert（`core_conversation_messages.go:95-140`）。不新增第二条同 `toolCallId` 的结果行。

### 3.4 数据

```sql
CREATE TABLE IF NOT EXISTS deferred_tool_calls(
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id),          -- 会话锚点任务
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  node_id         TEXT NOT NULL,                               -- 发起调用的 master 节点
  execution_id    TEXT NOT NULL,                               -- 准入时的 execution：结算归属
  operation_id    TEXT NOT NULL,                               -- 发起调用的那一轮
  tool_call_id    TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  request_id      TEXT NOT NULL,                               -- 幂等键（缺省 = toolCallId）
  request_digest  TEXT NOT NULL,                               -- 参数摘要：同 requestId 必须同参数
  state           TEXT NOT NULL CHECK(state IN
                    ('accepted','running','settled','failed','cancelled','timed_out','interrupted')),
  args TEXT, summary TEXT, result TEXT, reason TEXT,
  started_at INTEGER NOT NULL, deadline_at INTEGER, finished_at INTEGER,
  UNIQUE(conversation_id, tool_call_id),
  UNIQUE(conversation_id, request_id));
CREATE INDEX IF NOT EXISTS deferred_tool_calls_live ON deferred_tool_calls(state, deadline_at);
```

不变量：**一行要么是终态（`settled`/`failed`/`cancelled`/`timed_out`/`interrupted`），要么注册表里有它的活作业。** 都不是就是孤儿，由启动对账收尾（§4）。

### 3.5 HTTP 契约（laneA 与 laneC 的接口，先冻结）

```
GET  /api/conversations/{conversationId}/tool-calls
→ 200 {"toolCalls":[{"toolCallId","name","summary","state","requestId","operationId",
                     "startedAt","finishedAt","reason","result"}]}

POST /api/conversations/{conversationId}/tool-calls/{toolCallId}/cancel   {"requestId":"..."}
→ 200 {"toolCallId","state":"cancelled","reason","cursor"}
   同一 requestId 重放返回同一结果，不产生第二次取消。
```

`state` 取值同表。E2E 只读这两个端点与 `/history`，不读 sqlite 内部表。

## 4. 判定三：取消与超时走同一条收尾路径

只有一个函数能写终态：`finalizeDeferredToolCall(callId, state, reason, payload)`（`runtime_deferred_tool_settle.go`）。五个触发点都走它：

| 触发 | 入口 | 终态 |
| --- | --- | --- |
| 作业正常返回 | 作业 goroutine | `settled` |
| 作业抛错 / 工具 error | 作业 goroutine | `failed` + 原因 |
| 用户取消 | `POST .../tool-calls/{id}/cancel`（`store.Command` 去重） | `cancelled` + 原因 |
| 超时 | `deadline_at` 定时器 | `timed_out` + 原因 |
| 进程退出 / 重启发现孤儿 | `RecoverDeferredToolCalls()` | `interrupted` + 原因 |

它在一个事务里按序做五件事：① 已终态则返回（幂等）；② 写终态与 `finished_at`；③ `gate.Settle(callId, usage)` 结掉派发时开的那笔账（`KernelToolGate.Settle` 只写事件、不要求 execution 仍在跑，`runtime_kernel_tool_gate.go:50-52`）；④ 把工具行刷成 `done`/`error` 并带原因；⑤ 写 `tool_settled` 唤醒。**没有僵尸 operation**，因为：

- 终态行与唤醒在同一事务里落下；写失败整体回滚，作业仍在注册表（重试，或退出时标 `interrupted`）。
- 取消先把作业的 `AbortSignal` 置位再等它退出，之后才写终态；命令超时本来就走同一条 SIGKILL 收尾（`runtime_host_command.go:241-243`）。
- 启动对账不需要记忆：扫 `accepted`/`running`，本进程没有对应作业的全部按 `interrupted` 收尾；重启一次自愈，幂等键保证不重复写观察。

## 5. requestId 幂等：同一请求不产生第二次副作用

三层，缺一不可：

1. **HTTP 命令层**：动作都带 `requestId`，`store.Command(scope, requestId, ...)` 把结果写进 `commands`，重放返回首次结果（`Chat`、`CancelMessage` 即如此）。取消工具调用用同一套。
2. **工具调用层**：`UNIQUE(conversation_id, tool_call_id)`。崩溃后 submission 被重放时同一 `toolCallId` 会再执行一次 `Execute`；包装层先查行——已有行就**不启动第二个作业**，直接把已有状态当受理结果返回。这是 A4 的核心。
3. **请求层**：`UNIQUE(conversation_id, request_id)` + `request_digest`。模型在新一轮用同一显式 `requestId` 重发同一逻辑作业 → 同一行；摘要不一致则 `Raise("invalid_input")`，绝不复用别人的副作用。

副作用的可证伪证据由 E2E 给：慢工具往文件 append 一行，重放后文件仍只有一行。

## 6. 判定四：失败如何回报给模型与用户

- **给模型**：`tool_settled` 唤醒携带 `ok:false` + 截断后的 `reason`，下一轮读到"工具 X（调用 tc-1）失败：<原因>"，可自行决定重试、换法或如实告知用户。
- **给用户**：工具行终态 `error`，并且会话记录**带上原因文本**——需新增：`ConversationActivityRecords` 把 `message` 写进 `Data`（`core_conversation_messages.go:39-57`），控制台渲染 `data.message`（laneB）。今天原因只落在节点 entries 里。
- 取消/超时同理：终态 `cancelled`/`timed_out` + 原因，一行，同一 `toolCallId`。

## 7. 判定五：为什么不会出现同一会话两个并发模型回合

四条独立理由，任一条成立就够：

1. **队列串行**：`RunNode` 一次只 `Claim` 一条队列项（`core_node_executor.go:83-110`）。
2. **graph 层互斥**：`activeGraphs[taskId]` 保证同一任务同时只有一个驱动（`core_execution_dispatch.go:113-168`）。
3. **durable 会话层**：同一 identity 的 submission 用 `WhenBusyReject`（`backend/internal/pigkernel/session.go:283-290`），开会话前还 `WaitConversationIdle`（`runtime_pig_session.go:64-72`）。第二个输入只能排队或等待。
4. **唤醒不是旁路**：`tool_settled` 只是持久意图，`WakeMaster` 走 `ResumeSucceededNode` 把节点置为待运行，仍由 1、2 派发，从不直接调 `Prompt`。

`steer` 是唯一"进入正在跑的回合"的通道，它是同回合续写（`WhenBusySteer`），不是第二个回合。

## 8. 失败模式清单（先列，再写代码）

按 R24，实现前这份清单就是说明书；每条都要有对应 E2E 断言，或明确判为不可测。

| # | 失败模式 | 现在的后果 | 处置 |
| --- | --- | --- | --- |
| F1 | 作业用 submission 的 ctx | 回合结束即取消，工具半途死掉无记录 | 作业用自有上下文 |
| F2 | 完成时再过工具门禁 | `Raise("paused")`，结果回不来 | 只在派发时准入，完成只 `Settle` |
| F3 | 崩溃后行停在 `running` | 僵尸调用，永远"进行中" | 启动对账 → `interrupted` + 原因 + 唤醒 |
| F4 | 投递重复（重放/重试） | 同一结果出现两次 | 终态+唤醒同事务；`wake_intents` 唯一键 |
| F5 | 用 `pending` 表达"在跑" | 被队列/滞留判定当待办，节点自唤醒 | 用 `MessageStateRunning` |
| F6 | 回合结束刷成 done | 跨回合工具显示"完成" | 收尾保留仍活的调用为 `running` |
| F7 | 取消与超时分叉 | 一条留下 `accepted` 僵尸 | 单一 `finalizeDeferredToolCall` |
| F8 | 模型重复调用同一作业 | 两次副作用 | 两个唯一键 + 摘要校验 |
| F9 | 长工具占住一轮 | 第二条消息晚于工具完成 | 受理即返回，回合立即落定 |
| F10 | 延迟结果当 orphan tool result | provider 丢弃或补 `No result provided` | 走唤醒通道 |
| F11 | 工具描述变长 | 撑破 10,400 / 200 预算 | 在既有预算内压缩；不许改小 schema 测试上限 |
| F12 | 新表绕过单写者规则 | `check:ownership` 红 | 登记到 `scripts/check-table-ownership.mjs` |

## 9. 三条车道的独占文件清单

清单**排他**：一个文件只能属于一条车道，`git status` 里出现清单外路径就是越界，merge 会把越界路径退回集成点。

互不重叠的证明：laneA 只写 `backend/internal/graph/**` 与 `scripts/check-table-ownership.mjs`；laneB 只写 `src/core/**` 与 `src/web/**`；laneC 只写 `tests/e2e/**`、`tests/suite-baseline.json`、`tests/env-layers.json`。三段两两不相交，唯一跨段的路径是 `tests/harness-surface.json`，它在下面"共享文件"里被单独指派给 laneA 且不在 laneC 清单内。

### laneA — 后端（Go）

新增（7）：

```
backend/internal/graph/core_store_schema_deferred_calls.go
backend/internal/graph/core_deferred_tool_calls.go
backend/internal/graph/runtime_deferred_tool_call.go
backend/internal/graph/runtime_deferred_tool_settle.go
backend/internal/graph/runtime_deferred_tool_wake.go
backend/internal/graph/core_task_runtime_conversation_tool_call.go
backend/internal/graph/server_app_tool_calls.go
```

修改（15）：

```
backend/internal/graph/core_store.go                        # SCHEMA_VERSION 54 → 55
backend/internal/graph/core_store_migrate.go                # 跑一次 schemaV55
backend/internal/graph/core_conversation.go                 # MessageStateRunning
backend/internal/graph/core_conversation_messages.go        # running 映射；终态就地更新；原因进 Data
backend/internal/graph/core_conversation_usage.go           # 收尾时保留仍活的调用
backend/internal/graph/core_conversation_activity_items.go  # activityKey 收敛：延迟结果更新同一行
backend/internal/graph/runtime_pi_adapter_events.go         # 工具 start/end 记 deferred 与原因
backend/internal/graph/runtime_agent_tools.go               # ToolDefinition.Async
backend/internal/graph/runtime_pi_worker_config.go          # 门禁 Settle 交给作业
backend/internal/graph/runtime_pig_session.go               # 挂起判定 + 受理结果
backend/internal/graph/runtime_pig_native_handlers.go       # bash 的 async 实参
backend/internal/graph/core_wake_ledger.go                  # tool_settled 种类 + 渲染
backend/internal/graph/core_task_runtime_dispatch.go        # 启动对账入口
backend/internal/graph/server_app_routes.go                 # 两条路由
scripts/check-table-ownership.mjs                           # 登记 deferred_tool_calls
```

### laneB — 控制台（TypeScript）

```
src/core/conversation-projection.ts
src/web/transcript-model.ts
src/web/TranscriptRows.tsx
src/web/styles-section-03.css
```

要点：`TERMINAL_OPERATION_EVENTS` 现在会把该 operation 的 live tool 从投影里删掉（`src/core/conversation-projection.ts:271-276`），跨回合工具会凭空消失——按 `deferred`/`state==='running'` 留下来；`TranscriptRows.tsx:207` 的状态格区分"进行中（后台）"；失败要显示 `data.message` 的原因。
不必改 `ChatComposer`/`conversation-state.tsx`/`Conversation.tsx`：输入框在 `busy` 时本来就可用（§1、§3.2）。

### laneC — E2E

```
tests/e2e/go-deferred-tool-ordering.test.ts        # A2：第二条消息答复早于慢工具完成；结果只出现一次
tests/e2e/go-deferred-tool-cancel-timeout.test.ts  # A3：取消/超时同一收尾，无僵尸；重启对账
tests/e2e/go-deferred-tool-idempotent.test.ts      # A4：同 requestId/toolCallId 重放一次副作用
tests/e2e/go-deferred-tool-console.test.ts         # A5：浏览器里运行中、输入可用、可发新消息、失败显示原因
tests/e2e/harness-tool-fast-path.test.ts           # A6：快速工具同轮返回，不多付模型往返
tests/suite-baseline.json                          # 用例数只增不减
tests/env-layers.json                              # 浏览器用例登记到 window-services 层
```

### 共享文件：点名 + 冲突点

| 文件 | 归属 | 冲突点 |
| --- | --- | --- |
| `backend/internal/graph/runtime_kernel_operation_broker.go` | **本次不动** | 冲突点：`ExecuteModuleOperation` 的 `dispatched`/`uncertain` 拒绝重放语义（`runtime_kernel_operation_broker.go:181-182`）与 `rsiAdmitSource` 的集成判定，是模块投递"这次副作用算不算发生"的判定。一旦把 `workspace.command` 也做成可挂起，deferred 行就得替代 `kernel_module_operations` 承载终态，两者会抢同一个判定。本轮只做 `bash`，不碰。 |
| `backend/internal/graph/core_store.go` + `core_store_migrate.go` | laneA | 版本号只能被取一次：若合流时上游已占用 55，在 merge 节点一起抬到 56，不并存两套。 |
| `scripts/check-table-ownership.mjs` | laneA | 新表必须登记唯一写者，否则 `check:ownership` 红。laneC 不得为了让测试过而改它。 |
| `tests/harness-surface.json` | laneA（显式刷新） | laneA 改 `runtime_agent_tools.go`/`runtime_pig_native_tools.go`/`runtime_pig_native_handlers.go` 会让 harness surface 变化；`check:harness` 不会因此失败，但记录会过期，刷新是显式动作（`GRAPH_HARNESS_GATE_RECORD=1 node --run check:harness`），归 laneA。laneC 不得顺手改。 |
| `tests/e2e/harness-tool-schema.test.ts` | 只读、不放宽 | 它守着 10,400 / 200 的工具预算。laneA 必须塞进预算；塞不下由 merge 裁决，车道不许自己抬上限。 |
| `docs/agent/async-tool-execution.md`、`docs/agent/INDEX.md` | design（本节点） | 契约冻结。车道认为契约不可实现，写进 `result` 让 merge 改文档，**不要自己改**。 |

## 10. 验收如何被证明

- **A2**：真守护进程 + 真 provider；模型调 `bash {command:"sh -c 'sleep 30; echo done'", async:true}`，回合立刻答复"已在后台执行"；未完成时用 HTTP 发第二条消息拿到答复（时间戳 T2），工具完成时间戳 T3（读 `GET .../tool-calls`）。断言 `T2 < T3`（因果顺序，不是墙钟比较），且 `role='tool'` 中该 `toolCallId` 的行恰好一条、文本含 `done`。
- **A3**：取消与超时各一例：终态为 `cancelled`/`timed_out`、都带原因、都只有一条观察；杀进程重启后原在跑的行变 `interrupted` 且不新增观察。
- **A4**：同 `requestId` 同参数重放 → 同一行、文件只有一行副作用；同 `requestId` 不同参数 → 明确报错。
- **A5**：浏览器 E2E：工具行显示运行中、输入框可用、能发新消息并在记录里看到；失败用例断言原因可见。
- **A6**：快速 `bash`：provider 恰好两次请求，第二次带该调用的结果，回合只有一条最终答复。
- **A7**：`node --run check` 绿；`tests/suite-baseline.json` 用例数不减；工具预算仍 ≤10,400 / 平均 ≤200；没有新增单元或集成测试。

## 11. 不在本轮范围

- `workspace.command` / 模块操作 / `agent_browser` / 远端 MCP / `delegate` 的异步化（机制通用，逐个开）。
- 挂起工具的并行完成：本设计允许，但不额外排程；结果按 `toolCallId` 各自成行。
- 挂起工具的跨进程接管：本轮只做"收尾成 `interrupted`"，不续跑作业。

## 12. 合流后写回的判定（merge）

合流时三条车道已落地的实现与本文有四处偏差/空白，merge 逐条裁决如下。

### 12.1 工具 schema 必须真的把 `async` 与 `requestId` 交到模型手里（已补）

§2 说挂起是"模型自己的动作"，§5 说幂等键是"模型在新一轮用同一显式 `requestId` 重发"。laneA 已让 `bash` 接受这两个实参，但 JSON schema 只声明了 `command` / `timeout`：模型看不到的实参等于不存在（严格模式的 provider 还会直接拒收未声明属性），于是 §5 的第三层在真实会话里无从触发，只有 E2E 能直接塞进去。merge 在 `pigBashTool` 的 `parameters` 里补上 `async` 与 `requestId`（含一句用途），并同步 `runtime_pi_native_tools.go` 的目录清单。工具描述预算不变（预算按 `description` 计，参数在 `input_schema`）。

### 12.2 崩溃重放且未显式给 `requestId` 时，命令可能跑第二次（本轮写进已知限制，不修）

§5 第 2 层 `UNIQUE(conversation_id, tool_call_id)` 只能在模型自己的 `toolCallId` 可知之后才生效，而它要等工具返回（实参里没有它）。所以：submission 崩溃重放会带着**新的**调用 id 再执行一次工具体，缺省 `requestId`（= 那次调用的 id）随之不同，于是建出第二行、起第二个作业。绑定冲突会被发现、已有行绝不会被覆盖，但**命令本身可能已经跑了两次**。

本轮不修的理由：把它做对需要在工具体执行**之前**拿到 `toolCallId`，那是 `pigkernel` 的 `ToolExecutionApi.CallId`，不在本轮任何车道的文件清单里；用"参数摘要"代替调用 id 会把同一回合里两次**故意相同**的调用（例如两次 `ls`）错误合并成一次作业，代价比这个窗口更大。

明确的边界：**A4 冻结的那一层（显式 `requestId`）是完整的**；需要"绝不重复副作用"的调用应当带 `requestId`。这条写在这里，作为 §5 的已知限制，而不是留成一条没人知道的裂缝。

### 12.3 没有 conversation 行的会话：结果只回到行与唤醒，没有工具行可就地关闭（已知限制）

`deferred_tool_calls.conversation_id` 可为 NULL（节点会话没有 `conversations` 行），此时 §3.3 的"同一 `toolCallId` 就地更新"没有目标行；deferred 行与 `tool_settled` 唤醒仍然完整。这是 §9 车道清单里那条"新表覆盖两种行"的必然结果，不是缺陷。

### 12.4 终态非 `settled` 的调用把工具行写成 `failed`（与 §8 F6 一致）

`failed` / `cancelled` / `timed_out` / `interrupted` 一律让工具行 `state=failed` + `data.error=true` + `data.message`（原因），`settled` 才是 `done` + `data.result`。laneB 的投影据此把超时与中断也算失败；§6 的"原因可见"因此对四种失败都成立。

### 12.5 工具行上的状态字段名统一为 `state`（已改）

laneB 的控制台契约把「deferred 状态」读作 `data.state`（`accepted|running` → 运行中，五个终态 → 结束，顺序：`data.state` 终态 > `message.state` done/error > deferred 运行态）；laneA 写的是 `data.deferredState`，于是那条文档化的来源永远读不到，`已取消/已超时/已中断` 的区分与 `deferred` 标记只能靠 `message.state` 的粗判兜底。merge 把 laneA 的写入改名为 `data.state`（一行），两边的契约因此字面成立；`message.state` 仍是运行/结束的主判据，`data.state` 补上「哪一种结束」。

### 12.6 控制台两个文件已顶到 500 行上限（本轮不拆，下一轮先拆）

`src/web/transcript-model.ts` 498 行、`src/web/TranscriptRows.tsx` 500 行（上限 500，允许等于）。本轮不再往里加东西；下一次要改这两个文件里的逻辑，必须先拆分，并把拆出来的新文件加进 §9 的 laneB 清单——拆分不能由车道私自扩清单，也不能靠把上限调大绕过去。

### 12.7 终态行保留 `data.state`：成功结算的工具组不会被折进完成回合（已定）

laneB 指出一个会直接影响 A5 的放置问题：工具行结算后是否还是一个可见工具组，取决于它是否仍带着标记（`data.state` / `data.deferred` / 有 `reason`）。成功结算且一个标记都不带的行会收进完成回合的 `collapsed-turn`，而折叠态的子节点根本不渲染——于是「成功 settle 后同一个 li 变 `data-done=true`」不能当无条件事实。

裁决：**终态行一律保留 `data.state`**（§12.5 的改名已经做到：`settled` 也写）。于是：

- 成功结算的 deferred 行在**全新快照**里仍是可见工具组（不依赖前端增量合并时保留 `deferred` 的技巧），A5 可以稳定地断言「放行后同一组不再是进行中」；
- 失败/取消/超时/中断本来就带 `reason`，同样可见；
- 普通同步工具（无标记、无原因）照旧折进完成回合——laneB 的 m8 断言「完成回合折叠后 `tool-activity-group` 计数为 0」仍然成立。

证据（一次性探针，用真的 `buildTranscriptRows` 重建快照）：settled deferred 行 → 可见 tools 组且 `done`；cancelled 行 → 可见且带 `state` 与原因原文；无标记的普通完成工具 → 仍被折叠。三条都 PASS。

### 12.8 控制台把 `failed` 当作终态（已改，A5 的回归点）

后端把终态非 `settled` 的调用行写成 `messages.state='failed'`（§12.4），但控制台的 `toolCallDisplay` 只把 `done|error` 当作结束，且只读 `data.state`（早期后端写的是 `data.deferredState`）。后果是超时/取消/中断的工具行永远 `!done`：工具组一直显示「进行中/后台执行中」，失败原因虽然写进了 `data.message` 却挂在一条"还在跑"的行下，A5 的失败一例因此拿不到带 `data-error` 的终态组。

裁决：控制台的终态判定同时接受三条来源——`data.state`（或旧名 `data.deferredState`）落在五个终态里、`message.state` 为 `done|error|failed`、以及本轮已结束且不是后台调用；并且 `已取消/已超时/已中断` 三种标签优先于「失败」（它们也是 error 行，但读者要知道是哪一种结束）。A5 里补了三条对应断言：放行后同一组不再含「进行中」且行上 `data-done=true`、状态格「完成」；超时后行上 `data-done=true`/`data-state=timed_out`、状态格「已超时」、组带 `data-error` 且原因在组内可见。

### 12.9 取消是「停止」，不是「失败」（控制台表现层，`2ca743b6`）

服务端把每个非 `settled` 的终态行都标成 error（§12.4：`messages.state='failed'`、`data.error=true`、`data.message=原因`），因为对模型与 API 来说这次调用确实没有产出。控制台在这之上再区分一次：

- `cancelled`：用户自己的动作 → 状态格「已取消」、组上 `data-error=false`、原因照常可见；
- `timed_out` / `interrupted` / `failed`：仍是失败 → `data-error=true`、状态格「已超时/已中断/失败」。

判定全部读行上的 `data.state`（旧名 `data.deferredState` 同义）；deferred 行不再让通用文本/标志启发式（`toolError(message)`）覆盖自己的状态——否则取消会被 `data.error` 压回「失败」。

为什么不是「服务端别写 error」：`data.error` 是给模型与 API 的机器可读事实（§12.4，A3 的断言也依赖它），改它会改动已冻结的契约。两层各自成立：机器读「没有结果」，人读「你自己收回的」。
