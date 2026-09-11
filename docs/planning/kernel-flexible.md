# 执行内核备选 B：可组合任务图与受约束操作

状态：实现规划备选，2026-09-10；未实现、未改变已确认产品规则。适用于 Design It Twice 的“最大可组合性”方向，与少量命令入口的方案比较。依据 [首版设计](../graph-mvp.md)、[领域术语](../../CONTEXT.md) 和既有 ADR。

## 设计判断

把执行内核设计成解释**持久化任务图描述**的深 module。主管和模板作者通过声明节点、连接、汇合规则、回环与子图组合工作；所有执行规则仍藏在同一个 module 后面。interface 不接受任意状态 reducer、自由终端回调或调用者自行获取运行名额的代码。

这一方案优先让八种图模式及三类验证器都能组合、版本化和解释。代价是调用者需要学习图描述与变更协议，interface 明显大于命令式方案。适合 Graph 内部模板作者和主管工具，不能把这些实现概念直接要求终端使用者填写。

建议 TypeScript 实现。LangGraph 是经过调查的调度候选，首版不因其自带检查点而默认引入；下文给出可用映射和额外成本。Rust 在此 module 没有已证明的必要性。

## Interface

以下为设计草图，表达必要类型和协议；不是已经存在、可以导入的代码。`Ref` 均指不可变且可校验的版本或内容引用，`Json` 为可序列化数据。不同 ID 在实际实现中使用不同名义类型。

```ts
type AgentNode = {
  kind: "agent";
  id: NodeId;
  instance: AgentInstanceId;
  definition: AgentDefinitionRef;
  initialModel: AllowedModelId;
  brief: BriefRef;
};
type ProgramNode = {
  kind: "program";
  id: NodeId;
  operation: OperationVersionRef;
  input: Json;
};
type Edge = {
  from: NodeId;
  to: NodeId;
  outcome: OutcomeName;
  requirement: "required" | "optional";
};
type GraphRevision = {
  graph: GraphId;
  version: number;
  nodes: (AgentNode | ProgramNode)[];
  edges: Edge[];
  containers: {
    id: ContainerId;
    members: (NodeId | ContainerId)[];
    exports: ArtifactBinding[];
  }[];
  joins: {
    at: NodeId;
    members: NodeId[];
    policy: "all-required";
  }[];
  loops: {
    id: LoopId;
    implementation: NodeId[];
    verification: NodeId[];
    returnTo: NodeId[];
    noProgressLimit: 3;
  }[];
};
type RevisionProposal = {
  baseVersion: number;
  next: GraphRevision;
  reason: string;
  // 引用原验收范围与证据，程序校验而非相信主管声明
  acceptance: AcceptanceVersionRef;
  evidence: EvidenceRef[];
};
interface ExecutionKernel {
  defineOperation(spec: OperationDefinition): Promise<OperationVersionRef>;
  validate(graph: GraphRevision): ValidationReport;
  enqueue(task: ConfirmedFeatureTask, graph: GraphRevision): Promise<RunId>;
  revise(run: RunId, proposal: RevisionProposal): Promise<RevisionReceipt>;
  control(run: RunId, request: ControlRequest): Promise<ControlReceipt>;
  inspect(run: RunId): Promise<RunView>;
  follow(run: RunId, after?: EventCursor): AsyncIterable<RunEvent>;
}
type ControlRequest =
  | { type: "pause"; scope: "run" | NodeId; requestId: RequestId }
  | { type: "resume"; hold: HoldId; clarification?: BriefRef;
      requestId: RequestId }
  | { type: "resolve"; hold: HoldId; resolution: AuthorizedResolution;
      requestId: RequestId };
```

`ConfirmedFeatureTask` 必须包含仓库位置、目标分支、已确认验收版本、权限上限和使用者允许的模型。默认并发 10，实例额度 20,000,000；普通主管图变更不能修改额度。`AuthorizedResolution` 绑定真实使用者/主管身份和授权范围，不能通过随意传入 `actor: "user"` 升权。

操作注册用于模板扩展，限定为以下内容：已版本化纯规则、工具描述、受执行程序管理的动作协议。主管安装任意扩展并不等于将任意代码注入调度进程。扩展 worker 只能提出动作请求，由执行程序核准后运行。操作定义必须声明输入/结果 schema、错误分类、效果类别及恢复核查方式。外部动作没有核查方式时，崩溃后进入人工介入；不能默认重做。MCP、扩展及终端操作的实际权限隔离必须在 Pi 验证阶段证明，单凭此 TypeScript interface 无法实现操作系统隔离。

