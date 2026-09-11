# 执行内核方案 C：面向功能任务的持久 Task Runtime

状态：实现规划候选，尚未实现。2026-09-10。遵循 [首版设计](../graph-mvp.md)、[术语表](../../CONTEXT.md) 及现有 ADR，不缩减图模式、验证器或自主安装能力的范围。

## 选择的 seam

最常见调用者是本机 Web：与主管讨论、确认说明、观察后台执行、回答问题，最后收到自动合并结果。它不应拼装节点、消费内部执行命令，也不应负责恢复会话。

本方案把 seam 放在一个功能任务的生命周期。Task Runtime 是 deep module，外部 interface 提供持久 task handle；implementation 可以采用任务 actor 的串行收件箱，同时调度多个 Agent 执行。这里的 actor 是实现组织方式，不意味着引入分布式 actor 框架。

与 command kernel 相比，调用者使用任务语言，不必学内部命令集合；与可组合 graph builder 相比，调用者不构图、不持有 checkpointer，也不选择条件边。图是主管提交、程序校验后产生的可观察结果。这不是给另一个公开内核再套一层转发：调度、正式状态、暂停与恢复的规则均由本 module 负责，只有 worker 等外部执行依赖跨 internal seams。

## Interface 草案

以下为设计伪码；类型名表达契约，不承诺已有 SDK。

```ts
interface TaskRuntime {
  begin(input: {
    project: ProjectId;
    request: string;
    requestId: string;
  }): Promise<TaskHandle>;
  task(id: TaskId): TaskHandle;
}

interface TaskHandle {
  readonly id: TaskId;
  say(text: string, requestId: string): Promise<Receipt>;
  accept(input: {
    proposalVersion: number;
    targetBranch: string;
    requestId: string;
  }): Promise<Receipt>;
  pause(requestId: string): Promise<Receipt>;
  resume(requestId: string): Promise<Receipt>;
  answer(question: QuestionId, value: Answer, requestId: string): Promise<Receipt>;
  view(): Promise<TaskView>;
  watch(after?: Cursor): AsyncIterable<TaskUpdate>;
}

type TaskView = {
  id: TaskId;
  revision: number;
  phase: "discussing" | "queued" | "running" | "pausing"
    | "paused" | "recovering" | "merged" | "failed";
  proposal?: { version: number; acceptance: AcceptanceItem[] };
  graph: GraphView;
  questions: QuestionView[];
  usage: UsageView;
  delivery?: { commit: string; targetBranch: string; evidence: EvidenceRef[] };
};

type Answer =
  | { kind: "clarification"; text: string }
  | { kind: "add-budget"; tokens: number }
  | { kind: "grant"; grant: ScopedGrant }
  | { kind: "verification"; evidence: EvidenceRef; passed: boolean }
  | { kind: "reconcile"; evidence: EvidenceRef };
```

持久身份是 `TaskId`，不是 JavaScript 对象。daemon 重启或 Web 重连后 `task(id)` 取得相同任务的 handle。`Receipt` 只证明请求已经持久接受，附 revision 和结果标识；不暗示模型已完成、任务已暂停或已经合并。`watch` 只传输持久状态更新及可重建摘要，支持 cursor 重连；日志、产物通过只读引用加载，避免重连重复传输全部会话。

项目注册时配置路径、模型目录、权限基线、Agent 定义版本选择、10 个运行名额与每实例 20,000,000 token 默认额度；无需每次重复传入。daemon 启动配置与依赖注入留在 composition root。主管对话也由运行名额管理：其他任务排队期间，待讨论的主管请求进入全局调度器，不得越过 10 个名额；是否优先处理交互请求是调度策略，不是第二个功能任务开始实现。

`answer` 由经过本机会话身份认证的用户通道提交，不能作为主管自调用的万能授权工具；主管只有内部的、受用户授权上限约束的提案 interface。扩展不能伪造用户身份。自然语言 `say` 不直接增加权限或额度：需要绑定正式 question 的结构化答复。

## 常见使用例

