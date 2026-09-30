# 评审 2 报告：worker-2 成果（复杂档 v40 文档车道）

**评审节点**：review-2（agent 评审，`focus: 只评 worker-2 的成果`）
**被评对象**：`worker-2` 操作 `ae40e2f2-3c76-4c43-ad6e-d0cd72b45ec4` 的 v1 产出
**提交**：`742ce4b graph:worker-2:ae40e2f2…`
**被评文件**：
- `docs/design-graph-examples.md`（主交付，194+/81-）
- `deliverables/v40-doc-notes.md`（车道报告）
**判定**：**PASS**（有 1 处必须修的非阻塞缺陷与 2 处建议）

---

## 1. 我独立复跑/复核了什么（不是读它的报告）

| 检查 | 命令 / 方法 | 结果 |
|---|---|---|
| 目标用例真绿 | `node --run test -- tests/console/design-examples.test.ts` | **2 passed**，exit 0（`Test Files 1 passed`） |
| **照抄 JSON 真被产品自己的 validator 接受** | 自写脚本：抓本页每个 ` ```json `+`"nodes"` 块 → 替换 `<模型 id>` → 直调 `src/core/proposal.ts` 的 `validateProposal` | 3 块全 **ACCEPTED**（简单档 / 中等档 / v40） |
| **测试不是套套逻辑**（阴性对照，我自己造的） | 对 v40 块做三处变异再喂 validator | 三处全部按**文档写的理由**被拒：删 `synth` 的 predecessors → `Fresh predecessor edge review-1 requires an explicit handoff policy`；`worker-2` 的 `when.case` 改 `approved` → `Branch must select a declared router case`；`checkNode` 改不存在节点 → `Each acceptance item requires an assigned mandatory program check or Agent router` |
| 车道只动了自己的文件 | `git show 742ce4b --name-only`；`git status --porcelain` | 恰好 2 文件（`docs/design-graph-examples.md` + 本报告 `deliverables/v40-doc-notes.md`），工作树干净 |
| typecheck / lint | `node --run typecheck`、`node --run lint` | 均 exit 0 |
| 文档引用的代码行号是否真实存在 | 逐条 `sed -n` 打开被引文件对行 | 18 处引用，**17 处准确**，1 处指向不存在行（见 §3.1） |
| 关键机制说法与源码是否一致 | 读 `operation-lifecycle.ts:1113-1116`（`filter` 非 `find`）、`:1280-1288`（`reactivate(routed.map(...))` + `graph.rework`）、`router-action.ts:54-85`/`:88-98`、`predecessor-handoff.ts:30-51`/`:495-523`、`graph.ts:40-47`/`:71-76`/`:127-136` | 与文档说法**一致** |

结论：worker-2 报告的**主要断言都经得起复跑**——照抄件真的被 validator 接受、阴性对照真的按文档写的错误信息被拒、只动了自己的文件、定向门禁全绿。

---

## 2. 逐条对计划 §2 车道 2 完成判据

| 计划要求 | 落地 | 判定 |
|---|---|---|
| 1. 用 v40 JSON 替换「完整初稿」（planner / plan-reviewer(accept\|replan) / worker-1..3 带 `when` / review-1..3 / synth agent 路由器 / deliver `graph.human_check`；四条 loop；acceptance 只绑 `deliver`） | `## v40 完整初稿`，与需求逐项对应；我独立验证 10 节点、4 loop、1 验收项，结构正确 | ✔ |
| 2. 加「和 `graph.verify` 形状差在哪」表 | `## 和 graph.verify 形状差在哪` 6 行对照表 | ✔ |
| 3. 硬规则补三条（每条带「不这么写会怎样」） | `## 五条硬规则`（实际写了 5 条，≥要求），每条都有后果 | ✔ |
| 4. 保留旧 `graph.verify` 写法一小段 + 适用场景 | `## 旧形状（graph.verify 机械判定）——保留，仍然合法`，jsonc 片段 + 「什么时候仍然选它」 | ✔ |
| 5. 同步档位一句话；不动简单档/中等档两节 | 开头「各档一句话」已更新；两节 JSON 我复跑确认仍原样 ACCEPTED | ✔ |
| M3（plan-review 次要偏差）：显式标注受测范围 | `## 本页 JSON 的受测范围` + 证据表「守得住/守不住」列 | ✔ |

**额外加分（诚实性）**：文档 §「本节的说法各自指回哪里」主动列出**4 行「守不住」**（`when` 的 skip 行为、多 loop 整批触发、`declared:null`、`review_human_check`）——即指出 `design-examples.test.ts` 这道静态门**测不到**这些运行时机制，须靠真跑一张图的 E2E 钉。这与计划 §2 车道 3「不许把静态写成实测」的精神一致，避免了读者把「测试全绿」误读成「每句机制都被测过」。

---

## 3. 缺陷

### 3.1 【必须修，非阻塞】`src/core/proposal.ts:100-104` 是**不存在的行号**（引用指向空处）

**文件**：`docs/design-graph-examples.md`

同一处坏引用出现**两次**：

- 第 518 行（证据表）：`| 验收 checkNode 必须是强制的 program 门或 agent 路由器 | src/core/proposal.ts:100-104 | 守得住 |`
- 第 532 行：`| agent 节点可以当路由器 | src/core/operation-lifecycle.ts:1117、src/core/proposal.ts:100-104 |`

**证据**：`src/core/proposal.ts` 只有 **73 行**（`wc -l` = 73），第 100–104 行不存在。该规则的真实位置是 **第 61–72 行**，`invalid(...)` 调用在 **第 71 行**：

