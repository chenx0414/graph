# ADR 0043：统一 Agent 运行时、动态编队与千级并发执行

日期：2026-11-12

## 状态

已接受，实施中。取代 [ADR 0004](0004-agent-node-identity.md) 中“Agent 节点与实例一一对应”作为唯一身份模型的表述：节点身份继续成立，但 Agent 身份统一到 `agents` 登记表，节点、主管与动态子 Agent 共用同一套身份、父子关系与编队投影。

## 背景

现在有两套 Agent 编排：

- 全局主管与项目主管共用 `PiAdapter` + `AgentSession`。两者只在 `masterPromptSuffix` 按 `conversations.role` 注入职责说明和工具集上不同。
- graph 节点使用 `PigNodeHost` + `NodeTurnDriver` + `NodeSession`，有自己的提示词装配、工具面、恢复接线与轮次循环。

两套编排共用同一个 PiG durable 内核（`openPigSession` → `pigkernel.Session`）、同一份 `graph_durable_*` 命名空间、同一套模型准入与工具门。重复代码约 5,700 行，恢复语义各写一遍；新增能力（动态子 Agent、编队可视化、千级并发）必须在两处分别实现，这是本次收敛的直接原因。

规模目标同时变了：产品要成为“1,000 个 Agent 同时活跃执行、任意层级都能 spawn 子 Agent”的协作应用（当前全局 Agent 执行名额为 10，等待 20ms 轮询 SQLite）。编队页要复用 dsh-context Fleet 页的信息架构，但用 MyGo 重画；共享产物要进入同一张编队视图。

## 决策

### 1. 一个运行时：agentcore 在 PiG 之上，主管与节点只是不同配置

新建 `backend/internal/agentcore`：

- `Spec`：身份（id、parentId、kind、role、name）、工作区、模型、指令、工具包、能力、账本绑定。
- `Agent`：打开/提示/引导/中断/压缩/关闭/状态。
- `Turn`：一次输入的完整生命周期；打开会话、提示、收集用量与事件、冻结/恢复钩子、关闭会话。
- `SessionFactory`：宿主提供的会话打开器；Graph 用 `openPigSession` 实现，其他宿主可以替换。

PiG 仍拥有提示词循环、durable 会话、工具执行与恢复；agentcore 不重写循环。主管链与节点链都改为“构造 Spec + 调用 agentcore”，旧的两套 turn 编排在迁移完成后删除，不保留并行路径。

差异只允许存在于配置：职责提示词、工具包、能力、账本绑定、事件汇。`global`、`project`、`node`、`child` 四种 kind 共用同一个运行时。

### 2. Agent 登记表是编队与生成关系的唯一身份来源

新增 `agents` 表（schema v60），字段包括：`id`、`parent_id`、`kind`、`role`、`name`、`conversation_id`、`task_id`、`node_id`、`project_id`、`workspace`、`model`、`created_at`、`closed_at`、`metadata`。

- 旧数据迁移时补登记：每个 `conversations.role='global'|'project'` 对应一个 Agent；每个 graph 节点（`nodes.id!='master'`）对应一个 Agent，父级为所属项目主管。
- 该表存静态身份与父子关系；运行状态、用量、消息数、事件由编队投影从既有账本表实时聚合，避免双写。
- 新增 `conversations.role='child'`，子 Agent 的会话不进入用户会话列表，只在编队页出现。

### 3. 任意层级都能 spawn 子 Agent

新增 `spawn_agent` 工具，默认对所有 kind 开放（受能力包与授权约束）：

```
spawn_agent({ objective, name?, model?, workspace: "isolated"|"read-only", wait?: false })
  -> { agentId, conversationId }
```

