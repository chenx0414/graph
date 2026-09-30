# 评审 3 报告：worker-3 成果

**评审对象**：worker-3 的本次成果（operation `29fe8a40-b445-49b5-b584-754c47d80f67`，提交 `5f94028`）
- `notes/complex-tier-v40-mechanisms.md`（主件，214 行，sha256 `c5c11f9b33bfb0b30bc077d45104f943d81505d2950f06a16ad1844dd34f9e96`）
- `deliverables/v40-mechanisms-report.md`（摘要，145 行，sha256 `38b9f32fa7700831dbbf1c2ceb3efd24b70dd8b3ab2043d00b92cf98d14e2b89`）

**对象边界**：任务 `4c251059-89d9-4876-a281-380c9559c88c` 的已确认图提案（`graph_revisions.version=1`，spec 4891 字节，本次 DB 实测一致）与本次运行的 events/invocations 记录。

**焦点**：只评 worker-3 的成果，不评其它车道。

---

## 1. 判定

**correctness = pass**。成果是「v40 机制对照 + 证据表」，三条硬结论全部经我独立复现为真；代码/测试行号引用逐条核对无误；文件边界干净（只新增两个文件）；两个「与需求相反」的实测发现是真实的、且比它自己预测的还要确凿。发现 1 条 moderate 内部一致性问题（证据强度标签，见 §4），不阻断。

---

## 2. 独立复现的证据（我自己跑/查的，不采信其转述）

| 主张 | 我的复现 | 结果 |
|---|---|---|
| 只新增两个文件 | `git show --name-only 5f94028` | 恰好 `deliverables/v40-mechanisms-report.md`、`notes/complex-tier-v40-mechanisms.md`；`git status --porcelain` 空 |
| `deliverables/plan-review.md` 不是本车道的 | `git show --name-only 4d78623` | 由 plan-reviewer 提交，本车道未碰 ✅ |
| 命令 #1 绿 | `node --run test -- review-as-router node-deliverable human-prereview human-prereview-e2e design-examples` | `Test Files 5 passed (5)` / `Tests 19 passed (19)`，**EXIT=0**（21.45s），与其记录一字不差 |
| 命令 #2 红且为环境所致 | 同上跑 `context-model` + `predecessor-handoff-production` | `2 failed (2)` / `9 failed \| 12 passed (21)`，**EXIT=1**；失败点是 `provider.requests[1]` 为 undefined、`context` 为 undefined，即节点回合没跑起来 —— 与我的两个 markdown 无关（测试不读它们）✅ |
| §3-4 否证脚本：全仓无「同 from 同 case 的多条 loop」 | 我原样重跑该 python | **输出「同 from 同 case 的 loop 组数: 0」** ✅ —— 这正是 #11 标「静态」的硬依据 |
| proposal 无 `worker-N.deliverable`（#6 真缺口） | 解析 `graph_revisions.version=1` 的 spec（4891 字节） | `worker-1/2/3 deliverable=NO`，planner/plan-reviewer/review-1..3/synth 均 YES ✅ |

---

## 3. 两条「与需求相反」的发现：独立证实，且现在更确凿

### 3.1 评审节点不会用 space-bunny-free（需求 #16 与其冲突）

其引用的事件我从本次 DB 原样取出，逐字节一致：

```
model.switched | {"nodeId":"plan-reviewer","from":"opencode-go:space-bunny-free","to":"opencode-go:deepseek-v4.1-flash"}
review.independence_checked | {"nodeId":"plan-reviewer","independence":"model-excluded","policy":{"excludedModels":["opencode-go:space-bunny-free","space-bunny-free"],…}}
```

invocations 计数也一致：planner `space-bunny-free` 71 次 / plan-reviewer `deepseek-v4.1-flash` 46 次。代码链路我逐文件核对为真：`presets/manifest.json` reviewer 带 `review:true` → `src/core/model-selection.ts:12-17 isReviewer` → `:20-48 implementerModels` 收上游实调用模型入 `exclude` → `src/catalog/models.ts:169-170` 先 exclude 再找 requested → `src/core/execution.ts:751` 发事件。

**它还预测**「review-1/2/3 与 synth 也会被换掉」。这条预测**现已被运行证实**：DB 里 `review-3` 确实发生了 `model.switched → opencode-go:deepseek-v4.1-flash`（48 次 invocation），`excludedModels:["space-bunny-free"]`。也就是说它的核心告警不仅为真，而且比它写作时更完整地兑现了。

**结论**：这是需求与机制的冲突（独立评审要求：评审者不得用实施者模型），不是实现缺陷。其判断正确，且给 synth 的建议（不要照抄"全节点同模型"）正确。

### 3.2 「先由主 Agent 审证据、再汇报」的「先」不是门

