# Synthesise：v40 三车道评审汇总与判定

**节点**：synth（agent 路由器，`synthesizer@1`，`route.declared = null`）
**上游**：review-1 / review-2 / review-3（三份评审全部到齐，无缺）
**判定**：**fail**

---

## 0. 判定摘要

| 评审 | 被评车道 | 评审自身判定 | 我收录的必修项 |
|---|---|---|---|
| review-1 | worker-1（`tests/console/complex-tier-v40.test.ts`） | **PASS**，无阻塞缺陷 | 无（N1 读数不精确，非阻塞） |
| review-2 | worker-2（`docs/design-graph-examples.md`） | **PASS**，但显式标注 **2 条「必须修」** | **2 条（§3.1、§3.2）** |
| review-3 | worker-3（`notes/complex-tier-v40-mechanisms.md`） | **pass**，F1 moderate 不阻断 | 无 |

**三份评审的最终结论都是 pass，但 review-2 明确以「必须修」标注了两处未被任何其它证据驳回、且经我独立复核属实的缺陷。本汇总据此判 fail。** 详见 §4。

---

## 1. 收齐的报告（逐份点名）

| 报告 | 版本 / 摘要 | 字节 | 自述判定 |
|---|---|---|---|
| `reviews/review-1@1`（节点 review-1，operation `3c112499`） | 评审 1：worker-1 成果的独立审查 | 8791 | **PASS** |
| `reviews/review-2@3`（节点 review-2，operation `04986504`，supersedes @2 = attempt 1） | 评审 2（attempt 2）：worker-2 复杂档 v40 文档车道 | 14832 | **PASS（可修非阻塞：1 必修 + 2 建议）** |
| `reviews/review-3@2`（节点 review-3，operation `516955ee`，supersedes @1） | 评审 3：worker-3 成果 | 8891 | **correctness = pass** |

三份齐全，且**都是重新验过的版本**：review-2 用 @3（attempt 1 → 2 的自我更正版）替换了 @2，review-3 用 @2 替换了 @1。我采信的都是最新版本。

---

## 2. 各方一致点（可直接采信）

以下四条由三份评审**各自独立复现**得出，互相印证，我采信：

1. **各车道定向用例真绿，不是套套逻辑**
   - review-1：`node --run test -- tests/console/complex-tier-v40.test.ts` → **8 passed**，exit 0
   - review-2：`design-examples.test.ts` → **2 passed**，且**照抄的 3 个 JSON 块被产品自己的 `validateProposal` 全部 ACCEPTED**（简单档/中等档/v40）
   - review-3：`review-as-router node-deliverable human-prereview human-prereview-e2e design-examples` → **5 files / 19 tests passed**，exit 0
2. **全量 `node --run check` 的红与三条车道无关**。三人都复现了失败集，且**没有一份失败清单里出现本车道文件**；review-1 另做了「放射性证明」——在干净副本里带上本车道文件后 m8 两条用例照样绿（11/11）。review-2 复跑的数字与 worker-2 报告**逐位一致**。
3. **文件边界干净，无越界**。三份 commit 各自只含自己车道声明的 2 个文件；`src/**`、`tests/**`（worker-3）零改动；`git status` 均干净。
4. **阴性对照有真实判别力**（R27 要求，非自我实现）。review-1 做了变异实验：删 `when` → FM1 红；三条 fail 回边只留一条 → FM3 红。review-2 造了 6 个变异喂 validator：MUT1/2/3/4/6 全被 REFUSED 且错误信息与文档逐字一致。

**review-1 独有的一条实质正面发现**（值得记入知识库，v40 的文档与后续图都受益）：

> v40 的 `deliver` **没有 `when`**，只有 `dependsOn:['synth']`——而「失败」同样满足这个依赖。真正守住人工验收门的是**返工本身**：`reactivate` 沿 `GraphPlan.dependents` 把 `deliver` 一起重置（`src/core/operation-lifecycle.ts:217`），不是 `deliver` 上的条件。

**review-3 的两条「与需求相反」发现**（非缺陷，是需求与机制的落差，已独立证实）：
- **评审节点不会用 space-bunny-free**：`presets/manifest.json` 的 reviewer 带 `review:true` → `model-selection.ts:12-17 isReviewer` → 实现者模型进 `exclude`，DB 里 `plan-reviewer`、`review-3` 均发生 `model.switched → deepseek-v4.1-flash`。worker-3 预测「review-1..3 与 synth 也会被换」已被运行证实。
- **「先由主 Agent 审证据」的「先」不是门**：`human_check` 打开瞬间主 Agent 就被唤醒，`approveHumanCheck` 只追加 `preReview` 并发事件，check 仍 open。工具描述里的 "before the user is asked" 只是注意力顺序。

---

## 3. 冲突与更正

