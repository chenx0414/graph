# Graph 设计范例

这是「graph 设计范例」的第 **3** 份产物：**简单档 → 中等档 → 复杂档**三档已齐。

**本页给谁看**：设计图的 **main agent**。目标只有一个——**判档，然后照着一个已验证的形状写，而不是每次从零发明一张图**。

---

## 怎么用这页（操作顺序）

1. **先判档**（下面那条唯一要记的规则），别先想节点。
2. 选中某一档的「形状」后，**照抄那一档的范例**，只替换 `id` / `action` / `definitionVersion` / `model` / `input` / `deliverable`。
3. 三个硬规则不要漏：**显式声明 `decisions`**、**每个交回东西的节点声明 `deliverable`**、**每个子任务写成一个自包含的任务**。

各档一句话：**简单档**没有回边；**中等档**一条单向回边（实现↔评审）；**复杂档**≥2 条独立回边，多条车道的判断汇总进一处仲裁，且**放行与执行之间有一道 `when` 门**（见复杂档 v40）。

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

# 复杂档 v40：计划放行才开工 → 三条平行车道各一评审 → 汇总节点自判 → 人工验收

## 语义（使用者定义）

> 复杂档 v40 = planner 出计划 → plan-reviewer 审（**不通过就返工 planner，直到通过**）；通过后**计划才分发给三个 worker**；三个 worker 各产出一份成果，**各有一个对应评审**；Synthesise（**agent 路由器**）收齐三份评审、写汇总、**自己判定 pass/fail**，判 fail 时**三条回边全部返工**；通过后进入人工验收——**先由主 Agent 审证据，再向用户总结汇报**。

与中等档的差别还是判定线那一条：中等档是**单向**的「实现 → 评审 → 返工」；复杂档里**至少两条回边**、**多条车道的判断被汇总进一处仲裁**，而且**放行与执行之间有一道真门**。

## 本页 JSON 的受测范围（先读这段，否则会拿到假绿）

