# Graph 设计范例

这是「graph 设计范例」的第 **2** 份产物：**中等档**（第 1 份是**简单档**）。
另一份（**复杂档**）是后续待做，本页只留占位与判定线，不提前写。

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

**声明是保底通道**：声明即落地，**不要**依赖 subagent 记得调用 `artifact_publish`。harness 负责落地：

```json
"deliverable": { "path": "notes/x.md", "namespace": "research", "name": "x-notes", "title": "…", "summary": "…" }
```

同时 `artifact_publish` **仍然对子 agent 开放**，用于**除交付物之外的额外产物**（例如评审顺手写的复现 harness、实现者的自测脚本）。两条通道并存：

| 通道 | 用途 | 保证 |
|---|---|---|
| **`deliverable` 声明（保底）** | 这个节点**必须**交出的那一份东西 | 节点结算时 harness 代发；**文件不存在/为空则节点不 succeeded** |
| **agent 自调 `artifact_publish`** | 交付物**之外**的附加产物 | agent 自己决定，发布即成为 task 级产物 |

**为什么保底不能取消**：代发挂在「节点成功结算」上，「声明了却没写」是**机械失败**。若把交付物也改成纯 agent 自 publish，「忘了发」就不再是失败，而是**静默通过**——验收证据会神不知鬼不觉地消失。

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

# 中等档：并行实现 + 评审返工环

## 语义（使用者定义）

> 中等档 = 2–3 个 subagent **并行实现** → 1–2 个 subagent 评审 → **评审不通过就把评审结果返回实现者返工**，循环至通过 → 最后交由 main 测试。

与简单档的差别只有一条（见判定线）：**子任务之间需要中间状态在运行时来回传递**，而且方向单一（实现 → 评审 → 返工）。

## 先说结论：这一档不需要独立的「门」

早期版本给每条车道配一个 `graph.verify` 门（`multiview` / `independent` 判定）。**现在不需要了**：评审节点自己就是路由器——它在结果里给出 `route`，图的 `loops` 声明哪个分支表示返工，harness 校验路由必须落在声明过的分支内；绑了验收项的评审，其证据由 harness 登记（钉在评审写的那份报告上）。省掉的是一整层实体，以及「评审说了算、门再判一次」的语义重复。

建图要用到的部件只有四个：

| 部件 | 用什么 |
|---|---|
| 并行实现者 | n 个互不依赖的 `agent` 节点（同简单档） |
| 评审（= 路由器） | 每个实现者一个 `agent` 评审节点：`dependsOn` 它要评的实现者，`routes: ['pass','fail']`，`input.route.declared: null` |
| 评审必须留下的东西 | 该评审节点的 `deliverable`（例如 `reviews/review-a.md`）：未写或为空 → **结算失败**，评审不能空口放行 |
| 返工回边 | `loops: [{ from: 'review-a', to: 'impl-a', case: 'fail' }]`，**每条车道一条** |

**验收怎么绑**：把验收项的 `checkNode` 指到评审节点上。评审判 pass → 该验收项成立（证据 = 评审写的那份报告，按磁盘内容登记）；路由退回的那一轮不算通过。

## 推荐形状：每个实现者一条完整车道