| # | 冲突 | 裁决 |
|---|---|---|
| C1 | **review-2 §3.3 说文档的 `operation-lifecycle.ts:1117` 偏一位、应为 `:1118`**（review-1 的机制表也写了 1118） | **两位评审都错，文档是对的。** 我 `grep -n agentRouter` 实测：`const agentRouter = operation.kind === 'agent' && Boolean(nodeSpec.routes?.length);` **就在第 1117 行**。→ **§3.3 从返工简报中剔除**，采纳它会把文档改成错的 |
| C2 | review-1 说 `proposal.ts` 真实区间 `63-72`（invalid 在 `71`）；review-2 说 `61-72` | 非实质冲突：63 是 `for` 循环首行，61-62 是数组/去重前置检查，`invalid(...)` 确实在 **71**。返工统一写成 **`proposal.ts:61-72`（`invalid` 在 `:71`）** |
| C3 | review-2 attempt 1 曾把「删 `synth` 的 `predecessors` 即红」当作已复现；attempt 2 实测推翻了自己 | **采信 attempt 2**。attempt 2 的方向（自我推翻 + 用 MUT4 给出真正会触发该错误的最小反例）使结论更可信，不是更弱 |
| C4 | review-1 的 N1：全量失败计数不可逐字复现（42/187 vs 43/185，环境抖动） | 非阻塞，采信「本车道不引入新失败」这一**结论**（review-1 用放射性证明独立证实）；读数不精确不返工 |

**review-2 §3.1 / §3.2 我已独立复核，均属实**（不采信转述，直接开源码与文件）：

- §3.1：`docs/design-graph-examples.md:516` 写「**守得住**（删掉 `synth` 的 `predecessors` 即红）」。我在文件里确认该行原文；`synth` 节点确实是 `"context": { "purpose": "review", "predecessors": [...] }`；`predecessor-handoff.ts:30-33` 的 `independentReviewReceiver` 对 `purpose === 'review'` 返回真 → `defaultPredecessorHandoffMode` **第一个分支就返回 `evidence_only`** → 删掉显式声明照样 ACCEPTED。**该行是假阳性证据声明。**
- §3.2：`wc -l src/core/proposal.ts` = **73**，文档第 **518**、**532** 行引的 `proposal.ts:100-104` **不存在**；真实位置 `61-72`，`invalid(...)` 在 `71`（已 `sed` 打开确认）。
- §3.5（建议）：文档第 **450** 行硬规则表把 `synth` 当作「两者都不是（无默认→直接被拒）」的反例，但同一页的 `synth` 带 `purpose:'review'`，**命中第一行 `evidence_only`**——同一页自相矛盾。

---

## 4. 判定：**fail**

### 4.1 判定的依据

我的汇总规则：**任意一份评审指出「必须修」的问题，且该问题未被其它证据驳回 → fail。**

review-2 §3.1 与 §3.2 写明「**必须修**」（小节标题即 `【必须修，非阻塞】`，§6 再次写「**必修两条**」），**未被 review-1 / review-3 驳回**（两份均未涉及；review-1 反而在 §2 独立确认 `proposal.ts:100-104` 是错行号、真值在 63-72 一带），**且我已亲自开源码与文件复核为真**（§3 末段）。

### 4.2 为什么「非阻塞」「PASS」不足以放行

这一点必须诚实说明：**三份评审的最终结论都是 pass，review-2 也自评这两条「不使交付失效」。** 我仍然判 fail，理由是：

1. **这不是风格偏好或评级差异，是交付物里的事实错误。** 缺陷恰好落在 `docs/design-graph-examples.md` 整份文档的**卖点**上——该节标题是「本节的说法各自指回哪里，以及**哪条是上面那道测试真的在守的**」。516 行在一个专门用于「诚实区分守得住/守不住」的表里，把一条**并不守得住**的机制标成「守得住」，还附了一条**实测为假**的变异命令。这是把「没测到的说成测到了」，正是本项目规则明令禁止的方向。
2. **「非阻塞」的论证依据是范围，不是严重性。** review-2 说「不影响另外两条车道」——对，但也不影响本车道；它影响的是**用户读到的证据是否可信**。人手验收（`deliver`）是用户的**确认动作，不是修 bug 的车道**；把已知为假的证据声明放进验收，等于要求用户在验收时替文档抓错。
3. **成本不对称。** 误放行的代价是「谎报测试覆盖」的文档合入主干，事后无人会再看它；误判 fail 的代价是三个 worker 重跑一轮——其中 worker-1/3 本就零阻塞缺陷，返工只是复跑确认（见 §5）。B2 规定 fail 即整批返工，不按名单，本来就是用户的既定设计。

### 4.3 本次 fail 的范围

**只落在 `docs/design-graph-examples.md` 一个文件的 4 处**（2 必修 + 2 建议），**不涉及任何行为、测试或机制实现**。三条车道的实质内容（E2E 形状测试、v40 JSON 与证据表、机制对照分析）经三份评审独立验证为**合格**。返工是定点修字，不是重做。

---

## 5. 返工项（谁、改什么、改到什么程度算通过）

按 B2「整批重做」，三条 `synth--fail-->` 回边全部激活。

### worker-2（**唯一有必修项的车道**）

只允许改 `docs/design-graph-examples.md`：