```ts
const task = await runtime.begin({
  project: mediaBookmarks.id,
  request: "为现有 CLI 添加 B站收藏本机 Web 应用",
  requestId: submittedFormId,
});

// Web 将 say 接到输入框；主管形成可检查的需求说明。
await task.say("需要查看采集失败原因，并导出 Markdown", messageId);
const view = await task.view();

// 用户点击已展示版本的“确认并执行”。
await task.accept({
  proposalVersion: view.proposal!.version,
  targetBranch: selectedTargetBranch,
  requestId: confirmationId,
});

for await (const update of task.watch(savedCursor)) {
  render(update); // 图、问题、状态与交付；浏览器断开不会停止执行。
}
```

UI 不负责“审查未通过则重新 prompt”、分支汇合、token 累加或 merge。这些一旦泄露到调用端，module 的 depth 就被破坏。发布没有自动入口，最终交付状态为 `merged`。

## Invariants、调用顺序与错误

| 契约 | 行为 |
| --- | --- |
| 需求确认 | 仅能确认已展示、仍有效的 proposalVersion；固定验收项、检查方式、证据要求及目标分支后进入队列。旧版本返回 `StaleProposal`。 |
| 任务顺序 | 一次只执行一个功能任务；新增功能建立独立 handle 并排队。`say` 中识别出的新增功能形成新任务草案，不能修改当前验收。 |
| 暂停 | `pause` 先持久关闭准入，再返回 `pausing` receipt；已发送调用可结束。只有所有模型/工具调用停稳、记录落盘后发布 `paused`。`resume` 在 pausing 时返回 `NotQuiescent`。 |
| 澄清 | 已确认任务收到范围内澄清时先暂停并形成影响评估；受影响证据失效，保留原因后才能恢复。新增功能不使旧任务成果失效。 |
| 部分受阻 | 节点问题阻塞它及依赖闭包，其他独立分支继续；全任务问题或权限上限问题关闭整个任务准入。task phase 可以仍为 running，同时展示 questions 与受阻节点。 |
| 人工问题 | question 带作用域、版本、允许答案类型。重复答复按 requestId 去重；已失效的问题返回 `QuestionClosed`，错类型返回 `InvalidAnswer`。 |
| 持久重试 | requestId 与内容绑定；同 ID 同内容重放返回原 receipt，不重复派发。相同 ID 不同内容返回 `RequestConflict`。外部操作不宣称 exactly-once。 |
| 身份与循环 | Agent 节点和实例一一对应；返工只增加执行轮次。会话、worktree、额度和实现模型集合持续累计；不能换实例洗额度。 |
| 并发 | 名额按正在执行的 Agent 计数，主管计入；同实例多个已准入工具仍只占一个名额。等待依赖/人工答复释放名额，恢复重新获取；子图共用池，程序节点不占。 |
| 合并 | evidence 绑定验收版本与具体 tree/commit。目标分支前移先重集成和重检；最终更新目标分支时校验旧 tip，竞争失败重新核查，不能复用不对应当前组合的通过结论。 |

配置缺少项目或目标分支、没有有效模型、权限不满足分别表现为 `UnknownProject`、`InvalidTarget`、可处理的模型 question、权限 question。供应商失败、预算不足、缺失用量不是 HTTP 请求失败后遗忘的异常，而是可重连看到的正式执行状态。数据库不能持久化时不能向调用者返回成功 receipt，关闭新执行准入；恢复后先核查已有副作用。

性能契约：写调用只等待持久接受，不等待长模型回合；任务时长无总上限。普通暂停可能长时间等待已经发出的工具，期间始终显示 pausing 和对应调用，不能虚报完成。

## Implementation 隐藏的复杂性

一个任务收件箱串行处理状态转换；单独的执行 workers 发起工作并回报带 operationId、instanceId、round、graphVersion 的证据。状态写入、request 去重、执行意图写入同一事务，提交后才派发。启动扫描未完成意图并核查外部结果；第二个 daemon 必须拿不到同一运行权，过期 worker 的回报可保留为证据但不可直接提交新状态。

运行许可不是可提前囤积的通行证。准入必须贴近 broker 实际 dispatch，与 pause 的状态变更串行化：排在 pause 前的发送视为已发，排在它之后的一律等待。工具 preflight 后到 execute 前还可能停顿，必须在实际执行 broker 再查 gate，不能只依靠 Pi 提前执行的一次 hook。

每个模型实际 attempt 先登记意图与预算预留，结束后按供应商语义结算原始用量；Graph 汇总是投影，不能把子 Agent 结果中的 token 再计入主管。错误消息中的默认零值不能证明零成本：只有明确返回的有效 usage 才结算，否则待核对并阻塞该实例。重启后未知用量需要核对，再决定重发；不能边暂停待核对边给原工作换新实例继续消费。

