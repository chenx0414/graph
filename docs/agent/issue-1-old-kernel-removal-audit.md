# 旧内核删除前的能力对照（§13.8 / HB-261c）

> 历史快照：本文描述 2026-10-02 的代码，不能作为当前原生能力或退役进度的结论。后续实际进程、模型、产物、Git 与入口迁移证据见 [实施进度](issue-1-implementation-progress.md)；旧内核退役仍未完成。

2026-10-09 补充：main 的 Execution 已退出旧 DAG 就绪扫描、跨节点输入与隐式合入；OperationLifecycle 已删除旧 route/result_handoff/返工/验收结算。原 router-action-e2e 六项现通过真实命令、Pi 输出与显式模块验证。完整 gate140 通过 272 文件 / 1862 项（191.30 秒）。legacy-routing.ts 仅余旧测试引用；router-action.ts 尚有 briefing 引用，GraphPlan/types/read views 等仍未删除。文件无生产调用不等于完整旧内核已退役，亦不等于默认 app 已交付。

同日启动清理补齐仅有 graph_revisions、没有节点/提案的旧图：真实 v13/v17 HTTP 列表 RED 后修复，两文件44项及完整 gate142（272文件/1862项，185.96秒）通过。原生 kernel revision、外部 conversation anchor、graph owner 仍优先保留；旧 task 及其修订均删除，同一数据库 inode 与配置保持，原生 Pi 结果重启不重放。详细失败、修复和后续缺口见实施进度。

同日继续退役：删除 legacy-routing.ts、router-action.ts，briefing.ts 缩为外部 main 简报，去除全部旧节点 focus/依赖闭包/路由指令/reworkBriefing。删除前全 src/test 引用核对表明 legacy-routing 仅余自己的旧5项测试；router-action 仅余 briefing 的旧节点分支和自己的8项测试；briefing 的 graph/focus/review 参数、nodesReading/nodeContract/reworkBriefing 没有实际生产 caller，Execution 的两处调用仅传 main 信息。删除后上述符号在 src/tests 无调用，正式 router/queue/submit 不依赖这些文件。

### 本批测试删除审计（test-audit）

| 候选与位置 | 能检测的旧故障与历史 | 保留的真实合同/证明 | 删除与风险 |
| --- | --- | --- | --- |
| tests/m8/legacy-routing.test.ts T1–T5 | declared/byField/byStatus 的 input.route 解析、agent/program 区分、loadGraph.loops 的 case 过滤；4841cfb 的 HB277 纯提取边界测试 | tests/console/router-action-e2e.test.ts 实际 command/Pi 输入到显式模块的通过/返工/未匹配/必需字段/未知输出；tests/m8/module-router.test.ts 原生 enabled 边和模块串行发送 | 删除5项与62行旧生产模块。其旧解析字段和loops不属于新执行模型；无生产 caller，不为维持数量重造测试 |
| tests/console/router-action.test.ts 8项 | succeeded/failed status、output.outcome、declared case、非声明/无映射/无可解 case 的 resolveRouteCase | 同一真实 router E2E 主边界，以及 module-runtime each/once/输入保留/重开/失败记录 | 删除8项与旧 route 动作。旧单 case 决策接口已从正式产品退出，不能用它校验新多输出路由 |
| tests/console/briefing.test.ts 11项旧节点合同 | dependency artifact 自动注入、旧 declared deliverable、focusBriefing 的自己/检查/兄弟 lanes、summary 去重、nodesReading 闭包、3项 reworkBriefing、2项 agent/program 路由说明；HB208/HB214/HB242 修复的是旧 submit_result/route 返工规则 | 保留3项外部 main 的附件、recipe 描述、requirement/message/acceptance；attachments-payload 的图片/文本实际入口；native-repair-freeze 的真实初次概述/补交 delta/配置冻结；node-deliverable/context-model 的原生发布/版本/输入/自己历史 | 去除旧函数和图参数，不自动注入前驱工作。原 master 全图 listing 用例保留真正仍工作的 main 版本/消息/验收合同，旧 DAG listing 断言移除 |

上述删除合计24项、2文件，是已确认整体废弃旧 SDK 的结果；采用仓库 GRAPH_UPDATE_BASELINE=1 明示更新真实完整报告，预期新基线270文件/1838项。未删除原生失败用例，不按测试数量补无关用例；全量结果另记。其余 graph.ts/types/read views、Pi旧提交/前驱 parser 仍待退役，不宣称整体完成。

完整 gate144 实证：270文件/1838项全绿，182.41秒，TypeScript/lint/显式baseline/evidence全过（/tmp/graph-v2-full-check-144.log）。原生运行时间与未知用量的独立计量、真实凭据等待、硬owner死亡保留未知时间、浏览器统计及剩余原生模块/产物/上下文/main合同均通过。旧读取/layout推断尚待删除；默认app和完整spec未交付。

### 原生边 ID 与旧回路渲染退役（2026-10-09）

发现真实产品回归：原生声明中的 `loop:feedback` 会被 GraphCanvas 按 ID 推断为旧回路，丢弃 HTTP layout 的路线，改用左侧隐藏接口与私有 gutter。既有 ui-flow 的原生子 graph 浏览器用例扩充同端点显式边，直接核对 HTTP 路线与实际 SVG；修复前 RED 显示服务器路径 `M 128 288...`，浏览器却绘制 `M 29.5 256 L -8...`，不是颜色或源码断言。移除 GridLoopEdge、ID 判断及 loopChannels，所有显式边统一使用原生路线。

删除候选 `tests/console/loop-channels.test.ts` 的三个精确用例为 `three side-by-side lanes get three distinct channels, each beside its own lane`、`the leftmost lane still uses the left gutter`、`two loops in the same lane separate instead of stacking on one line`。历史 60dc1bc/42c2ff7 引入旧回路近侧通道纯函数及断言；它们检测旧 gutter 数值，而非原生显式路线。唯一生产 caller 是现已移除的画布推断；没有公开 SDK caller。删除 src/web/graph-edges.ts 和这三个用例，不保留测试专用旧布局。保留实际 UI 子 graph/折叠/反馈/错误合同与 confirm-graph 的真实声明式连接；风险是折叠边失去其正确代表节点，已用原浏览器折叠/展开用例验证。两文件12项通过，日志 /tmp/graph-opaque-edge-green.log。完整 gate145 实证269文件/1835项通过（179.87秒），类型/lint/evidence 同时通过；显式更新基线后再次用普通模式确认。

task-runtime 的 loadGraph 读取兜底同步退役：外部 main 保留自身会话节点与 nodeRun；原生图继续读取 kernel 修订、节点、模块和具名接口。不存在的节点不再被旧容器伪造为空会话；main inspect 不再把旧 graph_revisions 当实际执行定义。server/layout 的 dependsOn/loops fallback 等仍待删除，未宣称读取整体退役。

### 显式布局与旧分支投影删除审计（2026-10-09，实施前记录）

候选为 tests/console/branch-edges.test.ts 全部5项：`a gated node gets a branch edge from its router, tagged with the case`、`a branch edge is distinguishable from a plain dependency edge`、`a container gate counts, or a gated branch group would be invisible`、`a node with no when gets no branch edge: nothing is invented`、`a condition naming a router that declares no routes is still drawn, so the defect shows`。它们只能发现旧 when/routes/containerLeaves 的私有派生边变化，历史 cb45aa9 为 HB-182 的旧 DAG 条件不可见问题增加该投影。唯一生产 caller 是 server/layout，isBranchEdge 没有生产 caller；新 definition 不包含 when/routes，明确模块的输出映射与显式边才是执行事实。删除 src/core/branch-edges.ts 及其5项私有测试，不能继续用旧单 case 推断边。

保留的主边界：confirm-graph 真正 HTTP draft/running 的显式边与相同布局；ui-flow 真浏览器子 graph、并行、反馈和折叠；design-examples 的8种实际原生拓扑与正交路线；module-router/router-action-e2e 真实输入/条件/输出/投递。布局采用窄类型，要求显式 edges，保留 ELK 分组与正交路线，仅去掉 dependsOn/loops/when 推断与被原生路线覆盖的 ELK edge section 二次解析。风险是跨子 graph 连接与反馈位置，应运行上述实际边界及全量门禁。main 外部自身 nodeRun 和会话仍保留；无定义的外部 main 返回空图，绝不伪装为内部节点。graphMessages 是真正原生节点聊天记录，必须继续送到 HTTP/画布；旧 graphHandoffs 唯一产品入口随旧 fallback 删除，parser 其它活跃调用不粗删。完整 gate146 通过268文件/1830项（184.90秒，/tmp/graph-v2-full-check-146.log），显式降低真实基线后普通模式再次复核；TypeScript/lint/evidence 全通过。

### GraphPlan/GraphState 与旧前驱冻结退役审计（2026-10-09）

删除前全 src/tests 引用核对：GraphPlan/GraphState/loadGraph 只余 predecessor-handoff 内部旧 policies/build/settle 路径；resetIdleNode 仅有一个直接私有测试；reactivate/supersedeOpenQuestions 无外部生产 caller。task-runtime 唯一 graph.ts import 是 main 的 createActivation/hasLockedQuestion，迁到 main-node-state.ts 保留同一 SQL 与额度判断。Pi adapter 仍调用 inspectResultHandoffSubmission/laneSubmissionContext/resultHandoffFromSubmission；该提交检查与真实 write ledger 暂时保留，不因旧 DAG 删除而丢弃 main 的真实工具检查。

删除候选一：tests/console/question-routing.test.ts `resetting a node supersedes the open questions of its retired activation`，只能发现旧 nodes/activations/evidence 的 resetIdleNode 直接调用是否将问题设 resolved；历史 review-as-router/HB224–226 修复旧激活问题残留。没有产品入口调用该重置，原生节点没有此 activations 重置模型。移除该1项及 graph.ts 的旧 reset/reactivate，保留同文件所有权限/额度/main问题归属/唤醒合同，以及原生 human acceptance 精确版本与重验的真实 graph-final-acceptance 测试。

删除候选二：tests/console/artifact-workspace.test.ts `result handoffs can freeze an exact published artifact version without relying on its private path`，直接伪造旧 Proposal/依赖/operation/instance，再调用 settleResultHandoff 并读取 result_handoffs.body；没有生产 caller，不能证明原生发布或投递。不可变 artifact workspace 的其它9项保持；精确版本与真实 bytes 的主边界是 node-deliverable 的原生产物/commit/旧版本读取、native graph-final-acceptance 的实际 artifact_read/验收目标、declared artifact-reference protocol 的真实投递拒绝缺失版本。移除该1项，解锁旧 DAG policies/冻结/读取/格式化/修复的无调用路径删除，不用一个同义测试重造旧表。

风险与验证：main 激活与预算锁不可变化；真实 Pi 提交检查及 manifest-vs-disk 的 write-ledger 安全合同保持；运行 question-routing/artifact-workspace/manifest-vs-disk/main 会话与原生产物/最终验收边界，再全量 check。完整 gate147 因设置页实际重复 autosave 引发一次 config_conflict 失败；修复后 gate148 通过268文件/1828项（183.00秒），显式更新旧测试退役基线，不补数量测试。类型/lint/evidence 及普通模式基线检查通过。GraphPlan 类型与旧通道整体移除后，Pi 的旧 result_handoff 可选 schema 支路及共享 types 仍需单独审计，不能宣称整体 SDK 退役。

### Pi 旧 result_handoff 支路与前驱类型退役审计（2026-10-09）

生产入口核对：core/execution 只生成 agent_result@1 的 external-main context；正式原生 kernel-node-host 从 shared agentTools 排除 submit_result，并由 resident/native submit 事务验证具名输出。Pi adapter 的 outputSchema=result_handoff validateSubmission 支路无正式调用，resultHandoffFromSubmission 的附加返回也没有 result reader。agentTools.validateSubmission 的唯一 caller 是该支路；进一步核对 AgentToolDeclaration 表明 submit_result 只面向非 master；正式 main 没有暴露它，原生节点排除它。因此连同旧声明、executor、onSubmit 回调、submitted 结果包装和 native 排除特例一起删除。main 保留真实回复和会话 activity；原生 submit 继续由 native tools 注入。

删除 tests/console/manifest-vs-disk.test.ts 全部5项：`a manifest that matches the lane change set is accepted and keeps the worker own fields`、`a manifest that omits a file the lane really changed is refused, naming the omission`、`a manifest that claims a file this lane never touched is refused`、`a manifest whose digest disagrees with the bytes on disk is refused, never rewritten`、`a manifest naming a path outside the lane scope is refused as belonging to another lane`。历史 HB215/HB216 及旧 manifest receipts 约束的是 result_handoff@1 在已废弃 DAG 节点的必需提交；这些用例直接调用旧 inspector，不能证明正式 submit。无原生 caller，删除解锁 predecessor-handoff.ts 整个剩余文件及 Pi/agentTools 旧可选校验钩子。

保留的合同并不等价于旧 manifest：原生提交按用户声明协议验证，不暗中要求一份 file-change manifest。必须保留的实际安全/稳定版本合同有 write-ledger 自己磁盘 capture（write-ledger.test.ts）、真实 artifact workspace 的 traversal/symlink拒绝与稳定bytes、node-deliverable 的 commit/版本绑定、native-repair-freeze 的协议错误零投递/补交、graph-final-acceptance 的实际 check/review/精确版本。删除旧 claims inspector 不取消工具访问门或真实内容绑定，保留 WriteLedger 生产调用。

外部 main 冻结 context 不再发送空 predecessorPolicies/predecessorHandoffs，也不再解释旧 predecessor_policy列；共享类型删除旧 ResultHandoff/PredecessorHandoff，OperationResult 不附旧 route/resultHandoff。context表、自己会话绑定、精确 prompt/工具/预算与既存main历史继续复用，旧可选列不为破坏数据库而强制drop。验证 main Pi/原生 submit/写账本/产物/配置重启/旧 schema升级，再完整check。预期267文件/1823项，按真实报告显式退役5项，不用数量替代契约。

日期：2026-10-02。目的：在删除约 6,332 行旧内核之前，逐项核实**新内核是否已覆盖旧路径的能力**。所有结论均由工具核实（行数、引用图、能力 grep）。

## 一、结论先行

**"删掉旧内核" 不是一次文件删除，而是一次贯穿 31 个文件的替换。** 直接删除会摧毁产品。

最重要的发现：**`task-runtime.ts`（2,487 行）里只有 3 行与 v2 相关**（构造 kernel + `materializeGraph`）。其余是会话管理、产物、Git、合并、提问、问题路由——这些**与内核无关，必须保留**。

## 二、旧内核规模（实测）