我复现了 `tests/console/human-prereview.test.ts:48-57` 的语义（该文件本次跑绿）：check 打开瞬间 `questions.owner='user'`、`status='open'`，同时主 Agent 被 `human_check` 唤醒；`src/core/question-routing.ts:304-317 approveHumanCheck` 只追加 `preReview` 并发 `human.prereview_approved`，check 仍 open；`src/core/task-runtime.ts:2181-2192` 的 `approve:false` 插的是一条 `rework` 问题而非「拒绝验收」。工具描述里的 "before the user is asked"（`agent-tool-definitions.ts:262`）确认只是注意力顺序。

**结论**：其结论准确。这是需求措辞与机制能力的差距，不是缺陷。

---

## 4. 发现（唯一一条 moderate）

**F1 · 证据强度标签与它自己定的规则不一致（影响：中等，不阻断）**
- 位置：`notes/complex-tier-v40-mechanisms.md` 第 16 行规则 vs 第 57–58 行（#9、#10）；摘要报告 §1 同样。
- 事实：报告自己在第 16 行写下硬规则——「本次运行里 `synth` / `review-1..3` / `deliver` 尚未结算，凡是只有它们才能证明的行，即使强制点清楚，也标『静态』」。但 **#9**（synth 写 `summaries/synthesis.md`）与 **#10**（synth 自己判 pass/fail）被标为 **实测**，理由是「同一强制点已在 planner/plan-reviewer 上生效；synth 未运行」。这正是规则禁止的写法。
- 反例对照：**#12**（验收只绑 deliver）同样写「本次已过 validator」，但这是**真·实测**——提案确实被接受、validator 确实在本图上跑过，所以 #12 的「实测」成立。#9/#10 没有这个支撑，synth 一次都没跑。
- 影响：读者（尤其 synth 与车道 2）若只看「证据强度」列，会误以为 synth 的写汇总/自判 pass-fail 已被本次运行钉住；实际它们是**只有代码路径**。这与该报告贯穿全文的「不许把静态写成实测」自相矛盾，是本成果唯一实质瑕疵。
- 建议修法（若返工）：把 #9、#10 改回「静态」，或把规则放宽为「强制点在任一节点上走通即记『实测（异地强制点）』」并把 #12 之外的异地项也一并注明——二者选一，不要一边立规则一边破规则。

**非阻断观察（不要求改）**：
- 报告 §0 的状态表把 worker-3 记为 `running`、review-1..3/synth/deliver 记为 `pending`。这是其写作时刻的**快照**，且它明确声明「读表前先知道哪些行还没走到」，属诚实冻结；无需改。当前实际状态：worker-3 `succeeded`，review-3 `dispatched`（DB 实测）。
- #6「三个 worker 各产出一份成果」被其标为**未覆盖**并给出两种补法，这是诚实的。就本车道（文档/分析类成果）而言是正确判断；但它意味着「各产出一份成果」这条需求在整个 v40 里仍是约定、无机制强制——这一点值得 synth 收进汇总，而不是当成 worker-3 的缺陷。

---

## 5. 与共享测试标准的核对（rules/common.md）

- R22/R23（先测后码、E2E、可复跑产物）：本车道是**分析与文档类**成果，不存在新增可执行行为，故不适用「先测后码」。其对既有机制的验证走的是**复跑既有 E2E 套件 + 复跑否证脚本 + 查本次运行 DB 记录**，并留下可复跑命令（§3 自检 8 条），符合「留可复跑证据、不以断言拼信心」。
- R27（不要为实现细节写测试）：未新增测试，未触碰 `tests/**`，无违反。
- 反例对照：它的 §3-4 否证脚本正是「阴性对照」——先证明「全仓无同 from 同 case 的两条 loop」，再据此把 #11 标静态，而不是拿「我以为」当证据。这是加分项。

---

## 6. 结论汇总

| 维度 | 结论 |
|---|---|
| correctness | **pass** |
| 文件边界 | 干净：只新增 2 个 md，未碰 `src/**`、`tests/**`、`docs/**` |
| 关键主张 | 全部独立复现为真；两条「与需求相反」的发现经 DB 复核为真且更确凿 |
| 代码/测试引用 | 逐条核对无误（graph.ts、operation-lifecycle.ts、execution.ts、models.ts、model-selection.ts、question-routing.ts、task-runtime.ts、predecessor-handoff.ts 及所引 5 个测试文件） |
| 验收缺口披露 | 诚实地列出 3 条未覆盖 + 3 条静态 + 2 条与需求冲突，并各给补法 |
| defect | 1 条 moderate（F1 证据强度标签不一致），不阻断 |

**建议**：本成果可判 **pass**；F1 作为「知道即可」的观察交给 synth 汇总，不构成该 worker 的返工理由（它已在括号里披露了实情，且不影响结论方向）。

**files**（若 F1 需修）：`notes/complex-tier-v40-mechanisms.md`、`deliverables/v40-mechanisms-report.md`
