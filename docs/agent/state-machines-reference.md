# 状态机明细

[状态机地图](state-machines.md) 的逐台展开：状态、标签、tone、终态与合法转移。
清单由 `backend/statemachine/machines.json` 生成，手改会被 `go -C backend test ./statemachine` 挡下；
重新生成用 `GRAPH_UPDATE_ATLAS=1 go -C backend test ./statemachine -run Atlas`。

<!-- atlas:machines:start -->

### task.phase

**任务阶段** · 存储：`table` · 写入者：`core_task_lifecycle.go`

落库位置：`tasks.phase`

初始：`discussing` · 终态：`completed`、`stopped`、`abandoned`

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| discussing | 待确认 | idle |  |
| chatting | 对话中 | running |  |
| queued | 排队中 | idle |  |
| running | 运行中 | running |  |
| idle | 空闲 | idle |  |
| blocked | 阻塞 | blocked |  |
| completing | 收尾中 | running |  |
| completed | 已完成 | success | 是 |
| stopping | 停止中 | running |  |
| stopped | 已停止 | muted | 是 |
| abandoned | 已放弃 | danger | 是 |

转移：

- `discussing` → `chatting` （chat）
- `discussing` → `queued` （accept）
- `discussing` → `running` （accept）
- `chatting` → `running` （accept）
- `queued` → `running` （dispatch）
- `queued` → `idle` （drain）
- `queued` → `blocked` （stall）
- `queued` → `stopping` （stop）
- `running` → `idle` （drain）
- `running` → `blocked` （stall）
- `running` → `completing` （complete）
- `running` → `stopping` （stop）
- `idle` → `running` （dispatch）
- `idle` → `blocked` （stall）
- `idle` → `completing` （complete）
- `idle` → `stopping` （stop）
- `blocked` → `running` （resume）
- `blocked` → `idle` （drain）
- `blocked` → `completing` （complete）
- `blocked` → `stopping` （stop）
- `completing` → `completed` （acceptance）
- `completing` → `blocked` （stall）
- `stopping` → `stopped` （drain）
- `stopping` → `completed` （acceptance）
- `*` → `abandoned` （abandon）

### node.status

**节点状态** · 存储：`table` · 写入者：`core_kernel_nodes.go`

落库位置：`kernel_nodes.status`、`nodes.status`

初始：`pending` · 终态：`retired`

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| pending | 待执行 | idle |  |
| preparing | 准备中 | running |  |
| running | 运行中 | running |  |
| idle | 空闲 | idle |  |
| blocked | 阻塞 | blocked |  |
| failed | 失败 | danger |  |
| succeeded | 成功 | success |  |
| skipped | 已跳过 | muted |  |
| retired | 已退役 | muted | 是 |

转移：

- `pending` → `preparing` （prepare）
- `preparing` → `running` （execution-started）
- `preparing` → `blocked` （prepare-blocked）
- `preparing` → `failed` （prepare-failed）
- `pending` → `running` （execution-started）
- `pending` → `idle` （reset）
- `pending` → `skipped` （revision）
- `running` → `succeeded` （execution-completed）
- `running` → `failed` （execution-failed）
- `running` → `blocked` （execution-blocked）
- `running` → `idle` （reset）
- `running` → `skipped` （revision）
- `idle` → `pending` （revision）
- `idle` → `running` （execution-started）
- `blocked` → `idle` （resume）
- `blocked` → `running` （execution-restarted）
- `blocked` → `failed` （exhausted）
- `failed` → `idle` （resume）
- `failed` → `pending` （revision）
- `succeeded` → `pending` （revision）
- `succeeded` → `running` （execution-started）
- `*` → `retired` （retire）

### execution.state

**执行状态** · 存储：`table` · 写入者：`core_kernel_executions.go`

落库位置：`kernel_executions.state`

初始：`running` · 终态：`completed`

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| running | 运行中 | running |  |
| blocked | 阻塞 | blocked |  |
| failed | 失败 | danger |  |
| completed | 已完成 | success | 是 |

转移：

- `running` → `completed` （submit）
- `running` → `failed` （error）
- `running` → `blocked` （question）
- `blocked` → `running` （resume）
- `failed` → `blocked` （park）

### queue.state

**队列项状态** · 存储：`table` · 写入者：`core_kernel_queue.go`

落库位置：`kernel_queue.state`

初始：`queued` · 终态：`done`

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| queued | 排队中 | idle |  |
| claimed | 已领取 | running |  |
| failed | 失败 | danger |  |
| done | 已完成 | success | 是 |

转移：

