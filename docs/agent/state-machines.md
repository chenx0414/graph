# 状态机地图

Graph 里每一个会变的状态都归属于一台状态机：谁写它、谁读它、哪些转移合法、到什么状态就该收尾。
机器可读的唯一来源是 [backend/statemachine/machines.json](../../backend/statemachine/machines.json)：
它是一份按主题分片的索引（`parts` 指向 `backend/statemachine/machines/*.json`），每片都不超过文件预算，
加载时按索引顺序合并；这份文档是它的人读视图，每台机器的状态与转移明细在
[state-machines-reference.md](state-machines-reference.md)。

读这份地图的三种人各取所需：

- 用户看到的「运行中 / 阻塞 / 已完成」都出自注册表里的标签与 tone，界面不再自己发明状态词。
- 开发者改一条转移时先改注册表，门禁会指出源码里与注册表不一致的那一处。
- Agent 用 `go -C backend run ./cmd/graphcheck machines` 一次拿到全部状态机与证据，不必逐文件猜。

## 核对

```sh
go -C backend run ./cmd/graphcheck machines            # 注册表自洽，且与源码证据一致
go -C backend test ./statemachine -count=1             # 本文与明细文档同注册表不漂移
go -C backend run ./cmd/graphcheck machines --verbose  # 逐条证据：表.列 = 状态 → 文件
GRAPH_UPDATE_ATLAS=1 go -C backend test ./statemachine -run Atlas -count=1  # 注册表变了就重写两张清单
```

文档被手改而注册表未动时，`go test` 可能命中缓存；带 `-count=1` 才能当场看出漂移。门禁判定什么、失败了怎么改，看它自己的输出。

## 总表

<!-- atlas:table:start -->

| id | 机器 | 落库位置 | 状态数 | 初始 | 终态 |
| --- | --- | --- | --- | --- | --- |
| `task.phase` | 任务阶段 | `tasks.phase` | 11 | `discussing` | `completed`、`stopped`、`abandoned` |
| `node.status` | 节点状态 | `kernel_nodes.status`、`nodes.status` | 9 | `pending` | `retired` |
| `execution.state` | 执行状态 | `kernel_executions.state` | 4 | `running` | `completed` |
| `queue.state` | 队列项状态 | `kernel_queue.state` | 4 | `queued` | `done` |
| `delivery.state` | 投递状态 | `kernel_deliveries.state` | 1 | `accepted` | `accepted` |
| `provider_call.state` | 模型调用状态 | `kernel_provider_calls.state` | 4 | `inflight` | `reconciled` |
| `module_operation.state` | 模块操作状态 | `kernel_module_operations.state` | 7 | `prepared` | `settled`、`failed`、`cancelled` |
| `create_request.state` | 图创建请求状态 | `kernel_create_requests.state` | 3 | `preparing` | `ready` |
| `operation.state` | 执行操作状态（旧） | `operations.state` | 11 | `intent` | `settled`、`abandoned` |
| `activation.state` | 节点激活状态（旧） | `activations.state` | 7 | `pending` | `succeeded`、`failed` |
| `message.state` | 消息状态 | `messages.state` | 7 | `pending`、`queued`、`running`、`done`、`failed` | `failed`、`cancelled`、`done` |
| `question.status` | 问题状态 | `questions.status` | 2 | `open` | `resolved` |
| `question.route_stage` | 问题处理阶段 | `questions.route_stage` | 3 | `project` | `user` |
| `node_question.state` | 节点问题状态 | `node_questions.state` | 3 | `recorded` | `answered` |
| `work_request.state` | 工作请求状态 | `work_requests.state` | 5 | `clarifying` | `completed`、`cancelled` |
| `work_graph.state` | 工作图状态 | `work_graphs.state` | 3 | `preparing` | （无） |
| `continuation.state` | 续跑请求状态 | `rsi_continuations.state`、`pause_continuations.state` | 4 | `waiting` | `cancelled` |
| `wake_intent.state` | 唤醒意图状态 | `wake_intents.state` | 3 | `waiting` | （无） |
| `deferred_tool_call.state` | 延迟工具调用状态 | `deferred_tool_calls.state` | 7 | `accepted` | `settled`、`failed`、`cancelled`、`timed_out`、`interrupted` |
| `conversation_goal.status` | 会话目标状态 | `conversation_goals.status` | 6 | `active` | `completed` |
| `artifact.state` | 产物状态 | `artifacts.state` | 2 | `published` | `retired` |
| `git_op.state` | Git 操作状态 | `git_ops.state` | 5 | `intent` | `succeeded`、`failed` |
| `project_preparation.state` | 项目准备状态 | `project_preparation.state` | 5 | `detected` | `ready`、`not_a_repository` |
| `fleet.agent_status` | 编队 Agent 状态 | （派生，不落库） | 6 | （无） | `done`、`stopped` |
| `providers.credential` | 供应商凭据状态 | （派生，不落库） | 4 | （无） | （无） |

<!-- atlas:table:end -->




## 运行期状态机（不落库）

这些状态只活在进程内存里，重启即归零，因此不进注册表；它们的合同写在各自的类型和测试里。