`tests/console/design-examples.test.ts` 把本页**每一个以 ` ```json ` 开头、且正文含 `"nodes"` 的代码块**原样喂给产品自己的 `validateProposal`——supervisor 调的就是同一个函数。三条必须知道的事：

| 事实 | 后果 |
|---|---|
| 只有 ` ```json ` **整图**受测；下面「`graph.verify` 旧形状」里那段是 ` ```jsonc ` **片段**，**不被测** | 改 jsonc 片段**不会红**——它不是门，别拿它的绿当保证 |
| 块内的 `<模型 id>` 会被替换成 `example:model` 再验 | 文档可以写占位模型，验的是**结构**不是模型 |
| 第二个用例另外检查 `acceptance[].checkNode` 与 `loops[].from/to` 都必须是图里存在的节点 | 指向不存在节点的「照抄件」也会红 |

## 这一档的部件（先看这里，再看 JSON）

| 图里的东西 | 用什么机制 | 为什么是它 |
|---|---|---|
| planner | 普通 `agent` + `deliverable`（`plans/plan.md`） | 计划必须**落成文件**，否则 worker 读到的只是空口 |
| plan-reviewer（= 路由器） | `agent` + `routes: ['accept','replan']` + `input.route.declared: null` | 「审计划」和「判是否放行」是同一个判断，不需要第二个门 |
| 放行才开工 | worker 上 `dependsOn: ['planner']` **加** `when: { node:'plan-reviewer', case:'accept' }` | 计划评审从**并列回路**升级成**开工许可** |
| 三条平行车道 | worker-1/2/3 互不依赖，各配 review-1/2/3 | 一一对应，返工时能说清是哪条车道 |
| synth（= 路由器） | `agent` + `routes: ['pass','fail']` + `deliverable: summaries/synthesis.md` | 汇总与判定**同一份东西**：写的汇总就是判的依据 |
| 整批返工 | **三条** `{ from:'synth', to:'worker-N', case:'fail' }` | 同一个 `from` + 同一个 `case` 的多条 loop **一起**触发 |
| 人工验收 | `graph.human_check` 程序节点，验收项只绑它 | 机械门与主 Agent 验收不重复时，人是唯一的那道门 |

## v40 完整初稿（可直接照抄；下面这段 JSON 本身就被上面的测试真的验过）

```json
{
  "requirementVersion": 15,
  "summary": "复杂档 v40：planner 出计划 → plan-reviewer 审（不过就返工 planner）；放行后计划才分发给三个 worker；三个 worker 各一成果各一评审；synth 收齐三评审、写汇总、自判 pass/fail，判 fail 三条回边全部返工；通过后人工验收",
  "decisions": [
    "全轮 agent 节点用同一个模型；换模型只改 model 字段",
    "plan-reviewer 判 accept 才放行，判 replan 走回边返工 planner",
    "synth 判 fail 时三条回边一起触发 = 整批重做，不按评审名单挑人返工",
    "验收只绑 deliver；主 Agent 的 review_human_check 是它之前唯一的审查"
  ],
  "acceptance": [
    { "id": "human-accept", "description": "使用者确认整份交付可接受（先经主 Agent 用 review_human_check 审证据）", "checkNode": "deliver" }
  ],
  "loops": [
    { "from": "plan-reviewer", "to": "planner", "case": "replan" },
    { "from": "synth", "to": "worker-1", "case": "fail" },
    { "from": "synth", "to": "worker-2", "case": "fail" },
    { "from": "synth", "to": "worker-3", "case": "fail" }
  ],
  "nodes": [
    { "id": "planner", "kind": "agent", "action": "plan", "definitionVersion": "coder@10", "model": "<模型 id>",
      "deliverable": { "path": "plans/plan.md", "namespace": "plans", "name": "plan", "title": "执行计划" },
      "input": { "focus": "把任务拆成三个可并行子任务的可执行计划，写入 plans/plan.md" } },
    { "id": "plan-reviewer", "kind": "agent", "action": "review-plan", "definitionVersion": "reviewer@8", "model": "<模型 id>",
      "dependsOn": ["planner"], "routes": ["accept", "replan"],
      "context": { "purpose": "review", "predecessors": [{ "source": "planner", "mode": "evidence_only" }] },
      "deliverable": { "path": "reviews/plan-review.md", "namespace": "reviews", "name": "plan-review", "title": "计划评审报告" },
      "input": { "focus": "审查计划是否可行；通过则放行并把最终 plan 汇报给使用者，不通过则要求返工", "route": { "declared": null } } },
    { "id": "worker-1", "kind": "agent", "action": "implement", "definitionVersion": "coder@10", "model": "<模型 id>",
      "dependsOn": ["planner"], "when": { "node": "plan-reviewer", "case": "accept" },
      "context": { "purpose": "implement", "predecessors": [{ "source": "planner", "mode": "evidence_only" }] },
      "input": { "focus": "按已过审的计划完成子任务 1" } },
    { "id": "worker-2", "kind": "agent", "action": "implement", "definitionVersion": "coder@10", "model": "<模型 id>",
      "dependsOn": ["planner"], "when": { "node": "plan-reviewer", "case": "accept" },
      "context": { "purpose": "implement", "predecessors": [{ "source": "planner", "mode": "evidence_only" }] },
      "input": { "focus": "按已过审的计划完成子任务 2" } },
    { "id": "worker-3", "kind": "agent", "action": "implement", "definitionVersion": "coder@10", "model": "<模型 id>",
      "dependsOn": ["planner"], "when": { "node": "plan-reviewer", "case": "accept" },
      "context": { "purpose": "implement", "predecessors": [{ "source": "planner", "mode": "evidence_only" }] },
      "input": { "focus": "按已过审的计划完成子任务 3" } },
    { "id": "review-1", "kind": "agent", "action": "review", "definitionVersion": "reviewer@8", "model": "<模型 id>",
      "dependsOn": ["worker-1"],
      "context": { "purpose": "review", "predecessors": [{ "source": "worker-1", "mode": "evidence_only" }] },
      "deliverable": { "path": "reviews/review-1.md", "namespace": "reviews", "name": "review-1", "title": "评审 1 报告" },
      "input": { "focus": "只评 worker-1 的成果" } },
    { "id": "review-2", "kind": "agent", "action": "review", "definitionVersion": "reviewer@8", "model": "<模型 id>",
      "dependsOn": ["worker-2"],
      "context": { "purpose": "review", "predecessors": [{ "source": "worker-2", "mode": "evidence_only" }] },
      "deliverable": { "path": "reviews/review-2.md", "namespace": "reviews", "name": "review-2", "title": "评审 2 报告" },
      "input": { "focus": "只评 worker-2 的成果" } },
    { "id": "review-3", "kind": "agent", "action": "review", "definitionVersion": "reviewer@8", "model": "<模型 id>",
      "dependsOn": ["worker-3"],
      "context": { "purpose": "review", "predecessors": [{ "source": "worker-3", "mode": "evidence_only" }] },
      "deliverable": { "path": "reviews/review-3.md", "namespace": "reviews", "name": "review-3", "title": "评审 3 报告" },
      "input": { "focus": "只评 worker-3 的成果" } },
    { "id": "synth", "kind": "agent", "action": "synthesize", "definitionVersion": "synthesizer@1", "model": "<模型 id>",
      "dependsOn": ["review-1", "review-2", "review-3"], "routes": ["pass", "fail"],
      "context": { "purpose": "review", "predecessors": [
        { "source": "review-1", "mode": "evidence_only" },
        { "source": "review-2", "mode": "evidence_only" },
        { "source": "review-3", "mode": "evidence_only" }] },
      "deliverable": { "path": "summaries/synthesis.md", "namespace": "summaries", "name": "synthesis", "title": "评审汇总与判定" },
      "input": { "focus": "收齐三份评审报告，写出汇总，并给出通过/不通过的判定", "route": { "declared": null } } },
    { "id": "deliver", "kind": "program", "action": "graph.human_check", "dependsOn": ["synth"], "input": {} }
  ]
}
```

## 和 `graph.verify` 形状差在哪（**别照抄错的那张**）

v40 之前，这一档还有一张**同样合法、但机制完全不同**的图：一个执行者 + N 个视角评审 + 一个 `graph.verify` 机械判定门。两张图的差别，逐条都是机制差别：

| 维度 | 旧形状（`graph.verify` 门） | v40（本页上面那张） |
|---|---|---|
| 执行者 | 1 个 worker | 3 个 worker，一一对应 3 个评审 |
| 仲裁节点 | `Pass?`：**program**，`graph.verify` + `verifier.multiview`，自己算 `outcome` | `synth`：**agent** 路由器，`synthesizer@1`，自己写汇总、自己给 `route` |
| 分支怎么来 | `input.route.byField` 读**判定节点自己产物**里的 `outcome` | `input.route.declared: null`——由 agent 在**提交结果**里给 `route` |
| 计划与执行的关系 | 计划评审是**并列**的第二条回路 | `when: { node:'plan-reviewer', case:'accept' }`——**放行才开工** |
| 返工粒度 | 一条回边只打回那一个 worker | 同一个 `case` 挂**三条** loop = **整批**重做 |
| 验收挂在哪 | 绑在判定节点（`checkNode: 'pass'`）上 | 只绑 `deliver`（`graph.human_check`），机械门与主 Agent 验收不重复 |

> 两张图**都能被 validator 接受**。本页现在只把 v40 放在主位；旧形状保留在下一节，注明它什么时候仍然是对的选择。

## v40 新引入的三个机制点（每个都带一个坑）

### 1. `when` 才是「计划放行才开工」——它加依赖，**也**挡下游

`when` 在建图时被拆成两件事（`src/core/graph.ts:33-45`）：把 `when.node` 追加进该节点的依赖，并检查那个 `case` 是不是该路由器声明过的分支。真正**挡住**下游的是就绪判定（`src/core/graph.ts:127-136`）：条件节点没 `succeeded` → `waiting`；路由器走了别的 case → **`skip`**。

**坑**：`plan-reviewer` 判 `replan` 时，三个 worker 与**它们的全部下游**（评审、synth、deliver）都是 `skip`，不是失败、也不是等。任务因此不会 `failed`，而是在别的节点上继续或停住——看到「下游一个都没跑」先查是不是 `skip`，不要去查 worker。

### 2. 同一个 `from` + 同一个 `case` 的多条 loop = **整批**返工

返工的目标是 `plan.loops.filter(loop => loop.from === nodeId && loop.case === settled.route)`（`src/core/operation-lifecycle.ts:1114-1116`）——是 `filter` 不是 `find`，**三条 `fail` 回边会一起命中**，然后 `reactivate(routed.map(loop => loop.to))` 一次性重激活三个 worker（`src/core/operation-lifecycle.ts:1281-1289`），事件流写 `graph.rework { from:'synth', to:['worker-1','worker-2','worker-3'] }`。

**坑**：这意味着**「只让不合格的那条车道返工」在 v40 里做不到**——图上没有这个粒度。`tests/console/complex-tier-shape.test.ts` 里那种「回边只点名一个节点」是**单条** loop 的行为，不能拿来推断多 loop 的情况。

### 3. 验收只挂 `graph.human_check` 时，主 Agent 的 `review_human_check` 是**唯一**的前置审查

`graph.human_check` 只把问题交给人，它不看证据。真正在派发之前审一遍证据的是主 Agent 的 `review_human_check` 工具（`src/runtime/agent-tool-definitions.ts:261`）：它把自己的判断挂在这条检查上，`approve:true` 表示证据看着对、可以去问用户；**它本身不是验收**——检查仍然是开的，用户还得自己点。

**坑**：v40 刻意删掉了 `verify-delivery` 机械门（与主 Agent 验收重复）。所以这一档**没有机械兜底**：如果主 Agent 忘了调 `review_human_check` 就把问题抛给用户，用户看到的是一堆没被审过的证据。删掉机械门是你自己的决定，但要知道**兜底同时也没了**。

## 五条硬规则（每条都附「不这么写会怎样」）

### 1. agent 路由器自判分支，必须写 `input.route.declared: null`

`declared: null` 才是「分支由 agent 在提交结果里自己给」（`src/core/router-action.ts:91-98`）。写死成 `"declared": "pass"` 时，运行时直接返回那个值（`src/core/router-action.ts:56-63`）——**agent 说什么都没用，等于固定路由**。另外：声明了 `routes` 却没交 `route` 会被**拒绝**（不是静默默认），否则所有分支都 skip，图会「看起来跑完了」其实没有结论。

### 2. 跨 agent 的边要在 `context.predecessors` 里声明 `mode`——而且要知道自己被默认成了什么

`reviewer ← worker`、`worker ← planner`、`synth ← 三个 review` 都是 agent → agent。少写**不一定**被拒：运行时/校验期有一个**默认规则**替你想（`src/core/predecessor-handoff.ts:41-51`，下表是实测结果）：

| 接收方长什么样 | 默认 `mode` | 漏写的后果 |
|---|---|---|
| action 含 `review`/`verify`/`jury`/`critic`，或 `context.purpose: 'review'`，或配方是 `reviewer@*` | `evidence_only` | 不红（拿到你本来想要的） |
| action 含 `work`/`implement`/`rework`，或 `context.purpose: 'implement'/'rework'`，且源是 agent | **`result_handoff`** | **不红，但语义反了**——worker 会去继承 planner 的结果交接，而不是只读计划这份证据 |
| 两者都不是（例：`synth` 的 action 是 `synthesize`） | 无默认 | **直接被拒**：`Fresh predecessor edge <节点> requires an explicit handoff policy`（`src/core/predecessor-handoff.ts:495-523`） |

所以这一条真正的写法是：**显式写出 `mode`，不要依赖默认**。默认只在名字碰巧对上时才是你想要的；名字不对时它要么给你一个你不想要的 `result_handoff`（静默），要么让整张提案被拒（响亮）。上面那张 v40 JSON 里 `worker-N` 显式写 `evidence_only` 就是为了避开第一行那个「静默拿到 `result_handoff`」的坑。

另两条硬约束：`policy.source` 必须是**直接** `dependsOn` 里的那个 id；`purpose: 'review'` 的接收方**只准** `evidence_only`（`Independent review and verification require evidence_only predecessor handoff`）。

### 3. `when` 引用的 `case` 必须是那个路由器 `routes` 里声明过的

写一个没声明的分支，整张提案在 `validateProposal` 阶段就被拒（`Branch must select a declared router case`，`src/core/graph.ts:45`）；`loops[].case` 同理（`A loop case must name a branch the router declared`，`src/core/graph.ts:73`）。**不这么写的后果**：不是「这条分支没人走」，而是**整张图跑不起来**。

### 4. 判 pass/fail 的节点必须真的留下东西

`plan-reviewer` 与 `synth` 都声明了 `deliverable`。声明了却没写、或写了空文件，节点**不会** `succeeded`——这是「评审/汇总不能空口放行」的机械保证。绑在验收项上的节点尤其如此：没写报告就是**静默通过**的解法。

### 5. `loops[].case` 必须写，而且它决定这条边**会不会真的触发**

`loops[].to` 必须是图里已存在的、与 `from` 不同的节点，且**必须是 `from` 的上游祖先**（`Loop must return to an upstream node`，`src/core/graph.ts:76`）；`from` + `to` + `case` 三者组合必须唯一。`case` 本身是**可选字段**，但**可选不等于安全**：

- 运行时选返工目标的条件是 `loop.from === nodeId && loop.case === result.route`（`src/core/operation-lifecycle.ts:1114-1116`）。**漏写 `case` 的边永远不匹配**，是一条**死边**：校验期合法，运行时**永远不触发**。
- 同一个 `from` + 同一个 `case` 可以挂**多条** `to`，它们会**一起**触发（机制点 2）。所以「只重跑一条车道」和「整批重跑」的区别**不在** `case` 怎么写，而在**你挂了几条**。
- 另外，路由器交回的 case 必须在 `routes` 里，否则整个结果被拒（`Router must return a declared case`，`src/core/operation-lifecycle.ts:1107`）；**声明了 `routes` 却没声明怎么选**（缺 `input.route`）同样是 `invalid_result`（`:1100-1104`）。

## 旧形状（`graph.verify` 机械判定）——保留，仍然合法

复杂档还有另一种合法画法：**一个执行者 + N 个视角评审 + 一处机械判定**。它的判定节点是 `program` + `action: "graph.verify"`，用 `verifier.multiview` 把多份评审的维度汇成一处结论（`outcome: 'pass' | 'rework'`），再由 `input.route.byField` 把结论变成分支。

```jsonc
// 判定节点的关键两处：verifier（怎么算结论）+ input.route（结论怎么变成分支）
{ "id": "pass", "kind": "program", "action": "graph.verify",
  "dependsOn": ["worker", "reviewer-1", "reviewer-2"],
  "routes": ["yes", "no"],
  "verifier": {
    "kind": "multiview", "subjectNode": "worker", "reportNodes": ["reviewer-1", "reviewer-2"],
    "dimensions": [
      { "id": "correctness", "required": true, "reportNode": "reviewer-1" },
      { "id": "fidelity",    "required": true, "reportNode": "reviewer-2" }
    ]
  },
  "input": { "route": { "byField": { "path": "outcome", "values": { "pass": "yes", "rework": "no" } } } } }
