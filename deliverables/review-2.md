# 评审 2 报告（attempt 2）：worker-2 成果（复杂档 v40 文档车道）

**评审节点**：review-2（agent 评审，`focus: 只评 worker-2 的成果`）
**被评对象**：`worker-2` 操作 `ae40e2f2-3c76-4c43-ad6e-d0cd72b45ec4` 的 v1 产出
**提交**：`742ce4b graph:worker-2:ae40e2f2…`
**被评文件**：
- `docs/design-graph-examples.md`（主交付）
- `deliverables/v40-doc-notes.md`（车道报告）
**判定**：**PASS（可修的非阻塞缺陷，1 必修 + 2 建议）**

> attempt 2 说明：下游未被记为失败，我按返工指令**重跑了本节点喂给下游的全部检查**。本轮相比 attempt 1 有两处**更正**（见 §3.0 与 §6）：上一版把「删 `synth` 的 `predecessors` 即被拒」当作已复现的阴性对照，本轮实测该说法**不成立**——这既是文档的一处真实缺陷（3.1），也是我上一版自己的复核疏漏。

---

## 1. 我独立复跑/复核了什么（不是读它的报告）

| 检查 | 命令 / 方法 | 结果（本轮实测） |
|---|---|---|
| 目标用例真绿 | `node --run test -- tests/console/design-examples.test.ts` | **2 passed**，`Test Files 1 passed`，exit 0 |
| **照抄 JSON 真被产品自己的 validator 接受** | 自写脚本抓本页每个含 `"nodes"` 的 ` ```json ` 块 → 替换 `<模型 id>` → 直调 `src/core/proposal.ts` 的 `validateProposal` | **3 块全 ACCEPTED**（简单档 / 中等档 / v40） |
| 阴性对照（我自己造的变异，逐条喂 validator） | 见 §4 表；`when.case`、`loops`、`acceptance.checkNode` 各变异 | 3 类均按文档写的错误信息被拒 |
| **文档 evidence 表两处「守得住」是否真守得住** | 对 v40 块做与文档逐字一致的变异 | 3 行真守住，**1 行（handoff）不成立**——见 §3.1 |
| 文档引用的代码行号是否真实存在 | `wc -l` / `sed -n` 逐条打开被引文件对行 | 18 处引用，**16 处准确**，2 处坏/偏（§3.2、§3.3） |
| 车道只动了自己的文件 | `git show 742ce4b --name-only`；`git status --porcelain` | 恰好 2 文件，工作树干净 |
| 全量 `node --run check` 是否环境红 | `node --run check` | **exit 1：Test Files 42 failed / 186 passed (228)；Tests 128 failed / 1405 passed (1533)**，与 worker-2 报告的数字**逐位一致**；失败均为 `git ENOENT` / 兄弟工作树缺失类，`design-examples.test.ts` **不在失败集内** |
| 关键机制说法与源码一致 | 读 `operation-lifecycle.ts:1113-1118`、`:1117-1118`、`router-action.ts:54-98`、`predecessor-handoff.ts:30-51`/`:495-523`/`:525-543`、`graph.ts:40-47`/`71-76`/`127-136`、`proposal.ts:61-72` | 与文档说法一致 |

---

## 2. 逐条对计划 §2 车道 2 完成判据

| 计划要求 | 落地 | 判定 |
|---|---|---|
| 1. 用 v40 JSON 替换「完整初稿」（planner / plan-reviewer(accept\|replan) / worker-1..3 带 `when` / review-1..3 / synth agent 路由器 / deliver `graph.human_check`；四条 loop；acceptance 只绑 `deliver`） | `## v40 完整初稿`，我独立验证 10 节点、4 loop、1 验收项，结构正确 | ✔ |
| 2. 加「和 `graph.verify` 形状差在哪」表 | `## 和 graph.verify 形状差在哪` 6 行对照表 | ✔ |
| 3. 硬规则补三条（每条带「不这么写会怎样」） | `## 五条硬规则`（写了 5 条，≥要求），每条都有后果 | ✔ |
| 4. 保留旧 `graph.verify` 写法一小段 + 适用场景 | `## 旧形状（graph.verify 机械判定）——保留，仍然合法`，jsonc 片段 + 「什么时候仍然选它」 | ✔ |
| 5. 同步档位一句话；不动简单档/中等档两节 | 开头已更新；两节 JSON 复跑仍 ACCEPTED | ✔ |
| M3：显式标注受测范围 | `## 本页 JSON 的受测范围` + 证据表「守得住/守不住」列 | ✔（但见 §3.1：其中一行结论错误） |