| 文件 | 行数 | 性质 |
| --- | --- | --- |
| `src/core/task-runtime.ts` | 2,487 | **绝大多数非内核**（会话/产物/Git/合并/提问） |
| `src/core/execution.ts` | 1,331 | 混合：旧 DAG 调度 + 跨切面职责（产物、Git、合并、恢复） |
| `src/core/predecessor-handoff.ts` | 1,004 | 旧"结果交接"；**v2 用 delivery 覆盖**（§3） |
| `src/core/verification.ts` | 334 | 验收/校验 |
| `src/core/graph.ts` | 227 | 旧 `GraphPlan` / `loadGraph` |
| `src/web/GraphCanvas.tsx` | 340 | 旧画布（渲染 `containers`） |
| `src/server/layout.ts` | 159 | 旧布局（含 containers/回边） |
| `src/core/revision.ts` | 154 | 改图 |
| `src/core/node-messages.ts` | 107 | 节点间消息 |
| `src/core/router-action.ts` | 98 | 旧路由动作 |
| `src/core/proposal.ts` | 91 | 旧提案校验（已含 v2 分支） |
| **合计** | **6,332** | |

## 三、引用图：旧内核编织在活跃设施里

被引用情况（实测）：

- `graph.ts` ← `predecessor-handoff.ts`、`operation-lifecycle.ts`、`node-messages.ts`、`revision.ts`
- `revision.ts` ← `task-runtime.ts`
- `verification.ts` ← `operation-lifecycle.ts`、`templates.ts`、`proposal.ts`、`types.ts`
- `router-action.ts` ← `operation-lifecycle.ts`、`catalog/briefing.ts`
- `predecessor-handoff.ts` ← `operation-lifecycle.ts`、`proposal.ts`、`task-runtime.ts`、`execution.ts`
- `proposal.ts` ← `revision.ts`、`task-runtime.ts`
- `node-messages.ts` ← `task-runtime.ts`

**受旧内核牵动的文件共 31 个**（含 `context.ts`、`model-selection.ts`、`branch-edges.ts`、`conversation.ts`、`graph-presentation.ts`、`node-prompt.ts`、`templates.ts` 等）。

结论：**`operation-lifecycle.ts` 是枢纽**——它同时引用 `graph.ts`、`verification.ts`、`router-action.ts`、`predecessor-handoff.ts`，必须最后处理。

## 四、能力对照：v2 覆盖了什么、没覆盖什么

### 已被 v2 覆盖（可安全随旧代码一起退役）

| 旧能力 | v2 对应 | 依据 |
| --- | --- | --- |
| `dependsOn` 依赖调度 | **delivery/投递**（§3） | 边携带值，而非"等前驱完成" |
| `loops` / 容器回边 | **module 路由**（§2/§6），`MAX_ROUTING_DEPTH=8` | 返工环经模块路由，深度受限 |
| `GraphPlan.readiness` | **NodeQueue**（旧时才有队列） | `kernel_queue` |
| 结果交接（1004 行） | **投递值进节点输入** | v2 更显式：边即数据流 |
| 节点跳过/路由就绪 | **模块判定 + 路由**（HB-264） | — |
| 旧 `proposal` 校验 | `parseGraphDefinition`（§3/§4） | v2 严格更强 |

### ⚠️ v2 **尚未**覆盖（删除前必须处置）

| 能力 | v2 现状 | 风险 |
| --- | --- | --- |
| **deliverable（产物声明）** | **0 处** | 节点声明"我必须写出这个文件"→ 发布产物；v2 无此概念 |
| **artifact 发布/晋升** | **0 处** | 产物工作区、跨任务共享索引 |
| **workcopy（隔离工作副本）** | **0 处** | 节点的独立代码副本 |
| **merge（冲突合并）** | 仅 1 处引用 | 合并 Agent 走旧 operation 模型 |
| **context 模式**（review/verify/fork） | 0 | 独立评审/验证上下文 |
| **revision（改图）** | 0（v2 有 `publishRevision`） | v2 有等价物，但 UI 走旧路径 |
| **budget（预算/计量）** | 7 处 | 旧 gate 与 operation 绑定；v2 用 `NodeExecutor` 的节点预算，但**模型调用计量未接 v2** |

其中 **deliverable、artifact、workcopy** 是最关键的缺口：它们是"节点干活 → 产物 → 合并"的旧主线能力，v2 目前完全没有。

## 五、删除前的最小安全顺序（建议）

1. **先补缺口再删**：为 v2 补 `deliverable`（§5 节点提交里带产物）、`artifact` 发布、`workcopy` 隔离。否则删掉旧路径后，节点干完活**产物无处可去**。
2. **把 `operation-lifecycle` 拆成"通用"与"旧内核"两半**：前者留（产物、Git、合并、计量），后者随旧内核删。
3. **UI 最后**：`GraphCanvas.tsx` 改画 v2 图（§13.7 尚未做，见 HB-260），`layout.ts` 的 containers/回边随之退役。
4. **docs/ADR/术语**同步更新。
5. 旧历史按 ADR 0030 整体废弃（不做转换器）。

## 六、给用户的决策点

删除旧内核是**不可逆的产品行为变化**，且当前存在**明确能力缺口**（deliverable / artifact / workcopy）。按 §15.9 需先对齐：

- **选项 A（推荐）**：先补 v2 的 deliverable/artifact/workcopy，再删旧内核。慢，但删完产品不残缺。
- **选项 B**：先删旧内核，接受这几项能力暂时缺失（明确记入 backlog）。快，但产品会退化。
- **选项 C**：只删"纯内核"部分（`graph.ts` 的 `GraphPlan`、`predecessor-handoff.ts` 的交接逻辑），保留共用设施；`task-runtime`/`execution` 的跨切面部分不动。风险最低，但"统一走新内核"的目标只完成一半。

## 七、证据

- 行数：`wc -l`（见 §二表）。
- 引用：`grep -rln "from './X.ts'"`（见 §三）。
- 牵动面：`grep -rln "loadGraph\|GraphPlan\|NodeSpec\|graph_revisions\|predecessor-handoff\|resultHandoff" src/` = 31 个文件。
- v2 缺口：按能力名在 v2 文件集（`kernel-*`/`graph-*`/`node-*`/`module-*`/`runtime/kernel-*`/`resident-*`）中 grep，deliverable/artifact/workcopy 均为 0。


## 2026-10-08：旧节点消息分派实际退役

- 删除模块：src/core/node-messages.ts（107 行）。旧消息通过 execution.steer 打断忙碌执行，或 reactivate / loadGraph 按 DAG 失效后继并重开已完成任务；与已确认的一次消息一次排队、graph 完成后结束内部服务契约冲突。
- 删除前活跃调用方只有 task-runtime.ts 的 SDK 节点 / peer 消息以及旧 Pi adapter peer channel；全部改为 kernel-node-messages.ts，原生常驻 Pi lane 已直接使用该模块。复核 src/tests 无旧模块导入。保留 external main 的 execution.steer / conversation steering：它服务 main 会话，不是 graph 内部节点消息。peerNodes 的旧 adapter 地址列表仍有非测试使用者，不随消息模块删除。
- 删除 tests/console/node-messages.test.ts（5 用例）的原因及剩余合同：

| 原合同 | 删除依据 | 剩余实际边界证据 |
| --- | --- | --- |
| completed-node messages invalidate only descendants, preserve instance and budget, and reach the next briefing once | 旧 DAG 失效后继并重开 completed graph；自动下游失效已被显式投递替代 | graph-messages 的真实 Pi 串行三回合、同实例 / 历史 / 累计用量、无 sibling 执行；graph-runtime 的 completed / stopped 拒绝控制重开；graph-messages 的停止后新输入拒绝 |
| live messages steer only their operation and retries do not deliver twice | 忙碌节点应排队，立即 steer 与已确认行为冲突 | graph-messages 持有真实 provider 请求时加入两条消息，三条队列中仅首条 claimed，重复请求不重复投递 |
| a peer message to a finished node reactivates it and reaches the next briefing like a user prompt | completed graph 内服务生命周期已结束；节点一次完成后的复跑用队列处理 | 同一真实 Pi 合同证明 idle 节点沿用 session 继续执行；结束后仅回执 replay 可用 |
| a peer message to a running node steers that operation instead of restarting it | 立即 steer 已废弃 | 同一真实 Pi 持有请求合同，busy peer 消息 queued，后续请求带前一回复及 From sibling 信息 |
| a peer message to a node outside this graph is refused and delivers nothing | 原生公开边界已有同一 reach / self / sender 拒绝，不保留旧表驱动的重复证明 | graph-messages 首合同验证 ghost / 跨 graph / self / 假 sender 拒绝且消息图只有实际投递 |

- 历史原因：旧模块由 a8e0a2f 建立以解决被动 inbox 不触发执行；测试最后经历 6c4cca4 的旧图提升和 cbb6710 的脚本适配。这些问题由正式 kernel 队列与常驻 Pi 已覆盖。
- node-deliverable 的四个公开合同手工迁为真实 Pi / 原生草稿与显式投递，删除该文件的旧 dependsOn、program check、OperationResult 脚本 fixture；自动产物由真实文件产生，读者通过具名输入收到精确发布引用并调用 artifact_read。旧 dependencySources/path 自动交接断言按新协议退役。
- 聚焦检查 7 文件 / 57 用例通过（9.17 秒）。预期基线 274/1866 → 273/1861，仅上述 5 个过期合同减少。全量验证与提交证据见实施进度，不据此宣布全部旧内核删除。

## 2026-10-08：旧程序节点与 DAG 验证器执行路径退役

- 删除 `src/core/program-adapters.ts`（297 行）：graphVerifier、workspaceCommandNode、humanCheckNode 的唯一非测试入口为 Execution.execute。该分支属于旧 NodeSpec program 节点；原生宿主 operation、纯 command 判断、人类完成门分别由 kernel-operation-broker、ModuleRuntime/隔离进程、graphAcceptance 负责，不调用本文件。原生定义不再允许独立工具节点；旧程序分支没有继续保留的产品授权。
- Execution.execute 移除上述三种内置适配与旧 human activation/commit 检查分支，只调度外部 main 的 agent 适配器。其余 main 运行、调用账本、Git/恢复设施保留。删除旧 executor 独占的 scratchRoot/program 字段及参数；program 配置仍传入原生 kernelGraphLane，真实宿主命令环境/依赖/暂停合同继续负责证明。
- `verification.ts` 的 GraphPlan 校验及 evaluateVerifier 已移除（303 行）。删前 validateVerifierConfig 没有调用方，evaluateVerifier 仅由已删除 graphVerifier 调用。保留少量旧类型及 isReworkDecision 供尚未退役的外部 main lifecycle / 旧模板类型调用，不能据此宣布旧 main foundation 全部删除。
- 保留业务合同：m2/verification 的 16 项用例全部迁为原生 command 模块、真实 Pi/HTTP submit/artifact_read/publish 与实际 Docker 隔离判断；文件/用例不删除。多视角必需/建议维度、对抗式有效反例、评委式硬条件/权重/平分、稳定 subject 版本及返工正文均继续验证；业务输出不再伪造 acceptance evidence 或依赖 operation.dependencySources。旧 graph.verify 适配器注入不能替代实际 code 模块。
- 新入口 `scripts/create-review-module.ts` 由 main 按需运行：JSON policy → 新的不可覆盖 code entry + 普通模块声明。review-policy.ts 是自包含纯判断代码生成器，不引入另一套执行器/图格式/常驻工具，输入名是显式模块端口。正式最终验收仍独立验证宿主操作、已发布报告、实际模型与 commit。
- 验证：16 项 CLI→真实隔离执行通过（/tmp/graph-native-review-authoring-cli.log，24.85 秒）；删除旧程序适配后 6 文件 / 53 项相邻合同通过（/tmp/graph-native-policy-and-program-retirement.log，29.04 秒）。最终配置校验及精确非法 placement 断言在完整门禁中复验；全量状态见实施进度。旧 templates、main lifecycle、DAG 数据结构与全部 UI 仍待退役，不把本批删除行数当作完整完成证据。
- 相关历史核对：8049fe7（HB-222）让失败命令保留完整记录/stdout，917f550（HB-221）核对真实沙箱路径，b463626（HB-221）允许完全访问下显式 sandbox:false；这些宿主命令合同由原生 broker 和 command-check/check-input-revision 真实进程用例保留，删除旧适配器不删除记录、沙箱或权限要求。第一百零七轮完整回归通过上述原生合同，剩余 80 项为旧定义入口；仍未提交。

### 原生模板执行证明（2026-10-08）

- 候选：tests/m2/templates.test.ts 的两项旧模板执行测试；原本可发现八种图模式的调度、返工、评委吸收后再验证缺陷，不能删除合同以变绿。历史 5766bb5 为 M2 模板能力，37dd08b 为吸收阶段前驱证据，dbf9765 为真实条件路由。原合同改为八模式真实 Pi/HTTP + 宿主命令/受限 Docker，独立发布与版本读取覆盖旧假 evidence，main 留在外部。文件两项总数保留。
- 删除旧 template test 的 ActionAdapter/GraphPlan helper；正式 JSON 四例成为 main 可读取的定义库，审查规则通过实际 authoring CLI 组合进普通 command 模块，不添加测试专用 production seam。src/core/templates.ts 已无生产调用，唯一余留 caller 是 m5/graph 几何测试；当前尚未删除该库或宣称布局完成。
- 风险：新 subject 更新与旧报告暂存可能额外返工，显式 wait 配方通过两个版本、恰两次工作及无输出等待 transition 证明；默认 stale rework 的独立 verification 合同仍保留。聚焦证据 /tmp/graph-native-pattern-review-siblings.log，5 文件 / 31 项通过。全量门禁另记，未提交。
- 全量证据：108 轮发现一项真实多场景集成测试的 15 秒总预算不足，超时后的异步回调导致 runtime closed；将该用例总限设为 60 秒，未放宽单次模块 5 秒或业务断言。109 轮该用例 20.784 秒通过；完整结果 252 文件 / 1784 用例通过，20 文件 / 78 用例仍因旧 DAG 定义失败，无未处理错误。合同总量 272/1862 保持，check:baseline/check:evidence/git diff --check 通过。完整 gate 仍未通过，未提交。

### 旧模板库删除与布局 owner 合同（2026-10-08）