可提供 `sequence`、`fanOut`、`route`、`loop`、`subgraph` 和三类验证器的构造函数；它们只生成上述数据，不持有会话、不执行模型。验证器也是组合模板，结果通过统一证据协议送入程序判断：有效阻塞反例未解决则失败、所有必需维度通过、候选先过硬性要求再评分。模板输出仍需经过同一个 `validate` 和正式状态校验。

### 调用顺序、约束与错误

1. 操作与 Agent 定义必须先存在且带版本，随后验证并入队。入队是持久化成功，非执行成功；只有队首功能任务执行。重发写操作携带请求 ID，返回原回执。
2. 节点与实例一一对应且不可重新绑定；模型不参与实例身份。回环增加执行轮次/激活序号，不增加节点、会话或额度。一个实例不能同时激活两次。
3. 图版本是乐观并发更新；过期 `baseVersion` 返回 `RevisionConflict`。受变更影响的运行中节点在当前调用结束后停稳，再提交版本；不相关分支继续。正在执行的调用始终记录启动时版本，不能被新图“抹掉”。
4. 节点删除采用保留历史的停用记录；不得删除已发调用、已有产物和预算归属。把额度耗尽节点换名重建以继续相同工作也必须被拦截：额度阻塞关联未完成工作及其来源，重新分配不能消除待追加额度状态。
5. 普通暂停回执先为 `draining`；所有当前调用已完成、所有 worker 已确认门控后才成为 `paused`。`resume` 必须引用当前 hold，旧 hold 返回 `StaleHold`。语义澄清先做影响评估；新增功能进入新任务，不能在 `revise` 中夹带新增验收范围。
6. 汇合输入按版本、循环轮次及产物来源校验。相同轮次内失败重试复用成功分支；代码或上游证据改变时只失效受影响证据，不能用上一轮的审查成功放行本轮新代码。提前标定的可选分支允许缺席。
7. 10 个名额由整个运行共享。Agent 等待主管回答、依赖或审查时释放；恢复前重新申请。程序节点不计入，但自身资源调度不能无限启动终端进程。暂停不仅检查图节点派发，还检查每次模型、工具、压缩等内部调用。
8. `inspect` 返回一致快照及事件游标；`follow` 是持久事件序列的增量投影，浏览器断线从游标续接。事件可能重复投递，事件 ID 去重；UI 不因断线停止后台。

可修正输入错误返回 `InvalidGraph`、`UnknownDefinitionVersion`、`InvalidSchema`；越权/变更范围返回 `PolicyDenied`、`AcceptanceChangeRequiresUser`。运行中的 `BudgetExhausted`、`UsageUnknown`、`NoEligibleModel`、`NoProgress`、`EffectOutcomeUnknown` 是可观测 hold，包含 scope、证据和允许处理方式，不将整个后台进程抛崩。数据库不可写等基础故障停止新派发并报告健康故障。

性能约束：图校验至少遍历节点和边；大图变更影响分析与事件回放需索引/快照。长对话只存引用，避免每次图更新复制 Pi 完整会话。没有运行时长上限，不应把框架默认最大步骤当作产品停止条件。

## Usage example

```ts
// 主观审查由 Agent 做；通过规则由程序节点计算。
const plan = composeGraph({
  agents: [frontend, backend, reviewer], // 已配置且各自拥有唯一实例
  program: [integrationTests, acceptanceGate, mergeTarget],
  flow: sequence(
    fanOut([frontend.id, backend.id], { join: "all-required" }),
    integrationTests.id,
    reviewer.id,
    route(acceptanceGate.id, {
      passed: mergeTarget.id,
      rework: loopBack([frontend.id, backend.id]),
    }),
  ),
  noProgress: { implementation: [frontend.id, backend.id],
                verification: [integrationTests.id, reviewer.id], rounds: 3 },
});
const report = kernel.validate(plan);
if (!report.ok) return presentErrors(report);
const run = await kernel.enqueue(confirmedTask, plan);
await kernel.control(run, {
  type: "pause", scope: "run", requestId: pauseRequestId,
});
for await (const event of kernel.follow(run, savedCursor)) {
  renderProjection(event); // 后台生命周期独立于此订阅
}
```