---

## 3.0 本轮的两处更正（诚实性记录）

1. attempt 1 的证据表写了「删 `synth` 的 `predecessors` → `Fresh predecessor edge … requires an explicit handoff policy`」并把这条当作**已复现**。本轮实测：`synth` 带 `context.purpose: 'review'`，`independentReviewReceiver` 为真 → 默认 `evidence_only` → **删掉显式 `predecessors` 后仍被 ACCEPTED**。该断言不成立。
2. 因此文档第 516 行那句「守得住（删掉 `synth` 的 `predecessors` 即红）」是**一条假阳性证据声明**——它正是被评文件自我声明的「可核验」承诺的一部分。已升级为必修（§3.1）。

---

## 3. 缺陷

### 3.1 【必须修，非阻塞】evidence 表把 `synth` 的 handoff 行标成「守得住」，实测守不住——阴性对照不成立

**文件**：`docs/design-graph-examples.md` 第 **516** 行

原文：

```
| 跨 agent 边的 handoff `mode` | `src/core/predecessor-handoff.ts:495-523` | **守得住**（删掉 `synth` 的 `predecessors` 即红） |
```

**证据**（本轮我直调 `validateProposal`，用的就是本页那张 v40 JSON）：

```
$ node /tmp/t516.mjs
DOC 516 claim (delete synth predecessors): ACCEPTED -> test stays GREEN, claim is FALSE
delete entire predecessors list: ACCEPTED -> still green
```

原因在源码里写得清楚：`src/core/predecessor-handoff.ts:30-33` 的 `independentReviewReceiver` 对 `context.purpose === 'review'` 返回真，`synth` 正是 `"context": { "purpose": "review", ... }`，于是 `defaultPredecessorHandoffMode`（`:43-45`）返回 `evidence_only`——**不需要显式声明**，删掉也不红。真正会触发 `Fresh predecessor edge … requires an explicit handoff policy` 的是 **action/配方都不落在 review 或 implement 两类**、且源是 agent 的节点（我用最小提案复现：见 §4 的 MUT4）。

**影响**：这份文档的核心卖点就是「每句机制说法都指回 `文件:行`，并区分『测试真的在守』与『守不住』」。516 行把一条**测试并不守**的机制标成「守得住」并给出一个**不成立**的变异命令，等于给读者一个可证伪的证据声明——这正是计划 §2 M3 要防的「把静态写成实测」的反面：这里是「把没测到的说成测到了」。**不改会怎样**：synth 与人工验收若照该行去核验，会得到与文档相反的结果，整张证据表的可信度受连带损害。

**修法**（只动 `docs/design-graph-examples.md`）：把该行改为「**守不住**——`synth` 的 `purpose: 'review'` 有默认 `evidence_only`，删掉显式声明也不红；该错误只在接收方 action/配方**既不匹配 review 也不匹配 implement** 时出现」，或改用一个真会触发该错误的变异（例如把某个接收方改成 `action: 'synthesize'` 且去掉 `purpose`）。

### 3.2 【必须修，非阻塞】`src/core/proposal.ts:100-104` 是不存在的行号（引用指向空处），同一坏引用出现两次

**文件**：`docs/design-graph-examples.md` 第 **518** 行、第 **532** 行