- 候选：src/core/templates.ts（tracked 92 行）；最后调用为 m5/graph 的 every template including back-edges receives layout positions 与 orthogonal dependency routes avoid node overlap and edge crossings 两项几何合同。它们能发现节点缺位、格点错位、缺失反馈连接、路线穿节点与同通道重叠，不能删掉合同以减少失败。历史 5766bb5 引入 M2 八模式模板，dbf9765 路由实执行，cb45aa9 增补可见分支；新 owner 合同为同一八模式正式定义经真实 HTTP 返回的节点/全部边、格点、端点、正交和节点/通道避让。与已通过真实 Pi/Docker 的 m2 definitions 共用，无第二套执行描述。
- src/core/templates.ts 无生产调用，迁完两项后源码/测试 grep 无剩余 import，正式删除；m2 执行两项及 m5 几何四项总量保留。新几何补充包括合法自回和七条同端点边；短连接共享是单一视觉端点的必然几何，只豁免对应两边的第一/最后短连接，其他线段保持严格不重叠检查。
- 实际 browser owner RED：四条正式边只有三条 SVG；GraphCanvas 原 filter 丢掉 self edges，修复保留有真实路线的 self。每条 SVG 坐标严格匹配真实 HTTP，无 page.route 假响应。原 browser 用例转换并保留设置、read-only、节点种类和独立节点窗口合同。任务名与 ID 不同后暴露节点概览无稳定身份，显示宿主 node.id 修复，未改成只检查任务文案。
- 风险与证明：固定端点使汇合路线重叠、嵌套默认层距造成节点穿越，均在真实 owner 出现并修复，日志见实施进度。新增原生格点 router 95 行（实际 server caller），无执行语义；保留 ELK 排列和旧 scaffold 投影直至整体退役。相邻 /tmp/graph-native-layout-retirement-proof.log 4 文件 / 15 项通过；浏览器 /tmp/graph-native-ui-routes-and-identity.log 通过。完整门禁另记，未提交，不宣称完整布局/SDK 退役已完成。
- 全量证据：110 轮 252 文件 / 1785 用例通过、20 文件 / 77 用例为旧 DAG 定义失败，无新增布局/浏览器失败或未处理错误（/tmp/graph-v2-full-check-110.log）。272/1862 基线与验收证据保持，check:baseline/check:evidence/git diff --check 通过。src/core/templates.ts 已删除且无调用，旧 layout scaffold/main SDK 等仍活跃，整体退役尚未完成，未提交。

### 原生预算浏览器合同与共享答复 owner（2026-10-08）

- 候选：tests/m5/ui.test.ts 的 graph follows runtime events and a budget question accepts a token increment。原先保护实时 UI 与追加额度 HTTP，旧注入动作及假 evidence 无法证明 Pi 准入或原生答复；保留一项，用正式定义、真实 Pi/HTTP/Chromium 验证 blocked → 用户追加 → main retry → succeeded。三个用例总数保持。
- 实际 RED 为预算问题缺失，并非旧格式拒绝；修复原生预算 question owner 和共享 OperationLifecycle 答复中的原生额度路径。原有 main 实例预算分支仍有生产调用，不能直接删除；没有旧图转换器或第二套调度机制。
- 不同风险由各自原合同负责：kernel-node-budget 证明活动 execution 的额度冻结/累计 usage/未知 hold；node-executor 证明提交不可重复；graph-final-acceptance 和 question-routing 证明人工验收/责任方。聚焦 5 文件 / 46 项全通过（/tmp/graph-native-budget-boundary-proof.log）。完整门禁另记，整体 SDK 退役尚未完成。
- 111 轮完整结果 253 文件 / 1786 用例通过、19 文件 / 76 用例仍为旧 DAG 定义入口拒绝；没有新增失败，原生预算 HTTP/界面合同已通过完整回归。基线与验收证据保持。未提交，下一完整门禁 112；旧实例分支、main SDK 和剩余合同仍需继续实际退役。

### 无限额度/重启/inbox 真实合同（2026-10-08）

- 候选：console/unlimited 六项与 app/insights-ui 两项。旧用量动作、旧 DAG propose、手造 v13 schema、假 evidence 和 browser route 假 100-node layout 已删除；不删除合同数量。历史 c8d2d18 曾修旧 schema 降级 SQL，6c4cca4/cbb6710 曾保留旧契约；按 ADR0030 不继承旧 graph 历史，第三项现在验证新内核有限授权/身份/session/累计 usage 的实际重启，而非保留迁移器。
- 无限额度、有限拒绝、持久授权、估算、未知 hold 的真实 provider 合同均执行；未知 hold 跨重启后加额度不能放行，独立 reconcile 才能继续，补足现有单进程 quota 合同的持久恢复风险。原生 setBudget 关闭 budget 问题缺口已实际 RED 并修复，不增加第二调度器。main/旧实例分支仍生产活跃，后续继续退役。
- app 界面合同实际创建两个 graph 验证聚合和独立答复；旧 reservation_exceeded 假动作不是产品预算证明。另一项保留严格 3 秒首屏上限但使用真实 100-node HTTP 图，99 条原生边实显。badge/history stale 已真实 RED，修复其 owner 数据刷新。相关 UI 历史 b1e3e17/0bb130c/086b81c/6258309；实际 graph/read-only/节点窗口/预算答复由 m5/ui 保留，性能与多图聚合由 insights-ui 独立负责。
- 聚焦 /tmp/graph-native-quota-and-inbox-fixed2.log，7 文件 / 54 项通过。文件/用例总数保留，无测试专用生产接口；完整 gate 另记，尚未提交，不宣称完整交付。
- 112 轮完整结果：255 文件 / 1792 用例通过，17 文件 / 70 项为旧 DAG definition 拒绝，未出现新额度/inbox/性能失败。本批旧动作/旧图 fixtures 已退出真实额度及 UI 合同；基线 272/1862 与验收证据保持，未提交。下一完整门禁 113，整体旧 SDK/DAG 与 main 生命周期仍需继续退役。

### 旧 reviewer router 合同迁至具名输出（2026-10-08）

- 候选 tests/console/review-as-router.test.ts 七项；旧 router routes/loops/when、手造 session、假 verdict/evidence ActionAdapter 全部删除，七项数量保持。历史 216e3f7 引入该行为合同，5028815 修复 acceptance router handoff digest 不一致，9bd3ddc 修目标前移交付。本批下游真实读取精确已发布报告并核对投递引用与验收 source，继续保护验收不能破坏交接；目标 branch/commit 交付由 graph-final-acceptance 原生真实 Git 合同执行。
- 新 caller 正式 native graph/submit/artifact APIs，不保留旧 API 兼容器。具名 approved/rework 输出直连，requiredAnyOf 二选一，业务不通过仍是 enable:true 发送明确 failed value；复跑原实例/历史和 reviewer 原话由 actual model HTTP 请求证明。失败反馈保留 queued input，由 main 暂停 worker 后显式处理，不把循环删除以掩盖失败。
- src/core/router-action.ts、legacy-routing.ts、model-selection.ts 的旧验收函数仍被 OperationLifecycle/Execution 调用，完整 main 生命周期未退役前不能宣称无生产 caller 或删除。聚焦 4 文件 / 14 项全通过（/tmp/graph-native-review-output-siblings2.log）；完整 gate 另记，未提交。
- 113 轮完整结果：256 文件 / 1799 用例通过，16 文件 / 63 项均为旧定义入口拒绝，reviewer 七项原生实执行无新失败。保持 272/1862 基线与验收证据；未提交，下一 gate 114。旧 router/main 生命周期活跃引用清理仍待完成，不能以本批合同迁移替代整体退役证明。

### 旧自动完成与交付 owner 删除（2026-10-08）

- 删除候选：Execution.readyToComplete/completeTask/deliver/advance/finish 与 OperationLifecycleHooks.advance。调用原为 report/reconcile/restore/用户答复；readyToComplete 在有 kernel revision 时直接拒绝，旧 Draft 已在入口整体拒绝，故这组旧图完成推断不能服务正式原生 graph。原生完成/停止通知、任务槽释放、精确版本审查和 Git deliver 的非测试 owner 为 GraphRuntime/graphAcceptance/graph-lane，实际合同 graph-completion-e2e/graph-final-acceptance/原生 reviewer 保留，不能把旧函数名称当作必要兼容接口。
- model-selection.independentReviewReady 22 行在完成路径删除后无剩余 caller（源码+测试），正式删除；旧 routes/graph.verify 的宽松通过推断不得替代当前 commit 的独立证据。历史 f1fbf31 为旧 reviewer route 通行，23566ee 为原生显式释放，7d64e79 为精确版本验收；原生强证据由真实 HTTP/Pi/产物/Git/user 答复执行，未用手造成功状态替代。
- 五个 lifecycle fixture 只删除空 advance callback，不删用例或断言；canReplayBeforeSend 仍有正式生产作用。10 文件 / 81 项以及后续 4 文件 / 11 项聚焦通过；完整 gate 另记，仍未提交。main lifecycle 其他活跃旧分支和旧 SDK 仍待退役。
- 114 轮完整结果 256 文件 / 1799 用例通过，16 文件 / 63 项仍均为旧定义拒绝，无本批完成/交付/恢复新失败；旧完成推断与旧审查 ready 函数实际删除且无引用。原生完成通知、队列释放与精确 Git 验收在完整回归继续通过。272/1862 基线和验收证据保持，未提交；下一 gate 115，main 的其他旧状态分支及整体 SDK 仍待退役。

### 原生 Git 工作副本三项合同（2026-10-09）

- m4/worktrees 三项从旧 DAG/动作脚本迁至正式节点及真实 Pi/Git，保留提交作者与提交者、并行工作副本隔离和集成交付、冲突保留现场等可观察合同。验收由真实命令检查和读取已发布代码的独立 reviewer 完成，非 fixture 写入成功状态。
- owner 缺陷实修：GitIntegration 的原生 recipe 精确版本读取与 settleWorkspace 冻结 recipe 传递，分别覆盖显式 workspace_commit 和自动工作副本提交。自动提交断言最初未触发路径，已改成下一次接口任务，实际 RED 身份 work→修复后 Native，HEAD 和集成内容均真实变化。旧 instances join 尚服务 main/旧活跃路径，不能以本次原生读取补齐宣称旧 SDK 已删除。
- 五文件 / 19 项聚焦通过，272/1862 用例总量未通过删例缩小；115 全量结果另记。未提交，整个目标仍未完成。

- 115 首次命令因 turn 中断丢失 handle，进程检查确认已终止且报告未更新，未把不完整日志当全量结果。115-retry 完整终止：1774 通过 / 88 失败，146.11 秒；60 项旧定义拒绝（较 114 减少三项 worktree），另 28 项为模块相关失败，明确 Docker daemon 不可连接，需恢复后实测归因。TypeScript/lint、272/1862 baseline、evidence、diff check 通过；已依用户此前授权启动 Docker Desktop，尚未宣称这 28 项均已解决。下一完整 gate 116。

- Docker Desktop 启动后 docker info 返回服务版本 29.4.0；六文件 / 48 项模块 owner 合同通过（/tmp/graph-native-module-docker-restored.log，26.16 秒）。随后第 116 轮完整终止：257 文件 / 1802 项通过，15 文件 / 60 项全部为旧定义拒绝，144.56 秒（/tmp/graph-v2-full-check-116.log；/tmp/graph-sdk-cutover-failures116.json other=[]）。115 的额外 28 项恢复后全量均通过，本批三个工作副本合同持续通过。TypeScript/lint、baseline 272/1862、evidence 与 diff check 通过。下一完整 gate 117；全量仍红，未提交，main/default app 未切换。Git 仍有 declaredScope/旧 DAG invalidateChecks 等生产依赖，下轮继续退役，不能宣称完整 spec 达成。

### GitIntegration 旧检查推断删除清单（2026-10-09）

- 删除 invalidateChecks、invalidateAllEvidence、changedPathsBetween、closureProducedPaths、producedPaths、retargetEvidence，以及 rechecksAfterIntegrationChange/staleRecheckTargets/sameTreePath；去掉 loadGraph/resetIdleNode 依赖。原生产 callers 为 integrate 与 recheckAgainstTarget，改为只维护 Git integration/target ref；原生 graphAcceptance 继续根据准确 commit 判断旧回执 stale，不改历史字节、不隐含投递。源码/测试搜索确认所删函数无残余 caller。
- 候选 git-baseline 七项：旧 predicate 断言只能证明内部分类/集合；直接证据插入且关闭 FK 的测试只证明旧 evidence 改绑，不能证明原生验收。历史 9fab3ad 为 HB-209 旧 DAG lane 去重，已被 ADR0030 的投递执行及用户确认精确版本取代。七项真实 Git/宿主模块/原生验收 owner 合同保留避免 stale 被当新通过、不隐含复跑、显式投递实际重检和用户文件保留，不需要旧私有 helper。
- 17 项删除前通过；六文件 / 36 项删除后通过；基线总量 272/1862 不缩小。旧 declaredScope 与实例身份仍活跃，不能声明 Git 所有旧依赖清空；117 全量结果另记，尚未提交。

- 第 117 轮完整门禁终止：257 文件 / 1802 项通过，15 文件 / 60 项仍均为旧定义拒绝，无 Git 删除新增失败，147.68 秒（/tmp/graph-v2-full-check-117.log，/tmp/graph-sdk-cutover-failures117.json other=[]）。TypeScript/lint、272/1862 baseline、evidence、diff check 通过。本批是实际移除旧 DAG 推断，不以失败数量未变否定源代码退役；旧调用尚需继续迁移，整体未完成，未提交。下一完整 gate 118。

### 未使用项目副本模块与实例身份查询删除（2026-10-09）

- src/runtime/program-copy.ts/prepareProjectCopy/projectCopyPath：源码无生产 caller，唯一 tests/console/program-copy 旧 helper tests，原 owner program-adapters 已删除；正式依赖库由 kernel-operation-broker/project-dependencies 的 canonical read grants 负责。旧 ADR 行为中的 project-side copy/hardlink 缓存不属于 v2 operation 声明，不保留其私有旧输入字段。历史 7e96c15 解决旧 copy assertion 两端路径；formal paths/dependency resolution 用真实 sandbox 命令证明，不靠静态声明或 mocked output。
- 六项旧 program graph/proposal 或旧 helper 用例替换为六项正式 operation/API/真实 Git 契约，测试支持不添加生产 export；四项旧入口失败应退出，本轮全量另记。未知 copy 静默接受已 RED，修复 formal parser 字段校验；初次 baseline 负断言是夹具理解错误，修为正式 prepare 确实建立版本后检查，不把现有支持破坏以造失败。
- Git agentIdentity 不再读取 instances，两个正式 native caller 提供 execution 冻结 recipe。NodeSpec 仍由 declaredScope/workspace 参数依赖，整体 Graph SDK 仍待处理。六文件 / 62 项聚焦通过，76 行源模块实删，下一完整 gate 118；未提交。

- 第 118 轮完整门禁终止：258 文件 / 1806 项通过，14 文件 / 56 项全部为旧定义调用（/tmp/graph-v2-full-check-118.log，151.62 秒；/tmp/graph-sdk-cutover-failures118.json other=[]）。本批四项旧 program 入口退出，六项正式命令合同与身份/精确验收相邻路径全量继续通过。TypeScript/lint、272/1862 baseline、evidence、diff check 通过。全量仍红，未提交；下一完整 gate 119，旧 NodeSpec/范围和 main/旧 SDK 调用继续退役，完整 spec 尚未完成。

### m4 验收八项旧图 caller 退出（2026-10-09）