```
$ sed -n '61,72p' src/core/proposal.ts
  for (const item of proposal.acceptance) {
    const check = nodes.get(item.checkNode);
    ...
    const isRouter = check?.kind === 'program' || (check?.kind === 'agent' && Boolean(check.routes?.length));
    if (!text(item.id) || !text(item.description) || !mandatory || !isRouter) invalid('Each acceptance item requires an assigned mandatory program check or Agent router');
```

**影响**：这一行恰是文档标记为「**守得住**」的一行——即它声称有测试钉住的那条。读者按行号去核验会**找不到东西**，这与本车道「每个机制说法都能指回 src/ 的文件:行」「让每句话都可核」的**自定完成判据直接冲突**。它不使 JSON 失效（validator 只吃 JSON 块），所以是非阻塞；但它正好破坏了这份交付的核心价值（可核验）。**不改会怎样**：整车道的「指回证据」承诺出现唯一一处断链，而 synth 与人工验收都被引导去按行号核验。

**修法**：把两处 `proposal.ts:100-104` 改成 `proposal.ts:61-72`（或精确到 `:71`）。仅动 `docs/design-graph-examples.md` 一处文件。

### 3.2 【建议】`operation-lifecycle.ts:1117` 行号偏一位

**文件**：`docs/design-graph-examples.md`（第 532 行）

`agentRouter` 的判定实际在**第 1118 行**，第 1117 行是空白/上一表达式：

```
$ sed -n '1115,1118p' src/core/operation-lifecycle.ts
      ? loadGraph(...).plan.loops.filter(...)
      : [];
    const agentRouter = operation.kind === 'agent' && Boolean(nodeSpec.routes?.length);
```

**影响**：轻微，读者多滑一行即命中。与 3.1 同属「行号精度」问题，可一并修。

### 3.3 【建议】`requirementVersion: 15` 在文档正文中无解释

**文件**：`docs/design-graph-examples.md`（第 335 行）

简单档与中等档两块都是 `"requirementVersion": 1`，v40 块却是 `15`。worker-2 在**报告** `deliverables/v40-doc-notes.md` §1.2 说明了「取自真跑 proposal」，但**文档本身**没有一句说明。读文档的 main agent 会疑惑「15 是随手抄的还是有含义」——对一份「照抄件」而言这是本可避免的噪音。

**影响**：不阻塞（validator 接受任意合法整数）。**修法**：在 v40 块上方加一句话说明 `requirementVersion` 来自被照抄的真实 proposal，可任意取值；或统一改成 `1`。同一文件。

---

## 4. 我未发现的问题（点名否证，供 synth 采信）

- **不是套套逻辑**：我用**自己写的**三处变异证明 validator 会拒（错误信息与文档逐字一致），而非仅凭 worker-2 报告的自述。
- **越界改文件**：无。`git show 742ce4b --name-only` 恰好 2 文件，`git status` 干净。
- **把静态写成实测**：无。文档专列「守不住」列，主动降低自己的证据强度声明。
- **全量 check 红嫁祸**：worker-2 称工作树全量 `node --run check` 因**环境**红（42 文件/128 用例，与本仓既有基线一致），并做了 stash 前后失败清单逐字节对照。此环境红在本仓其它车道文档中已被反复记录（`node_modules` 软链、`git ENOENT`、兄弟工作树缺失），与文档是纯 `.md` 改动**在机制上不可能相关**；我复核 `design-examples.test.ts` 不在失败集内、定向用例绿，**采信该结论**。

## 5. 给 synth 的一句话

worker-2 的车道**实质合格**：照抄 JSON 独立复跑被产品自己的 validator 接受、阴性对照按文档写的理由被拒、只动了自己的文件、定向门禁全绿、机制说法与源码一致。**唯一实质缺陷是 3.1 的坏行号 `proposal.ts:100-104`（文件仅 73 行）**，它破坏的是本车道最核心的「可核验」承诺，但**不使交付失效、不影响另外两条车道**——属于**可修的非阻塞缺陷**：若 synth 走 fail 返工，请只把这条（连同 3.2）作为返工简报发给 worker-2；若走 pass，请在汇总里显式记下该坏引用，供人工验收时一并修。

---

## 附：引用准确性清单（我逐条开的行）

| 文档引用 | 真实位置 | 判定 |
|---|---|---|
| `src/core/graph.ts:33-45` | 条件节点校验（`Branch must select a declared router case` 在 :45） | ✔ |
| `src/core/graph.ts:40-47` | `dependencies.push(condition.node)` | ✔ |
| `src/core/graph.ts:71-76` | loop 端点/回上游/唯一 | ✔ |
| `src/core/graph.ts:127-136` | `readiness()`（`skip` 判定） | ✔ |
| `src/core/operation-lifecycle.ts:1114-1116` | `loops.filter(from/case)` | ✔ |
| `src/core/operation-lifecycle.ts:1281-1289` | `reactivate(routed.map(...))` + `graph.rework` | ✔ |
| `src/core/router-action.ts:56-63` / `:91-98` | `resolveRouteCase` 的 `declared===null` 分支 / `agentChoosesItsOwnRoute` | ✔ |
| `src/core/predecessor-handoff.ts:41-51` | `defaultPredecessorHandoffMode` 默认表 | ✔ |
| `src/core/predecessor-handoff.ts:495-523` | `validatePredecessorPolicies`（`Fresh predecessor edge … requires an explicit handoff policy`） | ✔ |
| `src/runtime/agent-tool-definitions.ts:261` | `review_human_check` 定义（明写 "This is NOT acceptance"） | ✔ |
| `src/runtime/agent-tools.ts:438` | `review_human_check` 实现 | ✔ |
| `src/core/proposal.ts:100-104` | **文件仅 73 行，不存在**（真在 :61-72 / :71） | ✘ 见 3.1 |
| `src/core/operation-lifecycle.ts:1117` | `agentRouter` 实际在 :1118 | △ 见 3.2 |
