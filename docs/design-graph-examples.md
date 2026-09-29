# Graph 设计范例

这是「graph 设计范例」的第 **1** 份产物：**简单档**。
另外两份（**中等档**、**复杂档**）是后续待做，本页只留占位与判定线，不提前写。

**本页给谁看**：设计图的 **main agent**。目标只有一个——**判档，然后照着一个已验证的形状写，而不是每次从零发明一张图**。

---

## 怎么用这页（操作顺序）

1. **先判档**（下面那条唯一要记的规则），别先想节点。
2. 选中某一档的「形状」后，**照抄那一档的范例**，只替换 `id` / `action` / `definitionVersion` / `model` / `input` / `deliverable`。
3. 三个硬规则不要漏：**显式声明 `decisions`**、**每个交回东西的节点声明 `deliverable`**、**每个子任务写成一个自包含的任务**。

---

## 一条贯穿三档的判定线（唯一需要记的规则）

> **子任务之间需不需要「中间状态」在运行时来回传递？**
> 不需要 → **简单档**。需要，但方向单一（实现 → 审查 → 返工）→ **中等档**。需要在**多个视角/多个候选之间**反复交换与仲裁 → **复杂档**。

这条线决定图的**形状**：
- **简单档**的子任务彼此独立，谁也不需要知道别人的中间产物，因此**没有回边、没有跨节点上下文**——这正是它能廉价的原因。
- **中等档**引入**单一方向的返工环**（审查不通过就回到实现）。
- **复杂档**引入**多条回边 + 候选/评委之间的证据交换**。

---

# 简单档：把任务分给多个 subagent，产物自动交回 main

## 语义（使用者定义）

> 简单档 = 把一个任务**分到多个 subagent**（例如三个），**subagent 结束后自动把产物发布给 main**。

三个要点，缺一不可：
1. 子任务**互不依赖**（`dependsOn` 为空），所以可以**真并行**；
2. 子任务结束时**自动发布自己的产物**——不需要 main 去要，也不依赖 subagent「记得」调用工具；
3. main 结束后**能直接读到**这些产物。

## 形状

n 个互不依赖的 `agent` 节点 + 1 个收尾的 program 验收节点。

```
nodes:
  research-auth      agent,  dependsOn: []          deliverable: notes/...-auth.md
  research-surface   agent,  dependsOn: []          deliverable: notes/...-surface.md
  research-lessons   agent,  dependsOn: []          deliverable: notes/...-lessons.md
  check-notes        program dependsOn: [三个]      （验收项唯一允许的 checkNode）
```

**没有** `container`、**没有** `routes`、**没有** `when`、**没有** loop。简单档里出现这些，说明判错档了。

## 可直接照抄的范例（真跑通过的一张图）

```json
{
  "requirementVersion": 1,
  "summary": "并行调研 pi-subagents@0.73.1，产出可复核的调研笔记",
  "decisions": [],
  "acceptance": [
    { "id": "notes-exist", "description": "三份笔记真实写入仓库，且引文可回溯到一手来源", "checkNode": "check-notes" }
  ],
  "nodes": [
    {
      "id": "research-auth", "kind": "agent", "action": "research",
      "definitionVersion": "coder@10", "model": "<模型 id>",
      "input": { "question": "pi-subagents@0.73.1 的授权模型：agent 如何获得调用 subagents 的权限？写 notes/pi-subagents-auth.md" },
      "deliverable": { "path": "notes/pi-subagents-auth.md", "namespace": "research", "name": "pi-subagents-auth-notes", "title": "授权模型调研笔记" }
    },
    {
      "id": "research-surface", "kind": "agent", "action": "research",
      "definitionVersion": "coder@10", "model": "<模型 id>",
      "input": { "question": "工具面与工作流 API：subagent 参数、workflowScript 的 runs.run/runs.all/runs.lanes 语义。写 notes/pi-subagents-surface.md" },
      "deliverable": { "path": "notes/pi-subagents-surface.md", "namespace": "research", "name": "pi-subagents-surface-notes", "title": "工具面与工作流 API 调研笔记" }
    },
    {
      "id": "research-lessons", "kind": "agent", "action": "research",
      "definitionVersion": "coder@10", "model": "<模型 id>",
      "input": { "question": "提炼「agent 学会调用 subagent」的可迁移教训，哪些值得 Graph 简单档借鉴。写 notes/pi-subagents-lessons.md" },
      "deliverable": { "path": "notes/pi-subagents-lessons.md", "namespace": "research", "name": "pi-subagents-lessons-notes", "title": "可迁移教训" }
    },
    {
      "id": "check-notes", "kind": "program", "action": "graph.command",
      "dependsOn": ["research-auth", "research-surface", "research-lessons"],
      "input": { "command": "node", "args": ["scripts/check-pi-subagents-notes.mjs"] }
    }
  ]
}
```