- tests/m4/acceptance 八项旧 graph proposal/action/evidence 脚本替换为完整原生 JSON、真实 provider/Pi/check/Git/已发布审查/人工答复，数量保持；旧的 program-owned review gate 是 DAG 机制，其不可用 reviewer 结论越权交付的合同改由精确发布与 actual-send 独立模型历史证明。历史 5024e14 投影修复、6c4cca4 的提升器不作正式兼容器，不增加转换或假状态填充。
- Native 完成待处理判定真实缺陷：unknown review usage 使 node blocked 但 queue paused=0；完成把 queued input 误当可推进，实际 CPU 忙循环。执行8号 owner 合同已在修复前实际卡住，有真实进程与 SQLite 状态证据，终止后补 blocked/failed node 判定；之后 unknown hold+新 queued input+Git version 前移+complete 一并实际返回 blocked，invocation 一项、provider 请求一项，没有重发。未知结果不是增加自动重试的理由。
- 五文件 / 71 项及 TypeScript 通过；新测试没有导出或 flag seams，原子 submit/原会话与预算记录复用。119 全量另记，整个 main/旧 SDK 尚未完成，未提交。

- 119 完整命令未完成，271 文件已输出但 m2/loops 长期未输出；固定 Vitest handle、fork CPU 100% 与缺文件核对证明仍忙循环，不把日志当已完成 gate。首轮 owner 修复把 paused 表 join 到 kernel_nodes，遗漏非 agent 的 module paused 状态；保留旧暂停范围，用 UNION 合并全部 paused 对象与 blocked/failed agent。终止本轮唯一残余 fork 及 Vitest后再编辑。原八项验收 owner 合同和 m2/loops 的模块失败/重启/完成反例同时通过：六文件 / 75 项，15.33 秒（/tmp/graph-native-acceptance-and-module-completion.log）。119 不生成可信全量结果；下一轮完整 120 正在执行。

- 第 120 轮完整门禁正常终止：259 文件 / 1814 项通过，13 文件 / 48 项失败，150.90 秒（/tmp/graph-v2-full-check-120.log）；/tmp/graph-sdk-cutover-failures120.json 显示全部为旧 native-definition 入口拒绝，other=[]。本批八项旧验收 caller 全部退出，未知用量/失败模块完成反例与邻域全量通过。TypeScript/lint、272/1862 baseline、evidence、diff check 通过。全量仍红，完整 main/SDK 与 spec 未完成，未提交；下一完整 gate 121。

### m4 merge 七项旧入口退出与夹具集中（2026-10-09）

- 候选 tests/m4/merge 七项：旧 DAG/scripted action/自造 evidence/usage 不能证明 native graph 交付，已替换为正式图、真实 Git、Pi 与宿主程序、实际已发布审查和实际用户答复。历史 6c0b4b8 的 prepared preflight、6c4cca4/cbb6710 的旧提升器历史不维持第二正式格式；保留真实脏 target、ref 更新、已完成交付恢复、human、版本失效与晚到代码等产品不变量。
- 旧自动 rerun 断言按已确认显式投递模型改为不隐含复跑，记录一条旧 host check、明确新输入后第二条真实回执；原 commit 的已发布审查 bytes 保留，不能根据不相交 diff 把旧 review 当新通过。m4 acceptance 与 merge 共享 native-git-acceptance 实例夹具，消除两份启动/模型/graph 定义；没有 fake result callbacks 或测试专用生产 exports。
- 七项保持、baseline 不缩；六文件 / 24 项相邻通过，121 完整 gate 另记。旧 SDK 与 source 活跃依赖依然待整体退役，未提交。

- 第 121 轮完整门禁终止：260 文件 / 1821 项通过，12 文件 / 41 项均为旧定义调用拒绝，164.33 秒（/tmp/graph-v2-full-check-121.log；/tmp/graph-sdk-cutover-failures121.json other=[]）。本批七项 merge 退出旧入口，真实恢复/版本失效/条件更新/人工交付和共用 acceptance 夹具全量均通过。TypeScript/lint、272/1862 baseline、evidence、diff check 通过。全量仍红，未提交；下一完整 gate 122。完整 SDK/DAG 源码与 main 生命周期、spec 审核尚待继续，main/default app 未切换。

### 显式合并节点合同与旧隐式工厂退役（2026-10-09）

- 121 全量 1821/41，本轮处理旧 merge-resolver 工厂：真实生产 caller 为 task-runtime 自动组装，绕过 operation slot/预算账本且强制 full access/unlimited。依据 ADR 0030，不为新版增加隐式合并节点；删除 src/core/merge-resolver.ts（282 行）与 task-runtime 自动创建分支。旧 Execution 的注入式 MergeResolverChannels/attemptConflictResolution 及 conflict-merge helper 仍有旧 merge-loop 与 lower Git 测试引用，本批未声称已整体退役。
- console/matt-merge-recipe 一项通过正式声明、main 明确投递和真实 Pi 验证实际能力身份正文。console/merge-resolver 七项保留总数，改为正式节点执行：有 high 候选仍实际选择配方 medium；冻结 @1 身份而非最新 @2；标准权限实际拒绝工作区外 write_file；无配置模型保留输入且不发送；缺配方/缺指定版本在执行准入失败不发送；真实用量进入节点账本并重启不重放；有限预算正常准入并记账，不再要求不可计量的无限工厂。
- 夹具初次失败不视为产品 bug：推荐 grade 并非硬性排他，原生目录允许已有候选 fallback，因此无模型反例改为目录空；配方解析发生在执行准入，不是创建时 catalog 验证，按真实阶段核对失败输入。缺模型时队列 retained/节点 blocked，没有旧 questions 行，不用假问题兜底。
- TypeScript 通过；五文件 / 24 项聚焦通过（/tmp/graph-native-explicit-merge-siblings.log，15.17 秒）。旧主执行与冲突回调尚待退役；完整 spec 未完成，未提交。下一完整 gate 122。

- 第 122 轮完整门禁终止：262 文件 / 1825 项通过，10 文件 / 37 项失败，152.57 秒（/tmp/graph-v2-full-check-122.log）。四项原失败入口退出；七项替换合同与真实 Matt identity 均全量通过。37 项均为旧定义拒绝，其中两项 context-model 的 Vitest 比较文本截断旧拒绝说明；按稳定前缀核对分类（/tmp/graph-sdk-cutover-failures122.json other=[]），没有把错误的旧期望算原生回归。TypeScript/lint、272/1862 baseline、evidence、diff check 通过。全量仍红，完整 spec 尚未完成，未提交；下一完整 gate 123。

### 旧冲突回调、合并判断器与文件 scope 推断整体退役（2026-10-09）

- 122 全量 1825/37。本轮 caller 核对：mergeResolvers 唯一剩余使用为旧 merge-loop 夹具，Execution.attemptConflictResolution 为 conflict-merge.ts 唯一生产 caller；contributions 仅供该判断器与私有谓词测试。删除注入式 MergeResolverChannels/MergeUsage、task-runtime options 与 Execution 自动尝试，删除 src/git/conflict-merge.ts（215 行），不把旧判断器另藏进原生模块。冲突返回真实失败并保留工作，正常原生队列/default retry 与 main 控制仍负责后续工作。
- GitIntegration.declaredScope/restoreOutOfScope/outOfScopePaths 只读取旧 nodes.input.files，原生格式不具备此字段。删除旧节点数据库耦合和自动改写 worker commit 的推断（既有原生 workspace/提交授权与验收保持）；Git infrastructure 不再导入 NodeSpec/Operation 类型，只接受实际 Git effect 必需字段。明确提交按 literal pathspec 产生稳定版本，后续修改/提交不改写旧 commit；跨 sibling worktree 的提交遭实际授权拒绝。
- merge-loop 三项换成真实两路 HTTP/Pi、私有 Git worktrees：冲突后该节点下一条输入仍 queued，main cancel 不清掉原失败；磁盘 runtime 重启保留失败输入与集成 tip，不重放 worker、不启动隐式合流；main skip 不产生 check/review 回执也不能交付单侧版本。m4/worktrees 同 owner 夹具抽取 tests/fixtures/native-worktree-graph.ts，原三项保留。
- conflict-merge 七项换成 Git 基础设施 owner 和正式 graph 验收：main 明确进行真实两父 commit resolution，GitIntegration 记录 integration，再由真实 host check + 独立 HTTP/Pi reviewer 发布精确 commit 报告，完成后才更新 target；丢一侧、无关路径修改、残留 markers 三类真实 committed candidate 留在私有副本但 host check 失败阻止 delivery；外部真实 ref 改名使 Git integration 失败而原 tip/checkout 保持；无冲突的真实两路修改无 resolver 即合并；验收后改坏内容使旧 receipt stale，显式新 check 真失败。此层直接测试 Git effect，不假装 worker/model 写出了代码；模型执行/队列归上面的真实 Pi owner。
- merge-lane-conflict 两项与 git-baseline 一项退出 NodeSpec/Proposal/假 operation casts/旧 nodes 插入：保留多次集成后冲突的精确 metadata 与已有 disjoint bytes；显式 publication 只提交文件名 *.txt 而不展开 wildcard、不包含其他已 staged 修改；节点绑定不能在 sibling worktree 提交。共用 tests/fixtures/native-git-conflict.ts，避免复制临时 Git/Pi/检查配置。
- 聚焦五文件 / 32 项通过（/tmp/graph-native-conflict-and-scope.log，12.69 秒），TypeScript 通过。测试总数保持；旧 main/context/handoff/rework 尚待退役，完整 spec 未完成，未提交。下一完整 gate 123。

- 最终相邻聚焦八文件 / 45 项全通过（/tmp/graph-native-conflict-retirement-siblings.log，13.47 秒），Git 恢复、显式 merge recipe/账本、原生 kernel Git integration 同时通过。最终 TypeScript/diff check 通过，123 全量执行中。

- 第 123 轮完整门禁终止：264 文件 / 1830 项通过，8 文件 / 32 项失败，154.71 秒（/tmp/graph-v2-full-check-123.log；/tmp/graph-sdk-cutover-failures123.json：oldDefinition=32、other=[]）。本批旧 merge-loop 三项与 merge-lane 两项退出，lower conflict 七项、Git scope 三合同及相邻恢复全量通过。TypeScript/lint、272/1862 baseline、evidence、diff check 通过。剩余失败：context-model 8、predecessor-handoff-production 6、schema-upgrade 2、m6/faults 3、m8/conversation 1、rework-ui 1、rework 9、ui-flow 2；这些 caller 与仍存在的旧 main/context/handoff/rework/scaffold 源码继续退役。完整 spec 尚未完成，全量仍红，未提交、main/default app 未切换。下一完整 gate 124。

### 原生显式 handoff 合同与旧节点字段拒绝（2026-10-09）

- 123 全量 1830/32。本批 predecessor-handoff-production 原七项全部退出旧 Proposal/NodeSpec/dependsOn/containers/context.predecessors/submit_result、假 ActionAdapter/evidence/usage、私有 RESULT_HANDOFF_SCHEMA_EXAMPLE 重述；保留七项数量，使用正式 graph_create/send、两个或三个实际 HTTP provider、resident Pi、具名 submit 和明确 join 模块。旧 predecessor-handoff.ts 的 main/旧 context/lifecycle callers 尚未实删，不把测试迁移写作源码整体退役。
- 七项实际合同：模板 bundle 的公开输出直映 bundle/leaf.result，边记录真实叶来源，next 收到 value 而没有源的私有最终回复；两个来源明确提交 summary/evidence，once join 收齐后才触发，私有 transcript 不泄露；worker 再执行生成 V2，边历史 V1 不改写，next 保留原 session/回复；必需输出遗漏获得同 execution 的一次补交 delta，不重复初始任务全文，新 submit 后才投递；无效输入不发送模型、无效输出 objective 字段报错返回正在工作的模型，修正只投递一次；补交仍失败则 execution/queue 已知 failed、provider calls 都 settled，不假装 unknown/成功；实际交给模型的协议声明 string-list/object-list 元素类型，错误列表元素被 submit 拒绝后修正才向下游流动。
- 实际 RED：parseGraphDefinition 静默接受旧 context、dependsOn/when/container 字段，两个 formal schema owner 反例均未抛错（/tmp/graph-native-context-contract-red.log）。NodeDefinition 仅接受已声明 recipe/task/acceptance/inputs/outputs/submission/model/retry/budget/deliverable，未知字段给出具体 node/key 与显式连接修正指引；旧 command 使用原明确错误。context-model 前两项改为真实正式解析边界，不以旧 DAG validation 私有规则继续维持旧语言。schema 文档注释不再声称需要旧历史 reader，遵循 ADR0030。
- 初始夹具断言修正：edge history 公共接口按新到旧返回，V1/V2 核对该顺序；输入拒绝为 work.job 的 AJV required-property 文本，明确 await rejects，不用 catch 吞异常。两个 schema owner 反例已 GREEN（/tmp/graph-native-context-contract-green.log）。TypeScript 通过；五文件 / 75 项全通过（/tmp/graph-native-handoff-siblings-fixed.log，10.62 秒），submit bridge、executor、接口 parser 和八种真实模式同时验证。完整 spec 未完成，未提交；下一完整 gate 124。

- 第 124 轮完整门禁终止：265 文件 / 1838 项通过，7 文件 / 24 项失败，160.17 秒（/tmp/graph-v2-full-check-124.log；/tmp/graph-sdk-cutover-failures124.json oldDefinition=24、other=[]）。本批六个 handoff 旧入口与两个旧 context validation 退出，正式七项 handoff/字段拒绝/真实模块与模式全量通过。TypeScript/lint、272/1862 baseline、evidence、diff check 通过。剩余失败为 context-model 6、schema-upgrade 2、m6/faults 3、m8/conversation 1、rework-ui 1、rework 9、ui-flow 2；仍需旧 main/context/handoff/rework 源码清理和完整 spec 验收。全量仍红，未提交，main/default app 未切换。下一完整 gate 125。

### 原生凭证排队、执行上限与暂停恢复（2026-10-09）

- 将 m8/rework 原四项并发/暂停合同从 Proposal/NodeSpec/dependsOn/自动 check 迁移到 main.graphCreate 的原生声明及具名 job 接口逐次投递；删除三个虚构 check ActionAdapter 与对应虚构 evidence。保留文件原 13 项和完整套件 272/1862 数量。真实 HTTP SSE provider、真实 daemon/config/startup、实际 resident Pi 和生产 scheduler 执行，未新增生产测试开关。其余五项旧返工/部分执行/未知用量测试与相关源码尚待迁移。
- 已验证：同 secretRef 与不同 secretRef 相同实际值均共享凭证 cap=1，startup 正式返回 alias 映射且不泄露密钥，每个 worker 实际 12 token 入账；A 的十个等待任务释放执行名额，独立 B 的 HTTP 发送与完成不受阻；二十个凭证等待任务恢复时重新取得全局执行名额，实际 HTTP 并发不超过十；二十个 pre-send 等待任务暂停后零发送、零 token、零 reservation，每次 execution blocked 且 retries_used=0，恢复原输入后全部成功。daemon 会实际运行 owner 的一轮请求，因此 alias 合同总计三次 HTTP（owner 加两个 worker），不将 owner 请求漏计。
- 定向三项通过（/tmp/graph-native-rework-admission.log，11.05 秒）、暂停一项通过（/tmp/graph-native-rework-pause.log，4.70 秒）。125 gate 在 TypeScript 阶段发现旧/native 联合类型未都声明 instance.reserved，改用公开 execution.reserved 验证零 reservation 后运行 126；125 未运行完整测试，不计为完成的全量验证。
- 第 126 轮完整门禁终止：265 文件 / 1842 项通过，7 文件 / 20 项失败，166.48 秒（/tmp/graph-v2-full-check-126.log；/tmp/graph-sdk-cutover-failures126.json oldDefinition=20、other=[]）。四项迁移合同均通过全量负载；TypeScript/lint、baseline 272/1862、evidence 与 diff check 通过。剩余旧入口失败：context-model 6、schema-upgrade 2、m6/faults 3、m8/conversation 1、rework-ui 1、rework 5、ui-flow 2。完整 spec、旧 SDK/context/main/scaffold 退役及默认 app 切换仍未完成，未提交。下一完整 gate 127。
- 下一批需保留真实部分写入、会话续用和逐次用量证据，移除旧的“未知用量可不计费释放”约定：有限预算缺失 usage 必须保持 hold，main 明确记录 authoritative usage 后再恢复；旧 test 中 synthetic proof 不应冒充供应商账单。返工通过明确 reviewer/module 接口投递，不能恢复隐式 loop 推断。