```json
{
  "requirementVersion": 1,
  "summary": "两条车道并行实现，各自评审；评审判 fail 就返工对应车道",
  "decisions": ["评审即路由器：评审判 pass 即该车道验收成立，证据由 harness 钉在评审写的报告上"],
  "acceptance": [
    { "id": "a-pass", "description": "车道 a 通过自己的评审", "checkNode": "review-a" },
    { "id": "b-pass", "description": "车道 b 通过自己的评审", "checkNode": "review-b" }
  ],
  "loops": [
    { "from": "review-a", "to": "impl-a", "case": "fail" },
    { "from": "review-b", "to": "impl-b", "case": "fail" }
  ],
  "nodes": [
    { "id": "impl-a", "kind": "agent", "action": "implement", "definitionVersion": "coder@10", "model": "<模型 id>",
      "input": { "files": ["scripts/diag-a.mjs"], "focus": "新增这一个只读脚本" } },
    { "id": "review-a", "kind": "agent", "action": "review", "definitionVersion": "reviewer@8", "model": "<模型 id>",
      "dependsOn": ["impl-a"], "routes": ["pass", "fail"],
      "deliverable": { "path": "reviews/review-a.md", "namespace": "reviews", "name": "review-a", "title": "车道 a 评审报告" },
      "input": { "focus": "只评 impl-a 的产出", "lookFor": ["是否只读", "是否只新增了声明的那一个文件"], "route": { "declared": null } } },
    { "id": "impl-b", "kind": "agent", "action": "implement", "definitionVersion": "coder@10", "model": "<模型 id>",
      "input": { "files": ["scripts/diag-b.mjs"], "focus": "新增这一个只读脚本" } },
    { "id": "review-b", "kind": "agent", "action": "review", "definitionVersion": "reviewer@8", "model": "<模型 id>",
      "dependsOn": ["impl-b"], "routes": ["pass", "fail"],
      "deliverable": { "path": "reviews/review-b.md", "namespace": "reviews", "name": "review-b", "title": "车道 b 评审报告" },
      "input": { "focus": "只评 impl-b 的产出", "lookFor": ["是否只读", "是否只新增了声明的那一个文件"], "route": { "declared": null } } }
  ]
}
```

## 要「整合 + 一道整份交付的门」时，加尾段

三条车道各自通过后，常常还要一件「把这些成果汇成一份东西」的活，以及**一道对整个交付的机械门**。尾段就三件事：

1. `merge`（agent）：把 n 条车道的成果汇成一份交付。**明确告诉它不要重复跑整套测试**——整份交付的测试由下游那道门跑一次，那是唯一跑全套的地方（实测：不写这句时，四个节点各跑了一次全套，每次约 2.5 分钟）。
2. 门（`program`，`action: graph.command`）：跑项目自己的命令。它有三个声明值得知道：
   - `copy: "project"`：在**项目根旁的新副本**里跑，依赖是硬链的真实文件（工作副本里的 `node_modules` 是软链，项目自己的套件在那种环境里会成批失败）；
   - `timeoutMs`：这类检查要跑几分钟，默认两分钟会被切；**如实声明**，被切时记录会写明「是超过了你声明的上限」；
   - `sandbox: false`：**在沙箱外按项目自己的方式跑**（默认 `true` 不变）。实测同一份副本、同一条 `node --run check`：沙箱内 **224 失败 / 49 通过**（以套件自身超时为主），沙箱外 **1480 / 1480 全绿**。该声明**只在完全访问下兑现**，否则一律拒绝并写明原因；走出沙箱只解除围栏，**不改变检查能看到什么**（环境仍由 harness 用允许清单构造）。
3. 回边：`loops: [{ from: <门>, to: 'merge' }]` —— 整合不过就返工整合，而不是直接叫醒人。

最后再挂 `graph.human_check`，把「整份交付可不可以接受」留给人。

## 五条硬规则（都是实测出来的）

### 1. 评审的路由必须落在声明过的分支内

评审在结果里给 `route`；harness 只接受 `routes` 里声明过的值，并且只认**图里那条同名 case 的 `loops`** 才触发返工。`input.route.declared: null` 表示「分支由评审自己在结果里给出」；写死某个值则等于固定路由。

### 2. 回边只激活它指向的那个节点

`loops: [{ from: 'review-a', to: 'impl-a', case: 'fail' }]` 只重跑 `impl-a`，**兄弟车道不动**（实测：a 返工 1 次时 b 只跑了 1 次）。`loops[].to` 只能是节点，不能是容器。

### 3. 绑了验收项的评审，**必须**声明 deliverable

