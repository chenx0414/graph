# 执行内核候选 A：三个入口的持久状态机

状态：实现规划候选，2026-09-10。遵循 [首版设计](../graph-mvp.md)、[术语表](../../CONTEXT.md) 与既有 ADR；没有实现代码。本文是 Design It Twice 中“最小 interface、最高 depth”方向，与其他候选比较后再决定最终模块划分。

## 判断

建议使用 TypeScript 实现一个深 module，自己拥有正式状态、图版本、调用准入、operation journal、恢复、验收与集成规则。调用者只提交意图、读取快照、订阅变化；调用者不能操作 ready 队列、扣预算或声明某个节点已经成功。

首版采用一个独立后台进程作为唯一调度所有者，SQLite 保存正式记录，本地 Git 工作副本承载产物，Pi adapter 承载 Agent 执行。这是架构推断：首版单机、单功能任务执行、10 个活跃 Agent 的约束下，直接实现持久状态机比同时维护两套工作流状态更容易核查。本候选不引入 LangGraph 或 Rust，也不据此删除任何首版图模式。

## Interface

下列为设计用 TypeScript 示意类型，非可运行代码；省略的领域类型应有具体 schema，不能以任意 JSON 或任意脚本替代。

```typescript
interface ExecutionKernel {
  submit(command: Command): Promise<Receipt>;
  inspect(query: ReadQuery): Promise<Snapshot>;
  watch(query: StreamQuery): AsyncIterable<Change>;
}

type Command = {
  commandId: string;       // 调用方产生的幂等键
  expectedRevision?: number;
  intent:
    | { kind: "enqueue"; brief: ConfirmedBrief }
    | { kind: "pause"; taskId: string }
    | { kind: "resume"; taskId: string }
    | { kind: "clarify"; taskId: string; explanation: string }
    | { kind: "resolve"; interventionId: string; answer: Resolution }
    | { kind: "propose"; taskId: string; proposal: SupervisorProposal };
};

type SupervisorProposal =
  | { kind: "reviseGraph"; baseGraphVersion: number;
      reason: string; changes: GraphChange[] }
  | { kind: "selectModel"; instanceId: string; modelRef: string }
  | { kind: "approveWithinGrant"; requestId: string; grantRef: string };

type Receipt = {
  commandId: string;
  taskId?: string;
  revision: number;
  disposition: "accepted" | "alreadyAccepted";
};

type ReadQuery = {
  taskId?: string;         // 未指定时读取任务队列与活动任务摘要
  nodeId?: string;
  detail?: "summary" | "evidence" | "calls";
  page?: string;
};

type StreamQuery = { taskId?: string; after?: string };
// Snapshot 含 cursor；Change 含稳定 eventId/cursor，不承诺只投递一次。
```

`ConfirmedBrief` 包含项目位置、目标分支、已确认需求与验收项版本、检查证据要求、任务权限上限和使用者模型配置引用。讨论需求的 UI/主管先形成它；内核不把一句未确认想法立即转成编码任务。新增功能总走 enqueue，当前任务不扩大范围。排队任务保持已确认说明，真正启动时重新核查目标分支和项目状态。

认证主体由后台 transport/Agent channel 绑定，不能从 command 的字符串自报。使用者才可追加额度、扩大权限或确认降低验收要求；主管可以 propose，但没有改数据库、直接添加额度或绕过受阻节点的权力。resolve 的答案必须匹配待处理问题类型和所需主体。

三个方法不等于三个简单动作：interface 的真实复杂度还包括意图类型和领域约束。避免将所有底层“节点开始、预算预留、Git 结束”等操作塞入 public submit。Agent 结果由可信 Pi adapter 的内部通道提交，并由内核校验；普通调用者没有 `markSucceeded`。

模块构造时注入配置与依赖，后台宿主拥有启动、关闭、数据库迁移生命周期。不是每次 HTTP 请求创建内核；关闭订阅或网页不停止任务。重启后内核先进入恢复核查阶段，未核对完的 operation 不派发。

## 调用示例

```typescript
const receipt = await kernel.submit({
  commandId: requestId,
  intent: { kind: "enqueue", brief: confirmedMediaBookmarksBrief }
});

const view = await kernel.inspect({ taskId: receipt.taskId });
render(view);
for await (const change of kernel.watch({
  taskId: receipt.taskId, after: view.cursor
})) updateScreen(change);

await kernel.submit({
  commandId: pauseRequestId,
  intent: { kind: "pause", taskId }
});
// receipt 表示暂停意图已持久化；通过 snapshot/change 看 pausing → paused。
// 模型调用完成后发出的新工具调用同样被准入门阻止。
```