### 原生部分执行与明确返工路由（2026-10-09）

- m8/rework 剩余五项退出旧 Proposal/NodeSpec/loops/dependsOn/submit_result、问题式未知用量零释放与虚构 ActionAdapter/check/evidence；删除本文件最后的旧 checkNode/NodeSpec。文件仍是 13 项，未减少任何套件用例。新增两类共用本地夹具只驱动正式 graphCreate/graphSend/graphControl 与实际 HTTP/Pi/文件系统；没有生产专用开关。累计文件 196 行新增 / 465 行删除。
- 部分工作暂停：真实 write_file 已写出 partial.txt，在第二次供应商准入时暂停；原 execution blocked、零 reservation、retries_used=0，首调用实际 usage 50；恢复沿原 execution/instance/session 读到原写入及工具历史，第二调用累计 100，未重放写入。有限预算未知响应不会执行其 write_file，初次夹具假定未知工具仍写入而 ENOENT；改为先已知写入、再未知工具响应，核对缺失用量期间 unmetered.txt 确实不存在。缺失 usage 的 reconcile 请求明确拒绝，普通 resume 不解 hold；具体 call usage 核对两次只入账一次，再显式 node resume 回原会话/执行。混合两次真实写入后未知第三调用，已知 100 立即保留、核对至 150、续跑至 200，两份文件和 session/execution 身份不变。
- 明确返工：独立 reviewer 通过 submit 提交 passed:false 与真实 reason，each 路由模块将 $review 投递给 work.job；第二轮仅注入失败 delta，原任务和初始输入不重复，worker 保留自己的 PRIVATE_FIRST_WORKER_REPLY 而没有 reviewer 私有回复。两次 worker 结果分别形成不可变边投递，模块通过结果交公开 approved。未知用量发生在第二轮真实 fix.txt 写入之后，第一 execution 已完成、第二 blocked，审查只收到第一结果，公开通过输出为空；核对实际 call 后原第二 execution 继续 submit 第二结果，独立 reviewer 再执行后才产生 approved，无第一轮成功复用或已提交输出重发。
- 定向三项部分执行/用量通过（/tmp/graph-native-rework-partial.log，2.82 秒）；完整 rework 文件 13 项通过（/tmp/graph-native-rework-all.log，22.35 秒）；TypeScript 通过（/tmp/graph-native-rework-typecheck2.log）。新 fixture 不把 usage proof 文本当供应商账单，实际 provider 未报告的 usage 保持 unknown，测试只通过 main 明确写入该 call 的核对值。运行完整 gate 127。旧 execution/context/handoff/main scaffold 源码仍有活跃引用，未声称已实删；完整 spec/默认 app 仍未完成。

- 第 127 轮完整门禁终止：266 文件 / 1847 项通过，6 文件 / 15 项失败，162.91 秒（/tmp/graph-v2-full-check-127.log；/tmp/graph-sdk-cutover-failures127.json oldDefinition=15、other=[]）。m8/rework 全部 13 项在全量负载下通过（45.449 秒），本批五项旧图入口已退出。TypeScript/lint、272/1862 baseline、evidence、diff check 通过。剩余失败：context-model 6、schema-upgrade 2、m6/faults 3、m8/conversation 1、rework-ui 1、ui-flow 2。旧 execution/context/handoff/briefing 仍有生产 main/operation-lifecycle/pi-adapter 与其他测试引用，源码实删须随这些入口迁移后执行，不保留兼容转换器。完整 spec 尚未完成，全量仍红，未提交或切换默认应用；下一完整 gate 128。

### 原生实时图与浏览器流程入口（2026-10-09）

- rework-ui 原一项及 ui-flow 原两项退出 Proposal/NodeSpec/containers/loops/dependsOn、虚构 Agent/check ActionAdapter、虚构 usage/evidence 和 withIndependentReview fixture；保留两文件全部四项数量（包含不变 cursor 合同）。本批测试净减少 43 行：71 新增 / 114 删除，未新增生产开关或修改图执行规则。遵循 test-audit 与 e2e-race-conditions：只等目标状态/元素，未加入固定延迟。
- 实时图：实际 HTTP provider/resident Pi submit LIVE_RESULT_VALUE，显式边触发实际 node --version operation 模块，浏览器已打开的同一 URL 从 Agent idle 更新到 Agent/模块 succeeded，不导航、不 load more；正式 edge history 核对真实投递，正式 operation 核对 ok=true / result code=0 passed=true。初次断言误用 exitCode 字段，按正式 operation 输出结构修正，未伪造 operation 成功。
- 项目流程：A 的原生 graph 通过真实 submit 和宿主 command 完成后由 main 显式 complete；浏览器打开 Agent 独立 tab，再关闭仍保留图状态。B 为另一个 project 的独立原生 graph，仍 idle，B owner inspect A 明确 permission 拒绝；图 tab 的 A/B 名称分离，直达 A URL 重载后恢复节点。此测试证明控制台流程/项目分离，不声称无审查的 UI fixture 证明 Git 交付；真正精确 Git/check/独立 review 交付由 nativeGitAcceptance 与 final-acceptance/m7 等主合同覆盖。
- 复杂结构：可复用 branches@1 子 graph 实例 grp 内两 Agent、once join 模块、两个具名输入、显式 feedback 边和公开输入/输出映射；浏览器核对真实 grp/feedback 直角路径、容器实际包围 grp/left，折叠后 leaf DOM 消失、展开恢复。保留未知 task 与实际 HTTP 500 注入后明确错误显示，未保持旧 loop: ID 或旧扁平 container 伪模型。
- 定向两文件 / 四项通过（/tmp/graph-native-ui-flow.log，6.93 秒），TypeScript 通过（/tmp/graph-native-ui-typecheck.log），diff check 通过；正在运行完整 gate 128。此批退出三个旧入口失败，仍有旧 context/history/fault/main scaffold 代码引用；完整 spec 和默认 app 切换未完成，未提交。

- 第 128 轮完整门禁终止：268 文件 / 1850 项通过，4 文件 / 12 项失败，162.06 秒（/tmp/graph-v2-full-check-128.log；/tmp/graph-sdk-cutover-failures128.json oldDefinition=12、other=[]）。ui-flow 全部三项与 rework-ui 一项均在全量负载下通过。TypeScript/lint、272/1862 baseline、evidence、diff check 通过。剩余失败：context-model 6、schema-upgrade 2、m6/faults 3、m8/conversation 1。下一批 worker 非合规结果应以原生 required outputs/submit 协议失败、系统通知与 main 明确 retry/人工处理实现，不能恢复隐式前驱 handoff 修补回路。源码旧 execution/context/handoff/main scaffold 退役及完整 spec/默认 app 切换未完成；全量仍红，未提交。下一完整 gate 129。

### 原生交付失败、main 通知定位与用户决定回投（2026-10-09）

- m8/conversation 最后一项旧 graph 入口退出 Proposal/NodeSpec/dependsOn/context.predecessors/result_handoff/非合规隐式修补问题；替换旧 scripted worker/next/master、虚构 usage/check/evidence，使用四个实际 HTTP provider（main、worker、next、composer suggestion）、真实 Pi、具名 submit 和 main 管理控制。文件保留 41 项，未减少用例。旧 result_noncompliant/noncompliance_decision 源码还有 operation-lifecycle 等引用，尚未实删。
- 非合规 result 缺少协议要求 objective，实际 submit 工具返回 output_protocol_mismatch/objective 拒绝；一次自动补交仍无有效输出，原 execution failed、resubmits_used=1，三个真实 worker 请求、零 next 请求、零边投递。main 实际 model turn 收到失败通知，向用户说明缺失目标；用户通过 conversation.chat 提供决定，main 实际请求读到该内容。main 明确 skip 保留的失败 queue，然后 graphSend 将用户决定和修复理由投递原 work.job；沿原 instance/session 新 execution 提交合法结果，只有 FIXED_AFTER_ESCALATION 通过边进入 next，BROKEN_HANDOFF_SENTINEL 没有泄露给 next，新输入不重复顶层 TASK_REQUEST_SENTINEL。
- 初次夹具错误已查清：控制台的 composer suggestion 会在每轮 main 回复后选独立较小模型，本 fixture 的 worker 首条 provider plan 被建议请求消耗，导致后续 script 不对齐。供应商请求实读 lastUserMessage/assistantReply 确认，未把此事误报内核错误。按生产模型目录配置单独 low-grade suggestion provider，真实请求正常完成，未添加测试禁用开关或从 fixture 隐藏内部请求。
- 真正 RED：失败通知写 Node work 与 reason，但没有完整 graph ID，main 请求中只有状态摘要缩写 ID，无法可靠调用 graph_inspect。/tmp/graph-native-conversation-failure.log 直接实际 main model 请求未包含完整 graphId。修复 wakeForBlockedNode 持久 intent data 包含 graphId，renderWakes 同时显示节点、完整 graph 与原因，沿现有去重/消费机制，不发业务输出或重建旧 handoff 问题。正式 notify owner 反例 GREEN（/tmp/graph-native-conversation-failure-green.log，3.44 秒）。TypeScript 与 diff check 通过，正在运行完整 gate 129；完整 spec 和默认 app 切换仍未完成，未提交。

- 第 129 轮完整门禁终止：269 文件 / 1851 项通过，3 文件 / 11 项失败，177.22 秒（/tmp/graph-v2-full-check-129.log；/tmp/graph-sdk-cutover-failures129.json oldDefinition=11、other=[]）。conversation 全部 41 项、wake-ledger 全部 13 项通过，真实 main 通知 graph ID 修复和用户决定回投通过全量负载。TypeScript/lint、272/1862 baseline、evidence 与 diff check 通过。剩余旧入口失败：context-model 6、schema-upgrade 2、m6/faults 3。源码两行替换，测试 57 新增 / 111 删除；没有兼容转换器或删除原用例数量。完整 spec、旧 execution/context/handoff/scaffold 实删及默认 app 切换仍未完成，全量仍红，未提交。下一完整 gate 130。

### 原生 Git 副作用、未知用量与硬进程恢复（2026-10-09）

- m6/faults 原三项完全退出旧 Proposal/NodeSpec/dependsOn/ActionAdapter/withIndependentReview、虚构 Agent usage、手写 sandbox check evidence、旧 host.report/reconcile 回调。tests/fixtures/m6/crash-git.ts 改为实际 HTTP/Pi/原生 graph 的子进程 fixture，不保留兼容层；只有 faults 一个 caller，已核对。nativeGitAcceptance fixture 增加 workPlans 自定义真实 provider 响应序列，供这批共享现有真实 Git/check/独立 review setup，不增加生产测试开关。三项数量不变。
- 幂等：真实 worker write_file 后 submit 同一结果两次、再 submit 不同结果，前两次同 execution 的同内容 replay、第三次收到 already_submitted，磁盘 kernel_submissions 恰一项、原 execution completed；真实 command 检查和独立读取/已发布 commit review 通过，main complete 两次、重启后均只有一项 kernel_completion_delivery，target HEAD 仍为最初验证的 commit，worker 五请求/reviewer 三请求不重跑。初次断言用了不存在的 submission_conflict 名，按实际工具 refusal code already_submitted 修正，没有放宽一项正式提交约束。
- 未知用量：真实 write_file 与 workspace_commit 已完成、第三响应没有 usage，worker used=100、hold 保留，真实 HEAD 含 feature.txt 而目标仍 baseline。重启后无新供应商请求/新 Git commit；main 明确核对第三 call 50、resume 原节点，沿原 execution/session/instance 完成 submit 与最终回复，累计 250、原 worktree HEAD 不变；实际宿主 check 与独立 reviewer 通过后才交付 target，写/commit 不重放。
- 硬崩溃：子进程使用生产 native runtime，在真实 worktree 已 commit 后第三 HTTP send inflight 时回报观察到的正式执行/call 身份，父测试确认供应商已看到第三请求后 SIGKILL 整个 runtime owner（没有模拟 killed 标志）；晚到响应不能恢复已死 owner 的落账。重新获得 owner lock 后原 execution blocked、原两调用已知 100、第三 call unknown、无自动派发，commit 字节仍可 Git show。main 核对实际 call 并 resume 原 execution/session，worker 总五请求，原 HEAD 不变；首次真实 check/review 后 target 独立推进，complete blocked、两项 stale。明确 withdraw_complete 与第二次 check/review 才产生新验证 commit，最终同时保留 feature.txt/extra.txt；实际 module operation 两次、独立 reviewer 六请求，worker 不重放。
- 故障与相邻验收/合并三文件 / 18 项通过（/tmp/graph-native-git-faults-siblings.log，16.51 秒），TypeScript 与 diff check 通过。正在运行完整 gate 130；旧 SDK/context/main/history 源码和完整 spec 尚未完成，未提交。真实进程 fixture 不接受手写 reconcile result/evidence 作为恢复证明。


### 原生启动废弃旧 graph 与同库升级（2026-10-09）

