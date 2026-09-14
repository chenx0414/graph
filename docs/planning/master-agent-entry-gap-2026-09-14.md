# 以主 Agent 为入口：代码差距核对

日期：2026-09-14。状态：**分析已完成，改造已实施并本地验证；等待独立验收**。基线：`main@688dd1f`（T01–T08 与 PA01–PA05 返工均已独立验收关闭）。隔离工作树：`/Users/macmini/workspace/graph-master-entry-dev`，分支 `feat/master-agent-entry`（提交 `68795c2`、`1a1a974`、`a66459f`、`f12746d`；未合并、未覆盖 `main` 与 `feat/app-console`）。方案见 [主 Agent 入口改造草案](master-agent-entry-plan-2026-09-14.md)，决策见 [ADR 0009](../adr/0009-conversation-first-master-entry.md)，实施与验收结果见 [实施与验收报告](master-agent-entry-report-2026-09-14.md)。

## 已存在、本次复用的能力

- 持久 Pi 会话与实例目录：`openPiInstance` 恢复同一会话文件，主 Agent 不因操作结束丢失上下文（`src/runtime/pi-instance.ts`）。
- 逐调用门与账本：`taskGate` 在每次实际发送前检查暂停、未知用量、实例预算与预留；`invocations` 记录权威用量与费用（`src/runtime/task-gate.ts`）。
- 执行内核：`operations`/`instances`/`nodes`/`activations`/`questions`/`events` 的持久状态机、代次隔离、崩溃核查与 `drive()` 连续调度（`src/core/execution.ts`）。
- 主管通道：`runtime.supervisor(taskId).propose/revise` 校验后写入版本化草稿；`accept` 绑定当前需求版本与目标分支后才实例化节点（`src/core/task-runtime.ts`）。
- 事件协议：任务级 cursor + SSE，浏览器可断线续接（`src/server/app.ts`、`src/web/event-cursor.ts`）。
- 浏览器与受控 provider 测试基线：`tests/m8/integration.test.ts`（真实 Pi + 本地 OpenAI SSE）、`tests/m8/ui-flow.test.ts`（Vite 构建 + Playwright）。

## 结构缺口（逐项对应验收场景）

### G1 入口要求先有功能任务（场景 1）

`user.begin` 必须提供 `projectId` 与非空 `request`，并在同一命令里创建功能任务与主管节点（`src/core/task-runtime.ts` 的 `begin`）。`tasks.project_id` 为 `NOT NULL`，不存在“尚未绑定项目、尚未确定需求”的会话。用户无法先开聊再定位项目。

### G2 所有用户消息都被当作需求变更（场景 2、3、5、7）

`say()` 每次把 `requirement_version+1` 并写 `requirement.changed`；确认后直接拒绝（`requirements_locked`）。因此：普通问答、进度询问、方案讨论都会改变“需求版本”，并可能让刚生成的草稿失效；确认后无法再发言。发送时机也有缺陷：只有主管节点不在 `preparing/running` 且无锁定问题时，`say` 才把节点置为 `pending`；主管运行期间到达的消息不会触发下一轮，只能等用户再发一条。

### G3 对话没有正式消息记录（场景 1、4、7）

`view().messages` 仅由 `task.created`/`requirement.changed` 事件投影（`src/core/task-runtime.ts` `view`）。主管的自然语言回复只存在于 `nodes.output` 与 `operations.result`，没有稳定消息 ID、角色、状态、时间；工具调用只出现在操作记录的 JSON 里。界面 `TaskPanel` 把它渲染成“需求（vN）”列表。没有 assistant 流式输出，SSE 只推送事件类型，不能续接文字流。

### G4 确认后主管退出调度（场景 4、6）

`readyNodes()` 在 `phase='running'` 时把候选节点过滤为已确认图内节点（`execution.ts` 的 `nodes.filter(node => graph.plan.nodes.has(node.id))`），讨论用的主管节点不在图内，因此确认后再也不会运行；`say` 又拒绝受理。执行期间没有对话入口。

### G5 没有可靠的消息排队与恢复（场景 7）

消息只是事件行，没有 `pending/delivered/failed` 状态，也没有“被哪次操作消费”的关系。重启只恢复操作状态机，不会重放未处理消息；主管忙时连发的消息可能既不进入当前轮，也不触发下一轮（见 G2）。

### G6 主管提示与工具不适配“先讨论”（场景 1、2、3）

`pi-adapter` 对 `role='master'` 的提示直接给出 `propose_graph` 的 schema，并把“Configured models / task graph”当成主要产出；没有说明“先理解、调查、讨论取舍、再草稿”。工具集（`src/runtime/agent-tools.ts`）在讨论阶段同样暴露 `write_file` 与 `run_command`，不能保证“只讨论不修改业务文件”。

### G7 界面是任务表单而非对话（场景 1、4、6、8）

首页 `Overview` 的主操作是“选择项目 + 填需求 → 开始”；`TaskPanel` 的对话区只显示需求文本并提交补充说明；没有会话列表、流式回复、工具活动、草稿迭代与确认入口，也没有把执行状态作为对话侧栏。要完成场景 4（确认后问问题）必须先知道任务 ID 并进入任务页。

### G8 未建任务时没有账本归属（关键设计约束）

每个真实模型调用都必须是 `operations` 行（`task_id`、`node_id`、`instance_id` 非空），预算与未知用量都挂在实例上。没有任务就没有可计量的主管调查；直接新建一条聊天调用链会绕开已验收的门与账本。改造必须让“未确认前的对话”也落在现有 `operations`/`instances`/`taskGate` 上。

### G9 调度器只有单一 active_task（场景 4、6、7）

`drive()`/`readyNodes()` 以 `runtime.active_task` 为唯一工作源，且任务暂停时整体返回。执行期间要让主管继续对话，就需要独立于活动任务的交互通道，同时仍受全局 Agent 名额与凭据并发限制。

## 本次实现如何保持已验收机制

- 主管每一轮仍是一次 `nodes`+`instances`+`operations` 执行，经 `taskGate`：暂停门、预算预留、未知用量问题、代次与 activation 隔离、崩溃核查全部复用，不改语义。
- 讨论通道只读：主管在讨论阶段只暴露读取类工具，`propose_graph` 生成的仍是需用户确认的草稿；不调用 `accept` 就不是执行授权，不派发工人、不改业务文件。
- 确认动作仍是唯一执行授权：`confirm` 只接受当前需求版本上的最新草稿，创建独立功能任务并走既有 `accept`/`git.prepareTask`/验收证据路径；旧草稿无法执行。
- 普通聊天不写 `requirement_version`；预算、权限、范围变更各自走已有受校验命令或问题答复。
- 新增 `conversations`/`messages` 表只承载会话与消息账本，不改变图、实例与证据的身份规则。

## 交付顺序（纵向优先）

1. 代码差距与 ADR（本文件、ADR 0009）。
2. 会话内核：schema v11、会话/消息 API、anchor 任务与主管轮次、消息排队与恢复、确认创建功能任务。
3. 服务接口与流：会话 REST、会话 SSE、消息状态与草稿/执行摘要。
4. 生产主管：只读讨论工具、对话提示、assistant 流与工具活动、执行状态摘要。
5. Web：会话优先首页与会话页（聊天 + 草稿确认 + 执行侧栏 + 问题答复）。
6. 验收：脚本化内核测试、受控 provider 协议测试、Playwright 浏览器全流程、重启与排队场景；报告与证据。
