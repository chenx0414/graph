# M2 接手说明

快照：2026-09-11 22:38（Asia/Shanghai）。使用者已授权继续 M2，随后要求本轮停止扩展实现、整理 handoff，供其他 Agent 接手。

**目标：在现有 M1 内核上完成 M2 的 G06–G08，验证、审查并提交。M2 当前为未完成的工作区改动。**

## 接手时先做

1. 在 `/Users/macmini/workspace/13-Graph` 查看 `git status --short`。已完成的 M1 基线为 `19511f7`，当前分支 `main`。M2 代码尚未提交，包含未跟踪的新文件；接手者应使用这个工作区。仅检出基线提交不会得到 M2 WIP。
2. 读取 [AGENTS.md](../../AGENTS.md)、[领域文档规则](../agents/domain.md)、[CONTEXT.md](../../CONTEXT.md)，再读取 [实施计划 G06–G08](../implementation-plan.md#m2-全部图模式与验证器)、[产品规则](../graph-mvp.md)、[架构](../architecture.md)。关于状态、实例、恢复和外部操作，参照 ADR 0003、0004、0006、0007。
3. 运行下方快照命令，核对当前失败与本说明一致。首先接通 `graph.verify` 的第一个多视角场景，再逐条增加 M2 行为。每次先复现一个公开行为的失败，再补足实现。
4. 完成条件以 G06–G08 全部出口为准。通过单个图或多视角 happy path 后，继续完成回环、图修订、主管等待、无进展介入、全部验证器及嵌套模板。

`.gitignore` 中新增的 `.agents/` 是使用者已有改动，保留并与 M2 提交分开。M0/M1 代码无需重建；M1 的完整结果见 [M1 报告](m1-results.md)。没有配置 GitHub remote；工作包仍以实施计划为依据。本轮未读取 `.env`，未调用收费模型。

## 当前验证状态

在上述时间实际运行：

| 命令 | 结果 |
| --- | --- |
| `pnpm exec vitest run tests/m1 tests/m2` | 25 项通过、1 项失败：M1 22 项全部通过；M2 graphs 3 项通过；M2 verification 1 项失败 |
| `pnpm typecheck` | 1 处错误：`src/core/verification.ts:43`，TS7053，使用 string 索引 `Proof` |
| `git diff --check` | 通过 |

M1 提交时的完整检查是 49 项通过；加入当前 M2 改动后还没有重跑 M0 全部测试。当前不是全绿状态，也没有执行 M2 最终代码审查。

验证器失败为 `tests/m2/verification.test.ts` 的首个场景：期望任务 `completed`，实际 `running`。`graph.verify` 尚未接入执行宿主，产生 adapter 不可用的阻塞。类型错误位于 artifact 匹配代码：先显式校验版本字段，再用准确的键类型比较；避免以 `any` 掩盖输入校验。

## 已落地的 M2 改动

| 文件 | 当前作用 |
| --- | --- |
| `src/core/types.ts` | NodeSpec 增加 container、routes、when、optional；Proposal 增加 containers；新增产物与依赖来源类型；Operation 记录 activationId、graphVersion、dependencySources、inputVersions；结果支持 failed/skipped/route/artifacts |
| `src/core/graph.ts`（新文件） | GraphPlan 展开容器、继承依赖与条件，校验前向依赖环和容器输出；GraphState 计算就绪、路由缺席、容器输出及依赖来源；loadGraph 从当前图版本和节点状态构建投影；createActivation 建立激活记录 |
| `src/core/store.ts` | schema 4→5 增加 route；5→6 增加 graph_revisions、activations、节点输出版本/来源、operation/evidence 的 activation 关联及 evidence.valid，并为已有 M1 状态补齐数据 |
| `src/core/proposal.ts` | 复用 GraphPlan 校验容器/依赖；校验 router case、optional 字段；验收节点必须是必需程序节点 |
| `src/core/task-runtime.ts` | 确认时创建图版本 1 和各节点初始激活；view 增加容器、graphVersion、activationId、outputVersion 及证据有效性 |
| `src/core/execution.ts` | 路由未选分支持久记为 skipped；使用容器输出派发；必需失败形成局部问题，可选失败允许缺席；保存输入来源和产物版本；结算校验当前 activation，递增 outputVersion |
| `src/core/verification.ts`（新文件、未完成） | 已有三类 verifier/report/decision 类型和多视角的初步 evaluator；其他种类仍抛 Unsupported verifier kind；尚无 config 校验函数 |
| `tests/m2/graphs.test.ts`（新文件） | 三条已通过的集成测试，见下文 |
| `tests/m2/verification.test.ts`（新文件） | 一条尚未通过的多视角集成测试 |

三个已通过场景：

- 外层/内层容器中路由只派发选中的 Agent，未选分支没有实际调用，容器没有 Agent 实例，输出交给外部程序验收。
- 必需分支失败阻塞汇合，可选分支失败允许缺席；用户重试必需分支沿用实例与额度，已成功兄弟分支只执行一次。
- Agent 产物的 activation、operation、SHA-256 和输出版本跨数据库重开保留，程序检查收到准确依赖来源，交付证据关联检查节点激活。

当前激活能力仅完成初始激活与调用/产物绑定。还没有回环重激活、失效传播或动态图修订。`activations.state` 在若干中间状态仍未全面同步；实现完整激活生命周期时需要一起核对。

## 最近停下的位置：接通验证器

并行 Agent 的实现已停止，文件可以直接接管。其结果保存在 `verification.ts` 和测试中，没有额外分支或提交需要合并。

下一步可直接完成这个垂直切片：

1. 在 NodeSpec 中增加 `verifier?: VerifierConfig` 的类型关联。当前字段仅出现在测试传入的对象里，核心类型尚未声明它。
2. 将 `graph.verify` 作为保留的内建程序动作接入 `Execution.run`，调用 `evaluateVerifier(config, context)`。它仍经过同一暂停门、程序名额、意图日志和结果结算；调用方注册的普通 adapter 不应覆盖它。
3. context 的 `dependencies`、`dependencySources` 使用本次 operation 捕获的输入；`acceptanceIds` 从已确认验收项中按 checkNode 推导。
4. 接通提案校验：verifier 只能位于指定程序动作上；校验报告节点、subject/candidate、依赖关系、维度、硬性要求、权重和重复 ID。`validateVerifierConfig` 是计划中的导出，目前尚未实现。
5. 让首个多视角测试和类型检查通过，再继续负例、对抗与评委场景。

特别处理合法的否决：evaluator 返回外层 `OperationResult.outcome='completed'`，但 `output.outcome='rework'`，且没有验收 evidence。这表示检查执行完成、工作需要返工。当前 M1 的“已完成检查必须带验收证据”守卫需要识别这个情形，将其交给回环或持久返工问题；它不能被当成通过，也不应误报为外部结果不明。

已落地的来源合约在 `types.ts`：`ArtifactInput` 使用 `id/path/digest`；`ArtifactVersion` 再附 nodeId、operationId、activationId；`DependencySource` 包含输出版本及产物版本数组。产物来源由内核根据实际结果记录赋予。评审 JSON 自带的版本引用必须与本次捕获的来源匹配。

## 继续实施的顺序与出口

### 1. 激活、回环与局部复用

在当前前向图上加入明确的回环定义或等价协议。建议将回边与前向依赖分开：前向部分继续校验为 DAG，返工对原节点创建新激活。**这是设计建议，LoopSpec 及其字段尚未落地。**

出口：原节点、实例、会话归属和累计额度不变；新激活不能与旧激活并行；重试可复用输入未变的成功兄弟分支；受影响下游和旧验收证据失效。证明旧轮次的成功不能满足新输入的汇合，重启后仍遵循该规则。现有 evidence.valid 和 inputVersions 只是存储基础，尚未实现失效传播。

### 2. 图修订和工作归属

提供受限主管图修订入口，保存 baseVersion、原因和不可覆盖版本。当前只有确认时的 graph version 1，没有 revise 方法。修订不得改变已确认验收门槛，也不能把必需失败改为可选。

出口：拒绝旧版本、非法身份绑定和环；受影响调用先停稳再应用修订，不受影响分支继续；退役节点保留历史。耗尽但未完成的工作不能通过删除、改名、替代实例或伪造新 workId 消失；重新分派保留来源，无法判断是否为同一工作时形成用户介入。已有预算问题不能靠 resume 清除。

### 3. 连续调度和主管等待

M1 `host.runReady()` 仍只等待当前批次，保留它的既有语义以兼容测试。为持续运行增加合适的宿主推进方式，使完成事件能立即释放独立后继，而无需等一个慢兄弟分支结束。主管等待 worker 结果/问答后释放名额，恢复时重新获取。

出口：全图及所有嵌套共用 10 个 Agent 名额，主管计入；程序节点使用现有独立限额。慢分支不阻塞独立后继；主管在 10 个 worker 活跃时不会成为第 11 个。问答和重启保留实例、上下文及额度。

### 4. 三轮无进展

以返工循环/工作归属记录完成轮次，一轮包含实现或修复及其后的检查与审查。不要按失败调用次数计数。

出口：有证据关闭此前阻塞问题、通过此前失败验收项才计为进展；改写文字、重复修改、跳过失败检查不计。连续三轮无进展形成持久局部问题，附争议、尝试和证据；有实质进展重置连续计数。覆盖重复报告、第二轮后重启、独立分支继续和答复范围。

### 5. 三类验证器及全部模板

- 对抗式：有效或尚未澄清的、未解决且影响验收的反例不能被正面票数压过；反驳和处理结论有证据。
- 多视角：每个必需维度都有当前且指定来源的报告并通过；建议项失败可展示但不阻塞。覆盖缺失、重复维度和旧产物引用。
- 评委式：先检查全部硬性要求，再按确认的权重和确定性平局规则排名；全部不合格返工。胜者吸收其他方案后产生新产物版本，并重新验证。

当前 jury 类型已预留 `revalidate?: { selectionNode, subjectNode }`，算法未实现。提案校验还需要证明：selectionNode 是前一评委门；吸收节点依赖选择门；最终评审依赖吸收后的产物；前后规则相同；最终验收指向复验门。仅比较评审 JSON 里的 winner 名字不足以证明这条关系。

完成流水线、扇出扇入、条件路由、主管-工人、评估-优化、对抗、多视角、评委八种可复用模板。模板生成普通节点、容器、回环数据，复用同一调度器；模板模块及示例目前尚未编写。覆盖嵌套验证器、全部候选失败和吸收后误用旧证据的场景。

## 实施约束和最终交付

- 继续使用 `.agents/skills/implement/SKILL.md`、`tdd` 和 `codebase-design`。测试入口已沿用此前确认的 Task Runtime interface；通过用户句柄、主管提案和可信宿主观察结果，使用真实临时 SQLite/进程及 scripted 外部动作。
- 一次推进一个失败场景；单文件测试和类型检查随相关改动运行。全部 M2 行为落地后运行 `pnpm check`，并复验实际进程恢复。已有 M1 测试保留原行为约束。
- M2 使用 scripted adapter 验证机制。生产 Pi/模型目录、自动 Git 集成和 Web 分别在 M3–M5；它们不是当前阻塞。
- 多 Agent 可并行负责验证器与模板，但 `types.ts/store.ts/graph.ts/execution.ts/task-runtime.ts` 应由一个集成负责人协调，先约定类型和文件归属。
- 最终更新 README、架构进度和实施计划，新增 M2 结果报告；用 `code-review` 分别审查 Standards 与 Spec，基线为 `19511f7`，修复发现后提交当前分支。

完成时交付：G06–G08 出口逐项证据、全部八种模式可运行案例、恢复与并发/额度回归、两轴审查结论和本地提交。当前 handoff 只记录交接点，不代表这些出口已经完成。