- 完整门禁 130 已终止：270 文件 / 1854 项通过，2 文件 / 8 项失败，168.07 秒；/tmp/graph-v2-full-check-130.log、/tmp/graph-sdk-cutover-failures130.json。8 项均为旧定义入口拒绝，context-model 6、schema-upgrade 2。272/1862 baseline、evidence、diff check 均通过，m6 真实硬崩溃/Git 副作用三项通过全量。
- schema-upgrade 两项旧 DAG 流水线改为真实 v13/v17 SQLite 启动、HTTP、热配置、原生 Pi/submit 和重启测试；第三项 v23 schema 迁移暂保留，不作为旧图历史 reader。原文件仍 3 项，不使用 ActionAdapter、虚构 check evidence 或旧 graph 转换。
- 实际 RED：旧 graph HTTP 返回 200，仍占用 legacy-model 配置绑定；/tmp/graph-native-upgrade-red.log。ADR0030 明确旧图丢弃，因此修复 runtime 启动：KernelStore 建表后、恢复前，原子删除没有原生 revision 的旧节点/提案所属任务和其调用、实例、预算、上下文、问题、Git/产物元数据及幂等回执。保留 project/catalog/config 基础设施、conversation anchor 和 native graph owner；native graph 不参与删除。事务 deferred FK 在 COMMIT 检查，失败释放 owner lock，不禁用外键，不转换旧定义。
- GREEN：旧图 HTTP 返回正式 not_found（现有 HTTP 错误约定 400），列表无旧 ID、模型配置无需保留 legacy-model 即能热更新；旧实例/invocation 消失。同一个 SQLite inode 运行真实 Pi submit，将 upgraded:true 交给公开出口；关闭重开后外部 main 能读取相同 results/executions，供应商只有两请求，无重跑，PRAGMA foreign_key_check 空。
- 升级及相邻 m6 故障/m1 恢复 3 文件 / 11 项通过，9.66 秒，/tmp/graph-native-upgrade-siblings.log。TypeScript/diff check 通过。旧 graph 私有目录/不可达 object bytes 没有被此元数据事务盲删；旧源码 scaffold、上下文路径、schema 迁移旧表、完整 spec 审计及默认 app 切换仍未完成。下一完整 gate 131；未提交。

- 第 131 轮完整门禁终止：271 文件 / 1856 项通过，1 文件 / 6 项失败，178.91 秒；/tmp/graph-v2-full-check-131.log 与 /tmp/graph-sdk-cutover-failures131.json。6 项均为 context-model 旧定义入口拒绝；没有其它故障。schema-upgrade 三项、m6 硬崩溃恢复、原生队列/返工重启、main conversation 与 HTTP 配置全量通过。TypeScript/lint、272/1862 baseline、evidence、diff check 通过。启动旧图元数据废弃已经通过完整负载；context/Fork/predecessor/main scaffold 及完整 spec/默认 app 交付仍未完成，未提交。下一完整 gate 132。


### 原生上下文主边界与旧 graph Fork 解析退役（2026-10-09）

- context-model 保留 14 项，整份退出 NodeSpec/Proposal/dependsOn、context.predecessors/Fresh/Fork、手写 operations/handoffs/artifacts/预算 SQL、虚构 program check/evidence/usage；改为真实 HTTP provider、Pi、原生具名 submit、发布/read 工具、显式 router projection、graphPatch 和重启。删去旧私有 parser/recovery/source graph/context binding 测试，不用新旧转换器补测。
- 原生独立 instance/session/预算：source 第一次 50、peer 50，source 复跑累计 100，peer 仍 50；本节点续用自己的历史，peer 不读 source 私聊。接收节点实际 model 请求包含具体任务/验收/逻辑接口/协议字段/激活 value/图节点，发送者完成私聊不进入接收上下文。
- 显式 router 只映射 source.evidence，接收者看见实际证据而看不到 source summary/private transcript；artifact reference 缺少 version 由 submit 返回 output_protocol_mismatch，自动补交仍不满足则保留失败输入，零下游请求/边投递。未发布私有文件的接口 value 原样保留，不编造 digest/absolute path/artifact；实际文件经相对路径发布后，digest 匹配真实字节，接收者 artifact_read 读到稳定版本而不继承发布者私聊。
- 同一 logical publication 发布 v2 后，接收者再次按原 v1 引用读取仍读 v1。真实 workspace 外文件发布被拒绝，没有共享产物或下游工作。两次 subgraph template 实例的聊天历史/预算独立；一个实例复跑不读另一实例聊天。重启后原节点续跑保留 instance/session/累计用量与原 briefing，仅新 input delta 不重复初始任务和验收。
- 配方改变在下一 execution 明确生效，供应商实际 developer/system identity 包含新规则，实例身份及原聊天历史/累计额度保留；复用 ADR0011/0030 已确认的能力重绑机制，session 文件/ID 会分支而不会丢聊天历史。初始测试错误限定 system role 和固定 session ID，实际 OpenAI 请求使用 developer role，且 session inspect 明确 rebind，已按真实 spec 边界更正断言，没有报成产品缺陷或修改机制。
- 两项其他夹具错误也记录：字段映射用 source.evidence 而非 $source.evidence（后者代表整个具名输入）；未请求 Git worktree 的 graph 节点 workspace 是 project，因此 workspace 外发布反例文件必须放在 project 之外，而非项目内。没有放宽生产发布边界。
- context.ts 删除旧 graph context request validator、跨节点 transcript/fork 判定、共享 budget/parent instance 设置、fork constraints 校验与 branch_created 路径；正式 resolver 只服务外部 main 的 fresh/continue，不接收 graph node/context。graph 节点仍走 resident/native input/session 路径，未迁移到旧 resolver。删除无任何 caller 的 recoverResultHandoffDraft wrapper，并移除旧 Execution 向 main resolver 传 reviewer/model exclusion 的参数。旧主会话 context/handoff 表和其它前驱 parser/settlement/scaffold 仍待退役，不能视为全部源码退出。
- context/handoff 与 main/conversation capability 四文件 / 72 项通过（/tmp/graph-native-context-main.log，27.39 秒）；全原生 context/handoff 两文件 21 项此前通过（/tmp/graph-native-context-all-green.log，12.82 秒）。最终 TypeScript、diff check 通过。下一完整 gate 132；完整 spec 和默认应用交付尚未完成，未提交。


### 真实配置快照时序与设置页生效版本回退（2026-10-09）

- 第132轮完整门禁结束：271 文件 / 1861 项通过，1 文件 / 1 项失败，181.61秒；/tmp/graph-v2-full-check-132.log、/tmp/graph-sdk-cutover-failures132.json oldDefinition=[]、other=设置页 autosave 生效版本未清除“正在同步”。context-model 14 项及所有旧定义入口迁移测试全量通过；这是新的 UI 配置时序失败，不计为旧 graph 入口失败。TypeScript/lint、272/1862 baseline、evidence、diff check 通过。
- 隔离原用例通过（/tmp/graph-native-settings-single.log，5.96秒），没有把“单独绿”当作产品正确。按 e2e-race-conditions 技能读取 Settings/load/startup/persistDraft 和真实 /api/config GET/POST；GET 已经提供同一响应的 revision/effectiveRevision，客户端只读前者，启动 snapshot 则无条件覆盖有效版本。
- 稳定 RED：在原 settings autosave 主合同内延迟真实 /api/startup 响应，等待服务端取出旧快照；通过实际 HTTP POST 对磁盘现有精确配置热保存得到新 revision（不改变模型/凭据/限额），浏览器 config GET 再读真实新 pair，随后释放旧 startup。等待由该 startup handler 渲染的 source-root，确保旧快照确实被处理；运行版本低于新 saved revision，/tmp/graph-settings-stale-startup-red.log，20.73秒。同一个10项测试文件，无新增计数、伪造响应 body、固定 sleep 或放宽断言。
- 修复 Settings 读取 config response 的 effectiveRevision，启动 GET、config GET、POST receipts 只允许推进已知生效版本，不允许晚到旧快照回退。保留保存/生效不同的真实状态，不把未知或未应用当已应用。两次早期夹具尝试也如实记录：延迟所有初始 startup 后又有后续 save，会冲掉反例；只有明确控制同一次设置页面的启动/配置响应与实际热保存顺序才形成稳定 RED。
- Settings 全部10项 GREEN（/tmp/graph-settings-stale-startup-green.log，20.14秒），TypeScript/diff check 通过；仍需相同全量负载验证，下一完整 gate133。源代码 Fork/predecessor/main/SDK scaffold、模型small/medium/frontier目录、统计与完整spec/默认app交付仍未完成，未提交。

- 第133轮完整门禁终止：272 文件 / 1862 项全部通过，178.81秒；/tmp/graph-v2-full-check-133.log、/tmp/graph-sdk-cutover-failures133.json failures=[]。TypeScript/lint、原始272/1862 baseline与tracked evidence检查通过，diff check通过。旧上下文测试已完整退出旧定义/私有上下文 SQL，旧 graph Fork resolver 删除以及真实设置快照回退反例在全量负载下通过。当前并未完成完整目标：Pi adapter 旧 graph Fork/审查分支、predecessor parser/settlement/history/main/ActionAdapter scripted scaffold、旧 GraphPlan/GraphState/types/layout 投影、模型 small/medium/frontier 目录、当前/下一配置展示、统计、规范/术语/使用文档和默认 app 交付仍需逐项实证；不能据全绿认定 spec 完整或旧SDK全部删除。尚未提交，下一门禁134。


### 冻结执行配置展示、旧 Fork 适配器与脚本执行路径退役（2026-10-09）

- 第 134 轮完整门禁通过：272 文件 / 1862 项，176.74 秒；TypeScript/lint/baseline/evidence 全过，日志 /tmp/graph-v2-full-check-134.log。旧 graph 的 AgentContextMode 已删除 fork，Pi adapter 的跨节点 Fork 校验/创建分支已删除；通用 Pi session API 的自身历史分支不冒充 graph Fork，仍供合法会话重绑使用。
- 扩展现有真实 Pi/MCP 用例，在旧 worker@1 的供应商响应进行中发布并 graphPatch 为 worker@2：修复前 nodeRun.instance 错报 worker@2，红证据 /tmp/graph-frozen-config-red.log；修复后当前执行配置取 execution.revision_version，下一次配置取最新声明。prompt 身份取实际 recorded execution 的 revision，模型取该 execution 的实际 provider call，不把新配方标到旧 prompt 上。
- 原生 prompt/run 提供 configurations.current/next/pending；只比较节点声明与 defaults，不因其它节点变更的 revision 数字不同而标成待生效。未执行没有 current，移除节点没有 next。界面显示当前与下一次配方，待生效时可查看下一次声明，实际 prompt 字节保持独立。
- 聊天的现有 SSE 刷新补收 graph.* 原生事件；graphPatch 在同一事务中记录 graph.patched。详情沿聊天刷新实际 prompt，并用请求序号拒绝旧请求覆盖新结果。真实 Chromium 保持窗口打开，验证 coder@1 当前、coder@2 下一次及原始发送 prompt；未添加轮询。3 文件 52 项运行时用例通过，浏览器 3 项通过，均纳入 gate134。
- 删除 task-runtime 的 options.actions → scriptedTurn 桥、kernel-graph-lane 的 scriptedHost、processId=0、自动生成 submit output 与 0 usage 执行替身。操作模块仍无需模型，agent 节点走配置模型的实际常驻 Pi。旧测试文件 scripted-lane.test.ts 迁移为 native-repair-freeze.test.ts，保持一项主验收，不维护生产中的测试专用执行路径。
- 迁移用例真实 HTTP/Pi 完成 5 次模型发送：缺少必需输出后补交一次，当前 task/recipe 不随执行中的 patch 改变，下一 execution 才使用新身份/任务；公开结果实际产生两次，原 instance 保留，用量分别累计 150/250。定向用例与主/Web TypeScript 通过，日志 /tmp/graph-scripted-retirement-test.log、/tmp/graph-scripted-retirement-types.log。删除路径后的完整 gate135 正在运行，不提前宣称全量通过。
- 完整 spec、旧 main/SDK/DAG scaffold 全部移除与默认 app 交付仍未完成；此批未提交。


### 无 Pi 的旧脚本执行替身：剩余夹具迁移（2026-10-09）

- gate135 完整结果为 266 文件 / 1841 项通过，6 文件 / 21 项失败，174.83 秒；日志 /tmp/graph-v2-full-check-135.log、分类 /tmp/graph-sdk-cutover-failures135.json。全部来自残留的无模型 graph ActionAdapter 夹具：console/git-admission 4、m2/revision 2、m3/planning 1、m4/command-check 11、m5/http 1、m8/v2-completion 2；没有恢复已删除的生产 scriptedTurn/scriptedHost。
- 上述六份夹具逐个改为真实 HTTP provider、Pi、submit、文件工具、工作副本、正式 API。main planning 用真实 propose_graph，不以回调直接替代主 agent 的提案工具；真实请求确认 main 读到私聊 marker，worker 只读显式任务/验收与投递值。revision 仍保留四项原有行为；completion 三项仍区分成功节点、确认的人类验收与缺少必需输出。
- Git 准入以真实 provider 请求数证明 dirty baseline 拒绝时没有发送，明确基线后才发送；工作副本通过公共 worktrees 元数据检查，并保留文件字节/项目目录隔离断言。公共 worktree path 是 Git 根；有 projectSubdir 时实际工作位置要加该子目录，不能误把投影字段改成会话 cwd。
- 初次迁移误用 Pi 通用工具名 write，原生图实际工具为 write_file。真实工具结果明确 Tool write not found；旧脚本直接宿主写文件绕过了这个边界。纠正后要求 worker 工具结果无 isError，避免空的 node --test 偶然通过掩盖根本没有写测试文件的情况。所有原有 TMPDIR、loopback/子进程守卫、依赖解析、检查失败、命令拒绝及固定版本断言保留。
- submit 成功立即投递，而代码集成在执行结束时结算，两者按 spec 分开。command-check 夹具不再假定 submit 已完成集成：结构中的自动检查边明确禁用，main 在真实 worker 成功并集成后显式投递 check.job；命令仍严格验证最终集成 commit、stdout 和 receipt，不伪造证据或延迟生产 submit。
- HTTP 暂停用例以真实进行中的 provider 响应作为并发边界，恢复后补交必需输出。不能用旧 ActionAdapter 无条件自动提交，也不能在已经成功 submit 的执行上以恢复为由重复发送。定向用例已通过，并补充单 execution、一次补交/零自动重试、三次真实请求和累计 150 token 的断言；这些新增断言纳入 gate136。
- 迁移定向：m2/revision、m8/completion、native-repair-freeze 与 m3/planning 通过；m4/command-check 12、git-admission 10、m5/http 其余 5 通过，最后暂停定向也通过。主/Web TypeScript 与 diff check 通过。gate136 正在运行；完整退役/spec/default app 未完成，未提交。


### 外部 main 执行器退役旧 DAG 调度与前驱组装（2026-10-09）