> `definitionVersion` 只是「角色」的载体。**main 可以自己造配方**（`POST /api/catalog/combinations` → 返回 `definitionVersion`），也可以直接用现成的（如 `coder@10`）。配方只能**引用已存在的能力**，不能创造能力或授予权限。

## 三条硬规则（简单档最容易踩的三个坑，都是实测出来的）

### 1. 总是显式声明 `decisions`，哪怕写 `[]`

草稿的 `decisions` 有两个分支：
- **显式声明** → 用你策展的那几条（`validateProposal` 限 ≤50 条、每条 ≤800 字）；
- **字段缺失** → harness **回退**成「把该会话里已投递的使用者消息 dump 出来」。

那次我没声明，回退把 `decision_digest` 变成 **636 条**——我自己的对话历史（含 `continue`、`/agent_browser`）。**给 `[]` 就是「冻结零约束」**，只有**字段缺失**才走回退。
→ **约束由 main 给出，而不是让 harness 去猜**（奥卡姆）。

> 顺带一个设计意图，别误解：子任务**确实会**收到会话里的约束，这是刻意的——使用者随口说的「登录先不改」必须能到达干活的节点（`tests/m8/conversation.test.ts` 钉住这条）。回退窗口已改为**保头保尾**（最早 6 + 最近 14，≤20 条、≤4000 字，超预算从中间丢），因为**最老的几条正是原始请求与早期约束所在处**。

### 2. 要交回东西的节点，就声明 `deliverable`

**不要**依赖 subagent 记得调用 `artifact_publish`。声明即可，harness 负责落地：

```json
"deliverable": { "path": "notes/x.md", "namespace": "research", "name": "x-notes", "title": "…", "summary": "…" }
```

行为（已实现，`validateProposal` 与结算期都会把关）：

| 事项 | 规则 |
|---|---|
| `path` | **相对路径**，不得以 `/` 开头、不得含 `..` 或空段（否则 harness 会读到节点无权交出的文件） |
| `namespace` | 只能是 `plans` / `research` / `reviews` / `deliverables` / `summaries` |
| `name`、`namespace` | 小写 slug |
| `title` / `summary` | 可选；非空且有界（≤300 / ≤2000 字符） |
| 发布时机 | 节点**成功结算**时由 harness 发布为 **task 级产物**，`producer` = 该节点 |
| 文件不存在或是空的 | **节点不会 `succeeded`**（报错原因写在结果里，如 `notes/x.md was declared as this node deliverable but was never written`） |

最后一行是这个字段存在的**全部理由**：图许诺了一个文件，**「通过了但没有文件」就是缺陷**，不该静默通过。—— 这次的教训正是：三个节点都只写了「写 notes/xxx.md」，**没有任何节点被要求发产物**，于是三条车道只有一条自己顺手发了。

### 3. 每个子任务写成一个**自包含**的任务

