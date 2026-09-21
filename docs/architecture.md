# Graph 实现架构

日期：2026-09-12。基于使用者已确认的 [首版设计](graph-mvp.md)。本文为完整工程方案；M0 已验证固定版本 Pi 的受控接入及当前 macOS 执行限制，见 [M0 报告](planning/m0-results.md)。M1 已实现任务入口、固定 DAG、操作结算和恢复核对，见 [M1 报告](planning/m1-results.md)。M2 已实现版本化图、容器、回环、主管修订、连续调度与三类验证器，见 [M2 报告](planning/m2-results.md)。M3 已实现生产 Pi adapter、模型目录、Agent 库与主管规划，见 [M3 报告](planning/m3-results.md)。M4 已实现实例工作副本、任务集成分支与自动合入，见 [M4 报告](planning/m4-results.md)。M5 已实现本机 HTTP/SSE 与 React 任务图，见 [M5 报告](planning/m5-results.md)。M6 机制矩阵见 [M6 报告](planning/m6-results.md)。M7 在克隆上交付 B站 Web，生产路径与页面验收见 [M7 报告](planning/m7-results.md) 与 [验收复验](planning/acceptance-rework.md)。

## 架构选择

采用 **TypeScript 自有执行内核 + Pi Agent + SQLite + 本机 Web**。首版不引入 LangGraph 或 Rust；全部图模式和验证器仍在首版范围内。

### 三种接口方案的比较