上例 `composeGraph` 等只是说明组合 interface。真实计划若前后端存在数据协议依赖，先串行确定协议；不能因模板支持扇出就假定两者独立。返工路由由问题归属决定，示例同时返回两个节点不是固定策略。`mergeTarget` 验证已检查的 commit 与目标分支状态，在目标移动后重新集成检查；其结果必须有 Git 证据。

## Seam 后的 implementation

调用者不需要拼装：图编译/校验与版本历史、就绪计算和分支阻塞传播、循环代际与证据失效、全局名额、预算预留/结算、调用去重、恢复核查、主管问答的等待/唤醒、任务说明包和产物索引、Pi 会话恢复、模型切换记录、独立工作副本、集成和检查证据、投影与断线续接。

最关键的内部记录是 `InvocationId` 与 `EffectId`。每次原始模型请求先持久化归属实例和预留，再派发，再结算；用量回调和会话恢复观察到同一请求不得重复入账。缺失用量进入待核对，不能在恢复或换模型后记零。工具内发起的模型请求、自动压缩等也必须经过相同路径。

外部动作采用 `planned → dispatched → observed | unknown`，记录预期对象及核查依据。恢复 Git 合并用提交/树与引用证明结果；仅有命令退出记录缺失不足以认定失败。创建文件、安装能力、MCP 写操作有各自核查器；不能核查时等待。数据库事务和外部效果之间没有通用原子提交，不能许诺 exactly-once。

## 依赖分类与 adapters

| 依赖 | 分类 | 测试与 seam |
| --- | --- | --- |
| 就绪计算、必需分支、循环、额度算术、证据门槛 | In-process | 并入 module，通过上述 interface 验证，无单独 adapter。 |
| SQLite、文件内容、Git worktree/ref | Local-substitutable | 内部 seam；测试使用临时 SQLite 文件和临时 Git 仓库，崩溃/重开通过真实存储验证，不用纯内存假装持久恢复。 |
| Pi 运行和供应商请求 | True external | 内部注入 Pi adapter 和可控测试 adapter；生产保留独立会话，测试模拟用量缺失、模型失败、调用间暂停。另用少量真实 Pi/provider 冒烟测试确认外部协议。 |
| MCP 与下载/安装源 | True external | 受动作协议控制的 adapter；测试模拟成功后断线、不可核查结果及权限拒绝。 |

Pi SDK 虽在本机进程运行，对其会话语义及外部 LLM 行为没有控制权，故此处按外部依赖管理；不能只 mock SDK 就声称真实工具/扩展权限有效。没有远程自有服务需求，不增加网络 ports。

## LangGraph JS 适配核查

以下区分官方事实和本项目推论；核查日期 2026-09-10，正式采用前仍需锁版本并运行小范围验证。