| 机器 | 位置 | 状态 | 说明 |
| --- | --- | --- | --- |
| 守护进程生命周期 | [app/daemon_phase.go](../../app/daemon_phase.go) | `stopped` / `starting` / `supervised`（launchd 托管）/ `owned`（本窗口拉起）/ `adopted`（接管已有进程）/ `stopping` | 六个相位取代了原来的 `owned` / `launched` / `stopped` 三布尔加 `adoptedPid`：`daemonTransitions` 是唯一迁移表，`daemonTransition(phase, event)` 给出下一相位与是否真的发生迁移。launchd 托管时 `stop` 只解除本窗口跟踪、不杀进程；托管进程的自重启不产生本窗口迁移；托盘提示读 `Phase.Label()`，不再只写「Graph」。 |
| 页面加载 | [app/load_state.go](../../app/load_state.go) | `idle` → `loading` → `ready` / `failed` | 带 `generation`：过期响应直接丢弃，失败保留原文，`begin()` 在 `loading` / `ready` 时拒绝重复请求，因此两个并发加载不会互相覆盖。 |
| 聊天轮次 | [app/round_phase.go](../../app/round_phase.go) | `idle` / `queued` / `preparing` / `running` / `blocked` / `paused` | 先认服务端的 `master.status`（`preparing` / `running` / `blocked`），再看消息相位：`paused` 一票否决，输入框只给「继续」；只有 `preparing` / `running` / `blocked` 算 `busy()`，因此输入框在真的跑着时给「暂停」；单独一条 `queued` 消息不构成轮次（仍可撤销、仍可发送）。 |
| 消息相位 | [app/round_phase.go](../../app/round_phase.go) | `settled` / `queued` / `pending` / `running` / `failed` / `cancelled` | 由落库的 `messages.state`（见 `message.state` 机器）投影而来，界面只认这六个词。`delivered` 对用户消息是历史（真实库里 1849 条 `delivered` 都是已答过的提问），对工具行仍是进行中；`cancelled` 的工具行读「已取消」，不再永远挂着「正在运行」。 |
| 状态归一 | [app/status.go](../../app/status.go) | `idle` / `pending` / `running` / `blocked` / `failed` / `done` / `stopped` / `unknown` | 所有后端状态词先经 `workStatusAliases` 归一，再取标签与色调；未登记的词落到 `unknown`，界面不再原样泄露内部 token。 |
| 流式增量 | [app/chat_live_state.go](../../app/chat_live_state.go) | 未开始 / 增量中 / 已落定 | `live:` 前缀标记尚未落库的临时消息；同一 operationId 的正式消息一到，临时消息整段被替换。 |

## 状态怎么到达界面

1. 落库状态机写 `state` / `status` / `phase` 列（例：`tasks.phase`）。
2. 服务端把该列原样放进视图 JSON（例：`fleetTask.status`，见 [server_fleet_query.go](../../backend/internal/graph/server_fleet_query.go)）。
3. 界面用 `workStatusOf` 归一成 `workStatus`，再取 `Label()` 与 `toneOf`。
4. 未登记的词一律成为 `unknown`（「未知」），既不会漏显示，也不会把内部词汇暴露给用户。

这条链路就是「同一状态在编队、轨迹、白板三个页面读起来一致」的原因：三个页面共享同一张归一表，
而不是各自维护一份 switch。

## 新增或修改一个状态

1. 在 `backend/statemachine/machines.json` 里给对应机器加 `states`（name / label / tone，终态加 `terminal: true`）；新增合法转移时同时补 `transitions`。
2. 改 store 层的写入与守卫，让源码里出现该字面量或该转移。
3. 跑 `go -C backend run ./cmd/graphcheck machines`，它会点名「注册表有、源码没有」或「源码有、注册表没有」的那一条。
4. 跑 `GRAPH_UPDATE_ATLAS=1 go -C backend test ./statemachine -run Atlas` 重写本文总表与明细清单。
5. 状态会出现在界面上时，先看 `workStatusAliases` 是否要加别名，避免落到 `unknown`。
6. 跑 `python3 scripts/check-queue.py` 收尾。

## 已知边界

- 迁移里的临时表（如 `conversation_goals_next`）与 staging 列也会被扫描到；它们不是独立状态机，归属重建后的表（`conversation_goal.status`），不单独声明。
- 只读枚举（例如 `usage.status` 表示一次账单条目的分类）不是状态机：没有转移，也不该有终态。
- 注册表只描述状态与合法转移，不描述守卫条件本身。守卫仍写在 store 的 SQL 与 Go 判断里，由各状态机的测试（如 `core_task_phase_test.go`）覆盖。

## 相关

- 注册表本身即规范：`backend/statemachine/machines.json`，`go -C backend run ./cmd/graphcheck machines` 判定源码与注册表是否一致。
- 界面运行期状态机的盘点、隐性缺陷与收口顺序：[隐式状态机](../specs/implicit-state-machines.md)。
- 运行中的机器可读副本：`GET /api/state-machines`（见 [server_app_routes.go](../../backend/internal/graph/server_app_routes.go)）。
- 门禁：`go -C backend run ./cmd/graphcheck machines`；本文件与明细文档由 `go -C backend test ./statemachine` 盯住不漂移。
