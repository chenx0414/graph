# 执行计划：把「一个执行者 + N 个视角评审 + 一处机械判定」落成可照抄、可机械校验的整图

**本文件是 planner 节点的交付物（`plans/plan.md`），交给 plan-reviewer 审，并由 worker 节点按它执行。**
目标分支：`main`（基线 `201458e`，含 `2f5c5cd`）。

---

## 0. 目标与范围（先划清边界，再看步骤）

**目标**：把使用者的复杂档「一个执行者 + N 个视角评审 + 一处机械判定」那张图，落成 main 上**可照抄**（文档里一份能通过产品自己 validator 的 ` ```json ` 整图）且**可机械校验**（一条测试钉住它与 v40 不同的箭头 + 一条宿主门命令）的东西。

**本节点只允许动这三个文件**（worker 的文件清单）：

| 文件 | 动作 |
|---|---|
| `docs/design-graph-examples.md` | 把「旧形状（`graph.verify` 机械判定）」一节里的 ` ```jsonc ` 片段，**换成一份完整的 ` ```json ` 整图**；并修掉因此变假的两处「不受测」说法 |
| `tests/console/design-examples.test.ts` | **新增**一个用例，钉住这张图与 v40 不同的三条箭头 |
| `package.json` | 新增脚本 `"test:design-examples": "vitest run tests/console/design-examples.test.ts"`（宿主门用） |

**明确不做**：

- 不改 `src/**`（`resolveRouteCase`、`validateProposal` 只**被引用**，不被修改）。
- 不改文档里 v40 那一节的主体（v40 的整图 JSON、机制点、真跑回执、五条硬规则都原样保留）。
- 不改简单档、中等档两节；不改 `tests/console/complex-tier-shape.test.ts`（那是另一张图的可执行版本）。
- 不删除 `design-examples.test.ts` 现有的两个用例。

> **一处必须动的、看起来像「v40 那一节」的行**：文档第 315 行「本页 JSON 的受测范围」表里有一行写「下面『`graph.verify` 旧形状』里那段是 ` ```jsonc ` **片段**，**不被测**」。把 jsonc 换成整图之后这句话**变成假的**，必须同步改。它属于**全页**受测说明，不属于 v40 的图/机制内容，所以是允许且必要的一处；审查时按「文档自洽」验收，不要按「越界改 v40」判。

---

## 1. 已核实的事实（写计划前实测过，plan-reviewer 可按此复核）

| # | 事实 | 证据（本轮实测） |
|---|---|---|
| F1 | 本计划 §3 那张候选整图**被产品自己的 `validateProposal` 接受** | 用 `src/core/proposal.ts` 的 `validateProposal` 直接跑候选图，输出 `ACCEPTED`（候选图与 §3 逐字相同，仅 `model` 占位符替换规则同测试） |
| F2 | 宿主门当前**在工作副本里可跑通**，基线是 **2 passed (2)** | `./node_modules/.bin/vitest run tests/console/design-examples.test.ts` → `Test Files 1 passed (1) / Tests 2 passed (2)`，125ms |
| F3 | 工作副本的依赖需要先链接，否则 vitest 不可用；本副本已按 `docs/guides/checks.md` 用**硬链**链接 | `cp -al /Users/macmini/workspace/13-Graph/node_modules node_modules` 已执行；`node_modules/` 被 `.gitignore` 忽略，`git status` 干净 |
| F4 | 文档里**每一个**「` ```json ` 开头且正文含 `"nodes"`」的整图都会被原样喂给 `validateProposal`，被拒即红 | `tests/console/design-examples.test.ts:18-45`（`examples()`） |
| F5 | 第二个用例另外要求 `acceptance[].checkNode` 与 `loops[].from/to` 都必须是图里存在的节点 | `tests/console/design-examples.test.ts` 第二个 `test` |
| F6 | 待替换的 jsonc 片段在 `docs/design-graph-examples.md:494`；「不受测」的说法还在第 315、509、542 行 | `grep -n 'jsonc' docs/design-graph-examples.md` |
| F7 | `multiview` 的 `reportNodes` 必须是判定节点的**可达依赖**，每个 `dimensions[].reportNode` 必须列在 `reportNodes` 里 | `src/core/verification.ts` 的 `validateVerifierConfig` |
| F8 | `loops[].case` 必须写，且必须是 `from` 路由器 `routes` 里声明过的分支；否则整张提案被拒 | `src/core/graph.ts:71-76`（`A loop case must name a branch the router declared`） |
| F9 | `byField` 读**路由器自己**产物里的字段；`byStatus` 把「有结论=completed」的判定节点永远映射到同一个分支，**返工分支是死代码** | `src/core/router-action.ts:56-81`；`tests/console/complex-tier-shape.test.ts` 最后一个用例已实证（`byStatus` → `{case:'yes'}`，`byField` → `{case:'no'}`） |
| F10 | `when: {node, case}` 会把条件节点追加成依赖并挡下游；`plan-reviewer` 车道**并列**时不写 `when` 在 worker 上，worker 就只等 `planner` | `src/core/graph.ts:33-47`、`:127-136` |
| F11 | 本仓库完整门 `node --run check` 在 Graph 工作副本里跑不过（实测 main `2f5c5cd`：127 failed / 1541）；所以宿主门**只用** scoped 命令 | `docs/adr/0027-work-copy-dependency-link.md` 追加节 + job 约束 |
| F12 | 目标分支 `main` = `201458e`，与工作副本 HEAD 相同；`plans/plan.md` 是 tracked 文件（上一轮任务提交过） | `git rev-parse --show-toplevel`、`git log -- plans/plan.md` |

---

## 2. 步骤（每步：交付物 / 验收点 / 命令）

顺序按 R22：**先让新用例红，再改文档让它绿**。

### 步骤 A — 先加宿主门脚本（让门命令存在）

**交付物**：`package.json` 新增 `"test:design-examples": "vitest run tests/console/design-examples.test.ts"`（放在 `test:m0` 一带）。

**验收点**：
- `node --run test:design-examples` 能识别脚本（当前**必然红**，因为新用例还没写，只有现有 2 个用例——这一步只需确认命令能跑起来）。
- 除这一行外 `package.json` 无其它 diff。

**命令**：`node --run test:design-examples`

### 步骤 B — 先写会红的用例（R22：先看它因正确原因失败）

**交付物**：`tests/console/design-examples.test.ts` 新增一个 `test`，**复用文件里已有的 `examples()`**，按「图里有节点 `pass`」选出这张机械判定图，断言：

1. **回边只回 worker**：`proposal.loops.filter(l => l.from === 'pass')` 恰好是 `[{ to: 'worker', case: 'no' }]`（不是三条、不是指别人）。
2. **计划车道并列、不挡 worker 开工**：`worker.when === undefined` 且 `worker.dependsOn` **不含** `plan-reviewer`；同时存在 `{ from: 'plan-reviewer', to: 'planner', case: 'replan' }`。
3. **判定节点的结论经 `byField` 变成 yes/no，而 `byStatus` 是死写法**：
   - `pass.routes` 恰为 `['yes','no']`；`pass.input.route` 恰为 `{ byField: { path: 'outcome', values: { pass: 'yes', rework: 'no' } } }`；
   - 用 `resolveRouteCase`（从 `src/core/router-action.ts` 引入）证明：同一份 `output:{outcome:'rework'}` 下，`byStatus:{completed:'yes'}` → `{case:'yes'}`（**死写法**），`byField:{path:'outcome',values:{pass:'yes',rework:'no'}}` → `{case:'no'}`。
4. **`when` 门指向 `pass=yes`**：`haiku.when` 恰为 `{ node:'pass', case:'yes' }`，且 `deliver.action === 'graph.human_check'`。

实现注意（避免用例写不出来的坑）：
- `NodeSpec.input` 的类型是 `Json`，取 `pass.input.route` 需要一次窄化（如 `(pass.input as Record<string, Json> | undefined)?.route`）；**不要**为了好写而 `as any` 掉断言强度。
- 选图时若找不到 `pass` 节点，用 `expect(found, '…').toBeDefined()` 给出**可读原因**，而不是 `!` 硬取。
- 现有两个 `test` 一字不改。

**验收点（这一步的关键）**：跑新用例时**必须红，且红的原因**是「文档里还没有含 `pass` 节点的 ` ```json ` 整图」——即 `examples()` 找不到该图。若它因为 `JSON.parse` 语法错、导入错或别的原因红，不算通过本步。

**命令**：`node --run test:design-examples`（期望：新用例失败，现有 2 个仍绿）

### 步骤 C — 改文档：jsonc 片段 → 完整整图

**交付物**：
1. 把 `docs/design-graph-examples.md:494` 的 ` ```jsonc ` 片段整段替换成 §3 给出的**完整 ` ```json ` 整图**（逐字使用；`model` 写 `<模型 id>`，测试会替换成 `example:model`）。
2. 修掉因替换而变假的三处说法：
   - 第 315 行（全页受测范围表）：改为「本页所有 ` ```json ` 整图（含机械判定那张）都受测；本页已无不受测的 jsonc 片段」。
   - 第 509 行 blockquote：改为「这是**整图**，会被 `design-examples.test.ts` 原样喂给 `validateProposal`」，并保留「什么时候仍选它 / 两条仍有效的规则（`multiview` 必过维度、**不要用 `byStatus`**）」。
   - 第 542 行（本节说法出处表）：把「那段是 jsonc，本来就不受测」改成「那段现在是受测整图，`byField`/`byStatus` 行为由 `tests/console/design-examples.test.ts` 的新用例钉住」。
3. 小节标题与首句按需微调（它不再只是「旧形状、不受测」，而是一张**可照抄的整图**），但**不删**「旧形状保留、仍然合法」的定位与适用场景说明。

**验收点**：
- `node --run test:design-examples` **exit 0**（这同时证明新整图被 `validateProposal` 接受 + 新用例的断言全部成立 + 现有 2 个用例仍绿）。
- `git diff --stat` 只出现 `docs/design-graph-examples.md`、`tests/console/design-examples.test.ts`、`package.json` 三个文件。
- 文档里 `grep -n 'jsonc' docs/design-graph-examples.md` 不再出现「不受测/不被测」的断言（若有 jsonc 字样，必须是在说「不再有 jsonc」）。

**命令**：`node --run test:design-examples`、`git diff --stat`

### 步骤 D — 收尾证据（写进 worker 的 `result` 摘要）

**交付物**：worker 在 `result` 输出里贴：产物引用（文件路径 + commit）、`node --run test:design-examples` 的**完整输出尾部**（`Test Files` / `Tests` 计数与 exit code）、`git diff --stat`。

**验收点**：证据里三条命令的结果都是**原文**，不是「已通过」一句话；失败就贴失败输出。

**命令**：`node --run test:design-examples; echo "exit=$?"`、`git diff --stat`

---

## 3. 步骤 C 要插入的整图（候选图已被 `validateProposal` 实测接受，见 F1）

```json
{
  "requirementVersion": 1,
  "summary": "复杂档机械判定：planner 出计划、plan-reviewer 并列评审（不过就返工 planner）；一个 worker 实现，三个视角评审；pass 用 graph.verify + multiview 把三份评审汇成一处结论，再由 byField 变成 yes/no；yes 才进 haiku 与人工验收，no 回到 worker",
  "decisions": [
    "判定用 graph.verify 的 multiview：三个视角的必过维度全过才算 pass，结论由维度规则算出而不是某个 agent 拍板",
    "结论经 input.route.byField 读判定节点自己产物里的 outcome（pass→yes / rework→no）；不要用 byStatus，那会把返工分支变成死代码",
    "计划评审是并列车道：plan-reviewer 判 replan 只返工 planner，不挡 worker 开工（worker 上没有指向 plan-reviewer 的 when）",
    "验收只绑 deliver（graph.human_check）：机械判定保证维度，人负责最终接受"
  ],
  "acceptance": [
    { "id": "human-accept", "description": "使用者确认整份交付可接受", "checkNode": "deliver" }
  ],
  "loops": [
    { "from": "pass", "to": "worker", "case": "no" },
    { "from": "plan-reviewer", "to": "planner", "case": "replan" }
  ],
  "nodes": [
    { "id": "planner", "kind": "agent", "action": "plan", "definitionVersion": "coder@10", "model": "<模型 id>",
      "deliverable": { "path": "plans/plan.md", "namespace": "plans", "name": "plan", "title": "执行计划" },
      "input": { "focus": "把任务拆成可执行计划，写入 plans/plan.md" } },
    { "id": "plan-reviewer", "kind": "agent", "action": "plan-review", "definitionVersion": "reviewer@8", "model": "<模型 id>",
      "dependsOn": ["planner"], "routes": ["accept", "replan"],
      "context": { "purpose": "review", "predecessors": [{ "source": "planner", "mode": "evidence_only" }] },
      "deliverable": { "path": "reviews/plan-review.md", "namespace": "reviews", "name": "plan-review", "title": "计划评审报告" },
      "input": { "focus": "审查计划是否可行；通过则放行，不通过则要求返工", "route": { "declared": null } } },
    { "id": "worker", "kind": "agent", "action": "implement", "definitionVersion": "coder@10", "model": "<模型 id>",
      "dependsOn": ["planner"],
      "context": { "purpose": "implement", "predecessors": [{ "source": "planner", "mode": "evidence_only" }] },
      "deliverable": { "path": "docs/evidence/implementation.md", "namespace": "deliverables", "name": "implementation", "title": "实现说明" },
      "input": { "focus": "按计划完成实现，并写 docs/evidence/implementation.md" } },
    { "id": "reviewer-1", "kind": "agent", "action": "review-correctness", "definitionVersion": "reviewer@8", "model": "<模型 id>",
      "dependsOn": ["worker"],
      "context": { "purpose": "review", "predecessors": [{ "source": "worker", "mode": "evidence_only" }] },
      "deliverable": { "path": "reviews/reviewer-1.md", "namespace": "reviews", "name": "reviewer-1", "title": "视角 1：正确性" },
      "input": { "focus": "只评 worker 的成果是否真的成立，主动找反例" } },
    { "id": "reviewer-2", "kind": "agent", "action": "review-fidelity", "definitionVersion": "reviewer@8", "model": "<模型 id>",
      "dependsOn": ["worker"],
      "context": { "purpose": "review", "predecessors": [{ "source": "worker", "mode": "evidence_only" }] },
      "deliverable": { "path": "reviews/reviewer-2.md", "namespace": "reviews", "name": "reviewer-2", "title": "视角 2：规格符合性" },
      "input": { "focus": "逐条对照需求与验收点，找漏项与假绿" } },
    { "id": "reviewer-3", "kind": "agent", "action": "review-reproducibility", "definitionVersion": "reviewer@8", "model": "<模型 id>",
      "dependsOn": ["worker"],
      "context": { "purpose": "review", "predecessors": [{ "source": "worker", "mode": "evidence_only" }] },
      "deliverable": { "path": "reviews/reviewer-3.md", "namespace": "reviews", "name": "reviewer-3", "title": "视角 3：可复核性" },
      "input": { "focus": "自己把交付物跑一遍，检查证据是否可复现" } },
    { "id": "pass", "kind": "program", "action": "graph.verify",
      "dependsOn": ["worker", "reviewer-1", "reviewer-2", "reviewer-3"], "routes": ["yes", "no"],
      "verifier": {
        "kind": "multiview", "subjectNode": "worker",
        "reportNodes": ["reviewer-1", "reviewer-2", "reviewer-3"],
        "dimensions": [
          { "id": "correctness", "required": true, "reportNode": "reviewer-1" },
          { "id": "fidelity", "required": true, "reportNode": "reviewer-2" },
          { "id": "reproducibility", "required": true, "reportNode": "reviewer-3" }
        ]
      },
      "input": { "route": { "byField": { "path": "outcome", "values": { "pass": "yes", "rework": "no" } } } } },
    { "id": "haiku", "kind": "agent", "action": "summarize", "definitionVersion": "coder@10", "model": "<模型 id>",
      "dependsOn": ["pass"], "when": { "node": "pass", "case": "yes" },
      "input": { "focus": "把通过机械判定的交付总结成一段给使用者的汇报" } },
    { "id": "deliver", "kind": "program", "action": "graph.human_check", "dependsOn": ["haiku"], "input": {} }
  ]
}
```

> 若最终插入的 JSON 与上面有任何字符差异（例如 `model` 不是 `<模型 id>`、`loops` 端点被改名），步骤 C 的验收（`node --run test:design-examples` 绿）**必须重跑**；这张候选图的 `ACCEPTED` 结论只对**逐字相同**的这份负责。

---

## 4. 风险与回退

| # | 风险 | 触发信号 | 回退 / 预案 |
|---|---|---|---|
| R1 | `multiview` 配置与依赖不匹配（`dimensions[].reportNode` 不在 `reportNodes`、或 report 节点不是 `pass` 的可达依赖） | `validateProposal` 抛 `invalid_proposal`：`Dimension reportNode must be listed in reportNodes` / `Verifier reports must be current dependencies` | 直接对照 §3 的 `pass` 节点逐字恢复（候选图已实测 ACCEPTED）；不要自己发明依赖结构 |
| R2 | `loops[].case` 写错或漏写：写错 → 整张提案被拒；漏写 → 校验期合法但运行时**死边** | 前者报 `A loop case must name a branch the router declared`；后者只有新用例会红 | 恢复 `pass` 的 `routes: ['yes','no']` 与两条 `case`（`'no'` / `'replan'`）；新用例第 1、2 条断言就是防这个 |
| R3 | 把 worker 写成 v40 那样 `when: {node:'plan-reviewer', case:'accept'}`（计划放行才开工） | 新用例第 2 条断言红（`worker.when` 应为 `undefined`） | 删掉 worker 的 `when`；本图要的是**并列**车道，不是放行门 |
| R4 | 判定节点写成 `byStatus`（validator 不会拒，但返工分支是死代码） | 新用例第 3 条断言红（`pass.input.route` 不等于 `byField`） | 改回 `byField: { path: 'outcome', values: { pass:'yes', rework:'no' } }` |
| R5 | 文档改了整图却留下「这段不受测」的旧说法 | 第 315/509/542 行的 `grep` 仍命中「不受测/不被测」 | 按步骤 C.2 的三处逐条改；这是 reviewer-2 的规格符合性验收点 |
| R6 | 新用例因环境（依赖没链接 / vitest 找不到）而红，被误当成「先红后绿」的合法红 | 报错是模块解析或 `vitest: not found` | 先 `cp -al /Users/macmini/workspace/13-Graph/node_modules node_modules`（F3），确认基线 `2 passed` 后再进入步骤 B |
| R7 | 顺手把完整门 `node --run check` 当验收门 | 出现 127 failed / 1541 一类的环境失败 | **门只认** `node --run test:design-examples`（F11）；完整门在本工作副本里本来就不成立，不要为它改别人的测试 |
| R8 | 越界改动（`src/**`、v40 整图、简单/中等档、`complex-tier-shape.test.ts`） | `git diff --stat` 出现第四个文件 | 立刻 `git checkout HEAD -- <越界文件>`；越界改动不会落地，且会被 reviewer 判不通过 |

**统一回退方式**：本轮改动只落在 3 个文件、且是**加性**的（新增一段整图 + 新增一个用例 + 新增一行脚本）。任一步走坏，`git checkout HEAD -- docs/design-graph-examples.md tests/console/design-examples.test.ts package.json` 即回到基线 `201458e`（F12），不会牵连别的车道。

---

## 5. 交付物与证据清单（worker 提交 `result` 时按这张表收）

| 交付物 | 路径 | 验收点 |
|---|---|---|
| 文档整图 | `docs/design-graph-examples.md` | `node --run test:design-examples` exit 0；`grep -n jsonc` 无「不受测」断言 |
| 钉箭头的用例 | `tests/console/design-examples.test.ts` | 新用例先红（找不到 `pass` 整图）后绿；现有 2 个用例仍绿 |
| 宿主门脚本 | `package.json` | `node --run test:design-examples` 可执行 |
| 证据 | worker `result` 摘要 | 三条命令原文 + exit code + `git diff --stat` |

**给三个视角评审的对照物**：本计划 §1 的事实表、§3 的候选整图、§4 的风险表，分别是「正确性」「规格符合性」「可复核性」三份评审各自该独立复核的靶子——reviewer-3 尤其要**自己重跑** `node --run test:design-examples`，不要引用 worker 的输出当自己的证据。