```

> 这段是 **jsonc 片段，不是整图**，所以**不受测**（本页只测含 `"nodes"` 的 ` ```json ` 整图）。它保留下来的作用是让人看懂机制，不是当照抄件——要照抄这张形状，请把上面 v40 那张整图的 `synth` 换成「`program` + `graph.verify` + 一个 `multiview` 配置」。

**什么时候仍然选它**：维度判定**本来就有客观标准**（例如「正确性维度必须全过」），你希望结论由**维度规则**算出来，而不是由某个 agent 读一遍报告后拍板。代价是多一层实体与一份 `verifier` 配置。

**两条仍然有效的规则**（属于这张图，不属于 v40）：

- `multiview` 的 `required: true` 维度全过才算 pass；建议项不阻塞（某维度写 `required: false` 时它不通过也不产生 blocker）。
- **不要用 `byStatus`**：一个「有结论」的判定节点状态必然是 `completed`，`byStatus` 会把它永远映射到同一个分支——**返工分支就成了死代码**。用 `byField` 读自己产物里的 `outcome`。

**不要用 `program` + `action: "route"` + `byField` 去读兄弟节点的产物**——`byField` 读的是**路由器自己**的产物（`src/core/router-action.ts:12-13`）。程序动作只有 `graph.verify`、`graph.command`、`graph.human_check` 三个。

