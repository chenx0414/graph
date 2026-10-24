# Harness² 评估与融合方案

日期：2026-10-22。状态：评估结论已定，第一段融合已在本分支落地。

参考来源：[google-research/harness2](https://github.com/google-research/harness2)（Apache 2.0）、
论文 [arXiv:2610.14224](https://arxiv.org/abs/2610.14224)、
配套文章 *Your Agent Harness Should Repair Itself*（Opik 四层栈：Tracing → Ollie → Test Suites → Agent Sandbox）。

## 结论

**不部署 Harness² 本体，只移植它的方法内核。**

Harness² 是一套**面向基准跑分的研究框架**，不是一个可以装进 Graph 的运行时：Python 3.12 + uv、
只支持 Linux、依赖 Vertex AI，底座是 OpenCode / Codex 两套执行器，评测对象是 JobBench / LAB /
WorkBuddy-Bench 三个公开基准。它的 harness 树（system prompt、guardrails、memory、tool guidance、
subagents、skills、scripts、plugins）是给这些基准的求解器准备的文件树，不是 Graph 的 harness。

Graph 的处境恰好相反：Graph 已经有**跑多候选的能力**（一张图就是多个候选并行跑同一任务）、
有**确定性门禁**、有**预算与名额**、有**产物与项目级知识**、有**代码级自我改进闭环**。
Harness² 假设"你很难反复跑自己的 harness"，而 Graph 的产品形态就是反复跑自己的 harness。
所以 Graph 要拿的是它的**比较方法**，不是它的**跑分框架**。

Graph 真正缺的只有三件：

| Harness² 的机制 | Graph 的现状 | 判定 |
| --- | --- | --- |
| 任务级递归（Propose–Probe–Compose） | RSI 只做"改源码 → 跑门禁 → 热重载"，没有"同一任务多候选对比" | **缺** |
| 无标准答案的选择（匿名候选 + 行为对比 + 选择器） | 没有任何"比较两个候选"的机制 | **缺** |
| Harnessing 级递归（按领域沉淀经验库） | `harness-backlog` 只是摩擦点清单，没有"采纳了什么、依据是什么"的沉淀 | **缺** |
| harness 的八个可编辑部件 | prompt 库 12 个文件 + skills + 配方 + 能力包 | **已有**（脚本/插件两类缺） |
| 证据即文件（context 树，prompt 只做指路） | 节点 transcript、产物、`node_entries` 都已落盘 | **已有**，但 Agent 读不到 |
| 并行 / 顺序递归两种扩展方式 | 图内多车道并行 | **已有**（等价于并行递归） |
| 评测与成本统计 | `scripts/harness-real-eval.mjs` 等六个脚本 | **已有**（离线、脚本驱动、非闭环） |

## Harness² 的机制拆解

源码在 `harness2/core/`，关键文件：

- `recursion.py`：`run_parallel`（2k 个候选提案 → 并行跑 → k 次独立合成）与 `run_sequential`
  （k 轮嵌套精化）。每个阶段失败会**回退到当前 harness**，不丢弃已投入。
- `proposer.py`：提案 Agent 在 `context/harness/` 里直接改文件，改完由宿主校验；
  **校验失败带原文回喂重试一次**。
- `selection.py`：**匿名候选**（`assign_ids` 用任务 id + k + mode 做种子打乱，稳定可复现），
  选择器只看到匿名产物，必须回一个 `choice` 块；选择器失败则**回退到已交付的 base**，不抛错。
  整个选择过程**没有标准答案、没有 grader**。
- `library.py`：按**领域**分目录的经验库，每条经验带 `cue / lesson / evidence / confidence`，
  存**完整 harness 树**而不只是摘要；按构造检索（同领域目录只放同领域条目）。
- `context.py`：证据树落盘（task / rollouts / deliverables / harness / library / pool），
  prompt 只给一份目录清单，"证据在磁盘上，去读"，因此不受 prompt 预算截断。

一句话概括：**把"改进 harness"变成"对比同一任务在不同 harness 下的行为，再把赢家沉淀下来"。**

这条链在 Graph 里已经闭合，并且有**一次跑完的 E2E**（`tests/e2e/harness-loop.test.ts`）：
一次失败的工具调用 → 读自己的证据 → 两个 harness 的探针对比 → 按通用轴记录裁决 →
下一个任务的 system prompt 里已经在场。

## Graph 现状（与融合相关的部分）

- **可编辑 harness 面**：`~/.graph/prompts/` 下 12 个文件（`agents/main.md`、`tools/{main,worker,reviewer}.md`、
  `rules/{common,main,worker,reviewer}.md`、`runtime/{worker,node,prompt-suggestion,sediment}.md`）
  + `tools.json` + `defaults/`；另有 skills（`~/.graph/capabilities/skills/`、`<project>/.agents/skills/`）、
  Agent 配方（`~/.graph/agent-combinations.json`）、能力包（skill / mcp / extension / pi-extension / prompt）。
  拼装顺序：identity → rules → docs，宿主强制的测试策略与权限闸门不可被这些文件放宽。
- **代码级 RSI**（ADR 0026）：`apply_rsi_change` 改 Graph 自己的 checkout、跑 `node --run check`、
  提交到 `rsi/*` 分支、请求重载；`inspect_rsi_status` 读 checkout / 分支 / 待重载 / 在途 operation。
- **harness 评测脚本**：`scripts/harness-real-eval.mjs`（真 daemon + 真模型跑冻结用例）、
  `harness-eval-cases.mjs`（4 个冻结用例）、`harness-eval-context.mjs`（把 harness 上下文冻结成摘要稳定的快照）、
  `harness-eval-summary.mjs`（带权重的对比汇总）、`harness-cost.mjs`（成本账本）。
  这些是**离线性、脚本驱动**的，产物落在 `runs/`，不进产品运行时。
- **运行时事实**：节点 transcript 落 `node_entries`（含工具调用与结果）、执行与提交落
  `kernel_executions` / `kernel_submissions`、模型用量落 `kernel_provider_calls`、
  工具事件落 `events`、产物落 `artifacts`（可提升到项目作用域）。

## 为什么不能部署本体

1. **运行时前提不符**：只支持 Linux + Python 3.12 + uv + Vertex AI；Graph 的产品后端是 Go 进程
   （`graphd`），桌面端是 Electron。
2. **底座不符**：Harness² 的求解器跑在 OpenCode / Codex 上；Graph 的执行内核是 PiG，
   工具与准入闸门都由宿主掌握。
3. **对象不符**：Harness² 优化的是**基准求解器的 harness 文件树**；Graph 要优化的是**自己的 harness**，
   而且 Graph 的 harness 一半是代码（宿主、闸门、内核），一半是声明式文件。
4. **取舍相反**：Harness² 刻意**放弃标准答案**，因为它要跨基准泛化；Graph 是生产产品，
   有确定性门禁、验收与人工确认，**不该**为了"通用"放弃可验证性。
5. **规模不匹配**：Harness² 一次 sweep 要打几百次模型调用、几个小时的基准跑分；
   Graph 的每个任务预算、并发名额与用户期望都不是这个量级。

## 融合方案：Graph 原生三件套

Harness² 的跑分框架不需要移植，它的**方法**可以拆成三个 Graph 原生部件：

1. **对比式 Probe（已落地）**：同一任务的多个候选跑完后，宿主读出每个候选的**行为事实**
   （执行状态、提交了什么、调用了哪些工具、工具是否失败、花了多少 token、耗时多久、最终答复），
   算与基线的**行为差异**，并把候选**匿名化**（A / B / C…，映射稳定可复现）。
   匿名是刻意的：能看到"哪条车道产出了哪个答案"的选择者，会按车道选，而不是按答案选。
2. **无标准答案的裁决（已落地）**：对比只给事实，不给判决。选谁是 Agent 的决定，
   决定连同 **cue / lesson / evidence** 三件套写进**领域经验库**（`plans/harness-experience-<domain>`
   制品，提升到项目作用域，下一个同领域任务能找到）。
3. **经验召回（已落地）**：接一个领域时，对比结果自带该领域已采纳的经验，
   `read_harness_experience` 可单独读；下一个任务因此不是从零开始。

对应到 Harness² 的原文：三件套分别落在 `selection.py`（匿名 + 选择）、
`library.py`（经验库 + 按构造检索）、`context.py`（证据在磁盘上）。
**Probe 的"跑"由 Graph 原生的图执行承担**，不引入第二套跑分框架。

### 本次落地的具体形状

- 三个主 Agent 工具（只对 main 开放）：
  - `compare_harness_candidates`：对比一个图里同一任务的多个候选节点；
  - `record_harness_decision`：记录采纳哪个候选、以及那条经验；
  - `read_harness_experience`：读某领域已采纳的经验（不带领域则列出有哪些领域）。
- 实现：探针驱动在 `backend/internal/graph/runtime_harness_probe.go`，对比读数在
  `runtime_harness_compare.go`，经验库在 `runtime_harness_experience.go`（教训）
  与 `runtime_harness_knowledge.go`（摩擦与领域），
  工具声明在 `backend/internal/graph/runtime_agent_tool_definitions.go`，
  接线在 `backend/internal/graph/core_task_runtime.go` 与 `runtime_agent_tools.go`。
- 事实来源：`kernel_executions`（状态/耗时）、`kernel_submissions`（提交了什么）、
  `node_entries`（工具调用与结果、最终答复）、`kernel_provider_calls`（token）。
- 经验库：制品 `plans/harness-experience-<domain>`（schema `graph.harness-experience@1`），
  写用 Agent 自己的制品通道（producer 正确），读用宿主侧制品库（跨任务可见，项目边界由
  `assertScope` 把守）。
- E2E：`tests/e2e/harness-probe.test.ts`——真 `graphd` 进程、真 HTTP、两个候选节点真跑同一任务
  （`coder@1` 与 `reviewer@1` 两种 harness）、假 provider 制造行为差异，
  走完"建图 → 两候选 → 匿名对比 → 记录裁决 → 召回经验"。

### 边界

- 对比**只给事实**，不代替判断。Graph 的确定性门禁与人工验收优先于无标准答案的裁决。
- 经验库是**宿主拥有**的：只有 cue、lesson、evidence 三者齐全才收；没有证据的经验会教坏下一个任务。
- 经验库是**项目作用域**的：跨项目不共享，与"项目共享产物"的既有边界一致。
- 匿名映射在**同一个图**内稳定；跨图不承诺同一映射。

## 后续分期

- **P2：探针驱动器（已落地）**。`probe_harness` 把"同一任务 × N 个 harness 变体"做成宿主能力：
  变体 = 节点定义上的 `harness` 覆盖（对可编辑提示面的差分），宿主建图、派发、等待、产出对比。
  配套的 `NodeDefinition.harness` 让同一张图里两个节点跑同一任务、不同 harness；
  `AgentContextLibrary.WithOverlay` 让覆盖落在**会话真正读的那份库**上，
  而不是只落在记录用的快照里。
- **P3：双轴提案与接续（已落地）**。探针的每个变体带一个轴：`general`（这条改动应当对任何一类
  工作都成立）或 `specific`（只对当前领域成立）。裁决时同一条教训落在同轴的 scope 里：
  `general` 的 scope 被**每个领域**读到，`specific` 的只留在本领域。
  Harness² 的 INV/DOM 两轴在这里换了个说法：INV 不再是"一份更通用的 harness 树"，
  而是"一条每个领域都能用上的教训"。
  **接续**也落地了：采纳的教训留住它跑在什么 harness 下，探针可以以它为基线，
  于是每一轮是在上一轮的赢家上试一个改动。
- **P4：经验进上下文（已落地）**。宿主在装配主 Agent 的 system prompt 时自动注入
  一段 `Lessons earlier runs of this project learned`（生成型部件，排在 host 规则之前），
  每条一行：情况 → 做法 → 依据。注入的是**该项目声明的领域**的教训 + **通用** scope 的教训；
  领域由 `declare_harness_domain` 声明并按项目保存，宿主读回后才知道该带哪一 scope。
  这也让"通用轴"从口号变成事实：一条对任何工作都成立的经验，现在**在每个任务开工前就在场**。
- **P5：把评测脚本接进闭环（已落地）**。`harness-real-eval.mjs` 从离线脚本变成门禁的一步：
  四个冻结用例由一个**只按 harness 行事**的替身模型跑一遍，结论是各用例自己的 verify 脚本；
  工具的使用纪律（读 → 精确改 → 读回来核对）也是结论的一部分。
  门禁记下被判过的 harness 面与每个用例的判决，所以"改完 harness"有了行为上的判决，
  而回归会指名道姓地说哪个用例坏了、harness 少了哪句规则。
  `node --run check` 会跑它（`check:harness`，约 20 秒）。

## 已补的缺口：Agent 读自己的证据

RSI 身份文本要求 Agent"观察自己的轨迹、工具错误、被挡住的 operation 与检查结果"
（`backend/internal/graph/runtime_agent_context.go` 的 `DEFAULT_MAIN_RSI_IDENTITY`），
但此前**没有任何工具让 Agent 读到这些**：`events` 表、`node_entries` 与 Pi transcript
都已落盘，却没有面向 Agent 的读接口。

现在 `read_harness_evidence` 把这些事实读成一份摘要：每个节点走了多少步、哪些工具调用
失败了（以及能拿到的原因）、最后答复是什么；被挡住或失败的节点及原因；当前挂着的内部问题；
最近一次应用改动的检查结果；这次运行的请求数与 token。它只给事实，不给判决。

两条记录形状都读：图里的节点写 `node_entries`（带工具名、结果与失败原因），
会话里的主 Agent 不写 transcript，它的工具调用在 `message.tool` 事件里（带工具名与错误标记）。
这是 Harness²"证据即文件"原则在 Graph 的直接对应物。