主管通过受限通道提出图修改；它只需提供节点、依赖、回边、容器、模板参数和变更理由，无需自行做并发计数。一个返工回边触发原实现节点的新 attempt，仍保留 instanceId、会话、worktree 和账本。

## 必须保持的不变量与顺序

| 领域 | 内核保证 |
| --- | --- |
| 身份 | Agent 节点与实例双向唯一；图版本变化不可重绑已有节点的实例。轮次和调用有独立 ID，不复用 operationId 来隐藏新调用。 |
| 图变更 | 每次变更引用期望图版本、理由和需求版本；结构及权限校验后原子提交。已运行节点不物理删除，保留历史；受影响旧结果标注有效范围。执行中的 attempt 绑定启动图版本和输入证据摘要。 |
| 预算 | 每实例默认 20,000,000 token；预留、结算与去重同事务提交。重试、恢复、换模型、回环都继承账本。耗尽工作保持阻塞，改节点名或另派实例不能移走阻塞。 |
| 反逃逸 | 图变更需声明工作来源/取代关系，已耗尽 work item 的继续执行必须引用原实例或使用者追加记录；不得借新增节点承接同一受阻工作。主管语义分类本身不是可靠证明，变更有疑义时留待使用者核对。 |
| 并发 | 全任务与全部子图共用 10 个活跃 Agent 名额，主管计入。名额从执行恢复到等待/停稳期间持有；等待依赖/回复释放。程序节点不占 Agent 名额，但另有工具/进程资源限流。 |
| 暂停 | pause 先在事务内关闭派发门；已发调用可结束，不能再发下一模型或工具调用。直到全部在途调用结束才显示 paused。无时限调用可能使 pausing 持续，不能提前宣称停稳。 |
| 恢复 | 未知副作用先核查，无可信结果时阻塞；原模型调用用量未知时先标待核对，不能用“可重试”绕过 Q27。确认用量后重发作为新 operation 继续累计。 |
| 汇合 | 按本轮所需分支 token 汇合，不能用前一轮成功误满足下一轮；成功且输入未变化的分支可复用。必需失败不得动态改可选。 |
| 审查 | 绑定具体轮次、产物/commit 和验收版本；所选审查模型不能属于该轮实现模型集合。合并或后续修改导致证据不匹配时重新检查。 |
| 人工介入 | 局部问题阻塞节点及传递依赖，独立分支继续；全任务需求/权限问题暂停全图。三轮无实质进展附有效阻塞项与验收变化证据。 |

同一实例不并行执行两个 attempt。主管在等待工人期间释放名额，回到处理结果前重新取得名额。节点等待下游审查，不等于实例销毁。

命令幂等键相同且 payload 相同返回原 receipt；同键不同 payload 报错。并发图提案用 baseGraphVersion 拒绝旧版本覆盖；暂停无需前端先读取最新图。resume 只解除暂停意图，不能清掉预算、未知操作或需求问题的独立阻塞。

## 隐藏在 seam 后的 implementation

1. **纯状态转换。** 事件驱动的 TypeScript 转换决定下一次准入、图变更合法性、分支有效性、轮次进展与介入。图遍历和模板展开为 in-process 计算，不为每种模板增加一套外部 interface。
2. **持久状态与日志。** SQLite 保存任务队列、图版本、节点/实例、attempt、证据引用、调用用量、授权、待处理问题、已接受命令和操作日志。维护当前状态与追加审计记录，在同一事务提交；无需首版就把整个系统实现为可重放一切的 event sourcing。
3. **operation journal。** 每项外部操作记录 intended → dispatched → observed / unknown → reconciled，含输入摘要、前置事实、作用对象、实例、图版本和执行宿主代次。发出副作用前先提交 intent；崩溃后只凭该记录不能断言副作用已完成，也不能断言未发生。
4. **调度所有权。** 单后台所有者 + 持久租约/代次阻止重复派发，数据库事务原子领取 operation。宿主崩溃后不能单靠租约过期就启动相同 shell；先识别并接管或结束旧进程、核查结果，再释放相应名额。代次能拒收旧写回，不能撤销已发生的系统调用。
5. **Pi 调用桥接。** 每个实例拥有独立持久会话，模型请求、工具执行、摘要/压缩等耗用均穿过准入和计量。已产生的模型工具请求可挂起，恢复后再执行，而不是丢掉请求重新问模型。流事件只是观测，只有有证据的结束才正式结算。
6. **证据与上下文。** 共享空间保存不可变版本的说明包和产物引用，按哈希/commit 验证适用范围；不强制把全部历史塞入每个工人的上下文。主管可按需展开记录。
7. **集成。** Agent 工作分支进入任务集成分支；最终门槛绑定集成 commit、目标分支旧值、验收版本和独立审查。目标分支变动先纳入并重检；最终 ref 更新必须有旧值前置条件，避免“检查后又变化”的竞态。目标分支已在人工 worktree 检出时，还需保证 index/worktree 一致，不能仅更新 ref 冒充安全合并。

