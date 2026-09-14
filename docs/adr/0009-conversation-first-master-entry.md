# 会话优先的主 Agent 入口

状态：2026-09-14 已实施并本地验证，等待独立验收（分支 `feat/master-agent-entry`，基线 `main@688dd1f`）。方案见 [主 Agent 入口改造草案](../planning/master-agent-entry-plan-2026-09-14.md)，代码差距见 [差距核对](../planning/master-agent-entry-gap-2026-09-14.md)，结果见 [实施与验收报告](../planning/master-agent-entry-report-2026-09-14.md)，独立验收反例的修复见 [第一轮返工报告](../planning/master-agent-entry-rework-report-2026-09-14.md) 与 [第二轮返工报告](../planning/master-agent-entry-rework2-report-2026-09-14.md)。

## 背景

产品要求用户像与 Pi 聊天一样持续与主管交流：可以不先创建功能任务、可以先说模糊目标、可以调查与讨论、可以在确认提案后继续问进展与调整。已验收的执行内核（操作/实例/activation、逐调用门、预算、未知用量、暂停、证据绑定）必须原样生效，不能为聊天另建一条绕过账本的路径。

## 决策

### 1. 会话是有账本的持久实体，主管轮次复用执行内核

新增 `conversations`（`id`、`project_id`（可空）、`workspace_project_id`、`anchor_task_id`、`title`、`created_seq`、`created_at`）与 `messages`（自增 `seq`、稳定 `id`、`conversation_id`、`role`、`kind`、`text`、`data`、`state`、`operation_id`、`turn`、时间）。

每个会话有一个 **anchor 任务**（`tasks.phase='chatting'`、`conversation_id` 指向会话）与唯一主管节点/实例。主管每轮是一次正常的 `operations` 执行：`instances` 预算、`invocations` 用量、`taskGate` 的暂停/未知用量/预算检查、代次与 activation 隔离、崩溃核查全部复用。未绑定项目时用一个仅属于该会话、`grants=[]` 的宿主工作目录作为 anchor 任务项目，绑定项目后改指真实项目。

选择“anchor 任务承载主管”而不是“另建聊天调用链”的原因：另建链路必须重写预算、未知用量、暂停与恢复语义，等于把已验收机制复制一份并留下分叉；anchor 任务让聊天与图执行共用同一套账本与问题路径。代价是会话在数据层以一个隐藏任务行存在，需要 `chatting` 阶段与独立调度通道（决策 6）。

### 2. 消息与正式变更分离

`messages` 记录用户、主管、工具与系统四类消息，状态为 `pending`（待主管处理）、`delivered`（已被某轮操作消费）、`failed`/`cancelled`。普通聊天只写消息、不写 `requirement_version`；正式变更仍走各自受校验的命令：`propose_graph`（草稿）、`revise_graph`（执行中局部修订）、问题答复、确认（`confirm`）、绑定项目。消息创建使用 `store.command` 幂等键，重复请求不会重复触发模型。

### 3. 草稿到执行的确认边界

主管的 `propose_graph` 只生成版本化草稿（`proposals`，绑定当前需求版本），确认前不创建图节点、不派发工人。`confirm` 只接受当前最新草稿：校验会话已绑定项目、草稿版本与需求版本一致、同一版本未被确认过；成功后创建独立功能任务（`tasks.conversation_id` 关联、复制提案为 v1、实例化节点、入队/激活），`git.prepareTask` 走既有路径；anchor 的 `requirement_version+1` 使旧草稿全部失效，并写 `conversation_acceptances` 溯源。确认后 anchor 保持 `chatting`，主管继续可对话；范围变更必须形成新任务或走执行中问题流程，聊天不能静默修改。

### 4. 主管轮次的只读讨论边界

讨论阶段（`phase` 为 `chatting`/`discussing` 的主管节点）的工具集不含 `write_file`/`run_command` 等写入工具，只有读取、目录列举、结果提交、草稿、目录/能力安装；调查不得修改业务文件或派发工人。执行确认后的对话仍用只读工具，主管通过执行摘要解释实际状态，不做代码修改。

### 5. 流式文字与最终消息分离

运行中的 assistant 文本以合并后的 `message.delta` 事件持久化，供 SSE 断线续接；轮次结束时写入正式 assistant 消息（稳定 ID、状态 `done`）与工具活动摘要消息。工具活动同时有实时 `message.tool` 事件。部分流与最终记录去重由 `operation_id`/`toolCallId` 关联，不伪造隐藏推理。

### 6. 交互调度通道独立于单一 active_task

`drive()` 在两个通道上调度：所有 `chatting` 会话的主管节点优先，然后才是 `active_task` 的图节点。两个通道共用全局 Agent 名额与凭据并发；主管暂停只作用于对应 anchor 任务，不影响正在执行的功能任务暂停。这样确认后的执行与对话可以并行，且都不绕过调用门。

### 7. 重启与排队语义

消息在操作创建事务内被标记 `delivered` 并绑定 `operation_id`；若操作在派发前失败（`not_sent`，如暂停/预算/适配器准备失败），消息回到 `pending` 以便重试；若已派发但结果未知（`interrupted`/`unknown`），消息保持绑定，由既有未知用量/恢复问题路径处理，不重复发送。主管运行期间到达的消息保持 `pending`，本轮结束后自动触发下一轮；`settle` 只在无待处理消息时把节点置为 `succeeded`。进程重启后 anchor 任务的 pending 消息与未完成操作按同一规则恢复。

## 后果与限制

- 会话数据层依赖一个隐藏 anchor 任务；任务列表与界面必须过滤 `chatting`，避免把会话当功能任务展示。
- 交互优先是“先派发主管、后派发图节点”，凭据队列仍是 FIFO；更细的优先级与长会话摘要留待后续。
- 未做会话级整体运行时间上限与心跳看门狗，仍沿用已验收的逐调用门与未知用量问题路径。
- 未实现跨会话共享决策摘要；新功能任务通过 `conversation_id` 可追溯，但说明包仍以确认后的提案为权威范围。
