# Orchestration Engineer：代码现状与本轮范围

日期：2026-10-27。检查基线：`671587c5` 与当前工作区。本文包含代码核对、已确认产品约束与阶段建议；阶段安排尚不等同完整实现规格。

## 已确认的产品意图

- 用户默认与全局 main agent 对话；main 不属于单一项目。
- 每个项目只有一个长期 thread，由 thread agent 作为部门主管管理，所有任务在该 thread 中延续。
- 项目内可运行多个 graph；graph 是多个 subagents 及其协作关系。
- 用户可主动与任意一级 agent 对话。下级问题逐级汇总，由全局 main 先处理，无法解决才向用户提问。
- 想法先澄清到足够明确，再启动执行。
- subagent 保留身份、角色、职责、技能与配置，不跨任务保留任务记忆；未完成工作在应用或服务重启后应恢复。
- orange 清单纳入本轮。SF 已确认为 Software Factory；autoresearchclaw 按最新指示暂不展开。

## 结论

已有执行、持久化、人才库和跨会话通信基础。主要缺口是把“用户管理多个会话，每个会话一个主管”改成“全局 main 管理项目，每项目唯一 thread 与主管”，并将委派、问题、结果和记忆的归属做成正式关系。

### 能力对照

| 目标 | 当前证据与状态 | 缺口 |
| --- | --- | --- |
| 全局 main | 普通会话可暂不绑定项目；主管可列项目、绑定项目；另有跨会话读取与发送工具 | 没有专属全局角色、唯一入口与其项目主管关系。未绑定会话不能直接等同全局主管 |
| 每项目唯一长期 thread | `TaskRuntimeConversations.Create` 每次创建新 conversation、anchor task 和 master；侧栏明确提供项目内新对话 | 数据/API/UI 都仍允许一项目多会话；需收敛为唯一 thread，并处理历史会话 |
| 项目主管协调多个 graph | `GraphCreate` 保存 graph owner 与 conversation/project，创建独立 graph 实例 | 可作为项目主管基础；需接入上级委派、回执与问题升级 |
| 不同 graph 并发 | `GraphLane.Runnable` 枚举各 graph；`Execution.pumpGraphs` 为每个 graph 启动 goroutine；节点受全局名额与模型凭据并发约束 | 执行器已有基础，但进一步追踪发现草稿 Confirm 仍按 active_task 将新图置 queued；需统一创建受理并验证重叠执行及独立暂停，资源不足仍会排队 |
| 稳定人才身份、跨任务新上下文 | 配方/版本化定义可复用；`GraphCreate` 对节点分配新 instance ID；同一 graph 内节点继续会话 | 区分人才定义 ID 与执行 instance ID。现状符合“人才身份复用”，不等于同一个运行实例跨 graph 复用 |
| 任意层直接对话 | 主管会话、节点聊天及独立节点界面已有；graph chat 进入节点串行队列 | 全局入口缺失；完成/停止 graph 拒绝触发执行的聊天，结束后如何再委派应沿人才定义创建新执行 |
| 运行中干预、暂停、停止 | conversation 支持 steer/interrupt；graph 支持发送、暂停/恢复、队列处理、整体 stop | 节点普通聊天排队，不等于即时 steer；`graph_control stop` 停整个 graph，不能仅传 nodeId 就认为是停止指定 agent。需补齐一致的目标粒度 |
| 下级问题逐级汇总 | 问题有 `main/user` 所有权、主管唤醒、解决和升级能力 | 只有当前会话主管这一层；权限、预算、人工验收等仍可直接归 user。需统一由全局 main 呈现，决策权与消息入口分开 |
| 澄清后启动 | 草稿、确认、确认指令记录已存在 | `graph_create` 也可直接建图；所有执行入口需使用一致的澄清/授权事实，不能只依靠提示词或草稿入口 |
| 重启恢复 | PiG durable 与冻结执行、完成回执、队列恢复已有 | 已到模型但结果不确定的回合停在 blocked 等核对；“恢复”不等于无条件重发。三级委派及问题处理也需恢复 |
| 关闭应用 | 关闭最后窗口不停止 daemon；退出应用会停止 daemon | 关闭窗口与退出应用需分别验收。现状不是退出应用仍在后台执行 |
| 记住工作方式 | 持久对话、压缩、项目共享产物、harness 知识库与已采纳经验已有 | 尚未发现全局个人记忆与 Hindsight 接入；项目经验不能直接等同全局用户记忆 |

### 主要代码证据