SQLite 的事务只能原子覆盖 SQLite 数据，不能把 Git、网络或文件修改一并纳入事务。官方说明提供 ACID 事务保障；选择 WAL 允许读写并行，但仍只有一个 writer，同机本地文件系统才适用。[SQLite 事务](https://sqlite.org/transactional.html)、[WAL](https://sqlite.org/wal.html)

建议使用 WAL + FULL 同步、本地磁盘和短事务；任务模型执行不得持有数据库写事务。日志正文与大型产物放文件，数据库存摘要、位置与状态；文件写入也遵循临时文件、完成核查和记录协议。驱动与 SQLite 具体版本待兼容验证后锁定，不能只写“SQLite 最新版”。

Git 支持独立 worktree，ref 更新支持提供旧对象值作为前置条件；这为隔离与竞态检查提供底层能力，完整自动合并流程仍由 Graph 实现。[git-worktree](https://git-scm.com/docs/git-worktree)、[git-update-ref](https://git-scm.com/docs/git-update-ref)

## 全部模式如何落入同一内核

| 模式 | 持久表达 |
| --- | --- |
| 扇出扇入 | 一次激活生成分支集合；汇合保存分支必需性和输入版本。 |
| 主管-工人 | 主管 Agent 节点提案创建工人，等待结果释放名额，结果触发原主管继续。 |
| 流水线 | 带产物与证据引用的依赖边。 |
| 条件路由 | 受限条件表达式/固定程序 handler；未选分支明确 skipped，不与失败混淆。 |
| 评估-优化 | review round 和回边；重新激活原节点，保存进展证据与连续无进展计数。 |
| 对抗式 | 反例、证据、有效性判定与解决记录；存在有效阻塞反例即不通过。 |
| 多视角 | 固定必需维度与建议维度；全部必需维度通过才汇合。 |
| 评委式 | 先硬门槛过滤再按已定标准排名；全部失败回环，胜者吸收修改后失去旧通过证据并重新验证。 |
| 嵌套 | 子图保存输入/输出契约和容器路径；内部节点仍由全局调度器处理。 |

“程序统一判断”不意味着程序能客观判别所有语义：反例是否有效、关闭问题是否有实质证据由明确审查职责产生结构化结论；程序检查完整性、对应范围及预设规则，争议不自动视为解决。各模板需要自己的验收案例，但不增加 scheduler 分支。

## 依赖与 adapters

| 依赖类别 | 策略 | 验证方式 |
| --- | --- | --- |
| in-process：图、门槛、预算计算、模板 | 放在 module 内；不制造 graph engine port。 | 经 submit/inspect/watch 验证可观测行为。 |
| local-substitutable：SQLite | 使用临时文件真实 SQLite 作为本地替身，同样 schema/事务；不公开 SQL port。 | 重启、磁盘写入失败注入、重复命令和进程竞态。不能用纯内存字典证明崩溃恢复。 |
| local-substitutable：Git/文件 | 临时真实仓库与目录，执行同一 Git implementation。 | 制造冲突、目标分支推进、半完成操作并核查恢复结果。 |
| true external：Pi/provider | 内部 AgentExecution port 注入 production Pi adapter 与 scripted adapter。 | script 精确产生 usage 缺失、乱序/重复完成、模型切换、暂停边缘和恢复记录；另用少量真实 Pi 契约测试检验事件映射。 |
| true external：MCP/扩展调用 | 内部 operation 执行/核对 port；production 与 scripted 两个 adapter。 | 模拟“外部成功后宿主崩溃”；无核查能力的操作必须进入待处理状态。 |

Pi SDK 提供会话创建与事件订阅，本候选把它作为 Agent 执行 adapter，而非把 Pi 会话文件作为 Graph 正式状态。[Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)

最关键的前置实验是证明固定 Pi 版本能在**每次模型和工具调用之前**执行准入，包括自动连续调用、压缩和扩展触发的调用。若默认 SDK 钩子无法覆盖，不可把“回合结束”代替用户要求的调用级暂停；应在 Pi 底层调用桥接处实现可控 adapter，必要时维护小范围补丁。先完成实验再估算主体工作。

扩展具有宿主权限这一已核查事实见 [Pi 能力核查](../pi-capabilities.md)。自主安装新能力仍可保留，但运行任意扩展时仅靠 cwd 和工具白名单无法落实任务权限；需要隔离的执行进程/受限宿主及受控 I/O。该执行隔离必须是首轮可行性验证的一部分，不能留到最后才发现可绕过。

## 错误与性能契约

- `InvalidIntent`：图结构、领域 schema 或前置条件不成立，附具体原因；无部分写入。
- `RevisionConflict`：返回当前 revision，调用者重新读取并重新提案；不能自动覆盖。
- `IdempotencyConflict`：同一 commandId 携带不同内容。
- `Forbidden`：主体不具备所需权限，主管不能伪造使用者 resolve。
- `Unavailable`：持久层不可用，未确认 receipt 的命令可用相同键重试；不启动未持久化操作。
- `CursorExpired`：观测历史已压缩时要求重新 inspect，不丢正式状态。首版可先保留历史并为未来预留该错误。

模型不可用、额度耗尽、无进展与未知副作用通常表现为已持久化的 intervention，而不是 UI 请求永久 pending 或无上下文异常。命令 receipt 只确认受理，不承诺完成；操作/订阅允许重复事件，按稳定 ID 去重。

快照与订阅须支持分页、按需读取记录；百万 token 会话不能随节点摘要返回。短事务不跨网络，慢订阅者不能阻塞 scheduler。首版不承诺特定毫秒指标，验证 10 个活跃实例下暂停命令不会被模型调用占住事件循环。

## 关键失败场景

| 注入故障 | 必须从 public interface 看到的结果 |
| --- | --- |
| 预算预留后崩溃、实际请求未确认发出 | 先核查 operation；绝不既清零预留又盲目发新请求。 |
| provider 已回答，usage 写入前崩溃 | 保留 unknown 用量并暂停；核对后精确一次结算；重发不覆盖原调用。 |
| 用户暂停与工具派发竞争 | 已获得准入并发出的调用可完成；pause 持久化后不得派发后续调用。 |
| 主管等 10 个工人 | 主管等待释放；最多 10 个工人可活跃，主管醒来排队，不能变成 11 个。 |
| 部分分支成功后图追加合法依赖 | 未受影响成功结果保留；旧证据不能满足新增依赖或下一轮。 |
| 预算耗尽后主管创建“修复者 2”接替 | 拒绝绕过阻塞，要求额度追加；正常独立新工作仍可新增节点。 |
| 重启时旧终端命令仍运行 | 核查/接管在途状态，不重复运行、不虚增可用名额。 |
| 最终 Git 操作成功但数据库未写回 | 比较已记录 expected/desired ref 及工作副本状态，确认已完成后补记。 |
| 独立审查后目标 ref 被人工推进 | 前置条件失败，重新集成并验证，不能用旧证据直接重试更新。 |
| 新能力试图越过任务权限 | 受控执行阻止，产生有依据的介入，安装本身不升级权限。 |

## 里程碑与取舍

1. **可行性门槛**：锁定 Pi/运行时候选版本，证明调用级准入、用量完整性、会话恢复和能力执行隔离；未证明前不承诺可无人值守。
2. **持久垂直切片**：enqueue → 主管 → 单工人 → 程序检查 → 独立审查 → 返工/完成；真实临时 SQLite/Git，scripted Agent adapter。已有 attempt 恢复、重复 receipt 与未知副作用必须在此通过。
3. **并行与全部图模式**：全球名额、子图、版本图、全部模板与三类验证器；正常路径与故障注入同时交付。
4. **真实运行整合**：production Pi、版本能力库、权限、模型选择、费用、完整观测和最终集成门槛；验证 UI 断连与后台重启。
5. **首版双验收**：所有执行机制案例通过，再由 Graph 完成 MediaBookmarks 已确认流程并提供可核对产物；后者的具体需求确认仍属于独立功能任务。

Depth 主要来自把正确性规则集中在一个 seam：删除本 module 后，UI、主管、Pi adapter 和 Git 路径都得重新实现预算/暂停/恢复，说明它不是转发层。Locality 集中在内核的领域 schema 和准入路径，模板与 UI 不分担正式状态。

代价是内核内部较重，领域意图类型仍需理解，深度依赖严格收敛公共命令而不是追求方法数量。直接状态机还要自行维护激活/回环/图版本语义；收益是没有第二套执行状态与 Graph 规则同步。若以后需要用户可执行自定义程序节点，必须先规定 handler 与核查契约，不能把任意 callback 暴露成公共扩展点。