自主调整图、三类验证器、三轮无进展、模型独立性、验收证据与合并核验均在 implementation 内集中落实。主管只能提议，程序校验所有必需分支、模板规则和授权上限。Graph view 提供稳定节点身份与版本，不向 UI 暴露内部数据库表或 Pi 会话树。

## Pi 接入：能证明什么，不能假定什么

源码核查固定到 Pi 提交 `400d6905ce46ec46e79da8a7701b1b48850192df`；这是研究快照，不等同于已选定 npm 发布版。实施时必须把包版本与此类特性逐一对应并锁定。

1. **会话恢复有现成基础。** `SessionManager.open` 可打开指定会话，SDK 支持持久会话和 `AgentSessionRuntime` 会话替换；替换后需要重新订阅/绑定。Graph 保存 instance 对应的精确会话标识，不使用“最近会话”恢复多实例。Pi 的会话恢复不替 Graph 核验已经执行的 Git 操作。[官方 SDK](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/coding-agent/docs/sdk.md)

2. **普通 agent loop 存在可控制的 internal seam。** `Agent.streamFunction` 和 `beforeToolCall` 为 public；`StreamFn` 可异步返回流，因此可在发起之前等待准入，工具可在执行之前拦截。`StreamFn` 的运行失败契约是返回 error/aborted stream，而非抛错；Graph adapter 必须保持此协议。[Agent 实现](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/src/agent.ts)、[类型契约](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/src/types.ts)

3. **摘要也需要覆盖。** 此快照的内置 compaction 和 branch summary 把 `this.agent.streamFunction` 传给下层实现，是包裹 stream seam 的有利证据。仍需证明每次 retry、上下文溢出后重试、扩展自定义摘要都进入 Graph 的实际请求 broker；仅监听 message_end 或每轮 before_agent_start 不足。[AgentSession 源码](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/coding-agent/src/core/agent-session.ts)

4. **extension hook 不能单独承担安全与预算。** 官方 `tool_call` 可阻止执行，但同批工具默认并行且先逐个 preflight；`before_provider_request` 用于替换 payload，不是覆盖任意第三方代码网络访问的总阀门。扩展具有运行进程的系统权限。[扩展说明](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/coding-agent/docs/extensions.md)

5. **用量必须按来源正规化。** Pi Usage 区分 input/output/cacheRead/cacheWrite；reasoning 是 output 子集，cacheWrite1h 是 cacheWrite 子集，不能再次相加。供应商返回的 total 与分项映射须作 contract test；不能仅凭对象存在判定中断调用用量完整。[Usage 类型](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/ai/src/types.ts)、[Anthropic 映射](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/ai/src/api/anthropic-messages.ts)

结论：SDK 的公开低层接口足以提出普通模型/工具调用的受控 adapter，但尚不能证明仅用高层 `session.prompt()` 加几个订阅就满足每调用暂停和预算。首个实现门槛必须验证完整调用路径。若所选发行版或 provider 内部重试绕过 stream gate，就由 Graph 管理 retries，并在每个真实模型请求的 broker 上准入；必要时采用受控 Pi lower-level adapter，保持 Pi Agent 硬约束，不以“SDK 没提供”静默降级产品规则。

## MCP、扩展与本机执行限制

提出的架构是 daemon 持有数据库、凭据和用户授权；Pi workers、MCP servers、安装脚本在有实际 OS 限制的执行环境运行。所有 LLM 请求穿过 daemon 的 broker，worker 不持有可直连供应商的长期凭据；工具的文件、命令、联网操作通过受控执行入口落实任务 grant。新增安装不会向 daemon 进程直接 import 任意扩展，运行中的实例绑定原版本。

MCP stdio 规定客户端启动子进程并交换 JSON-RPC，这只说明通信方式，不提供权限隔离。[MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) 普通子进程、worktree、cwd 均不是 sandbox；任意 bash、依赖安装脚本和扩展的直接文件/网络访问也必须受执行环境限制。

