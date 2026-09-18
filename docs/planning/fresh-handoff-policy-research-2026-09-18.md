# Fresh Agent 前驱交接策略研究

研究日期：2026-09-18

状态：研究草稿，未修改产品代码，未形成 ADR。

## 问题

Main Agent 定义 graph 时，需要为每条进入 Fresh Agent 的前驱边选择一种策略：

- `evidence_only`：Fresh Agent 只拿验收、证据、决策和 artifact 引用，不读取前驱的推理，适合独立审查。
- `result_handoff`：前驱结束前必须生成结构化结果交接，Fresh Agent 读取紧凑的工作结果摘要，适合普通下游实现流水线。

需要回答的问题包括：

1. 当前 Graph 是否已经存在前驱在结束后发给 Fresh Agent 的 handoff。
2. 两种策略应采用什么术语和 schema。
3. 策略属于节点还是边，如何处理多个前驱和容器。
4. 哪些条件必须在 proposal 校验和实际派发前 fail closed。
5. 一手研究和现有 Graph 结构支持哪种取舍。

## 结论摘要

### 当前事实

**当前不存在由前驱主动生成的 Fresh handoff。**

当前 Fresh Agent 收到的是接收方派发时由 Graph 合成的 `ContextHandoffPackage` 加 briefing。`ContextHandoffPackage` 包含 mode、purpose、独立性、请求事实、来源节点、summary、decisions、acceptance、artifactRefs、outputSchema 和 briefing，见 [types.ts](../../src/core/types.ts:35)。它的 `summary` 来自 proposal summary 或原始请求，decisions 和 acceptance 来自已确认 proposal，artifact refs 来自所有依赖节点的结果，见 [execution.ts](../../src/core/execution.ts:438)。

因此：

- 前驱不会在 operation 完成时生成“给某个下游 Fresh Agent 的结果交接”。
- 下游看到的是稳定任务约束和 artifact 引用，不是前驱刚刚完成工作的结构化摘要。
- `briefing()` 只把依赖 artifact 的 path 与 digest 写入文本，不写前驱 output，见 [briefing.ts](../../src/catalog/briefing.ts:4)。
- 当前只有 reviewer 有正式的 `evidenceOnly: true` 策略，见 [context.ts](../../src/core/context.ts:148)。普通 Fresh Agent 没有 per-edge 的 evidence-only/result-handoff 选择。

### 设计判断

**合理且建议实现。** 一手来源支持将“独立判断所需的输入隔离”和“普通流水线所需的结果连续性”分开：