- 第 518 行（证据表）：`| 验收 checkNode 必须是强制的 program 门或 agent 路由器 | src/core/proposal.ts:100-104 | 守得住 |`
- 第 532 行：`| agent 节点可以当路由器 | src/core/operation-lifecycle.ts:1117、src/core/proposal.ts:100-104 |`

**证据**：`wc -l src/core/proposal.ts` = **73**，第 100–104 行不存在。该规则真实位置是 **第 61–72 行**，`invalid(...)` 在 **第 71 行**：

```
$ sed -n '61,72p' src/core/proposal.ts
  for (const item of proposal.acceptance) {
    const check = nodes.get(item.checkNode);
    ...
    const isRouter = check?.kind === 'program' || (check?.kind === 'agent' && Boolean(check.routes?.length));
    if (!text(item.id) || !text(item.description) || !mandatory || !isRouter) invalid('Each acceptance item requires an assigned mandatory program check or Agent router');
```

**影响**：518 行恰是文档标为「守得住」的一行；读者按行号核验会找不到东西，与「每句话都可核」的承诺冲突。不使 JSON 失效（validator 只吃 JSON 块），故非阻塞。**修法**：两处 `proposal.ts:100-104` → `proposal.ts:61-72`（或 `:71`）。

### 3.3 【建议】`operation-lifecycle.ts:1117` 行号偏一位

**文件**：`docs/design-graph-examples.md` 第 **532** 行

`agentRouter` 判定实际在第 **1118** 行，1117 是上一表达式尾部：

```
$ sed -n '1115,1118p' src/core/operation-lifecycle.ts
      ? loadGraph(...).plan.loops.filter(...)
      : [];
    const agentRouter = operation.kind === 'agent' && Boolean(nodeSpec.routes?.length);
```

**修法**：`:1117` → `:1118`，可与 §3.2 一并修（同文件、相邻行）。

### 3.4 【建议】`requirementVersion: 15` 在文档正文中无解释

**文件**：`docs/design-graph-examples.md` 第 **335** 行

简单档/中等档都是 `"requirementVersion": 1`，v40 块却是 `15`。worker-2 在报告 §1.2 说明了「取自真跑 proposal」，但**文档本身**没交代。**修法**：在 v40 块上方加一句说明该值来自被照抄的真实 proposal、可任意合法整数；或统一为 `1`。同一文件。

### 3.5 【建议】第 450 行「无默认」表把 `synth` 当反例，与 `synth` 实际命中默认相矛盾

**文件**：`docs/design-graph-examples.md` 第 **450** 行

硬规则 2 的表格第三行写：`| 两者都不是（例：synth 的 action 是 synthesize） | 无默认 | 直接被拒 … |`。但同一页那张 v40 JSON 里的 `synth` 带 `"context": { "purpose": "review" }`，**命中第一行**（`purpose:'review'` → `evidence_only`）。因此拿 `synth` 当第三行的例子会误导读者：他会以为本页那张图里的 `synth` 需要显式 `predecessors`，实则不需要。

**证据**：

```
synth action= synthesize purpose= review
default mode for synth(<-review-1) = evidence_only
synth policies = {policies:[review-1:evidence_only, review-2:evidence_only, review-3:evidence_only], missing:[]}
```

**修法**：把第三行的例子换成一个**既不 review 也不 implement** 的接收方（例如 `action: 'synthesize'` 且不带 `purpose: 'review'`），或保留机制说明但改用 `<某节点>` 占位，避免与实际 v40 `synth` 冲突。同一文件。

---

## 4. 阴性对照总表（我逐条实跑，供 synth 采信）