- 会话创建与角色：[core_task_runtime_conversations.go](../../backend/internal/graph/core_task_runtime_conversations.go)、[core_conversation.go](../../backend/internal/graph/core_conversation.go)。
- 用户侧项目多会话入口：[app-sidebar.tsx](../../src/web/app-sidebar.tsx)。
- 跨会话工具与来源标记：[runtime_agent_tool_sessions.go](../../backend/internal/graph/runtime_agent_tool_sessions.go)、[runtime_conversation_tools.go](../../backend/internal/graph/runtime_conversation_tools.go)。已有读/发消息/steer/暂停/恢复，写入受完全访问约束；尚非正式的上下级委派模型。
- graph 创建与归属：[core_graph_service_create.go](../../backend/internal/graph/core_graph_service_create.go)、[core_graph_service.go](../../backend/internal/graph/core_graph_service.go)。管理权限目前按 owner 或同 conversation 判断。
- graph 并发：[core_execution_dispatch.go](../../backend/internal/graph/core_execution_dispatch.go)、[core_graph_lane.go](../../backend/internal/graph/core_graph_lane.go)、[core_graph_runner.go](../../backend/internal/graph/core_graph_runner.go)。进一步核对 [core_task_runtime_conversation_confirm.go](../../backend/internal/graph/core_task_runtime_conversation_confirm.go) 发现 Confirm 仍按 `active_task` 将新图置为 `queued`，而 GraphLane 不受理该阶段。因此不能据执行器支持并发就宣称全部产品入口已并发；这是第一阶段需要消除的入口差异。
- 控制与节点聊天：[core_graph_service_control.go](../../backend/internal/graph/core_graph_service_control.go)、[core_graph_runtime_deliver.go](../../backend/internal/graph/core_graph_runtime_deliver.go)、[core_execution_surface.go](../../backend/internal/graph/core_execution_surface.go)。
- 问题归属与主管处理：[core_question_routing.go](../../backend/internal/graph/core_question_routing.go)、[core_task_runtime_supervisor_problems.go](../../backend/internal/graph/core_task_runtime_supervisor_problems.go)。
- 恢复：[runtime_pig_node_recovery.go](../../backend/internal/graph/runtime_pig_node_recovery.go)、[runtime_pig_recovery.go](../../backend/internal/graph/runtime_pig_recovery.go)；桌面生命周期：[main.mjs](../../desktop/main.mjs)。
- 人才详情与能力：[server_app_graph_agent.go](../../backend/internal/graph/server_app_graph_agent.go)、[catalog_agent_combinations.go](../../backend/internal/graph/catalog_agent_combinations.go)。
- 经验与评测：[runtime_harness_knowledge.go](../../backend/internal/graph/runtime_harness_knowledge.go)、[runtime_harness_probe.go](../../backend/internal/graph/runtime_harness_probe.go)、[runtime_harness_compare.go](../../backend/internal/graph/runtime_harness_compare.go)、[harness-eval-report.mjs](../../scripts/harness-eval-report.mjs)。

## orange 清单：全部登记

| 待办 | 现状 | 本轮安排建议 |
| --- | --- | --- |
| 不同 graph 同时跑 | 执行器已有并发结构 | 第一阶段消除草稿 Confirm 的 active_task 串行受理，统一建图路径；验收跨 graph 重叠、资源排队与控制隔离 |
| 删除或归档项目 | 有会话/草稿归档，没有发现项目归档/删除的完整 API 和 UI；移除配置不等于项目生命周期 | 第一阶段先做项目归档与恢复；归档同时暂停未完成工作并停止接受新委派 |
| 人员招募 agent | 人才库、资源检索、配方与定义机制可复用；未发现专门招募工作流 | 后续阶段；已确认包含选人组队、创建配方、发现并安装新能力 |
| 多种 graph 的 eval | 已有单图候选节点的 token/耗时/工具事实对比，也有冻结用例的 harness 真模型评测 | 后续阶段扩展为同任务不同 graph 结构的实验；统一任务、输入、预算和验收，重复运行后统计成功率 |
| autoresearchclaw 转 graph | 未发现仓库内对应集成 | 按用户最新指示暂缓，仍保留待办 |
| 持久化 Software Factory | graph、代码交付和恢复可复用；未发现 GitHub Issues 持续摄取、领取、去重与任务闭环的专用实现 | 后续阶段；明确仓库、任务筛选、持续触发及交付终点，再接入项目主管 |
| 全局入口记忆 / Hindsight | 对话、项目经验和产物基础已有；未发现 Hindsight 接入 | 全局入口成立后实施；先定个人偏好、项目知识、任务上下文的边界，再确定记忆后端 |
| 在 X 发布 | 发布准备类待办 | 具备可复现演示和真实证据后准备内容；当前没有已完成的发布材料或发布动作 |

“未发现”指本次仓库源码、工具声明、路由和相关文档的检索结果，不代表用户机器上其他项目或外部服务不存在这些能力。

## 第一阶段建议：三级协作的完整流程

目标体验：用户从全局入口提出两个项目的任务，澄清后分别交给各自主管执行；能继续对话、检查进度和干预；问题由全局 main 处理后再决定是否询问用户；重启后仍知道每件工作归谁、到哪一步。

