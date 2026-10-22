# ADR 0034：Harness² 的融合方式——移植方法内核，不部署其本体

日期：2026-10-22

## 状态

已接受。

## 背景

Harness²（[google-research/harness2](https://github.com/google-research/harness2)，Apache 2.0，
论文 arXiv:2610.14224）提出让 harness 自我改进的两层递归：任务级的
**Propose–Probe–Compose**（提出 harness 改动 → 在同一任务上探测其效果 → 从行为对比里合成更好的 harness），
以及 Harnessing 级的**经验库**（按领域沉淀采纳过的 harness 与教训）。

Graph 已有自己的 RSI（[ADR 0026](0026-main-agent-recursive-self-improvement.md)）：Main Agent 改
Graph 自己的源码 checkout、跑项目门禁、提交到 `rsi/*` 分支、请求热重载。执行者与改进者是同一个 Agent，
改动对使用者可见可审计。

问题是：Harness² 与 Graph 的 RSI 是什么关系？是可以把 Harness² 装进 Graph，还是只能借鉴？

评估结论见 [Harness² 评估与融合方案](../agent/harness2-fusion.md)。关键事实：

- Harness² 是**面向基准跑分的研究框架**：Python 3.12 + uv、只支持 Linux、依赖 Vertex AI，
  求解器跑在 OpenCode / Codex 上，评测对象是三个公开基准。它的 harness 树是给基准求解器准备的文件树。
- Graph 的产品后端是 Go 进程（`graphd`），执行内核是 PiG；它的 harness 一半是声明式文件
  （`~/.graph/prompts/` 的 12 个文件、skills、配方、能力包），一半是宿主代码。
- Harness² 刻意**放弃标准答案**，因为它要跨基准泛化；Graph 是生产产品，有确定性门禁、验收与人工确认。
- Graph 已经具备 Harness² 假设缺失的东西：一张图就是"同一任务的多个候选并行跑"，
  执行事实、产物、用量都落盘，且有 `scripts/harness-real-eval.mjs` 等离线评测设施。

Graph 真正缺的不是"再跑一遍 harness"，而是**把多个候选的结果放在一起比较**，
以及**把采纳的结果连同依据沉淀下来**。

## 决策

- **不部署 Harness² 本体，不引入 Python/uv/Vertex 依赖，不引入第二套执行底座。**
- **移植其方法内核**，并在 Graph 原生运行时里实现三件套：
  1. **对比式 Probe**：同一任务的多个候选跑完后，宿主读出每个候选的行为事实
     （执行状态、提交内容、工具调用与失败、token、耗时、最终答复），给出与基线的行为差异，
     并把候选**匿名化**（A/B/C…，同一图内映射稳定）。
  2. **无标准答案的裁决**：对比只给事实，判决留给 Agent；裁决连同 **cue / lesson / evidence**
     写进领域经验库。缺证据的经验不收——没有依据的教训会教坏下一个任务。
  3. **经验召回**：某领域已采纳的经验随对比结果一起返回，也可单独读取。
- **匿名是刻意的**：能看到"哪条车道产出了哪个答案"的选择者会按车道选，而不是按答案选。
- **不改变现有 RSI 的定位**：代码级改进仍走 `apply_rsi_change` 与确定性门禁；
  本决策新增的能力是 harness **行为**层面的比较与沉淀，两者互补而非替代。
- **经验库存放在既有制品体系里**：`plans/harness-experience-<domain>`（schema
  `graph.harness-experience@1`），写用 Agent 自己的制品通道，读用宿主侧制品库，
  提升到项目作用域。跨项目不共享，与"项目共享产物"的既有边界一致。
- **不新建第二个权威状态库**：经验落在 `artifacts` 表，事实读自
  `kernel_executions` / `kernel_submissions` / `node_entries` / `kernel_provider_calls`，
  不新增 schema 迁移。

## 后果

- Main Agent 多三个工具：`compare_harness_candidates`、`record_harness_decision`、
  `read_harness_experience`，只对 main 开放。
- 一张图跑出多个候选之后，Agent 可以按"行为差异"而不是"感觉"选，
  选完的教训会在同项目下一个同领域任务里出现。
- Graph 与 Harness² 的关系从"要不要装"变成"方法怎么落地"，
  后续 P2（探针驱动器）、P3（双轴提案与合成）、P4（经验进上下文）、P5（评测脚本进闭环）
  都建立在本次的三件套之上，详见评估文档。
- 代价：新增三个工具面与一处制品约定；对比结果是**事实**，
  它不替代既有门禁与人工验收，也不应该被当成质量证明。

## 与既有决策的关系

- [ADR 0026](0026-main-agent-recursive-self-improvement.md) 决定 RSI 改 Graph 源码、走门禁、热重载：
  本决策**不改变**它，只在其旁边补上 harness 行为层面的比较与沉淀。
- [ADR 0030](0030-graph-v2-interface-delivery-kernel.md) 决定 graph 入口统一走新内核：
  本决策的对比与裁决都跑在新内核的正式事实之上，不新增平行执行路径。

## 2026-10-22：探针驱动器与节点级 harness 覆盖

第一段落地（对比 + 裁决 + 经验库）之后，剩下的问题是"多候选谁来组织"：
Agent 要自己建图、派发、等节点、再调对比，实验本身还要用户确认草稿。

决定：

- **节点定义新增可选的 `harness` 覆盖**：`{"<提示键>": "<文本>"}`，只允许替换
  `agents/<definition-id>.md`、`rules/<role>.md`、`tools/<role>.md`、`runtime/node.md`。
  它改变"Agent 被告知什么"，不改变宿主强制的权限、闸门与预算——与 ADR 0026 的分界一致：
  那是宿主的事，这是 harness 的事。
- **覆盖必须落在会话真正读的那份提示库上**：`AgentContextLibrary.WithOverlay` 返回一份带覆盖的库副本，
  节点泳道把它交给该节点的会话。只把覆盖写进执行快照（`prompts`）是不够的：
  模型读的是库，快照只是冻结记录，两者不一致时模型会读到旧文本。
- **新增 `probe_harness` 工具**：宿主建一张内部图（每变体一个节点，同一任务、同一输入、
  不同 harness），派发、等待候选停稳，产出与 `compare_harness_candidates` 同形状的对比。
  探针图由宿主创建，不经用户确认的草稿：它是一次实验的结构，不是要交付给使用者的产物结构。
  它照样占用全局执行名额、照样计入预算、照样落盘成可审计的执行事实。
- **不新增状态库**：变体随图定义走，对比事实读内核既有表，经验落在既有制品体系。