- `queued` → `claimed` （claim）
- `queued` → `done` （drain）
- `queued` → `failed` （error）
- `claimed` → `queued` （block）
- `claimed` → `done` （finish）
- `claimed` → `failed` （error）
- `failed` → `queued` （requeue）

### delivery.state

**投递状态** · 存储：`table` · 写入者：`core_kernel_deliveries.go`

落库位置：`kernel_deliveries.state`

初始：`accepted` · 终态：`accepted`

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| accepted | 已受理 | success | 是 |

### provider_call.state

**模型调用状态** · 存储：`table` · 写入者：`core_kernel_provider_calls.go`

落库位置：`kernel_provider_calls.state`

初始：`inflight` · 终态：`reconciled`

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| inflight | 调用中 | running |  |
| settled | 已结算 | success |  |
| reconciled | 已对账 | success | 是 |
| unknown | 用量未知 | blocked |  |

转移：

- `inflight` → `settled` （usage）
- `inflight` → `reconciled` （usage）
- `inflight` → `unknown` （interrupt）
- `unknown` → `settled` （usage）
- `unknown` → `reconciled` （reconcile）
- `settled` → `reconciled` （reconcile）

### module_operation.state

**模块操作状态** · 存储：`table` · 写入者：`core_kernel_module_operations.go`

落库位置：`kernel_module_operations.state`

初始：`prepared` · 终态：`settled`、`failed`、`cancelled`

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| prepared | 已准备 | idle |  |
| dispatched | 已发送 | running |  |
| settled | 已结算 | success | 是 |
| uncertain | 结果不确定 | blocked |  |
| unknown | 未知 | muted |  |
| failed | 失败 | danger | 是 |
| cancelled | 已取消 | muted | 是 |

转移：

- `prepared` → `dispatched` （dispatch）
- `prepared` → `cancelled` （cancel）
- `dispatched` → `settled` （settle）
- `dispatched` → `uncertain` （interrupt）
- `dispatched` → `unknown` （interrupt）
- `dispatched` → `failed` （error）
- `uncertain` → `settled` （settle）
- `unknown` → `settled` （settle）

### create_request.state

**图创建请求状态** · 存储：`table` · 写入者：`core_kernel_graph_creation.go`

落库位置：`kernel_create_requests.state`

初始：`preparing` · 终态：`ready`

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| preparing | 准备中 | running |  |
| ready | 就绪 | success | 是 |
| failed | 失败 | danger |  |

转移：

- `preparing` → `ready` （prepare）
- `preparing` → `failed` （error）
- `failed` → `preparing` （retry）

### operation.state

**执行操作状态（旧）** · 存储：`table` · 写入者：`core_task_operations.go`

落库位置：`operations.state`

初始：`intent` · 终态：`settled`、`abandoned`

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| intent | 已登记 | idle |  |
| waiting | 等待中 | blocked |  |
| dispatched | 已发送 | running |  |
| not_sent | 未发送 | muted |  |
| interrupted | 已中断 | danger |  |
| unknown | 结果未知 | blocked |  |
| succeeded | 成功 | success |  |
| failed | 失败 | danger |  |
| skipped | 已跳过 | muted |  |
| settled | 已结算 | success | 是 |
| abandoned | 已放弃 | danger | 是 |

转移：

- `intent` → `waiting` （admit）
- `intent` → `dispatched` （dispatch）
- `intent` → `not_sent` （refuse）
- `waiting` → `dispatched` （dispatch）
- `waiting` → `failed` （error）
- `dispatched` → `succeeded` （settle）
- `dispatched` → `failed` （settle）
- `dispatched` → `unknown` （interrupt）
- `dispatched` → `not_sent` （refuse）
- `dispatched` → `interrupted` （interrupt）
- `dispatched` → `settled` （settle）
- `unknown` → `succeeded` （settle）
- `unknown` → `failed` （settle）
- `unknown` → `settled` （settle）
- `unknown` → `abandoned` （abandon）
- `interrupted` → `settled` （settle）
- `succeeded` → `settled` （settle）
- `failed` → `settled` （settle）
- `skipped` → `settled` （settle）

### activation.state

**节点激活状态（旧）** · 存储：`table` · 写入者：`core_task_activations.go`

落库位置：`activations.state`

初始：`pending` · 终态：`succeeded`、`failed`

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| pending | 待激活 | idle |  |
| preparing | 准备中 | running |  |
| running | 运行中 | running |  |
| idle | 空闲 | idle |  |
| blocked | 阻塞 | blocked |  |
| succeeded | 成功 | success | 是 |
| failed | 失败 | danger | 是 |

转移：