- OpenAI Agents SDK 默认让接收 Agent 看到完整历史，但明确提供 `input_filter` 修改接收方输入，并允许 `input_items` 只过滤模型输入而保留完整 session history，见 [Handoffs](https://github.com/openai/openai-agents-python/blob/fdf21db62c303a3db54b0dfbee82de2141fa2799/docs/handoffs.md#L105-L119) 和 [`HandoffInputData`](https://github.com/openai/openai-agents-python/blob/fdf21db62c303a3db54b0dfbee82de2141fa2799/src/agents/handoffs/__init__.py#L70-L118)。
- Claude Code 的普通 subagent 从 fresh、isolated context 开始，只收到委托任务摘要；Fork 才继承完整 conversation、system prompt、tools、model 和 message history，见 [Manage subagent context](https://code.claude.com/docs/en/sub-agents#manage-subagent-context) 和 [Fork the current conversation](https://code.claude.com/docs/en/sub-agents#fork-the-current-conversation)。
- Anthropic 将 sub-agent 描述为在 clean context 中工作并只返回 condensed summary，见 [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents#context-engineering-for-long-horizon-tasks)。其多 Agent 文章进一步建议用文件系统保存大结果，只传 lightweight references，避免多阶段摘要造成 `game of telephone`，见 [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)。
- Pi 官方 subagent 示例的普通子 Agent 使用独立进程和 `--no-session`，把任务作为新 prompt；只有 chain 模式显式把前一个子 Agent 的 final output 通过 `{previous}` 交给下一个子 Agent，见 [subagent index.ts](../../node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts:300) 和 [subagent index.ts](../../node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts:550)。

因此建议正式采用：

1. `evidence_only` 和 `result_handoff` 都是一等边策略。
2. 两者都属于 Fresh，不会复制前驱 transcript。
3. 独立 review/verify 必须使用 `evidence_only`。
4. 普通实现流水线默认使用 `result_handoff`，但 Main Agent 必须按具体边显式决定。
5. 前驱只生成一份结构化 `ResultHandoff`。`result_handoff` 边向 Fresh 暴露它，`evidence_only` 边不暴露它。
6. `result_handoff` 缺失、失效或 digest 不匹配时 fail closed，下游不得自动降级为 evidence-only。

## 术语

### 与 OpenAI `handoff` 的区别

OpenAI Agents SDK 中的 `handoff` 首先表示控制权转移：调用 handoff 工具后，新 Agent 接管 conversation，见 [Handoffs](https://github.com/openai/openai-agents-python/blob/fdf21db62c303a3db54b0dfbee82de2141fa2799/docs/handoffs.md#L1-L13)。Graph 中前驱完成后仍由 DAG 调度下游，不存在控制权转移。

因此文档和代码应区分：

| 名称 | 含义 |
| --- | --- |
| `handoff` | 泛指一次上下文的正式交接，不单独使用这个裸词。 |
| `ResultHandoff` | 前驱 operation 产出的、结构化、不可变的工作结果交接。 |
| `EvidenceOnlyHandoff` | Graph 根据冻结验收、证据、决策和 artifact refs 构造的只读输入。 |
| `ContextHandoffPackage` | 当前接收方冻结的 handoff 包，继续保留为 projection 领域对象。 |
| `PredecessorHandoffMode` | graph 边策略：`evidence_only` 或 `result_handoff`。 |

推荐用户文案使用“结果交接”和“仅证据交接”。代码字段使用 `evidence_only` 与 `result_handoff`，避免只写 `handoff`。

## 一手行为对比

### OpenAI Agents SDK

OpenAI 的默认行为是把完整 previous conversation 交给下一个 Agent；`input_filter` 接收 `HandoffInputData` 并返回新的 `HandoffInputData`，可以改变下一个 Agent 看到的输入，见 [Input filters](https://github.com/openai/openai-agents-python/blob/fdf21db62c303a3db54b0dfbee82de2141fa2799/docs/handoffs.md#L105-L119)。

关键事实：

- `input_history`、`pre_handoff_items` 和 `new_items` 被分别建模，见 [`HandoffInputData`](https://github.com/openai/openai-agents-python/blob/fdf21db62c303a3db54b0dfbee82de2141fa2799/src/agents/handoffs/__init__.py#L70-L99)。
- `input_items` 可以只改变下一个 Agent 的 model input，同时保留 `new_items` 供 session history 使用。这支持 Graph 将“完整内部记录”和“下游可见投影”分离。
- `input_type` 只定义 handoff tool-call 的小型结构化 metadata，不替换接收 Agent 的主输入，见 [Handoff inputs](https://github.com/openai/openai-agents-python/blob/fdf21db62c303a3db54b0dfbee82de2141fa2799/docs/handoffs.md#L62-L103)。
- SDK 提供删除所有 tool 相关历史的 helper，见 [Input filters](https://github.com/openai/openai-agents-python/blob/fdf21db62c303a3db54b0dfbee82de2141fa2799/docs/handoffs.md#L125-L139)。

对 Graph 的启发：

- 必须把“前驱完整记录”与“下游模型可见输入”分开审计。
- 不能因为数据库保存了前驱 output，就自动认为 Fresh Agent 应该看到它。
- 边策略应是一个明确的 input projection policy。

### Claude Code

Claude Code 官方将普通 subagent 与 fork 分开：

- 普通 subagent 从 fresh、isolated context window 开始，不看到 conversation history、已调用 skill 或已读文件；Claude 只写一条 summary 形式的 delegation message，见 [Manage subagent context](https://code.claude.com/docs/en/sub-agents#manage-subagent-context)。
- Fork 继承完整 conversation、相同 system prompt、tools、model 和 message history，因此失去普通 subagent 的输入隔离，见 [Fork the current conversation](https://code.claude.com/docs/en/sub-agents#fork-the-current-conversation)。
- 普通 subagent 的中间 tool calls 不回写主 conversation，只把相关 summary 返回，见 [Create custom subagents](https://code.claude.com/docs/en/sub-agents)。

对 Graph 的启发：

- `evidence_only` 和 `result_handoff` 都不应复制 transcript；Fork 是第三种、独立的上下文来源。
- 独立审查应使用普通 subagent 类隔离，而不是 Fork。
- 普通流水线的连续性应通过结果交接实现，而不是偷偷继承完整历史。

### Anthropic 上下文工程

Anthropic 建议 sub-agent 在 clean context window 中处理专门任务，最后只返回约 1,000 到 2,000 token 的 condensed summary，见 [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents#context-engineering-for-long-horizon-tasks)。

在多 Agent 研究中，Anthropic 还建议：

- 接近 context limit 时启动 fresh subagent，并通过 careful handoff 保持连续性。
- 大结果写入 filesystem，只把 lightweight references 返回，避免所有信息都经过 lead agent 的“game of telephone”，见 [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)。

对 Graph 的启发：

- `result_handoff` 应是 bounded summary，不是 transcript 或大型正文。
- artifact 正文保留在文件系统，图中传递 path、digest 和用途说明。
- 摘要用于解释结果和决策，artifact refs 用于取得完整证据。

### Pi SDK

Pi 的 SDK 将 session、resource loader 和 operation 分开：

- `AgentSession` 管理 lifecycle、message history、model、compaction 和 event stream，见 [SDK](../../node_modules/@earendil-works/pi-coding-agent/docs/sdk.md:44)。
- `SessionManager` 的 `createBranchedSession(leafId)` 把 root 到 leaf 的完整 path 提取到新的 session file，生成新的 session ID，见 [session-manager.d.ts](../../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:308)。这是 Fork primitive，不是结果摘要。
- 当前 Graph 的 Fork 也先复制指定 leaf 的有效 context，再比较 source/child context digest，见 [pi-instance.ts](../../src/runtime/pi-instance.ts:178)。
- Pi 官方普通 subagent 示例使用独立进程和 `--no-session`，只把 `Task: ...` 交给子 Agent，见 [subagent index.ts](../../node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts:300)。
- Pi chain 模式把前一个子 Agent 的 `final output` 替换到下一个步骤的 `{previous}`，见 [subagent index.ts](../../node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts:550)。

对 Graph 的启发：

- Pi 已能提供 fork primitive，但 `result_handoff` 不能依赖 session copy。
- 普通 chain 已有“只交上一步 final output”的成熟先例。
- Graph 只需要把这个先例升级为正式 schema、版本、digest 和 fail-closed 校验。

## Graph 现状与缺口

### 已有能力

| 能力 | 当前实现 | 结论 |
| --- | --- | --- |
| Fresh 新 session | `SessionManager.create`，见 [pi-instance.ts](../../src/runtime/pi-instance.ts:203) | 可复用。 |
| 冻结接收方 handoff | `freezeContextHandoff()`，见 [context.ts](../../src/core/context.ts:274) | 可复用。 |
| handoff digest | `handoffDigest`、`constraintsDigest`，见 [context.ts](../../src/core/context.ts:266) | 可复用。 |
| 独立审查 evidence-only | `ReviewIndependencePolicy`，见 [types.ts](../../src/core/types.ts:28) | 可扩展为通用边策略。 |
| artifact 版本与来源 | `GraphState.sources()`，见 [graph.ts](../../src/core/graph.ts:132) | 可作为 result handoff 的 artifact 引用基础。 |
| context rejection | `context.rejected` 与 blocking question，见 [execution.ts](../../src/core/execution.ts:512) | 可作为缺 handoff 的 fail-closed 路径。 |

### 主要缺口

1. **没有 per-edge policy。**
   `NodeSpec.dependsOn` 只有字符串数组，无法表达某条前驱边是 evidence-only 还是 result-handoff，见 [types.ts](../../src/core/types.ts:74)。

2. **没有前驱-authored result handoff。**
   当前 handoff package 由接收方派发前生成，summary 是 proposal summary，不是前驱刚完成工作的结构化结果，见 [execution.ts](../../src/core/execution.ts:440)。

3. **前驱 output 没有进入 Fresh briefing。**
   `briefing()` 只列 artifact path 和 digest，不列 predecessor output，见 [briefing.ts](../../src/catalog/briefing.ts:4)。存在 artifact 时信息较充分，没有 artifact 时下游只能看到任务级 summary。

4. **evidenceOnly 只在 reviewer policy 中。**
   普通 Fresh Agent 无法声明“只看证据”或“读取前驱结果摘要”，见 [context.ts](../../src/core/context.ts:148)。

5. **没有 result-handoff 完整性闸门。**
   当前没有“有 result_handoff 边但没有结构化结果”的 proposal 或 dispatch 拒绝规则。

## 建议设计

### 边策略

建议在接收 Agent 的 `ContextRequest` 中增加 predecessor policy：

```ts
type PredecessorHandoffMode = "evidence_only" | "result_handoff";

interface PredecessorHandoffPolicy {
  source: string;
  mode: PredecessorHandoffMode;
  resultSchema?: { kind: string; version: number };
  maxSummaryChars?: number;
}

interface ContextRequest {
  // 现有字段...
  predecessors?: PredecessorHandoffPolicy[];
}
```

语义上它描述 incoming edge。当前 `dependsOn` 没有边对象，因此最小改动是放在接收节点的 `context.predecessors`；如果以后引入正式 edge 实体，应迁移为 edge metadata。

关键规则：

- `source` 必须解析为当前节点的直接依赖 leaf。容器依赖应展开到 leaf，因为 provenance 与 artifact 由 leaf operation 产生，见 [graph.ts](../../src/core/graph.ts:132)。
- proposal 必须覆盖全部会向 Fresh 输入的依赖 leaf。
- 同一个 source 可以由不同下游节点采用不同 policy。
- `result_handoff` 边产生模型可见的结果摘要；`evidence_only` 边隐藏同一份摘要。
- 策略必须随 graph revision 冻结并进入 handoff/constraints digest。

### `evidence_only`

允许包含：

- 原始 request、requirement version。
- proposal summary、已确认 decisions。
- acceptance 及对应 evidence。
- 前驱 node、instance、operation、activation 和 outputVersion 等 provenance。
- artifact、evidence、review report 的 path、digest、schema 和用途。
- 统一 output schema。

禁止包含：

- 前驱 assistant 最终自由文本。
- 前驱 transcript、thinking、tool call 和 tool result。
- 前驱 `ResultHandoff.workSummary`。
- 前驱的临时推理、尝试路径和未验证结论。

`evidence_only` 不表示“没有任何上下文”，而是“只接收经过允许列表过滤的冻结事实和证据”。

### `result_handoff`

前驱必须在其成功 operation 中提交一份结构化 `ResultHandoff`。建议最小 schema：

```ts
interface ResultHandoff {
  schemaVersion: 1;
  source: {
    nodeId: string;
    instanceId: string;
    operationId: string;
    activationId: string;
    outputVersion: number;
    operationResultDigest: string;
  };
  objective: string;
  outcome: "completed" | "partial" | "blocked";
  workSummary: string;
  changes: Array<{
    kind: "file" | "artifact" | "external";
    path?: string;
    digest?: string;
    summary: string;
  }>;
  decisions: Array<{
    decision: string;
    rationale: string;
    evidenceRefs: string[];
  }>;
  verification: Array<{
    summary: string;
    result: "pass" | "fail" | "unknown";
    evidenceRefs: string[];
  }>;
  knownLimits: string[];
  openQuestions: string[];
  nextActions: string[];
}
```

约束：

- `workSummary`、`rationale` 和 `changes.summary` 是面向工作结果的可审计说明，不是隐藏 chain-of-thought。
- 大型内容必须写 artifact，只在 `changes` 中传 path、digest 和用途。
- `ResultHandoff` 在 operation settlement 时冻结，并计算独立 digest。
- 同一次 operation 只生成一份 `ResultHandoff`。不同下游边只是决定是否投影它。
- 可以复用现有 `submit_result`。有 result-handoff 下游的 Agent 必须以该 schema 提交 terminal result；不需要额外增加一次模型请求，见 [agent-tools.ts](../../src/runtime/agent-tools.ts:88)。

### Fresh 输入组装

接收方派发 Fresh Agent 时，程序按边策略组装：

```text
base =
  request
  + requirement and acceptance
  + decisions
  + target output schema
  + per-predecessor evidence refs

for each incoming edge:
  if evidence_only:
    append EvidenceOnlyHandoff
  if result_handoff:
    append ResultHandoff

freshSession = create new Pi session
prompt = base + selected predecessors + task delta
```

不得复制前驱 session。完整 transcript 仍只属于 Fork。

### 校验与 fail closed

#### Proposal 校验

建议新增：

1. 每个 Fresh-capable Agent 节点的 incoming dependencies 必须全部有 policy。
2. `source` 必须存在、是依赖祖先，并且能解析为直接依赖 leaf。
3. `purpose="review"`、`purpose="verify"` 或 `independence="model-excluded"` 时，所有 incoming policy 必须是 `evidence_only`。
4. review/verify 中出现 `result_handoff` 一律 `invalid_proposal`。
5. `resultSchema` 必须是 bounded kind 和正整数 version。
6. policy 与 source 不得重复。
7. 非 Fresh resolution 不得静默套用 Fresh policy；必须记录 policy 不适用。

#### Dispatch 校验

建议新增：

1. 先解析 context mode。
2. 只有 Fresh 才读取 predecessor policies。
3. 对每条 `result_handoff` 边，前驱必须已有匹配当前 `activationId` 和 `outputVersion` 的 `ResultHandoff`。
4. `operationResultDigest`、artifact digest、schema kind/version 和 constraints digest 必须匹配。
5. 缺少或失效时写入 `context.rejected`，阻塞该节点并形成问题；不得自动降级为 evidence-only。
6. `evidence_only` 必须通过允许列表构造，不能从完整 briefing 中“少写几句”。
7. 整个结果在模型请求前冻结、digest，并与 operation 同事务登记。

#### 循环、返工和重试

- 结果交接绑定精确 activation 和 outputVersion。
- 前驱重新执行后，旧 handoff 自动失效。
- 下游返工使用 Continue 时不重新注入 predecessor handoff。
- 新 activation 的 Fresh 下游必须读取新版本 handoff。
- 不允许 Main Agent 在前驱结束后手工补写 `ResultHandoff` 来绕过校验。

### 多前驱和容器

每个 incoming leaf 独立选择 policy。一个 Fresh 节点可以同时收到：

- A 的 `ResultHandoff`。
- B 的 `EvidenceOnlyHandoff`。
- C 的 artifact 与 evidence refs。

如果目标是独立审查，这种混合不允许。必须全部为 `evidence_only`。

容器依赖在 proposal 中按容器表达，在校验和派发时展开为实际 leaf。policy 不应只绑定容器 ID，因为容器输出最终来自 leaf artifacts。

### Main Agent 建图决策

Main Agent 应在 proposal 中逐 incoming edge 固定策略，而不是把选择留给接收 Agent：

| 场景 | 推荐策略 | 原因 |
| --- | --- | --- |
| 实现节点 → 后续实现、修复、集成准备 | `result_handoff` | 下游需要知道前驱实际完成了什么、采用了哪些决策以及还剩什么问题。 |
| 探索、调研、分析 → 综合或实现 | `result_handoff` | 前驱的主要价值是压缩后的结论和证据引用，而不是完整探索轨迹。 |
| 实现 → 独立代码审查、安全检查、事实核验 | `evidence_only` | 需要排除前驱自由文本、结果摘要和 tool history 带来的锚定效应。 |
| 多个候选实现 → 评委、对抗或多视角验证 | `evidence_only` | 评委应基于冻结 artifact 和验收标准独立判断候选。 |
| 实现 → 只执行已确认命令的 E2E 测试 Agent | `result_handoff` | 测试 Agent 通常需要理解变更意图和不变量；若只是黑盒执行，可显式改为 `evidence_only`。 |
| 验证结论 → 返工实现 | `result_handoff` | 返工需要具体 blocker、证据和期望修复，但不能读取 verifier 的隐藏推理。 |
| 上游明确要求精确 transcript/tool-call 状态 | 不使用两种 Fresh 策略；选择 `fork` | 只有完整会话连续性是任务本身必需条件时才继承 transcript。 |

程序校验应以接收节点语义兜底：`review` / `verify` / `model-excluded` 只能使用 `evidence_only`；普通下游若声明 `result_handoff`，前驱必须具备该 schema 的完成结果。Main Agent 可以覆盖默认值，但不能覆盖这种硬约束。

### UI 与审计

节点详情应显示：

- 每条 incoming edge 的 policy。
- 实际提供 handoff 的 source node、operation 和 outputVersion。
- `result_handoff` 的 digest、大小和 schema。
- `evidence_only` 是否排除了 predecessor result summary 和 transcript。
- 缺失或拒绝原因。

事件建议：

- `context.handoff_policy_selected`
- `context.result_handoff_frozen`
- `context.evidence_only_frozen`
- `context.result_handoff_missing`
- `context.handoff_rejected`

## 取舍

| 维度 | `evidence_only` | `result_handoff` |
| --- | --- | --- |
| 连续理解 | 较低，可能缺少实现意图和未落盘决策 | 较高，能解释前驱做了什么、为什么这样做 |
| 独立性 | 最好，适合 review/security/verify | 较差，可能把前驱偏差传给下游 |
| 上下文成本 | 低 | 中等，受 summary 上限控制 |
| 实现成本 | 低，主要是 allowlist | 中，需要 schema、digest、完整性和失效规则 |
| 失败模式 | 下游理解断层 | 摘要失真、遗漏隐含状态、review 被污染 |
| 推荐场景 | 独立审查、证据核验、安全判断 | 实现流水线、有依赖的后续开发、需要理解前驱决策 |

`result_handoff` 不应包含大段代码、日志或 transcript。否则会退化为“用摘要复制完整 context”，同时承担高 token 和低独立性两个缺点。

## 推荐决策

建议接受以下方案作为 ADR 输入：

1. `result_handoff` 与 `evidence_only` 都是正式 graph edge policy。
2. Main Agent 在 proposal 中逐 incoming edge 选择，不能由接收 Agent 运行时自行选择。
3. 普通实现流水线默认 `result_handoff`；Main Agent 仍可按边覆盖。
4. 独立 review/verify 强制 `evidence_only`，否则 proposal 不合法。
5. 前驱只生成一份结构化 `ResultHandoff`，证据边只是选择不投影它。
6. `result_handoff` 缺失、过期或 digest 不匹配时 fail closed。
7. artifact 正文放文件系统，handoff 只带 bounded summary 和 exact refs。
8. Fork 保持独立第三种模式，不承担 result handoff 语义。

## 建议验收

后续实现至少覆盖：

1. Fresh 普通流水线能读取前驱刚生成的结构化结果摘要。
2. evidence-only reviewer 看不到 predecessor final text、tool history 或 `workSummary`。
3. review/verify 使用 result-handoff policy 时 proposal 直接拒绝。
4. result-handoff 缺失时 downstream 不发送模型请求，并产生 `context.rejected`。
5. 多前驱可分别使用不同 policy。
6. 容器依赖正确解析到 leaf provenance。
7. loop/rework 后旧 handoff 失效，新 activation 重新生成。
8. UI 和审计记录 exact source operation、outputVersion、policy、schema 和 digest。
9. 大结果只通过 artifact refs 传递，不进入结果摘要正文。
10. Fork 的 source/child context digest 校验和共享预算语义不回归。

## 限制

- OpenAI 的 handoff 语义是控制权转移，不等同于 Graph 的 predecessor result handoff；本文只借用其 input projection 设计，不把两者视为同一协议。
- Claude Code 文档是可更新的产品文档，不是冻结版本；本文引用 2026-09-18 可访问内容。
- Pi 官方 subagent chain 只提供 final output 传递先例，没有 Graph 所需的 schema、版本、digest 或 fail-closed 语义，这些仍需 Graph 自己实现。
- 本文没有决定 database migration、具体 TypeScript 类型名或 UI 文案；这些应在 ADR 和实现任务中固定。

## 主要来源

### Graph 本地

- [ADR 0014](../adr/0014-agent-context-continuity.md)
- [context.ts](../../src/core/context.ts)
- [execution.ts](../../src/core/execution.ts)
- [briefing.ts](../../src/catalog/briefing.ts)
- [types.ts](../../src/core/types.ts)
- [graph.ts](../../src/core/graph.ts)
- [pi-instance.ts](../../src/runtime/pi-instance.ts)
- [Pi SDK](../../node_modules/@earendil-works/pi-coding-agent/docs/sdk.md)
- [Pi subagent example](../../node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/README.md)

### 外部一手来源

- OpenAI Agents SDK handoffs, commit `fdf21db62c303a3db54b0dfbee82de2141fa2799`:
  <https://github.com/openai/openai-agents-python/blob/fdf21db62c303a3db54b0dfbee82de2141fa2799/docs/handoffs.md>
- OpenAI Agents SDK handoff input types:
  <https://github.com/openai/openai-agents-python/blob/fdf21db62c303a3db54b0dfbee82de2141fa2799/src/agents/handoffs/__init__.py>
- Claude Code subagents:
  <https://code.claude.com/docs/en/sub-agents>
- Anthropic effective context engineering:
  <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- Anthropic multi-agent research system:
  <https://www.anthropic.com/engineering/multi-agent-research-system>
