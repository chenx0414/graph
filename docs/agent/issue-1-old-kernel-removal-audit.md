# 旧内核删除前的能力对照（§13.8 / HB-261c）

> 历史快照：本文描述 2026-10-02 的代码，不能作为当前原生能力或退役进度的结论。后续实际进程、模型、产物、Git 与入口迁移证据见 [实施进度](issue-1-implementation-progress.md)；旧内核退役仍未完成。

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