`tests/console/complex-tier-shape.test.ts` 是这张图的**可执行版本**，真跑通过。

## 什么适合 / 什么不适合

- **适合（v40）**：三份以上互不相关的成果要分别评审、评审意见要汇总、且**不合格时整批重来**；或者「计划没过审就不许开工」本身就是需求。
- **适合（旧形状）**：单一执行者 + 多视角评审，且**维度标准是客观的**。
- **不适合**：只有一个视角在评（那是中等档）；要在**多个候选方案之间选一个胜者**（那用 `jury` 形状，本页不展开）。
- **不适合**：你其实只想要「不合格的那一条返工」——v40 的三条 `fail` loop 是整批返工，画不出按名单返工。

## 本节的说法各自指回哪里，以及**哪条是上面那道测试真的在守的**

| 说法 | 强制点 | 上面那道测试守得住吗 |
|---|---|---|
| `when` 加依赖 + 校验 case 已声明 | `src/core/graph.ts:33-45` | **守得住**（删掉/改错 `when.case` 即红） |
| 跨 agent 边的 handoff `mode` | `src/core/predecessor-handoff.ts:495-523` | **守得住**（删掉 `synth` 的 `predecessors` 即红） |
| `loops` 端点存在、回到上游、组合唯一 | `src/core/graph.ts:71-76` + 测试第二个用例 | **守得住** |
| 验收 `checkNode` 必须是强制的 program 门或 agent 路由器 | `src/core/proposal.ts:100-104` | **守得住** |
| `when` 不满足即 `skip`（挡住下游） | `src/core/graph.ts:127-136`（`readiness`） | **守不住**——静态验证器不看运行时调度 |
| 同一 `from`+`case` 的多条 loop 一起触发（整批返工） | `src/core/operation-lifecycle.ts:1114-1116`、`:1281-1289` | **守不住**——`validateProposal` 只查端点合法 |
| `declared: null` 才是自判；写死=固定路由 | `src/core/router-action.ts:56-63`、`:91-98` | **守不住**——写成 `"pass"` 一样能过校验 |
| `review_human_check` 存在、且它不是验收 | `src/runtime/agent-tool-definitions.ts:261`、`src/runtime/agent-tools.ts:438` | **守不住** |
| `graph.verify` 旧形状的 `byField` / `byStatus` 行为 | `src/core/router-action.ts:65-81` | **守不住**——而且它那段是 `jsonc`，本来就不受测 |

> 「守不住」不是缺陷，是这道门的边界：它只保证**这份照抄件能被产品接受**，不保证**每句机制说法都被测过**。后四行要靠真跑一张图的 E2E 用例来钉。

### 本节其余说法的出处（上面那张表没列的）

| 说法 | 强制点 |
|---|---|
| 批量重激活全部目标 | `src/core/operation-lifecycle.ts:1281-1289` |
| agent 节点可以当路由器 | `src/core/operation-lifecycle.ts:1117`、`src/core/proposal.ts:100-104` |
| `when` 会把条件节点追加成一条依赖 | `src/core/graph.ts:40-47` |
| 上面那张 v40 JSON 被产品自己的 validator 接受 | `tests/console/design-examples.test.ts`（本页 = 它的输入） |
| 「本页 JSON 的受测范围」那张表的三条事实 | `tests/console/design-examples.test.ts:18-45` |

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