- `pending` → `preparing` （prepare）
- `pending` → `running` （start）
- `pending` → `idle` （reset）
- `preparing` → `running` （start）
- `running` → `blocked` （block）
- `running` → `idle` （reset）
- `running` → `succeeded` （finish）
- `running` → `failed` （finish）
- `blocked` → `running` （resume）
- `blocked` → `idle` （resume）

### message.state

**消息状态** · 存储：`table` · 写入者：`core_task_messages.go`

落库位置：`messages.state`

初始：`pending`、`queued`、`running`、`done`、`failed` · 终态：`failed`、`cancelled`、`done`

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| pending | 待发送 | idle |  |
| queued | 排队中 | idle |  |
| delivered | 已送达 | success |  |
| running | 进行中 | running |  |
| failed | 失败 | danger | 是 |
| cancelled | 已取消 | muted | 是 |
| done | 已完成 | success | 是 |

转移：

- `pending` → `queued` （queue）
- `pending` → `running` （activity-started）
- `running` → `done` （activity-settled）
- `running` → `failed` （activity-failed）
- `pending` → `delivered` （deliver）
- `pending` → `cancelled` （cancel）
- `queued` → `delivered` （deliver）
- `queued` → `cancelled` （cancel）
- `delivered` → `pending` （retract）

### question.status

**问题状态** · 存储：`table` · 写入者：`core_task_questions.go`

落库位置：`questions.status`

初始：`open` · 终态：`resolved`

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| open | 待回答 | blocked |  |
| resolved | 已解决 | success | 是 |

转移：

- `open` → `resolved` （answer）

### question.route_stage

**问题处理阶段** · 存储：`table` · 写入者：`core_question_routing.go`

落库位置：`questions.route_stage`

初始：`project` · 终态：`user`

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| project | 项目主管 | idle |  |
| global | 全局主管 | idle |  |
| user | 用户 | blocked | 是 |

转移：

- `project` → `global` （escalate）
- `project` → `user` （escalate）
- `global` → `user` （escalate）

### node_question.state

**节点问题状态** · 存储：`table` · 写入者：`core_node_questions.go`

落库位置：`node_questions.state`

初始：`recorded` · 终态：`answered`

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| recorded | 已记录 | idle |  |
| parked | 已挂起 | blocked |  |
| answered | 已回答 | success | 是 |

转移：

- `recorded` → `parked` （park）
- `recorded` → `answered` （answer）
- `parked` → `answered` （answer）

### work_request.state

**工作请求状态** · 存储：`table` · 写入者：`core_task_work_requests.go`

落库位置：`work_requests.state`

初始：`clarifying` · 终态：`completed`、`cancelled`

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| clarifying | 澄清中 | running |  |
| ready | 就绪 | idle |  |
| dispatched | 已派发 | running |  |
| completed | 已完成 | success | 是 |
| cancelled | 已取消 | muted | 是 |

转移：

- `clarifying` → `ready` （confirm）
- `clarifying` → `cancelled` （cancel）
- `clarifying` → `dispatched` （dispatch）
- `ready` → `clarifying` （revise）
- `ready` → `dispatched` （dispatch）
- `ready` → `cancelled` （cancel）
- `dispatched` → `completed` （finish）
- `dispatched` → `cancelled` （cancel）

### work_graph.state

**工作图状态** · 存储：`table` · 写入者：`core_task_work_graphs.go`

落库位置：`work_graphs.state`

初始：`preparing` · 终态：（无）

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| preparing | 准备中 | running |  |
| ready | 就绪 | success |  |
| blocked | 阻塞 | blocked |  |

转移：

- `preparing` → `ready` （prepare）
- `preparing` → `blocked` （error）
- `blocked` → `preparing` （retry）
- `blocked` → `ready` （prepare）

### continuation.state

**续跑请求状态** · 存储：`table` · 写入者：`core_rsi_continuation.go`

落库位置：`rsi_continuations.state`、`pause_continuations.state`

初始：`waiting` · 终态：`cancelled`

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| waiting | 等待中 | idle |  |
| ready | 就绪 | blocked |  |
| consumed | 已消费 | success |  |
| cancelled | 已取消 | muted | 是 |

转移：

- `waiting` → `ready` （commit）
- `waiting` → `cancelled` （cancel）
- `ready` → `consumed` （resume）
- `ready` → `cancelled` （cancel）
- `consumed` → `ready` （replay）

### wake_intent.state

**唤醒意图状态** · 存储：`table` · 写入者：`core_wake_ledger.go`

落库位置：`wake_intents.state`

初始：`waiting` · 终态：（无）

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| waiting | 等待中 | idle |  |
| ready | 就绪 | blocked |  |
| consumed | 已消费 | success |  |