| 能力 | 官方依据 | 对 Graph 的判断 |
| --- | --- | --- |
| 动态路由与扇出 | `Command` 合并状态更新与路由，`Send` 给命名节点发送不同输入；图在执行前 compile。[Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api) | 可实现模式，但动态派发到 worker 不等同于动态增加有稳定业务身份的 Agent 节点。须额外保存实例 ID、激活 ID 与图版本。 |
| 拓扑迁移 | 中断线程的节点重命名/移除受限制。[Graph migrations](https://docs.langchain.com/oss/javascript/langgraph/graph-api#graph-migrations) | 不能把主管改图直接映射为热改 compiled graph。需停稳受影响执行并迁移，或使用固定调度图解释业务图。 |
| 子图 | 子图支持持久模式；同一 per-thread 子图的并行调用有 checkpoint namespace 冲突约束。[Subgraphs](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs) | Pi 的独立会话应自行按实例持久化；业务容器不必创建第二套会话。LangGraph 子图不是全局 10 名额的权威。 |
| 持久化 | checkpointer 保存线程图状态；MemorySaver 重启会丢失。[Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) | 可以保存执行游标；不直接证明 Git/MCP/文件动作只做一次，也不替代用量账本。 |
| interrupt | 恢复会从触发 interrupt 的节点开头再执行。[Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) | 在 `session.prompt()` 前后 interrupt 无法实现 Pi 内部每调用暂停；前置副作用也要去重/核查。 |
| 效果恢复 | 官方要求把效果放入 task 并保持幂等，任务未完成时可能重做。[Functional API](https://docs.langchain.com/oss/javascript/langgraph/functional-api) | task 包裹完整 Pi 回合仍有“效果成功但结果未落盘”窗口；Graph 必须保留动作核查和缺失用量 hold。 |
| 调度 | Pregel 超步执行所选 actor，阶段结束后应用更新。[Runtime](https://docs.langchain.com/oss/javascript/langgraph/pregel) | 长 Pi 回合放入一个 LangGraph 节点，会推迟其他独立分支后继的执行；需短派发/收集步骤或独立 worker。 |
| 独立会话 | Pi SDK 提供会话创建、资源和模型配置。[Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) | 可以嵌入普通 JS 节点函数；集成方式本身不证明调用门控、隔离和额度正确。 |

建议不选“一个产品 Agent 节点直接包整个 Pi prompt，再让 LangGraph 独占恢复”的映射。它无法自然覆盖即时调用门控、动态新增业务节点、失败分支不阻断其他后继等约束。

若采用 LangGraph，较合理的实现是固定调度图 `collect → decide → dispatch → park`，短步骤处理持久化指令，Pi worker 在外部按实例执行。`Send` 只分配已持久化的激活，不以 LangGraph 临时 task ID 定义 Agent 身份。业务任务图与八种模式保存在 Graph 图描述里，由解释器执行。这样能用 checkpoint 和 interrupt 承接调度游标，但 LangGraph 已经承担较少业务复杂性，是否仍值得引入需要验证而非预设。

### 两套状态机与日志职责

**Graph SQLite 是正式状态权威**：任务图版本、实例身份、节点激活、权限、全局名额、调用预留/用量、hold、效果记录、验收证据和 Git 集成状态。**LangGraph checkpoint 只负责编排游标与可重复派发的引用**，不能在 reducer 内维护第二份权威预算或正式节点成功状态。Pi 会话文件另负责对话树，不是第三份业务账本。

两套状态机通过 `dispatchId` / `invocationId` 和 Graph 的 inbox/outbox 协调：Graph 先事务写动作意图，LangGraph/worker 领取；重复领取返回原结果或待核查状态。结果先提交 Graph，再推进调度 checkpoint。若 checkpoint 落后则重读幂等结果；若无法验证引用对应 Graph 事实则暂停修复，不能从 checkpoint 反向强行覆盖事实。

不假定 SQLite checkpointer 与领域 SQLite 能共享一个事务，即使它们在同一文件。重启先恢复 Graph 记录、核查未知效果和用量、清理过期运行租约，再恢复框架调度。恢复工作需要防旧 worker 继续提交/派发的 fencing；父进程重启不表示子进程或远程请求已经终止。

若去掉 LangGraph，单套 Graph 状态机直接调度，Pi 对话仍单独保存；上述 interface 不变。但不为尚未选择的两个调度实现提前设计公共 backend port，先做验证并选定一种。

## 必须先证明的机制

用可控 Pi adapter 加临时 SQLite/Git，从 module interface 驱动：一条慢分支不阻塞另一条独立分支的后继；暂停与派发竞态无下一调用；10 名额覆盖嵌套与主管等待；回环不重建实例；重启前后用量不重置；动作成功但落盘前崩溃不会盲重试；动态版本更新不接收失效证据；目标分支变化触发重检。若评估 LangGraph，使用同一组验收，不以框架自己的 happy path 演示替代。

Pi 实际集成验证必须覆盖模型、工具、自动压缩与扩展请求的门控，以及会话持久化和 Graph 账本之间崩溃窗口。未经验证，不在计划中把 SDK hook 写成已经解决的保证。

## Trade-offs

Depth 较高处是主管只声明可组合图和修改意图，预算、暂停、身份、恢复和证据都留在 implementation。Locality 集中在图解释与动作准入，添加三类验证模板无需每处重新处理恢复。

Depth 较薄处是图描述及注册协议本身需要学习；若给每个小计算都注册独立 operation，会产生形式大于收益的 shallow module。只在模板复用与实际动作可变处使用注册，纯规则留在内部。

与少量命令入口相比，本方案更适合频繁组合嵌套验证器，但维护 schema、迁移和组合器有成本。建议保留它的持久化图描述、实例身份和动作核查设计；外部任务使用者仍使用简单“确认任务、暂停、回应、查看”interface。LangGraph 不作为默认依赖，除非验证证明它减少的调度实现超过新增的双状态协调成本。
