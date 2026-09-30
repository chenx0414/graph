# 复杂档 v40：三车道执行计划

**本文件是 planner 节点（`plans/plan.md`）的交付物，由 plan-reviewer 审。**

---

## 0. 一句话说清这轮要交付什么

任务 `4c251059` 自己这张图**就是**复杂档 v40 的范例（proposal 已被运行时接受，节点正在跑）。
所以这轮的交付不是「再画一张图」，而是**把 v40 这张图在仓库里落成三样可复核的东西**：

1. 一份**可执行的形状**（E2E 真跑运行时，钉住 v40 与旧形状不同的那几条箭头）；
2. 一份**可照抄的文档**（`docs/design-graph-examples.md` 里 validator 接受的 v40 JSON + 规则）；
3. 一份**机制对照**（每一句需求 → 图里哪个字段 → 运行时哪一行强制 → 哪个测试钉住）。

三条互不重叠、可以真并行；最后由 synth 收三份评审汇成 `summaries/synthesis.md`。

---

## 1. 已核实的事实（写计划前先查过，plan-reviewer 可按此复核）

| 事实 | 证据 |
|---|---|
| `when: {node, case}` 是受支持的节点门：它给节点加一条对条件节点的依赖，并要求该 case 是路由器 `routes` 里声明过的分支 | `src/core/graph.ts:33-45` |
| 一个路由器同一个 case 挂**多条**回边会**一起**触发：`routed` 是 `filter`（不是 `find`），按 `from + case` 取全部 loop | `src/core/operation-lifecycle.ts:1114-1116` |
| 批量返工真的会重跑全部目标：`reactivate(routed.map(loop => loop.to))` + 事件 `graph.rework { from, to: [...] }` | `src/core/operation-lifecycle.ts:1281-1289` |
| agent 节点可以当路由器：判据是 `kind === 'agent' && nodeSpec.routes?.length` | `src/core/operation-lifecycle.ts:1118` |
| `review_human_check` 工具已存在（主 Agent 先审证据、用户自己点通过） | `src/runtime/agent-tool-definitions.ts:261`、`src/runtime/agent-tools.ts:438` |
| 文档里**每一个含 `"nodes"` 的 ```json 代码块**都会被喂给产品自己的 `validateProposal`，被拒即测试红 | `tests/console/design-examples.test.ts:18-45` |
| 仓库已有复杂档 E2E，但它测的是**另一种形状**（1 个 worker + 2 个 reviewer + `graph.verify` 的 `Pass?`），**没有**测 v40 的三个新东西 | `tests/console/complex-tier-shape.test.ts`（b876e08） |
| 跑真实任务图的测试有现成夹具与三个已知坑（`user.begin` 需要已知项目；worker 结果必须合 `result_handoff@1`；节点结算异步要用 `settle(...)` 轮询） | `tests/fixtures/lane.ts` 文件头 |
| 提交/推送前必须 `node --run check`；在 Graph 工作树里跑它要先 `cp -al <主仓>/node_modules <工作树>/node_modules`（不要手工软链） | `docs/agents/checks.md` |

### v40 与已发布形状的差异（本轮真正的新东西）

| 维度 | 已发布（b876e08） | v40（本轮） |
|---|---|---|
| 执行者 | 1 个 worker | 3 个 worker，一一对应 3 个评审 |
| 仲裁节点 | `Pass?`（program，`graph.verify` + `multiview`） | `synth`（**agent** 路由器，`synthesizer@1`，自己写汇总、自判 pass/fail） |
| 计划与执行的关系 | 计划评审是**并列**的第二条回路 | 计划评审**放行后才开工**（`when: {node:'plan-reviewer', case:'accept'}`） |
| 返工 | 一条回边只打回 worker | `fail` 时**三条**回边一起返工（整批重做，不按名单） |
| 验收 | 绑在判定节点上 | 只绑 `deliver`（`graph.human_check`），机械门与主 Agent 验收不重复 |

---

## 2. 三条车道（互斥文件，可真并行）

### 车道 1 — worker-1：可执行的 v40 形状（先写失败模式，再写用例）

**独占文件**：`tests/console/complex-tier-v40.test.ts`、`deliverables/v40-shape-e2e.md`

**目标**：把 v40 的 proposal 规格原样喂给真实运行时（`TaskStore` + `openTaskRuntime` + `tests/fixtures/lane.ts` 的脚本化车道），逐条钉住上面表格里 v40 那四行差异。

**先写失败模式（写代码前把这四条落到用例文件头的注释里）**：

| # | 失败模式 | 用例断言 | 阴性对照（证明用例不是套套逻辑） |
|---|---|---|---|
| FM1 | 计划门形同虚设：plan-reviewer 判 `replan` 后，三个 worker 仍被派发 | replan 轮次里 `briefings` 中不含任何 `worker-N`；planner 被重新激活且只被激活 | 把 worker 规格里的 `when` 字段删掉，同一断言必须**失败** |
| FM2 | synth 的 `fail` 落进死写法：路由没生效或被 `invalid_result` 挡下 | 事件流出现 `graph.rework { from: 'synth', to: ['worker-1','worker-2','worker-3'] }`，三个 worker 的 `briefings` 各自 +1 | 把 case 从 `'fail'` 改成未声明的 `'nope'`，必须被拒（`Router must return a declared case`） |
| FM3 | 批量返工退化成单点返工：只重跑被判不合格的那一条 | 同上 `to` 数组恰好三条、顺序稳定 | 只留一条 `loops` 条目，断言必须失败 |
| FM4 | 人工验收门被绕过：synth 判 fail 后 `deliver` 仍 ready/被派发 | fail 轮次后 `deliver` 的派发次数为 0；只有 synth 判 pass 之后才出现一次 | 把 acceptance 的 `checkNode` 从 `deliver` 摘掉，验收项不再成立（用例会红） |

**步骤**

1. 照 `tests/console/complex-tier-shape.test.ts` 的骨架搭夹具：`mkdtemp` 工作副本、`projects: [{ id, root }]`、`user.begin` 提交 v40 规格。
2. 用 `tests/fixtures/lane.ts` 的脚本化车道替换真实模型：planner / plan-reviewer / worker-1..3 / review-1..3 / synth 各自返回合规的 `result_handoff@1`；`plan-reviewer` 与 `synth` 按用例给定的 `route` 序列返回分支。
3. **先只写 FM1**，跑它，确认它**因为 worker 真的被派发而红**（不是因为别的错）；再补 FM2/FM3/FM4，同样逐个先红后绿。
4. 每条断言都配上面那一列阴性对照，全部保留在同一个用例文件里。
5. 用 `settle(...)` 轮询结算；不要用固定 sleep。

**验证命令**

```sh
cp -al "<主仓>/node_modules" node_modules        # 仅当本车道工作树还没有 node_modules
node --run typecheck && node --run lint
node --run test -- tests/console/complex-tier-v40.test.ts     # 目标用例
node --run check                                              # 收尾一次，exit 0
```

**完成判据**：`node --run check` exit 0；四条 FM 各自有「红→绿」两段记录；阴性对照全在文件里且注释说明了它们各自防住哪种退化。

**明确不做**：不改 `src/**`。若 FM 撞出真实运行时缺陷（断言红了且原因不在用例写法），**不要自行改 src**——把红测试、最小定位（文件:行）、修法建议写进报告，由 synth 判 fail 触发返工或由主 Agent 决定是否扩大范围。

---

### 车道 2 — worker-2：可照抄的文档（复杂档章节改写为 v40）

**独占文件**：`docs/design-graph-examples.md`、`deliverables/v40-doc-notes.md`

**目标**：让 main agent 照着这一节就能画出 v40 这张图，而且**这段 JSON 一定能被 validator 接受**。

**步骤**

1. 在 `docs/design-graph-examples.md` 的复杂档一节里，把「完整初稿」换成 **v40 的 JSON**（照本任务 proposal 的形状：planner / plan-reviewer(routes accept|replan) / worker-1..3(各自 `when:{node:'plan-reviewer',case:'accept'}`) / review-1..3 / synth(agent 路由器，`route.declared: null`) / deliver(`graph.human_check`)；`loops` 四条：`plan-reviewer--replan-->planner` 与 `synth--fail-->worker-1/2/3`；`acceptance` 只绑 `deliver`）。
2. 加一张「**和 `graph.verify` 形状差在哪**」的表（就是本文件 §1 那张的精简版），点明：**多个回边打同一个 case 就是批量返工**；`when` 才是「计划放行才开工」；验收只挂人工门时，主 Agent 的 `review_human_check` 是唯一的前置审查。
3. 硬规则一节补三条（每条都要有一句「不这么写会怎样」）：
   - agent 路由器自判分支要写 `input.route.declared: null`，写死等于固定路由；
   - 跨 agent 的边必须在 `context.predecessors` 声明 `mode`；
   - `when` 引用的 case 必须是那个路由器 `routes` 里声明过的，否则整个提案被拒。
4. **保留**旧的 `graph.verify` 写法一小段并注明适用场景（多视角 + 一个机械判定节点），不要删——那是另一种合法形状。
5. 同步更新文档开头的档位一句话说明（如有需要），但**不要**动简单档与中等档两节。

**验证命令**

```sh
node --run test -- tests/console/design-examples.test.ts     # 每个 JSON 块都要被 validateProposal 接受
node --run typecheck && node --run lint
node --run check                                              # 收尾一次，exit 0
```

**完成判据**：`design-examples.test.ts` 全绿（这等于「新 JSON 被产品自己的 validator 接受」）；文档里每条机制说法都能指回 §1 表中的证据或车道 3 的对照件；`git diff --stat` 显示只动了这一个文档。

**明确不做**：不改测试文件；不删 `tests/console/complex-tier-shape.test.ts`（它是旧形状的对照，别人的车道文件）；不改 `package.json` 与 `docs/architecture.md`。

---

### 车道 3 — worker-3：机制对照与证据表（让文档的每句话都可核）

**独占文件**：`notes/complex-tier-v40-mechanisms.md`、`deliverables/v40-mechanisms-report.md`

**目标**：一张表，把**使用者的需求原文**逐句映射到「图里的字段 → 运行时强制它的代码位置 → 哪个测试钉住它」，并诚实标出**哪些箭头目前还没有独立证据**。

**步骤**

1. 逐句拆需求（planner 出计划 / 审不过返工 / 放行才分发 / 三个 worker 各一成果各一评审 / synth 收齐三评审写汇总自判 / fail 三条回边全部返工 / 通过后人工验收先主 Agent 审证据 / 全节点 space-bunny-free），每句一行：

   | 需求原句 | 图里的字段 | 运行时强制点 | 钉住它的测试 | 证据强度 |
   |---|---|---|---|---|

2. 「证据强度」只用三档：**实测**（有绿测试）/ **静态**（只有代码路径，未有测试）/ **未覆盖**（没有强制点，或强制点与需求不符）。**不许把「静态」写成「实测」**。
3. 专门用一节写 **v40 相对旧形状新引入的三个机制点**及各自的坑：
   - `when` 门加的是依赖不是阻断（`src/core/graph.ts:33-45`）；
   - 同 `from` 同 `case` 的多条 loop 是**同时**触发的（`operation-lifecycle.ts:1114` 的 `filter`）；
   - 验收只绑 `graph.human_check` 时，主 Agent 的 `review_human_check` 是唯一的前置审查（`agent-tool-definitions.ts:261`）。
4. 结尾给「**本次交付之后仍然未覆盖的**」清单，每条写清楚补它需要哪个测试。
5. 报告 `deliverables/v40-mechanisms-report.md`：表格摘要 + 未覆盖清单 + 本车道跑过的命令与 exit code。

**验证命令**

```sh
node --run typecheck && node --run lint
node --run check                                              # 收尾一次，exit 0
```

**完成判据**：表里每一行的「运行时强制点」都能在仓库里 grep 到；「钉住它的测试」列若写「无」，必须与第 4 节的未覆盖清单一致（两处对不上就是缺陷）；全表零处把静态证据写成实测。

**明确不做**：不改任何 `src/**` 或 `tests/**`；不改文档（车道 2 的文件）。

---

## 3. 三条车道共享的约定

- **仓库规则**：改代码前先读 `docs/architecture.md`、`docs/implementation-plan.md`、`docs/graph-mvp.md`；提交前必须 `node --run check` 绿（`docs/agents/checks.md`）。
- **测试纪律**（R22/R24）：先写会失败的用例，看它**因为正确的原因**失败，再写实现/夹具；一车道只跑一次全量 `check`，其余用定向 vitest。
- **测试层级**（R27）：优先 E2E/黑盒，每条断言都从公开行为（事件流、派发记录、节点状态）看，**不断言私有变量或内部函数**；阴性对照必须留在文件里。
- **隔离**：每条车道只许动自己那两三个文件。碰到别人的文件就写进报告，不要替对方改。
- **工作树依赖**：本车道工作树若没有 `node_modules`，先 `cp -al "<主仓>/node_modules" node_modules`（硬链接），**不要手工软链**。
- **证据**：`node --run check` 的 exit code 与 `Test Files` / `Tests` 计数原文贴进自己的报告；失败就贴失败输出，不要只写一句「有红」。
- **截图类证据**：本轮不更新 `docs/planning/acceptance-evidence/`，不要跑 `GRAPH_UPDATE_EVIDENCE=1`。

## 4. 风险与预案

| 风险 | 预案 |
|---|---|
| 车道 1 撞出运行时缺陷（如 `when` 不阻断下游、批量回边只触发一条） | 车道 1 不改 src；写红测试 + 定位 + 修法建议进报告，交给 synth 判 fail 返工或主 Agent 定夺 |
| 车道 2 改文档时把 JSON 写成 validator 不接受的样子 | `design-examples.test.ts` 就是这道机械门，改完必须跑；红了就按拒绝信息改 |
| 三条车道结论互相矛盾（例如车道 2 写了机制、车道 3 说未覆盖） | synth 的职责就是把三份评审对齐；矛盾必须显式列出，不许含糊过去 |
| 全量 check 在工作树里因环境红 | 记下原始失败文件清单，证明**加自己的文件前后一致**（这是本仓已有的标准做法），不要为了变绿去改别人的测试 |

## 5. 交付物清单（synth 汇总时按这张表收）

| 车道 | 主文件 | 报告 |
|---|---|---|
| worker-1 | `tests/console/complex-tier-v40.test.ts` | `deliverables/v40-shape-e2e.md` |
| worker-2 | `docs/design-graph-examples.md` | `deliverables/v40-doc-notes.md` |
| worker-3 | `notes/complex-tier-v40-mechanisms.md` | `deliverables/v40-mechanisms-report.md` |