- gate136 已终止并全绿：272 文件 / 1862 项，190.09 秒；TypeScript/lint/baseline/evidence 通过，日志 /tmp/graph-v2-full-check-136.log。删除 scriptedTurn/scriptedHost 后剩余六份真实合同夹具均完成迁移，没有为绿灯恢复生产替身。
- Execution.readyNodesFor 只接受 chatting/discussing 的外部 master；删除 running 旧 graph loadGraph/readiness/skip/activation 调度循环。执行前明确校验 role=master/kind=agent。原生内部节点通过独立 native lane，不能重新落入旧扫描器。
- 删除 main 准备阶段的 loadGraph inputs/sources/inputVersions、graph.verify 隐式审查说明、旧 reworkDelta、Fresh predecessor handoff、result_handoff schema/repair 拼装、依赖 artifact 自动 reader 记录及 review.independence_checked。main 的自身消息/原始需求、提案摘要、能力、RSI/暂停恢复、wake、决策与自己会话继续保留；旧 context 账本的自身 fresh/continue 尚未全面更名/移除。
- model-selection 删除旧 implementerModels 的 GraphPlan containers/leaves/dependencies 遍历及 isReviewer/context 推断。此模块的唯一生产入口是外部 main 的 pickModel；原生 graph reviewer 的模型独立性仍由 kernel-graph-lane 的实际 provider 历史约束，不能用 main 的旧图遍历补造历史。
- 删除 main Execution 内重复的 graph declaredDeliverable/publish/withDeliverableArtifact、dependsOn 集成锁、agent 结果隐式代码合并和旧 reconciliation integrate。原生 node-executor/Git/module acceptance 的真实交付路径保留。main 仍通过明确的图管理与 workspace 工具管理工作，不能由结束一轮聊天隐式交付 graph。
- 定向 6 文件 / 75 项通过，日志 /tmp/graph-main-dag-retirement-targeted.log，涵盖真实 main 对话/提案、队列、能力与 RSI 恢复。进一步清理后主/Web TypeScript 再通过；第137轮完整门禁进行中。diff check 通过。仍需退役 OperationLifecycle 的旧 result_handoff/路由/验收/返工分支、GraphPlan/types/read views，以及完整 spec/default app 交付；未提交。


### main 生命周期停止隐式旧图路由、返工与验收（2026-10-09）

- gate137 完整通过：272 文件 / 1862 项，183.64 秒；TypeScript/lint/baseline/evidence 全过，日志 /tmp/graph-v2-full-check-137.log。main Execution/model-selection 的旧 DAG 调度及上下文/Git/产物结算分支退役已通过完整负载。
- 将原 OperationLifecycle 的旧 graph.verify 三轮停滞夹具改成外部 main 普通结构化 review 内容的主边界反例。修复前 lifecycle 因 output.kind=verification/outcome=rework 进入 handleRework → backEdges → loadGraph，main 没有旧 graph revision 导致 Cannot read properties of undefined (reading spec)；/tmp/graph-main-implicit-rework-red.log。不是运行失败重试，而是普通业务内容被隐式当控制指令。
- 删除 OperationLifecycle 的 resolveRouteCase/backEdges/routeSourceOf、handleRework 三轮停滞与节点重激活、clearStaleHandoffRejections、settleResultHandoff/结果修复控制、旧 graph evidence 生成/验证/落账与 route 返工分支；删除旧 answer 的 rework/stalled 跨节点 reactivate。原生 graph 问题答复仍在独立 kernel 入口处理，不能借 main lifecycle 重新计算旧依赖。
- main 普通结果仍按 outcome 结算、保留原 output、用量/未知 usage/预算/瞬时错误重试/排队/恢复；不按其业务内容自动创建循环、验收证据或停滞问题。反例修复后 succeeded，原 stall_count=2 未变，零 open questions。图的返工和审查通过显式原生模块/接口表达。
- 5 文件 / 69 项定向通过，含 main lifecycle、真实 main conversation/planning、HTTP pause 与真实 Git final acceptance；主/Web TypeScript、diff check 通过。/tmp/graph-main-lifecycle-retirement-targeted.log、/tmp/graph-main-lifecycle-retirement-types.log。gate138 已启动，尚未宣称完整通过。
- legacy-routing.ts 已没有生产入口，但仍有旧单元测试引用，尚未删文件；router-action/briefing、GraphPlan/types/read projections、旧 main context SQL 等待继续退役；完整 spec/default app 未完成，未提交。

共享旧工具的现有回归：tests/m3/agent-tools.test.ts 将 worker raw host 目录中 submit_result 的正向断言改为禁止该退休工具，公开工具目录是该声明的实际边界；/tmp/graph-old-submit-tool-red.log 修改前失败证明旧工具仍可见。原生 submit 的执行主边界是 node-submit-bridge/native-repair-freeze/simple-tier 的实际 Pi、协议与投递，无需重造旧回调接口。只更新旧测试注释，不减少其 native submit 合同。

旧 prompt 收尾：runtime/worker.md 仍是可编辑的公共 prompt 槽位，默认文案改为原生 submit。历史 submit_result 文案仅作为完整字符串的迁移匹配键保留；ensure 只替换未改过的内置默认，用户自定义文本与 reset 默认不覆盖。Conversation 移除没有原生生产来源的 predecessors 展示；具名输入输出与实际节点聊天保留。

gate149 失败定位：app-shell-ux 的草稿抽屉行为用例仍断言旧静态「传递的 handoff」标题；原生草稿没有 predecessors 数据生产者，该标题不能证明实际交接。保留此用例全部抽屉/聊天/版本窗口独立合同，以实际具名输入 job、输出 result 与 data 协议替代旧标题断言。不是删除 UI 测试或弱化真实投递检查。

边详情补齐测试作者审计：扩展 ui-flow 已有真实 provider/Pi submit/operation 检查/浏览器主流程，不新增私有查询夹具；保护 §10 来源执行及接收处理状态，当前投影只显示 accepted/value 会失败。原覆盖没有这两个字段，HTTP 与可见 DOM 同一路径核验。不会增加仅供测试的生产接口；模块 processed 与 operation succeeded 明确区分。

gate151 graphs 重启合同收尾：原投影无动态接收字段，整对象相等可证明全部旧字段不可变；新增 receiver 后排队任务实际完成必然 queued→done。扩展该原有实际重启/Pi/精确产物合同分别断言 queued/done，仅从严格对象比较排除 receiver，其余所有投递字段、来源执行与value继续相等，未删除用例或制造静态接收状态。

产物链接作者审计：扩展同一 ui-flow owner，真实节点 artifact_publish 再 submit 含 artifactId/version/digest 的嵌套对象；从边详情点击精确版本链接并读取实际发布字节。现有产物页面测试只覆盖页面自身，不能证明投递引用可发现/链接。修改前没有link应失败；不把任意字符串猜成ID，不注入已发布receipt，不新增仅测试接口。

边历史作者审计：kernel-explain原有历史owner通过正式submit产生25次投递，证明20条页+5条页无重复/丢失，以及大value不出现在摘要；ui-flow原有真实Pi/browser流程提交大value，概览响应不含marker，点击明确读取后完整值与产物链接出现。风险分别为数据库无限读取/响应泄漏/游标丢记录以及lazy UI未真正调用读取路径。无测试专用生产seam，HTTP精确投递读取是正式按需接口。

模块分页作者审计：继续扩展现有ui-flow复杂图真实each路由25条history，不新造数据或额外测试文件；末条大输入经正式路由进入输入账本与transition，概览不能带尾部marker，UI判断20+5分页、明确读取末条完整payload与当前完整输入。原owner已证明路由+边分页，不覆盖module无限读取与大状态通道，所以追加相应HTTP/DOM断言。

gate155 HTTP layout owner收尾：原m5/graph单例在概览中断言完整transition，新的spec lazy入口从概览省略历史因此失败；原真实路由输出/嵌套父子/回边/状态更新不移动布局合同保留。概览断言transitions=[]，另经正式模块HTTP历史接口严格验证实际passed输出，未删除判断验证或测试数量。

动态布局作者审计：扩展m5/graph既有真实HTTP/Pi/嵌套子图owner，执行结束后局部patch新增连接节点，旧节点/组完整rect严格不变；并发读取一致；显式relayout允许重排；删除空闲节点不挤压旧位置；实际关闭并重开runtime后HTTP布局保持。现有状态不移动测试不覆盖结构变化或重启锚点，新增断言针对全图重新ELK与仅内存缓存的真实失败，不新增测试专用入口。

增量布局追加作者审计：既有m5真实HTTP owner扩展到嵌套新增成员，独立保护容器增长后子节点仍被包含、原成员保持锚点、所有边绕开实际节点；顶层新增的合同无法覆盖层级递归的增长与碰撞。既有ui-flow复杂图owner追加真实“重新布局”按钮的HTTP操作与队列/路由账本保持，保护按钮接线和无执行副作用，非重复坐标算法测试。无测试专用生产接口、无新增case。

打包真实Pi probe发现新边界：project root接受普通符号链接路径，但residentLauncher在read/write授权中canonicalize后，cwd仍传入原别名，底层pinned grant正确拒绝，0个模型请求、3次尝试全失败。作者审计：在既有m5真实HTTP/Pi owner通过真实项目symlink覆盖这个受理后不能运行的合同，原执行/布局合同全保留；不同于低层拒绝不规范授权的安全合同。修复应在可信宿主捕获canonical workspace并用于cwd/read/write，保留低层canonicalGrant及路径替换防护，不放宽权限。无新测试case/专用生产注入。

### 节点工作位置与权限声明：作者审计（2026-10-09）

- 当前正式NodeDefinition不接受workspace/access；host自动分配工作副本，session只按recipe/globalaccess缓存；无法声明节点自己的cwd/访问策略，也无实际环境快照。需要复用现有工作副本与AccessPolicy，不新增调度机制。
- 扩展既有native-repair-freeze真实Pi/HTTP owner：两个真实子目录含不同文件，第一次执行明确standard，模型同时读取当前目录文件与目录外文件；供应商首次响应时main修改任务/配方/workspace/access，补交仍读旧环境，下一执行切换目录/full策略，保留同一instance/session/预算。直接工具结果与供应商请求保护冻结/重新绑定/权限，不用声明字段代替执行证据。可信回归：parse不接受字段、session缓存未包含环境、host按最新revision运行旧execution、cwd未改变、策略只写prompt未进入实际tools。现有任务/配方冻结合同无法证明cwd/权限，故在同一owner加真实访问。无新增case、无专用生产注入。

- 追加独立边界证明：同一真实Pi owner在权限超宿主上限、目录缺失、目录symlink越界、未准备Git却显式要求worktree时，检查队列保留、节点暂停、无provider调用/无自动重试/无预算占位；schema owner拒绝不合法路径与权限字段。m4既有parallel native Git owner把一个worker的cwd明确设到私有worktree子目录，仍提交/发布稳定代码版本/独立审查/最终集成，另一个worker保持默认工作副本，保护worktree模式实际生效；UI-flow已有browser owner检查实际工作目录/权限快照的显示，属于HTTP→浏览器投影合同。无新增case或测试专用生产API。


工具调用汇总作者审计：继续扩展现有 ui-flow 实际 artifact_publish + submit 的 HTTP/browser owner，节点概览即使聊天记录分页 limit=1 仍应显示2次调用；native-repair-freeze owner覆盖含拒绝 read 的第一次3次调用及下一执行累计6次。可信回归为从当前可见页统计、把失败调用漏掉、下一执行清零或将result计作第二次call。当前无总数，原能力调用/聊天条目不保护独立汇总字段。按执行ID/工具调用ID从真实call事件去重，SQL只读取汇总，不新增测试注入或case。

工具累计边界校正：供应商可在后续响应复用call ID，实际Pi仍再次执行；因此不能按execution+provider ID去重实际start事件。扩展同一browser owner让artifact_publish与随后submit使用同一个provider ID，仍应计2次；不增加调用/测试数量。直接统计已有call条目避免维护第二套计数身份。


模型分层作者审计：扩展 m3/models 已有真实Pi fallback owner，让目录同时含low/high/highest，以frontier配方选择highest、small配方选择low、旧high配方仍选择high，并检查真实provider模型及实例身份；保护新增别名进入实际选模而非只展示标签。m3/agent-tools 已有真实能力库 owner使用frontier筛选旧high审查配方，保护main发现入口。settings-ui已有实际保存 owner选frontier并从HTTP确认值与tier；原旧high配置的其他合同保留。无新case或测试专用生产seam。small/medium/frontier是新的目录分组；low/high/highest保留为历史精确选择，禁止将旧high自动扩成highest。

模型分层追加独立边界：扩展recipe-compile既有公开Catalog.saveAgentCombination owner，保存frontier并核对实际发布定义，保护配方文件parser→编译的链路；settings真实browser owner追加frontier/small筛选，不改变默认模型顺序。模型tier是只读派生视图，保存文档去除它；不建立独立目录或第二套配置。

定向负载发现settings既有编辑账户测试在点击后立即inputValue读取初始默认opencode-go；provider-setup在编辑前就存在，waitFor不能证明字段已更新。保留local与endpoint严格预期，改为等待实际字段达到期望，不增加sleep。最终全量并行门禁仍需验证；不宣称修改前隔离已复现。

分层偏好入口作者审计：同一m3/models实际Pi owner在默认frontier/旧high验证后设置既有models.preferences.frontier，再新建frontier graph；真实请求必须采用显式偏好，不能继续按等级默认选择。当前原生车道未接入现有preferences，主会话已使用；这是模型配置基础设施的真实遗漏，复用同一selectModel并接入live getter，不增加新配置。


### 模型分层门禁期间的旧 SDK 残留只读核对（2026-10-09）

- types.ts 的 Proposal 仍强制 nodes 并允许 containers/loops/可选definition；NativeProposal 是唯一实际受理格式。task-runtime/proposal/execution/graph-acceptance 的读取仍以旧 Proposal 强制断言；并非合法旧执行入口，validateProposal 明确拒绝旧字段，但对SDK使用者仍暴露错误类型。
- ContainerSpec/LoopSpec 在生产中仅用于旧 Proposal 和已无条件拒绝的 supervisor.revise 签名；应删除旧定义与revise入口，而非永久保留退休别名。所有真实草稿读写应统一 NativeProposal；动态更改使用graphPatch。负向旧输入验证应按unknown构造再验证，不恢复旧正式类型。
- NodeSpec 是外部main基础设施还在使用的内部记录；dependsOn/container/routes/when/optional/verifier/replaces 已无生产执行读者（task视图optional:false是原生卡片旧投影，并非NodeSpec reader）。删除这些声明需先核对全部测试和存储用法；不能把main身份、会话与预算基础设施一并删掉。
- graph-presentation.ts 用节点ID匹配human的判断早于kind=agent，可能把human命名的原生agent误画成人工验收；应基于正式对象身份，使用真实HTTP/UI owner证明，不删除人工验收模块的能力。
- App/Conversation 的静态类型与草稿详情仍残留dependsOn和“依赖”行；正式具名输入/输出/边才是定义权威。layout/GraphCanvas的containers是子graph几何投影，不能仅凭同名误删；模块规则when同理不能按旧DAG字段误删。
- verification.ts 现无生产行为调用，仅types.ts VerifierConfig与tests/fixtures/review-gate.ts类型依赖；正式check/review/final-acceptance已分别在原生模块/Git执行合同验证，退役旧类型不得降低这些能力。

旧SDK草稿类型退役作者审计：删除Proposal/ContainerSpec/LoopSpec及唯一退休revise方法；生产读写统一NativeProposal，旧格式negative经unknown断言进入真实受理校验并仍拒绝。m7/production原真实Git+Pi交付owner将退休revise调用改为不存在的公开入口断言，其全部nativepatch/acceptance/delivery合同保留；这独立保护公开SDK目录，不保留无生产调用的旧签名。m1/task-runtime与confirm-graph保留全部旧格式拒绝和零创建证明，不能用删负向用例替代退役。无新case或test seam。