子任务**看得见会话级约束**（好事），但它**看不见别的车道的中间产物**（简单档没有跨节点上下文）。所以 `input` 里要把这件事讲全：要什么、写成哪个文件、算做到什么程度。不要把关键信息留在别处等它猜。

## 产物怎么回到 main（这一段是本轮的新能力）

| 谁 | 能看见什么 |
|---|---|
| 发布它的那个车道 | 自己发布的 task 级产物 |
| **main agent** | **本任务 + 同一会话内所有任务的 task 级产物** ← 这是重点 |
| 用户（控制台「共享产物」页） | 项目级 + **该项目所有任务**的 task 级产物 |
| 本项目**未来的任务** | 只有**项目级**（即被晋升过的） |

所以：
- **产物可见性跟着「会话」走**，main **不需要**晋升就能读到子任务交回的产物。
- **晋升（promote）是另一回事**：它把一份产物变成**项目级共享知识**，让**未来的任务**也能发现它。**不要给每个 subagent 产物都晋升**——那会把某一次图的工作材料灌进之后所有图。晋升应当是对「这份结论值得成为项目记忆」的**显式判断**。

## 收尾与验收

- 收尾放一个 **program 节点**（如跑一个检查脚本），验收项的 `checkNode` **必须指向它**（acceptance 只接受强制 program 节点）。
- 检查脚本要**与验收措辞同强度**。这次的教训：验收项写的是「三份笔记**与一份汇总**」，而脚本只查那三份笔记，**比验收项弱**，于是「一份汇总」从来没被写出来却仍然通过。
- 验收要么断言**交付表面**（文件真的在主线 / 产物真的在项目级），要么就别在验收项里许诺它。

## 什么适合 / 什么不适合

- **适合**：多个互不依赖的调研、多方评审、多维度数据分析、并行产出多份笔记。
- **不适合**：子任务之间有强依赖、必须按顺序执行、需要频繁互相传递中间状态 → 那是**中等档**。

## 已实证的数字（不是推测）

- **真并行**：三个子任务在 **1 毫秒**内同时派发，各自独立跑 ~**140 秒**。
- **不需要新机制**：3 个节点都是普通 `agent` + `definitionVersion` + `model`，没有新 `role` 枚举。
- **真缺口**：全库 129 个任务里只有 **12 个**含非 master 的 agent 节点（`master 117 / work 23 / review 13`）。main 几乎总在自己干——三档里最常用的那一档，正是最缺的那一档。

## 可视化（已定）

简单档**不需要**一张单独的 graph 视图：它没有回边、没有分支、没有容器，画成图只会是一排孤立方框。要更轻的方式（例如任务卡上一行「派生了 N 个子任务，各自状态」）。

---

# 中等档 / 复杂档（待做）

**本页不写它们**，只留判定线（见上）。两份待做的范例各要回答：

- **中等档**：`work → review → 返工` 的**单一方向回边**怎么表达（容器 + `outputs`、`rework` 决策、返工时的证据传递）。
- **复杂档**：多视角/多候选之间的**证据交换与仲裁**（≥2 条回边、`evidence_only` 上下文、评委/对抗式形状）。

---

## 附：仍然有效的历史决策（v11 使用者回答）

1. **别脱节（硬约束）**：`templates.ts` 的可执行形状 ↔ `architecture-catalog.ts` 的玩家可见目录必须对应上。
2. **判定线**：同意上面的「中间状态」判定线。
3. **简单档可视化**：不要单独的 graph 视图。
4. **简单档的角色 = main 自己选/造的配方**：不是新 `role` 枚举，是配方；配方只能引用已存在的能力，不能创造能力或授予权限。
5. 目录每条架构用 `id` **硬绑定**到可执行模板；目录该列「**档**」。

## 开放问题

- 简单档的「更轻的可视化」具体形态。
- 中等档的返工环与模板/目录的绑定方式（第 2 份范例要先答）。
- `decisions` 回退的**语义过滤**（剔除 `continue`、slash 命令、短确认）——已记 harness backlog，判据未定。