| # | 位置 | 改什么 | 算通过的标准 |
|---|---|---|---|
| **M1**（必修） | 第 **516** 行 | 把「跨 agent 边的 handoff `mode` … **守得住**（删掉 `synth` 的 `predecessors` 即红）」改为**「守不住」**并说明真实原因：`synth` 的 `purpose:'review'` 使 `independentReviewReceiver` 为真，默认已是 `evidence_only`，删掉显式声明**不会**红（`predecessor-handoff.ts:30-33`）。该错误只在接收方 action/配方**既不匹配 review 也不匹配 implement** 时才出现。 | 新表述与实测一致；不得再出现「守得住 + 删掉 synth predecessors 即红」这种可被证伪的声明 |
| **M2**（必修） | 第 **518**、**532** 行 | 两处 `src/core/proposal.ts:100-104` → **`src/core/proposal.ts:61-72`**（`invalid` 在 `:71`） | 全文不再出现 `proposal.ts:100-104`；新行号 `sed -n '61,72p'` 能打开对应内容 |
| **M3**（建议，同文件） | 第 **450** 行 | 硬规则表第三行不能拿本页的 `synth` 当「两者都不是」的反例（它带 `purpose:'review'`，命中第一行）。换成真正既非 review 也非 implement 的接收方，或改用占位节点。 | 表格与本页 v40 JSON 不再自相矛盾 |
| **M4**（建议，同文件） | 第 **335** 行 | `requirementVersion: 15` 在正文无解释（简单档/中等档均为 1）。加一句说明其来自被照抄的真实 proposal，或统一为 `1`。 | 文档自身可解释该值 |

**worker-2 通过标准**：`node --run test -- tests/console/design-examples.test.ts` 仍 2 passed（exit 0）；三个 JSON 块仍被 `validateProposal` ACCEPTED（纯 md 改动不得影响这一点）；`node --run typecheck` / `lint` / `check:evidence` 全绿；`git show --name-only` 仍**只含自己车道的 2 个文件**。

**⚠️ 返工简报必须带的一条否决项**：**不要**按 review-2 §3.3 把 `operation-lifecycle.ts:1117` 改成 `:1118`——第 **1117** 行本来就是对的（见 §3 C1），改了会引入新错误。

### worker-1（无阻塞缺陷，返工=复跑确认）

- 改动范围：**零**。三份评审一致认定 `src/**` 零改动、边界干净、8/8 绿、变异实验有判别力。
- 要做的只有：把 `node --run test -- tests/console/complex-tier-v40.test.ts`（期望 8 passed）+ `typecheck`/`lint`/`check:evidence` 重新跑一遍并留下可复跑记录，确认返工回合没有引入回归。
- N1（全量失败计数不可逐字复现）**不返工**：结论已被放射性证明独立证实。

### worker-3（无阻塞缺陷，返工=复跑确认）

- 改动范围：**零**。correctness=pass，文件边界干净，主张全部独立复现为真。
- 可选修正（review-3 的 F1，不阻断，做了更好）：`notes/complex-tier-v40-mechanisms.md` 第 16 行的规则要求「只有 synth/review-1..3/deliver 能证明的行标『静态』」，但 #9（synth 写汇总）、#10（synth 自判 pass/fail）被标为「实测」。二者择一——把 #9/#10 改回「静态」，或把规则放宽为「强制点在任一节点上走通即记『实测（异地强制点）』」并注明。**不要一边立规则一边破规则。**
- 若不动，须在报告中保持诚实披露（现状已披露，不构成阻塞）。

---

## 6. 给人工验收的备忘（返工完成后）

1. **两个「需求 vs 机制」的落差需要用户知情**（review-3 证实，均非本仓缺陷）：
   - 评审节点（含 `review-1..3`、`synth`）**不会**用 `space-bunny-free`，会被 `isReviewer` 机制换成 `deepseek-v4.1-flash`——因为独立评审要求「评审者不得用实施者模型」。**本轮「全部节点用 space-bunny-free」这条用户约束，在评审节点上无法由机制保证。**
   - 「先由主 Agent 审证据、再向用户汇报」里的**「先」不是硬门**：`human_check` 一打开主 Agent 就被唤醒，`approveHumanCheck` 只是追加 `preReview` 事件、check 仍 open。若要真正的门，需要在图外约定。
2. **「三个 worker 各产出一份成果」目前只是约定，没有机制强制**（review-3 #6：提案里 `worker-1/2/3` 均无 `deliverable`，而 planner/review-N/synth 都有）。
3. **验收门靠返工连带重置**（review-1 的发现）：`deliver` 没有 `when`，它被守住是因为 `reactivate` 沿 `dependents` 把它一起重置。
4. 全量 `node --run check` 在沙箱里是红的（`git ENOENT` / 兄弟工作树缺失），**与本次三条车道无关**，已由三份评审各自独立证实。

---

## 7. 自述

本汇总**不改判**任何一份评审：review-1 = PASS、review-2 = PASS、review-3 = pass，三者原样记录在 §0/§1。`fail` 是 synth 依规则对**整份交付**作出的汇总判定，唯一触发点是 review-2 两条「必须修」中经我独立复核属实、且未被驳回者。全部临时副本已清理，未修改任何被评产出。