可验证的候选为 macOS OS sandbox 或受限 VM/container。域名放行不代表允许外部写操作：联网资料检索应由受控读取 broker 提供，外部服务修改采用结构化操作和 scoped grant；否则无法承诺“可检索但不可自行发布”。选哪种隔离 implementation 在 M0 用绕过案例验收决定，不靠增加确认弹窗代替。能力可以自主搜索和安装；与受限环境不兼容的扩展保留安装记录并报告明确原因，不能自动切到无限权限执行。

## 依赖与测试策略

| 依赖类别 | 放置方式 | 验证方式 |
| --- | --- | --- |
| In-process | 图校验、预算预留、依赖闭包、验证器判定、模型排除与三轮停滞规则直接放入 module implementation；不为纯规则制造 port。 | 通过任务 interface 驱动场景，断言 graph/question/delivery。 |
| Local-substitutable | SQLite、Git、会话文件、worktree 属于 internal seams；SQLite driver 可封装版本差异，不把连接或事务暴露给 Web。 | 临时磁盘 SQLite 与真实临时 Git 仓库；关闭重开、进程终止、目标分支竞争、先写副作用后崩溃。内存 SQLite 不替代崩溃恢复测试。 |
| True external | Pi/provider 交互、MCP 和自主安装来源由注入 adapter 承担；生产 Pi adapter 与 scripted adapter 构成真实 seam。 | Scripted adapter 明确控制请求阻塞点、usage 缺失、模型切换、多个工具、反例及评分；少量所选 Pi 版本/供应商的 contract tests 证明映射。 |
| Local process execution | worker/沙箱 runner 是内部执行 adapter，工具操作意图由 Runtime 管理。 | 真实受限 worker 测试越界路径、符号链接、环境凭据、直接 HTTP、子进程、安装脚本绕过；fake 不能证明权限生效。 |

测试通过同一个 task interface，观察实际调用是否发生，而不是窥探私有队列表。生产与 scripted adapter 都遵守“发起、结果、未知结果”的生命周期。未来替换调度 implementation 时这些测试不应跟着重写。无需预建远程微服务 port：当前没有自有远程依赖。

## Trade-offs

对 Web、CLI 和端到端测试，depth 高：一个 task handle 获得从讨论到合并的完整行为；重复连接、暂停竞态、证据核验的 locality 集中。删除该 module 后，这些知识会散入每个调用者，说明它承担了真实复杂性。

代价是它不能作为任意用户工作流 SDK：新生命周期动作会扩充 interface，actor implementation 若不维护内部职责会膨胀。它也不会让用户把自定义 graph builder 塞给执行器，这是有意针对“主管构图、用户观察”的产品选择。图结构和编排仍是重要内部协议，可以深设计，但不是 Web 要掌握的公开 seam。

## Milestone gates

1. **M0：证明 Pi 调用控制与权限。** 锁定候选版本；暂停卡在模型返回后、第二个工具前、压缩与 provider retry 前均不再新发；缺失用量不走下一调用；恶意或不兼容扩展无法绕过执行环境直写或借凭据直连。未通过则更换受控 adapter/runner，不能先搭 UI 假装规则已有保证。
2. **M1：持久任务骨架。** Scripted adapter 完成 begin → 讨论 → 固定验收 → 排队 → 程序检查 → delivery；重复 requestId、daemon 重启、watch 重连、调用结果未知保持一致。
3. **M2：全部编排规则。** 八种图模式及嵌套各有场景，通过同一 task interface 验证必需分支、三类验证器、原节点返工、三轮停滞、10 名额、模型排除与不重置额度。先后拆分可以迭代，首版出口不得遗漏。
4. **M3：真实代码集成。** 临时真实仓库完成独立副本 → 任务集成分支 → 测试和审查 → 目标分支；制造 target 前移与 merge 后落账前崩溃，证明恢复和再检。
5. **M4：本机 Web 与真实 Pi。** 所有 UI 动作调用同一 interface；页面关闭继续，重开看到同一任务；问题解答权限由用户会话证明。能力库/Agent 库版本与自主安装接入已通过的执行环境。
6. **M5：MediaBookmarks 验收。** 在独立功能任务内确认具体验收说明后完成 B站 Web 流程、独立审查和自动合并；与机制验收矩阵共同作为 Graph 首版出口。

以上是依赖顺序和可执行出口，不是工时承诺；真实模型清单、目标分支与 MediaBookmarks 人工登录证据在相关任务输入中确定。