转移：

- `waiting` → `ready` （deliver）
- `ready` → `consumed` （wake）
- `consumed` → `ready` （replay）

### deferred_tool_call.state

**延迟工具调用状态** · 存储：`table` · 写入者：`core_deferred_tool_calls.go`

落库位置：`deferred_tool_calls.state`

初始：`accepted` · 终态：`settled`、`failed`、`cancelled`、`timed_out`、`interrupted`

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| accepted | 已受理 | idle |  |
| running | 执行中 | running |  |
| settled | 已结算 | success | 是 |
| failed | 失败 | danger | 是 |
| cancelled | 已取消 | muted | 是 |
| timed_out | 已超时 | danger | 是 |
| interrupted | 已中断 | danger | 是 |

转移：

- `accepted` → `running` （start）
- `accepted` → `cancelled` （cancel）
- `running` → `settled` （settle）
- `running` → `failed` （error）
- `running` → `cancelled` （cancel）
- `running` → `timed_out` （timeout）
- `running` → `interrupted` （interrupt）

### conversation_goal.status

**会话目标状态** · 存储：`table` · 写入者：`core_conversation_goal.go`

落库位置：`conversation_goals.status`

初始：`active` · 终态：`completed`

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| active | 进行中 | running |  |
| paused | 已暂停 | blocked |  |
| verifying | 验证中 | running |  |
| usage_limited | 用量受限 | blocked |  |
| budget_limited | 预算受限 | blocked |  |
| completed | 已完成 | success | 是 |

转移：

- `active` → `paused` （pause）
- `active` → `verifying` （verify）
- `active` → `usage_limited` （usage）
- `active` → `budget_limited` （budget）
- `active` → `completed` （finish）
- `paused` → `active` （resume）
- `verifying` → `active` （reject）
- `verifying` → `completed` （accept）
- `verifying` → `budget_limited` （budget）
- `usage_limited` → `active` （resume）
- `budget_limited` → `active` （top-up）

### artifact.state

**产物状态** · 存储：`table` · 写入者：`core_artifact_rows.go`

落库位置：`artifacts.state`

初始：`published` · 终态：`retired`

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| published | 已发布 | success |  |
| retired | 已退役 | muted | 是 |

转移：

- `published` → `retired` （retire）

### git_op.state

**Git 操作状态** · 存储：`table` · 写入者：`core_git_operations.go`

落库位置：`git_ops.state`

初始：`intent` · 终态：`succeeded`、`failed`

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| intent | 已登记 | idle |  |
| dispatched | 已执行 | running |  |
| blocked | 阻塞 | blocked |  |
| succeeded | 成功 | success | 是 |
| failed | 失败 | danger | 是 |

转移：

- `intent` → `dispatched` （run）
- `intent` → `succeeded` （succeed）
- `intent` → `failed` （error）
- `dispatched` → `succeeded` （succeed）
- `dispatched` → `failed` （error）
- `dispatched` → `blocked` （block）
- `blocked` → `dispatched` （unblock）
- `blocked` → `failed` （error）

### project_preparation.state

**项目准备状态** · 存储：`table` · 写入者：`git_integration_prepare.go`

落库位置：`project_preparation.state`

初始：`detected` · 终态：`ready`、`not_a_repository`

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| detected | 已检测 | idle |  |
| initializing | 初始化中 | running |  |
| ready | 就绪 | success | 是 |
| not_a_repository | 非仓库 | blocked | 是 |
| failed | 失败 | danger |  |

转移：

- `detected` → `initializing` （initialize）
- `detected` → `ready` （attach）
- `initializing` → `ready` （prepare）
- `initializing` → `failed` （error）
- `failed` → `initializing` （retry）

### fleet.agent_status

**编队 Agent 状态** · 存储：`derived` · 写入者：`core_agent_registry_ledger.go`

初始：（无） · 终态：`done`、`stopped`

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| running | 运行中 | running |  |
| idle | 空闲 | idle |  |
| blocked | 阻塞 | blocked |  |
| failed | 失败 | danger |  |
| done | 已完成 | success | 是 |
| stopped | 已停止 | muted | 是 |

### providers.credential

**供应商凭据状态** · 存储：`derived` · 写入者：`app/providers_state.go`

初始：（无） · 终态：（无）

| state | 标签 | tone | 终态 |
| --- | --- | --- | --- |
| unconfigured | 未配置 | idle |  |
| unresolved | 凭据缺失 | danger |  |
| connected | 已连接 | success |  |
| disabled | 未启用 | muted |  |
<!-- atlas:machines:end -->