1. **明确身份和唯一关系**：全局 main、项目 thread、项目主管、graph owner 的关系进入正式存储；重复创建/重启不会多出第二个项目 thread。
2. **接通委派与返回**：任务、来源、结果、问题和处理状态持久化；现有跨会话工具作为基础，增加上下级归属与幂等回执。
3. **统一澄清与执行入口**：从想法到可执行任务有明确边界；全局与项目主管共享已澄清事实，避免重复问用户。允许用户主动直接指挥下级。
4. **接通控制与恢复**：区分排队消息、当前轮引导、暂停队列、停止当前执行、停止 graph；全局操作能到达正确目标。恢复不重复已完成副作用，不确定状态先回主管处理。
5. **调整界面与项目生命周期**：默认全局入口，项目打开固定 thread，保留节点直接聊天；先提供项目归档与恢复。
6. **真实 E2E 验收**：两个项目并行、同项目两个 graph 并行、问题升级、直接干预、重启恢复、项目归档。复用既有执行内核，仅补缺口。

### 第一阶段验收场景

- 模糊想法不派发执行；澄清后只交给正确项目；重复投递不产生第二份任务。
- 同项目连续任务与应用重启后仍进入同一个 thread；两项目拥有不同主管。
- 资源允许时两个 graph 的真实执行时间重叠；暂停一个不阻止另一个。
- subagent 的问题经过项目主管再到全局 main；main 能解答则不打扰用户，不能解答则保留上下文提问。
- 用户可直接进入主管或节点会话；引导与停止作用于所选执行，不误停另一个 graph。
- 中断恢复区分未发送、已有完成回执、外部结果不确定三种情况，并恢复委派和问题的归属。
- 项目归档后可恢复原 thread 与历史；归档期间暂停未完成工作并拒绝新委派；解除归档后仍保持暂停，用户明确要求继续后才恢复执行。

后续同轮阶段：全局记忆与招募 → 跨 graph eval → 持久化 Software Factory → X 演示与发布准备。顺序是建议，不等于这些需求被移出本轮；autoresearchclaw 单独暂缓。

## 与既有决策的关系

- ADR 0009 的会话优先、多会话与可绑定项目模式需要修订；新规则是每项目唯一长期 thread，并增加独立全局入口。
- ADR 0018 只有 `main/user` 问题归属，不能表达两级主管；需区分责任人、升级路径与用户呈现入口。预算等仍由用户决策，不意味着下级可以绕过全局 main 直接提问。
- ADR 0004 的定义/实例区分可保留。用户确认的持久人才身份目前落在配方/定义上，执行实例仍是每图每节点独立。
- ADR 0030/0031/0033 的投递驱动、共享 durable 宿主与恢复判据继续复用。若要自动重试“已到模型但结果未知”，会改变既有恢复边界，不能静默当作已批准需求。
- 待产品边界确认后，更新 CONTEXT 的主管术语并正式记录全局 main、项目 thread agent 与委派关系。

## 验证及限制

本次运行：

```sh
python3 scripts/check-queue.py --continue -- node node_modules/vitest/vitest.mjs run tests/e2e/go-conversation-http.test.ts tests/e2e/pig-node-recovery.test.ts tests/e2e/go-graph-lifecycle.test.ts
```

结果：3 个文件、6 个用例全部通过。这些用例使用真实 daemon 与持久化路径，模型端由测试 provider 替代；不是全产品真实模型验收，也不证明跨 graph 并发已通过端到端验证。此次没有新增/改写测试或产品源代码，没有执行全量 check，没有提交或推送。

检查开始时已有未提交改动：`core_task_runtime_projects.go`、`server_app_graph.go`、`server_app_routes.go`，以及未跟踪的 `tests/e2e/console-graph-create.test.ts`。它们增加控制台 graph 创建入口，不计作本轮新实现，也不修改这些文件。本报告的核心现状结论不依赖该未提交入口。

## 用户已确认的补充决定（2026-10-27）

1. **旧会话迁移**：同项目选择一个会话作为长期 thread，其余保留为可检索历史；不直接拼接所有 transcript。具体选择规则尚未指定。
2. **恢复边界**：能确定的自动恢复；结果不确定的先由主管核查，解决不了再由全局 main 问用户。不能将“应恢复”解释为无条件重放外部调用。
3. **招募职责**：包含从人才库选人组队、创建配方、发现并安装新能力。
4. **项目归档**：同时暂停未完成工作，并停止接受新委派；保留项目恢复入口。解除归档后，未完成工作仍保持暂停，须由用户明确要求继续；不自动恢复执行。

这些决定是后续设计与验收的约束。招募的能力安装应接入既有能力库、版本与绑定路径；归档需覆盖项目内所有未完成 graph，不能只隐藏侧栏条目。

## 后续设计仍需明确

- 历史项目由谁、按什么规则选择长期 thread。
- Software Factory 的任务来源、自动触发规则和交付终点，进入该阶段前明确。