草稿界面追加只读证据：Conversation.ProposalDetail仍声明nodes必需/definition可选，并在节点计数中保留旧nodes fallback；原生HTTP只产生definition。DraftGraph仍声明contextMode fork并显示缺失状态为Fresh，nativeGraphStructure从未产生contextMode；实际草稿没有会话记录，此标记不能证明运行上下文。已有app-shell-ux断言Fresh，只钉默认文案，需在保留节点详情/配方/指令/具名接口合同前提下更新为正式“独立会话”职责提示，不凭未运行记录猜已Fresh。两个依赖行显示空占位，与协议接口并列混淆。计划删除旧类型/节点fallback/依赖行/上下文猜测，保留子graph容器几何与原生模块。

原生草稿UI作者审计：扩展已有app-shell-ux实际HTTP/browser草稿owner，未运行节点显示独立会话职责、实际任务和具名接口，不再显示未生产的Fresh/继承事实/依赖行；原窗口/能力/指令/配方合同全保留。ui-flow已有第二项目owner将节点命名human-worker，真实页面必须按agent渲染，保护节点ID不能覆盖正式kind；原隔离/reload合同保留。原graphNodeVisualKind的human名字heuristic可直接复现，修复由正式kind优先判定，无新case或test seam。


旧NodeSpec与verifier残留删除审计：src/core/types.ts中dependsOn/container/routes/when/optional/verifier/replaces已无生产属性读者；NodeSpec仍服务外部main身份与operation基础设施，保留该实际记录。verification.ts的公开类型/函数无生产行为调用，仅NodeSpec.verifier与无人导入的tests/fixtures/review-gate.ts相互支撑；夹具所有exports在全src/tests/scripts/examples范围无外部引用，删除不影响测试case。原生替代的行为owner为tests/m4/acceptance、m8/graph-final-acceptance/kernel-git-integration以及review-policy模块真实用例；保留并定向验证，不能把删旧文件等同于减少验收要求。风险为残余typed调用，通过全主/Web TypeScript及全量门禁核查，无新增test seam。

NodeSpec.optional核对纠正：类型检查发现operation-lifecycle使用变量nodeSpec读取该字段（此前只搜spec遗漏），但现生产operation仅外部main，创建main从不声明optional。删除optional分支同时保留main失败重试/问题处理与skipped拒绝，不把master任务转成允许跳过。既有operation-lifecycle真实owner定向验证，不扩大到原生graph queue skip语义。


全spec剩余范围只读核对：§3要求大型value用内容引用存储。当前kernel_submissions.outputs/kernel_deliveries.value/module输入与transition/queue payload均TEXT内嵌JSON，SQLite查询CASE做lazy投影但并非内容引用存储，因此不能把已有边/module分页当该项完成。需要统一不可变JSON内容存储与正式读取，保持submit/direct/module整次事务、重放、精准版本/协议、queue取值与历史查看不变，并验证大value真正只存一次引用及崩溃恢复；不能仅限制value大小以缩小目标。§10子graph折叠现有representative保留跨组连接及group Handle，但points清空后使用新走线、group未显示公开接口名，这部分需实际browser proof核对是否完整满足，不能只凭函数存在认可。node_entries日志当前按页读取完整text/data并SSE node.entry附text，完整大日志lazy范围尚未验收。


大型 value 存储作者审计（gate165→166）：扩展既有 tests/m8/kernel-explain V6 的磁盘/history owner，保护「投递行只保存大内容引用」「模块输入复用相同不可变内容」「重启仍读取原值并保持 submit 重放去重」的独立 storage/recovery 合同。原边分页、协议、来源、完整读取与未投递/禁用区别全部保留；无新增 case 或测试专用生产 seam。新增检查在旧实现明确失败（11,018 字节 > 256），日志 /tmp/graph-content-reference-red.log。正式 KernelContent 在共享 SQLite 上存 SHA-256 内容、字节数与摘要；超过 4096 字节的 JSON 字段保存非 JSON 引用标记，用户 JSON 不能伪装内部引用；相同正文复用。投递/queue/submit 输出/模块输入与状态/transition/公开结果生产读取均还原原值；SQL 详情预览只读元数据，完整查询再读取正文。小值和原有 inline JSON 仍可读取。现存大 inline 行未批量重写，operation request/result 与 node_entries 日志尚未纳入此次存储改动，不宣称这些已完成。

gate165 真实子进程发现 KernelContent 构造器参数属性不兼容 Node strip-only（Vitest 转译掩盖），引发 39 文件/112 用例失败。已改显式字段赋值；真实 recovery/main tools/pricing owner 3 文件/8 用例通过（/tmp/graph-content-real-process-green.log），没有提高 timeout 或删除失败验收。graph.output SSE 改发 resultId 元数据，业务值由既有 graph_inspect results 主动读取，通知不内嵌大值。

gate166 完整复验 GREEN：267 文件/1823 用例，189.54 秒，failures=[]；原子提交、队列、模块规则、重放、真实 Pi/CLI/recovery/HTTP/browser/Git 合同整体保留。下轮先接 operation request/result 内容读取与精确验收证据，再补大日志 lazy；不能把本轮边与模块存储通过替代这些尚未覆盖的路径。


Operation 大内容与日志 lazy 作者审计（gate167）：
- 既有 tests/m8/graph-final-acceptance owner 是真实 Pi + Git + workspace.command + 最终验收界面，扩展真实检查的长 argv 和 stdout，保护 operation 持久请求/结果只存内容引用、公开读取还原原值、重新打开 SQLite 后已结算结果复用且 dispatch 仍只有一次。原 commit 漂移/dirty tree/独立模型审查/人工审批/最终精确 Git 交付全部保留；生产 executeModuleOperation 已有 graph runner 调用，没有新测试出口。旧实现在 requestBytes=15,290 处 RED；修复 broker 的 prepared/settled 写入与内容引用同事务，graph_inspect 和 graphAcceptance 读取解引用。定向 4 文件/12 用例 GREEN，/tmp/graph-operation-content-green.log。
- 既有 tests/m8/ui-flow 的真实 HTTP/Pi/browser owner 增加长最终回复，默认 run 不含正文末尾、node.entry 可恢复事件不内嵌全文、点击具体 entry 后显示全文、另一已存在 graph/node 拒绝借用该 entry ID。旧默认 run 正文泄漏明确 RED（/tmp/graph-lazy-log-red.log）。SQL 在查询边界截断大 text 为 512 字符，data 只保留 toolName/toolCallId/错误/peer 等显示元数据；完整内容仍在正式 node_entries 和 session，不更改模型历史。entryId 精确读取同 task/node，分页前后游标合同保留。
- 浏览器明确读取历史全文时，原 transcript pacing 把新增全文当 delta 慢慢展示；AgentNodeChat 针对已加载的历史回复重新挂载一次，直接显示已存全文，实时 streaming pacing 代码未改。背景 compact page 不覆盖已加载的全文。断言 marker 改成无 Markdown 特殊字符的 LAZYLOGEND，避免把 Markdown 去掉下划线误认为正文缺失。错误 response 遵从仓库已有 400 + code 合同；负向在已存在 agent 节点上检查精确 entry 归属，不拿不存在节点的错误充当隔离证明。最终 browser 3/3 GREEN（/tmp/graph-lazy-log-browser-green.log）；原 node-run/系统 prompt/app-shell 共 43 用例定向通过，未放宽 timeout 或删验收。

gate167 最终 267 文件 / 1823 用例 GREEN，184.94 秒，failures=[]。下一步折叠子 graph：src/server/app.ts nativeGraphStructure 目前只投影 group 输出 owner ID（非具名公开协议），GraphContainer 只画 label；运行 definition.subgraphInstances 已保存真实输入/输出映射，可由同源数据投影 public interfaces，不应从扁平边猜接口。折叠 representative 将跨组端点指向 group 并清除旧 points，当前 UI owner 仅检查隐藏/展开，不证明折叠跨组边仍可点击或 routing 格点与接口对应，需扩展实际 browser owner。


### 折叠子 graph 公开接口与嵌套聊天（gate168 GREEN）

正式容器投影公开输入、输出、协议版本与内部映射；折叠跨组边使用共享纯格点路由，保留真实端点与投递历史。嵌套折叠后的跨组聊天按可见节点汇总，详情仍显示实际发送者与接收者，不丢消息、不改变队列或模块状态。扩展原 ui-flow 真实 HTTP/Pi/browser owner，验证公开接口、16 格点直角避障、点击边读取第 25 次大值、嵌套聊天和展开状态。旧实现先因缺失公开接口和折叠消息 RED；最终 browser 3/3，相关 4 文件/43 项通过，无新增 case 或测试专用入口。完整 gate168：267 文件/1823 项 GREEN，184.95 秒；/tmp/graph-v2-full-check-168.log 与 /tmp/graph-sdk-cutover-failures168.json（failures=[]）。

CONTEXT、产品范围、架构和实施计划按已确认 spec/ADR0030 更新；历史 ADR 与报告保留为历史证据。实现计划重新对应 spec§13 八个阶段，并明确默认用户应用仍未交付。未提交；完整规格逐条审计、旧上下文类型退役及最新默认应用交付继续进行。


### 旧上下文 SDK 与当前 Agent 指南（gate169 GREEN）

删除公开 ContextRequest 与 NodeSpec.context；main resolver 仍拒绝存储中的旧 context，保留自身 fresh/continue 恢复与精确 lineage。两个异常处理点不再从退休请求声称有效事实或独立性，记录现有 main 的空 facts/none 及真实错误。原生 context negative、实际 Pi 自身历史/重绑与 main lifecycle 定向2文件33项通过；主/Web类型通过。完整 gate169：267文件1823项 GREEN，185.83秒；/tmp/graph-v2-full-check-169.log，分类 failures=[]。

逐项核对发现 Agent 当前执行/概述/产物说明仍引导旧 Fork、每轮汇合及 program node。已更新实际使用文档与 INDEX 触发条件，保留精确产物/权限/Git门和独立的大工具结果协议；新增 [规格验收对应表](issue-1-spec-acceptance-matrix.md)，将 spec 每组契约映射到生产职责和行为 owner。默认用户应用交付未验，正在构建最新包；未提交，整体目标继续。


### 默认桌面首次启动的真实数据量回归（gate170 待验）

最新 gate169 包构建及包内真实 Pi 提交通过，但默认 Electron 首次启动先在60秒、后在300秒等待窗口失败；没有把正在启动当交付成功。保留原配置与 SQLite 的快照后，定位实际18个旧 graph 的21,195条 operation 删除卡顿。诊断脚本在真实备份上逐条执行既有清理 SQL；DELETE operations 卡住。仅倒序删除不能消除保留 main 的 context_handoffs 外键扫描，继续补 context_handoffs.operation_id 与 context_resolutions.handoff_id 索引；同一整次事务、主会话保留与旧图丢弃规则不变。修复后真实备份总清理5,061ms，原两份旧数据库迁移/实际native执行 owner 3项通过。未写以时间阈值绑定机器速度的重复单元测试，保留实际规模复验与数据保留检查。

已安装 /Applications/Graph.app，持久 app-root 指向当前 graph-v2-complete 工作树；默认 userData 未重置。实际 Electron packaged=true、窗口可见、daemon 使用当前源码及原用户 state；首次截图仍是加载中，不能将该截图称为完整 UI 验收，正在追加正文加载检查。默认数据库136→118任务，18个旧graph丢弃；117个main conversation/node/instance/budget逐行保持，110个context binding保持，配置/凭据字节相同，foreign_key_check零错误。快照在 ~/.graph/cutover-backup-169。源码新索引尚需gate170完整门禁与新包复建；整体交付仍待闭合。


旧 lane 夹具删除审计：tests/fixtures/lane.ts 的 laneResult/laneUsage/scriptedLane/ScriptedLane/settle 在 src/tests/scripts/examples 中均无外部调用，仅 checks 文档残留指针；git历史06dbc58用于旧 DAG handoff，旧执行器已退役。删除该未参与测试的夹具（没有删除case），checks 改指原生 Pi/Git 夹具；正式真实 submit、队列、产物及验收 owner 全保留。NodeSpec.deliverable 无生产属性读者，移除外部main记录中的过时产物承诺；原生 NodeDefinition.deliverable 及node-deliverable/node-turn-driver 的真实文件发布职责保留。主/Web类型和完整门禁核查残余typed用法，不添加测试专用出口。

gate170完整GREEN：267文件1823项，178.99秒，baseline/evidence不变。默认Electron正文已完整加载（2739字符，无pageerror），截图不再是加载占位；实际包与原用户state/source root已核对。最后上述SDK/fixture清理需要gate171，再重建包含新迁移索引的包。


gate171 提交前完整门禁GREEN：267文件/1823项，181.64秒，baseline/evidence不变，failures=[]。已清除无调用旧lane夹具及NodeSpec旧交付声明，正式原生文件发布保留。完整当前docs链接核查零缺失，git diff --check通过。默认Electron已加载原会话正文、无pageerror；最新包复建与安装复验接续，不将未执行步骤写成已通过。


### 最终源码、包与默认入口交付（2026-10-09）

- gate171完整门禁：267文件/1823用例通过，181.64秒，TypeScript/lint/baseline/evidence通过，failures=[]。旧lane夹具删除未减少case；全规格对应见 issue-1-spec-acceptance-matrix.md。
- 最新 app:build 及 app:verify 通过（/tmp/graph-v2-app-build-171.log）。实际使用包内 runtime/node 加载bundle，真实Pi发起两次受控provider请求，submit→正式公开结果、动态patch、稳定布局/显式relayout及Web成功（/tmp/graph-v2-packaged-probe-171.log）。
- 安装 /Applications/Graph.app，核对关键内核/类型/内容/broker/Web字节与最终bundle一致；持久app-root指向当前managed checkout。无 GRAPH_APP_USER_DATA 或 GRAPH_RSI_ROOT 覆盖，实际默认Electron再次打开原会话正文2739字符，无pageerror，daemon使用原用户state与当前源码（/tmp/graph-desktop-default-171.log）。
- 原main会话/身份/预算/上下文保持，配置和凭据字节仍未变。原状态快照保留在权限0700的 ~/.graph/cutover-backup-169；仅诊断用临时SQLite副本已清理。未修改原业务项目checkout；其中原有untracked规格/历史报告不动。
- 恢复边界仍如规格：不声称任意命令副作用恰好一次、不把未知usage/资源状态当零或已完成。自定义代码需预置固定Docker镜像，不退回宿主执行。受限宿主命令硬崩溃缺少可验证清理凭证时保留未知资源占位；该限制在当前管理文档与验收对应表明确披露。
- 本次完整变更待保存为本地提交；没有推送或远程关闭Issue。