1. [命令式持久内核](planning/kernel-minimal.md)：submit / inspect / watch 三个入口隐藏图执行、预算、恢复与集成。规则集中，适合作为内部 implementation；若将所有命令直接暴露给 Web，调用者仍需理解较多执行概念。
2. [可组合图接口](planning/kernel-flexible.md)：声明图、注册动作、提交图修订，表达能力最强，适合主管与模板实现；作为用户入口会暴露过多图协议。LangGraph 的具体映射需要额外维护业务图身份和调用控制，并不能消除 Graph 的正式状态库。[LangGraph Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api)、[恢复规则](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
3. [任务级 Runtime](planning/kernel-task-runtime.md)：Web 使用“讨论、确认、暂停、答复、查看”的任务 interface，内部负责完整生命周期。最符合用户主要操作，但需要控制内部职责，防止任务 module 膨胀。

选用第三种作为外部 interface，将第一种的持久化命令处理和第二种的图描述放在同一个任务 module 内部。不是同时建立三套公开 Runtime。规则的 locality 在任务内核；模板只生成图数据，Pi 只执行 Agent，Web 只呈现状态。

## 技术基线

| 部分 | 规划选择 | 理由与验证边界 |
| --- | --- | --- |
| 运行时 | Node.js 24 LTS、TypeScript ESM、pnpm | Pi 与 Web 共用语言；M0 固定准确补丁和包版本，不修改其他项目环境。 |
| Agent | Pi SDK，经受控 adapter 接入 | 独立会话、模型与工具；M0 验证逐调用控制，不把整个 prompt 当成一个不可观察动作。 |
| 图执行 | 自有持久状态机和版本化图描述 | 稳定实例身份、动态节点、全局名额和程序权威统一管理。 |
| 持久化 | SQLite WAL + FULL；node:sqlite 封装在内部 | 本机单写者短事务。Node 驱动仍为 release candidate，M0 固定版本并做磁盘数据库验证。 |
| 本地 HTTP | Fastify，HTTP 命令/查询 + SSE 更新 | 长任务不占 HTTP 请求；浏览器断线从事件游标续接。 |
| 界面 | React + Vite + React Flow，elkjs 自动布局 | 图为执行状态投影，支持子图展开、回边与节点详情，无手工编排。 |
| 代码隔离 | Git worktree + 受控 Git 操作 | 每实例副本、任务集成分支、目标分支核验。 |
| MCP | 官方 TypeScript client，经工具执行 adapter 管理 | 本地 stdio 和远程连接；连接不等于权限授权。 |
| 测试 | Vitest、临时磁盘 SQLite/真实 Git、Playwright | 核心从任务 interface 测试，真实 Pi 契约与 OS 执行约束另测。 |

运行时、存储、Web 与执行限制的来源和本机版本见 [基础核查](planning/runtime-foundations.md)。版本锁定是 M0 的产物，本文不把未安装的依赖写成已验证组合。

## 进程与模块

```mermaid
flowchart TB
  U[本机 Web：对话、图、问题、记录] --> H[HTTP / SSE]
  H --> T[Task Runtime：正式任务状态]
  T --> DB[(SQLite：状态、用量、操作日志)]
  T --> F[会话与产物存储]
  T --> C[Agent 库 / 能力库]
  T --> G[Git 集成模块]
  T --> B[调用准入与执行 broker]
  B --> P[受限 Pi worker / MCP / 工具进程]
  B --> L[已配置模型供应商]
  P --> B
```

后台独立启动，关闭浏览器不停止它。第一次实现采用单后台所有者；额外启动的后台不能领取同一任务。macOS 自动重启由本机进程宿主接入，数据库恢复协议保持独立于启动方式。

| Module | Interface 的主要责任 | Implementation 隐藏的复杂性 |
| --- | --- | --- |
| Task Runtime | 任务讨论/确认、控制、问题答复、查询与订阅 | 图修订、就绪判断、名额、预算、验收、恢复、队列及正式状态写入。 |
| Agent execution | 恢复指定实例、推进、回传调用事件与结果 | Pi 会话、模型切换、上下文说明包、压缩摘要、逐请求 usage；生产 Pi 与 scripted 测试 adapter。 |
| Operation execution | 执行已准入操作、核查不明结果 | 文件/进程/MCP/模型实际派发、OS 限制、凭据、前置事实和结果证据。 |
| Catalog | 安装/发布版本、解析可复用定义 | Skills/MCP/扩展来源、版本、完整配置快照、实例版本固定。 |
| Git integration | 准备实例副本、汇集修改、验证后合入 | 分支与工作树、冲突、目标变化、精确提交证据和崩溃后核查。 |

### 执行模块导航

- [execution.ts](../src/core/execution.ts)：任务执行状态机、节点派发、暂停与恢复、主管回合和工具调用编排。
- [capability-library.ts](../src/catalog/capability-library.ts)：文件系统能力扫描、版本解析、搜索、配方读写、验证与编译。
- [capability-bundle.ts](../src/runtime/capability-bundle.ts)：定义绑定的不可变能力包、静态 policy digest 与 operation overlay。
- [context.ts](../src/core/context.ts)：Continue/Fresh/Fork 解析、handoff 冻结与上下文 lineage。
- [budget-ledger.ts](../src/core/budget-ledger.ts)：预算作用域与实例镜像、reservation、in-flight、usage commit、cap 改写与模型使用记录。
- [model-selection.ts](../src/core/model-selection.ts)：模型等级选择、审查模型排除与独立审查就绪判断。
- [operation-lifecycle.ts](../src/core/operation-lifecycle.ts)：operation 的 intent、dispatch、reconcile、settle、阻塞、未知用量与返工状态机。
- [program-adapters.ts](../src/core/program-adapters.ts)：`graph.verify`、`graph.command` 与人工检查程序节点。
- [conversation.ts](../src/core/conversation.ts)：会话消息、队列投递、回复摘要与消息事件。
- [conversation-projection.ts](../src/core/conversation-projection.ts)：会话历史分页覆盖、稳定 ID 归并、可恢复实时 delta/tool 合并、队列状态与消息排序；live snapshot 与 append/reset 协议见 [ADR 0019](adr/0019-recoverable-realtime-transcript.md)。
- [agent-session.ts](../src/runtime/agent-session.ts)：Agent session transport contract、统一 inspect/turn 结果与 in-process/restricted-process adapter 选择。
- [pi-instance.ts](../src/runtime/pi-instance.ts)：in-process Pi session 生命周期、能力包绑定和受控模型门。
- [pi-process.ts](../src/runtime/pi-process.ts)：受操作系统限制的 Pi session adapter、宿主请求路由与 worker 协议。
- [pi-adapter.ts](../src/runtime/pi-adapter.ts)：Agent operation 的能力包、凭据、gate、fork policy 与 Graph 事件语义到 session transport 的组合。

纯图规则、预算算术、模板和数据库事务为 Task Runtime 的内部 implementation，不为每个计算拆一层 adapter。SQLite/Git 测试使用真实临时文件与仓库。Pi、供应商和远程 MCP 才使用可控替身与生产 adapter 两套实现。

保持单一仓库与单一领域上下文，先按 `src/core/`、`src/runtime/`、`src/catalog/`、`src/git/`、`src/server/`、`src/web/` 组织内部代码；不因有前后端就引入多包工作区或多份 CONTEXT。

## 外部任务 interface

完整设计用类型。M1 可调用入口为 `openTaskRuntime(...).user`，具体行为和当前支持范围见 M1 报告：

```ts
interface TaskRuntime {
  begin(input: { projectId: string; request: string; requestId: string }): Promise<TaskHandle>;
  task(taskId: string): TaskHandle;
}

interface TaskHandle {
  say(text: string, requestId: string): Promise<Receipt>;
  accept(input: { proposalVersion: number; targetBranch: string; requestId: string }): Promise<Receipt>;
  pause(requestId: string): Promise<Receipt>;
  resume(requestId: string): Promise<Receipt>;
  answer(questionId: string, answer: Answer, requestId: string): Promise<Receipt>;
  view(): Promise<TaskView>;
  watch(after?: string): AsyncIterable<TaskUpdate>;
}
```

- Receipt 只确认持久受理；任务已完成或已暂停从 view/watch 查询。关闭 watch 不关闭任务。
- requestId 与内容绑定；相同请求重送返回原回执，不重复派发；同键异内容拒绝。
- accept 必须引用已展示的当前需求版本；新增功能 begin 新任务，当前任务验收范围不扩张。
- 用户身份由本机会话与 transport 绑定，不能靠 payload 写 `actor: user` 获得授权。主管使用内部受限提案通道，不能调用追加额度、扩大权限和发布的用户答复路径。
- TaskView 为投影，包含任务阶段、稳定节点、问题、额度摘要、交付证据与游标；大日志与会话分页读取。
- 版本冲突、非法配置和错误答复同步返回可处理错误；额度耗尽、模型不可用、无进展、结果不明是持久待处理问题。

## 正式数据与身份

| 记录 | 必要关系 |
| --- | --- |
| Project / FeatureTask | 项目位置和任务队列；任务记录目标分支、需求与验收版本。 |
| GraphRevision / Node / Container | 图版本不可覆盖，节点稳定；容器不是实例。 |
| AgentDefinitionVersion / CapabilityVersion | 已发布版本不可变；模型等级推荐与具体模型分开。 |
| AgentInstance / Activation | 实例与 Agent 节点双向唯一；Activation 区分重复激活，执行轮次区分实现/检查/审查循环。 |
| Operation / Invocation | 每次真实模型或工具动作一个 operation，模型实际请求有唯一 invocation；重试用新 ID 但同一额度归属。 |
| Usage / Reservation | 按实例预留与结算；每条用量带 `authoritative`、`account_delta`、`estimated` 或 `unknown` 来源，供应商请求 ID 和原始归一化来源去重。 |
| Artifact / Evidence / Acceptance | 绑定具体提交或内容摘要、输入版本、执行轮次和验收版本；不能以旧通过结论验证新代码。 |
| Intervention / Grant / Command / Event | 问题范围、`owner=user|main` 分流、真实答复主体、权限上限、幂等回执与可续接更新记录。 |

SQLite 保存正式状态与追加审计记录，两者同事务提交；Pi 会话文件负责对话上下文，不反向覆盖任务状态。大型正文和产物用内容引用保存，数据库记录摘要与适用范围。首版不要求完整 event sourcing，也不自动删除历史记录。

共享产物空间是任务级不可变对象库：文件内容按 SHA-256 存放于 Graph 受保护状态目录，SQLite 保存 `Artifact` 逻辑身份、version、namespace、producer、schema、trust、生命周期和事件。正式引用使用 `artifactId + version + digest`，绝对路径仅作为本机 materialization。Agent 通过 `artifact_list/get/read/publish/retire` 发现和发布文献集、Plan、Review Report 与交付文件；Main Agent 可显式 promotion 到项目级知识。私有 worktree 继续负责代码，integration branch 继续负责最终交付。见 [ADR 0025](adr/0025-shared-artifact-workspace.md)。

## 调度与图修订

- 一次执行一个功能任务；所有 Agent 调用进入同一 10 名额池，主管计入。同实例不能并行激活两次，等待依赖/结果释放名额。
- 每次汇合绑定本次分支集合、循环激活和输入版本。必需失败阻塞，可选缺席允许；旧轮次结果不能错误满足新轮次。
- 动态图提案携带原版本与原因；先验证结构、身份、验收范围和权限，受影响调用停稳后再生效。旧节点保留停用记录，不能删除调用历史。确认后的验收检查项在修订中固定 action、verifier、依赖与 input：改写检查命令属于改变已确认范围，不能在修订通道内完成，必须回到用户确认。
- 预算耗尽的未完成工作保持阻塞，改名、换节点或派新实例不能清除它。重新分派必须关联来源工作；程序无法确定是否为规避额度时交用户核对。
- 程序节点不占 Agent 名额，但仍经过暂停、权限与操作日志；工具进程另作资源调度，不能无限启动进程。
- Graph 模板展开为同一图描述：顺序、路由、扇出汇合、主管等待/唤醒、原节点回环，以及三种验证器均共用上述规则。

## 逐调用准入和恢复

模型、工具、压缩、摘要、provider 重试和扩展触发的请求均须过实际派发入口；提前执行一次 hook 不能代替派发前检查。

1. 短事务校验任务/节点阻塞、权限、名额及额度，登记操作意图、输入摘要、预期对象和调用归属。
2. 事务提交后，受控 broker 将实际派发与暂停门按顺序处理。准入许可不允许 worker 长期持有后自行发送。
3. 保存调用结果和原始 usage，按唯一 invocation 结算、释放预留、记录证据，随后计算后继。
4. 崩溃重启后先核查仍在运行的 worker、操作意图及外部结果。代次只阻止旧结果改变正式状态，不能撤销已经发出的系统调用。
5. 结果明确则补记；确认未发生且可重做才重试；不明则保持阻塞等待核对。不能承诺任意外部操作恰好一次。

模型用量来源按证据强度分为 `authoritative`（供应商逐请求返回值）、`account_delta`（可归属于本次发送的订阅/账户计量差额）、`estimated`（本地对请求上下文和响应文本的估算）与 `unknown`（无可用计数）。有限预算实例仅在 `authoritative` 或 `account_delta` 下继续；仅有 `estimated` 或 `unknown` 时仍执行“待核对并暂停该 Agent”的规则，核对后再重新发起并累计，不能将缺失用量记零。核对结论是供应商不提供该次失败调用的用量时，使用者/宿主可以用带说明的 `reconcile_usage` 显式放行：未记账调用保持 `unknown` 与费用 unknown，不折算为零；放行时必须按 invocation 去重累计同一 operation 内全部已知用量，并让已确认结果走与正常结算相同的 output、route、等待问题与版本路径，重复答复不得重复计费。`instances.unlimited=1` 的 Agent 没有有限上限可保护，缺失逐请求 usage 时先尝试账户差额，再使用明确标记的本地估算继续；两端都不可得时才记录 `operation.usage_unknown`、保持未知成本并继续，不创建阻塞问题，缺口留在报告中。重放会话和主管汇总子 Agent 统计不能重复扣除同一调用。见 [ADR 0017](adr/0017-unlimited-unknown-usage.md)。

问题按 `owner` 分流：只有权限、预算、人工验收和明确需要用户决定的事项直接进入用户收件箱；恢复不明确、适配器错误、上下文拒绝、Git 冲突、用量异常、返工和停滞先路由给 main Agent。main Agent 读取结构化问题后，可以重试、调整图、回答 worker 或显式保留未知用量；用户界面只展示已经过这层处理的 `owner=user` 问题，避免把内部异常和原始 JSON 当作人工待办。见 [ADR 0018](adr/0018-main-agent-problem-routing.md)。

暂停先关门，已发调用可结束，所有在途调用停稳后才报告 paused；长工具持续运行时保留 pausing 和对应记录，时长不限不意味着能虚报暂停成功。resume 不能解除未解决的预算或权限问题。

## 能力安装与权限落实

能力可以自主搜索和安装，不新增逐次人工审批。安装产物进入版本化能力库，Agent 定义引用准确版本，已运行实例继续原定义；主管不在正式后台进程直接加载第三方扩展。生产实例按定义版本装配能力包：Skill、Pi extension、`agent.md` 与生成的 `tool.md` 注入 Agent 专属 Pi 子进程；模型、命令、MCP 与 Graph extension 的真实执行仍由宿主持有并通过调用门。本地 stdio MCP 经真实客户端暴露代理工具，Graph extension 由受限 worker 按最小 `register(api)` 接口加载；普通 MCP 运行时只放行 `capability.json` 的 `networkDomains`，远程端点 host 自动属于该能力，浏览器类 MCP 的任意站点访问必须显式声明 `networkAccess: "unrestricted"`。`uvx` 与 `npx` 的依赖安装使用独立 `provisioning` 域名和隐藏缓存，首次预置后运行时强制离线，安装域名不会进入运行权限。各类调用都经调用门。能力绑定即默认运行授权：Main Agent 与 subagent 都可以直接调用该 Agent 定义中已经加载的能力工具，不再为普通 MCP 调用创建逐工具 permission 问题；网络域名、OS 沙箱、预算、暂停与计量仍独立生效。Pi extension 的能力目录作为只读根提供给独立 worker，入口及其包内依赖都能加载。网络资料检索由受控读取 broker 提供，域名白名单、拒绝重定向、只收文本并限制大小。见 [ADR 0008](adr/0008-definition-bound-capability-loading.md)、[ADR 0011](adr/0011-isolated-pi-process-capability-bundles.md)、[ADR 0013](adr/0013-capability-declared-mcp-network.md)、[ADR 0021](adr/0021-capability-binding-default-authorization.md) 与 [ADR 0023](adr/0023-mcp-provisioning-runtime-network-split.md)。

Main Agent 同样通过版本化 Agent 配方装载能力：`mode=main` 的 `main` 配方编译为 `main@N`，新建主 Agent 实例使用最新已编译定义，已有实例保留原版本。规划、建图、调用 subagents、模型选择、监控、问题处理和汇报由 `master` 角色工具强制启用，配方负责组合额外的 Skills、MCP、Pi extensions 与 Prompt。需要宿主命令、持久状态、loopback 或 Unix socket 的 Pi extension 通过 `runtime` 声明最小外部依赖，Main Agent 与 subagent 共用同一边界；浏览器类扩展另外依赖 macOS 的 Chrome Crashpad、ProcessSingleton、DNS Mach service 和 Unix socket 边界。见 [ADR 0016](adr/0016-main-agent-capability-recipe.md) 与 [ADR 0022](adr/0022-pi-extension-runtime-declarations.md)。

Main Agent 每轮获得裁剪后的系统自模型，并可通过只读 `inspect_graph_system` 查询失败节点、开放问题、未知用量、无效能力和待批准变更。系统修改采用两阶段边界：`propose_system_change` 只创建用户审批问题；用户批准后，同一实例才能调用 `apply_system_change`，由宿主写入版本化能力目录并重新扫描验证。未绑定项目不阻止自省或提出能力变更。见 [ADR 0020](adr/0020-main-agent-system-introspection-and-approved-changes.md)。

Agent 上下文来源采用程序解析的 `continue` / `fresh` / `fork` 三种模式。默认 Fresh：新实例只接收冻结 handoff、任务、验收、决策和产物引用。Fresh 的每条 incoming 依赖另有逐边前驱交接策略：普通实现与返工默认结果交接，独立审查与验证只读冻结证据；容器依赖展开到 leaf，缺失或失效的 `ResultHandoff` 失败关闭。已有实例返工或恢复使用 Continue。只有模型请求精确 transcript/tool-call 事实且源节点已成功时，才从源 session 的冻结 leaf 调用 Pi `createBranchedSession`，生成新 session file 与新 session ID；禁止多个 Agent 并发写同一 session。Fork 默认要求源与目标具有相同模型、定义、能力包和工具策略，不同配置必须显式 rebrand；独立审查始终 Fresh 且不得继承实现 transcript。Fork/Fresh 都创建新的 Agent 实例，Fork 加入源的预算作用域，写入型任务仍使用独立工作副本。具体决策见 [ADR 0014](adr/0014-agent-context-continuity.md) 与 [ADR 0015](adr/0015-predecessor-result-handoff-policy.md)。

正式数据库、任务授权和供应商凭据由后台持有；Pi worker、MCP 进程和安装脚本在实际受限的执行环境内运行。模型请求经 broker，信息检索经受控读取 broker，外部写操作经带范围授权的工具。域名白名单、独立 cwd 和普通子进程都不足以证明上述约束成立。受限执行边界在每次派发前扫描写授权内已存在的 `.git` 条目（含 worktree 链接文件），并以解析后的 literal/subpath 规则拒绝其写入，普通命令与 MCP 共用；只读 Git 子命令以具体的 Command Line Tools 二进制运行。

本机 macOS sandbox-runtime 是候选执行 adapter，M0 必须验证路径、子进程、网络与凭据隔离，以及任意扩展不能绕过调用门。已确认任务的 `graph.command` 检查可以在同一受限边界内绑定 loopback 并运行本机应用与无头浏览器测试（含 Chromium 的 Mach 注册服务）；只有检查节点获得 bind 与 loopback 例外。Agent 工具、本地 MCP 与扩展都不能监听端口；MCP 的出站网络仅来自能力清单声明，extension 仍保持无网络。Seatbelt 无法表达只允许 loopback 的绑定；本地网络检查每调用一次 loopback `listen(port, host)`，由预载经 IPC 向可信宿主请求，宿主按请求端口与主机绑定，把已绑定 socket 作为句柄交给检查，待检查确认 adopt 后再完全关闭宿主副本，并放行其原生 `listening` 事件（listen 回调保持 Node 的注册位置，按注册顺序在同一事件中触发），沙箱 profile 同时显式 `(deny network-bind)`，因此检查、其子进程与非 Node 进程都无法自行新建监听；预载只负责转发请求与采纳宿主句柄，不是权限边界。扩展在受限 worker 内的最小接口已实现；官方 Pi 扩展 API 的完整语义、远程 MCP 的其他 transport 与其他平台仍未验证。若不兼容，调整 adapter 并复验；不静默移除自主安装能力，也不放宽已确认权限规则。公开 Pi 接口与仍待验证的路径见 [Pi 详细核查](planning/kernel-task-runtime.md)。

## Git 与最终验收

Graph 管理任务集成分支和每实例工作副本；实现、审查与程序检查均记录精确输入提交。共同 Git 元数据由 Git 模块管理，普通工具对其写入也需受控，防止独立 worktree 被误当成隔离整个仓库。受限执行边界在写授权内拒绝所有已存在的 `.git` 条目，命令与 MCP 无法改写 refs、index 或 worktree 链接文件；M4 已在 Task Runtime 上落实该流程，见 [M4 报告](planning/m4-results.md)。

整体测试和独立审查绑定集成提交。目标分支有变化先纳入集成分支并重检；最终合入经验证的提交。目标未检出时可用带旧值条件的引用更新；已检出时必须同步处理 index/worktree，采用干净工作区上的快进合并，不裸更新 ref 或重置人工修改。竞争变化回到核查，脏工作区等待处理。

审查模型避开对应轮次的实现模型集合，换模型不改实例身份。对抗反例是否有效由有证据的审查判断，程序执行预设门槛；不将 LLM 的“通过”字符串当成已满足验收。胜者吸收其他方案或集成修改后重新验证适用证据。

## 首批必须验证的假设

详细出口见 [M0](implementation-plan.md#m0-兼容性与调用控制验证)。未验证前不能宣称已具备：完整 Pi 请求计量、扩展不能绕过权限、每调用暂停、崩溃后没有重复副作用、最终合并与已验证提交一致。它们是实施任务，不是需要重新访谈的产品选择。

访问策略在 operation 准入时由 `graph.config.json` 的有效配置解析并冻结。默认 `full` 预设自动批准 `permission` 与 `system_change`，向 Agent、MCP、Pi extension 和程序命令传递宿主文件系统、任意可执行文件、无限制网络、本地绑定、全部 Unix socket、Apple Events、Git metadata 写入和 credential stores 访问；暂停、预算、未知用量、恢复问题和讨论期只读策略不再阻塞派发。`standard` 仍可显式选择，保留 workspace、命令白名单、声明网络、受保护路径和普通审批。操作、invocation、用量与事件在 full 下继续记录供界面和审计使用，但不反向形成调用门；并发上限、人工验收、模型订阅决策和任务图确认仍独立。运行中的 operation 不热改策略，回退只影响下一次准入。见 [ADR 0024](adr/0024-full-access-policy.md)。