评审判 pass 时，harness 会把它写的那份报告登记成该验收项的证据；没写、写了空文件、或**声明了 deliverable 却不写**——都让该节点**结算失败**。这是「评审不能空口放行」的机械保证。

### 4. 返工是**复用原 instance**，不是重开一个

| 事情 | 行为 |
|---|---|
| 被返工的实现者 | 复用原 `instanceId`（接着上一轮的工作继续，而不是从零再来） |
| 它作废的证据 | `evidence.valid=0` |
| 未变的兄弟车道 | 不重跑 |
| 循环上限 | 连续 3 轮无实质进展 → `stalled` 阻塞，循环有界 |

返工简报由 harness 自动带上评审自己写的话，实现者不必另找来源。

### 5. 一个交付物只发一次，一次失败必须留下原因

- 声明了 `deliverable` 的节点，如果它自己已经用 `artifact_publish` 发过**同样的字节**，harness 结算时**不会再发一版**（版本链只表示「内容变了」）。
- 任何工具失败都会把**原因**写进记录（结果行文本 + `data.message`）；`artifact_publish` 的源文件必须位于**本次操作的工作副本**内，否则拒绝——拒绝消息会给出改法（写进工作副本，或直接用 `content`）。

## 收尾与验收
- 验收项的 `checkNode` 指到**评审节点**（agent 路由器）或**程序门**（`graph.command`）；两者都能作为强制 program/node 检查。
- 评审通过 → 验收项拿到 valid evidence，且证据钉在**评审写的那份报告**上（不是评审的话）。
- main 自己最后仍要验（看 diff / 跑脚本）；门只保证「这条命令真的退出 0」。

## 什么适合 / 什么不适合
- **适合**：实现 → 评审 → 不通过就返工；返工方向单一（实现 → 评审 → 实现）。
- **不适合**：在**多个候选之间比较并选一个**（那是复杂档）。

## 已实证（不是推测）
- **整套形状**（3 条车道 + 3 个评审路由器 + merge + 全量测试门 + 人工验收；真任务 `68543fed`，9 个节点全部 succeeded、4 条验收项全部 valid）：
  - 三条评审各自判 pass，证据随集成 SHA 重绑后仍 valid；
  - **返工路径真跑过**：其中一条车道的评审判过 fail、走了图声明的回边，只重跑它自己的实现者；
  - merge 整合后，门 **`completed`、code 0、217 文件 / 1480 用例全绿、139 秒、`sandboxed:false`**；
  - 任务从 `full-tests:blocked` 一路推进到 `human-accept` 并通过人工验收。
- **门的三种跑法对照**（同一份集成副本、同一条 `node --run check`）：沙箱内 224 失败/49 通过 → 沙箱外但环境错 178 失败/1278 通过 → **沙箱外且环境对 1480/1480**。
- 本节的 JSON 与真任务用的图同构（真任务那份见 `docs/adr/0029-check-outside-the-sandbox.md` 与 harness backlog）。

## 旧形状（历史，不再推荐）

早期这一档用**每车道一个 `graph.verify` 门**（`verifier: multiview(subjectNode)` / 统一门用 `independent(reportNodes)`）来表达同一个回路，`loops` 从门出发。它跑通过，但需要多一层实体与一份 `verifier` 配置，且「评审判了、门再判一次」的语义是重复的。保留这段只为读历史设计：**新图请用上面的「评审即路由器」**，`graph.verify` 相关的硬规则（`multiview` 只能判一个实现者、`jury` 永远不产生 blockers 等）随之失效。

---

# 复杂档（待做）

**本页不写它**，只留判定线（见上）。它要回答：

- **多视角/多候选之间的证据交换与仲裁**（≥2 条回边、`context` 的 `evidence_only`、评委/对抗式形状）。
- 复杂档通常不是单选而是**组合**；唯一可先固化的判据：**出现两条以上回边、或候选之间交换证据，才配称复杂档**。只有一条回边的是中等档。


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