| # | 变异（喂给 `validateProposal`） | 文档说法 | 实测 |
|---|---|---|---|
| MUT1 | `worker-2.when.case` 改成 `approved`（未声明的分支） | 应被拒 | **REFUSED** → `Branch must select a declared router case` ✔ |
| MUT2 | 删 `worker-2.when.case` | 应被拒 | **REFUSED** → 同上 ✔ |
| MUT3 | `loops[1].to = 'ghost'`（不存在的端点） | 应被拒 | **REFUSED** → `Loop endpoints must be distinct existing nodes` ✔ |
| MUT4 | 接收方 action 既不 review 也不 implement、源为 agent，且无显式声明 | 应被拒（真正触发 handoff 错） | **REFUSED** → `Fresh predecessor edge a requires an explicit handoff policy` ✔（最小提案复现） |
| MUT5 | 删 `synth` 的 `context.predecessors` | 文档 516 行称「即红」 | **ACCEPTED** ✘ —— **文档此断言不成立**，见 §3.1 |
| MUT6 | `acceptance[0].checkNode = 'nope'` | 应被拒 | **REFUSED** → `Each acceptance item requires an assigned mandatory program check or Agent router` ✔ |

一个真阳性的阴性对照（MUT1/3/4/6）证明这张 JSON 与 validator **是耦合的**、测试不是套套逻辑；MUT5 同时暴露了文档一处**假阳性证据声明**。

---

## 5. 我未发现的问题（点名否证，供 synth 采信）

- **不是套套逻辑**：MUT1/3/4/6 用我自造的变异证明 validator 会拒（错误信息与文档逐字一致），非仅凭 worker-2 报告自述。
- **越界改文件**：无。`git show 742ce4b --name-only` 恰好 2 文件（`docs/design-graph-examples.md` + `deliverables/v40-doc-notes.md`），`git status` 干净。
- **把静态写成实测（整体）**：文档专列「守不住」列主动降低证据强度，方向正确；**但 516 行是一个反例**（已列 §3.1），非系统性。
- **全量 check 红嫁祸**：worker-2 称全量 `node --run check` 因**环境**红。本轮我独立重跑：`Test Files 42 failed | 186 passed (228)`、`Tests 128 failed | 1405 passed (1533)`，**与它报告的数字逐位一致**；失败为 `git ENOENT` / 兄弟工作树缺失，`design-examples.test.ts` 不在失败集内。纯 `.md` 改动在机制上不可能造成这些失败，**采信环境红结论**。

---

## 6. 给 synth 的一句话

worker-2 的车道**实质合格**：照抄 JSON 独立复跑被产品自己的 validator 接受（3/3），真阳性的阴性对照成立，只动了自己的文件，定向门禁全绿，机制说法与源码一致；环境红与其 `.md` 改动无关且数字自洽。

**必修两条**（均只动 `docs/design-graph-examples.md`）：
1. **§3.1（新）**：516 行「守得住」是**假阳性证据声明**——删 `synth` 的 `predecessors` 实测 ACCEPTED，该行须改为「守不住/换变异」；
2. **§3.2**：`proposal.ts:100-104` 是**不存在的行号**（文件仅 73 行，真在 `:61-72`），出现两次（518、532 行）。

两条**都不使交付失效、不影响另外两条车道**，属可修的非阻塞缺陷。若走 fail 返工，请把 §3.1、§3.2（连同建议 §3.3/§3.5）作为返工简报发给 worker-2；若走 pass，请在汇总显式记下这两处，供人工验收一并修。

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
| `src/core/predecessor-handoff.ts:41-51` | `defaultPredecessorHandoffMode` 默认表 | ✔（注意 `:30-33` 的 `purpose:'review'` 优先，见 §3.5） |
| `src/core/predecessor-handoff.ts:495-523` | `validatePredecessorPolicies`（`Fresh predecessor edge …`） | ✔ |
| `src/runtime/agent-tool-definitions.ts:261` | `review_human_check` 定义 | ✔ |
| `src/runtime/agent-tools.ts:438` | `review_human_check` 实现 | ✔ |
| `src/core/proposal.ts:100-104` | **文件仅 73 行，不存在**（真在 `:61-72`/`:71`） | ✘ 见 §3.2 |
| `src/core/operation-lifecycle.ts:1117` | `agentRouter` 实际在 `:1118` | △ 见 §3.3 |