- 子 Agent 是独立持久实体：自己的 `conversations` 行（role=`child`）、anchor 任务、`agents` 行、独立工作区与 durable 会话；父级通过 `parent_id` 连接。
- `spawn_agent` 立即返回，不阻塞父级回合。子 Agent 完成后把最终回复与产物引用作为一条结果消息投递给父级，并写唤醒意图；父级被唤醒后读取。
- 子 Agent 可继续 spawn，受深度、单父级子数、项目总 Agent 数、全局执行名额与凭据并发约束；限制写入配置，不写死在代码里。
- 子 Agent 继承父级的项目绑定与授权上限，不自动获得更大权限；工作区默认隔离，`read-only` 模式只能读父级工作区与共享产物。
- 工具、提示词、编队视图都只认 `agents` 的父子关系，不按“节点/会话”特判。

### 4. 1,000 个 Agent 同时活跃执行

- 执行名额从常量改为配置 `limits.agentExecutions`，默认 1024；`limits.programExecutions` 默认 4。配置未写时使用默认值。
- 用 channel/队列实现的公平 limiter 取代 `OccupiedSlots` 的 20ms 轮询；DB 的 `waiting_slot` 仍记录等待事实供恢复与界面使用。重启时按运行中 execution 重建占用。
- 会话按需打开、空闲释放；不为 1,000 个 Agent 常驻 1,000 个内存会话。
- 保留策略与写放大单独治理：prompt 快照、durable entries、events 按项目/时间保留可配置窗口；1,000 并发压测必须给出 goroutine、RSS、DB 增长与吞吐数字。
- 千级并发是“1,000 个同时活跃执行”，不是“1,000 个同时打模型供应商”；模型调用仍按凭据并发排队，未获槽的 Agent 停在等待态，不算活跃执行。

### 5. 编队页用 MyGo 重画，并纳入共享产物

白板新增固定的“编队”页（非关闭页），复用白板卡片、滚动、悬停头、tab 样式；信息架构对齐 dsh-context Fleet：

- KPI 条：Agent 数、运行中、工作项、消息数、token、成本。
- Agent 网络：`global → project → node/child` 的树与跨 Agent 协作连线；卡片显示角色、模型、状态、token/成本、当前 execution。
- 跨 Agent 协作：委派、投递、spawn、问题与结果的时间线。
- 协作任务：`work_requests` 与 graph 的执行状态。
- 事件检查：按 Agent 过滤的账本事件。
- 共享产物：按 producer Agent 与任务归属展示 artifact 版本、来源、信任状态；点击进入现有共享产物面板。

1,000 个 Agent 的渲染必须分组折叠与窗口化，不一次性铺满；数据由 `GET /api/fleet` 提供，支持 `conversationId` 作用域、分页/截断与 SSE 增量。

## 后果

- 主管链与节点链的差异从“两套代码”缩小为“两份配置”；恢复、预算、事件、取消只维护一份。
- 新增 `agents` 表、`conversations.role='child'`、`spawn_agent`、`/api/fleet`、白板编队页；迁移 v60 必须可回放、可验证。
- 执行名额默认从 10 提升到 1024 会放大成本与供应商限流风险，由凭据并发、项目配额与保留策略兜底；错误配置必须在启动时报错而不是静默降级。
- 动态 spawn 带来指数级 Agent 增长风险，由深度、子数、项目总数与执行名额共同限制；父级退出时子级按现有归档语义处理。
- 旧的两套编排代码在迁移后删除；删除清单在实施记录中逐项列出，不留死代码与旧测试。

## 验证

- 单元/集成：`go -C backend test ./...` 覆盖 agentcore 的回合生命周期、limiter 的 1,000 并发公平性、agents 迁移、spawn 父子关系与 fleet 投影。
- 端到端：真实 daemon + 真实 SQLite + 模拟 provider，证明 supervisor 与 node 走同一运行时、子 Agent 被唤醒后回传结果、编队 API 返回正确树。
- 真机：白板编队页渲染 1、100、1,000 个 Agent；1,000 并发压测给出数字。
- 门禁：`python3 scripts/check-queue.py` 与 `go -C backend run ./cmd/graphcheck all` 通过。
