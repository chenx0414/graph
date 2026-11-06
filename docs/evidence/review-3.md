# 评审 3 报告（attempt 2）：worker-3 成果

**评审对象（本轮冻结）**：worker-3 的当前成果，提交 `003f0be`（`graph:worker-3:7165303c-204e-45b8-83a1-9f9035661374`），已合入 `ba2246a`。
- `notes/complex-tier-v40-mechanisms.md`（主件，243 行，sha256 `d1f262693a6f8e64df9149d62cc2c8335d26414fd5d8be3fde6b8565ddab2e4a`）
- `docs/evidence/v40-mechanisms-report.md`（摘要，172 行，sha256 `ab765f18acf0e8673794707c8d9d99342fc938d7b39b34e31397c24e08b62aaf`）

**注意**：本对象与我上一轮（attempt 1）评审的版本不同——上一轮是 214/145 行，本轮已返工为 243/172 行（worker-3 在 `§6 返工记录` 自述修 F1）。本轮全部结论都基于上述冻结字节重新取得，不沿用上一轮结论。

**对象边界**：任务 `4c251059-89d9-4876-a281-380c9559c88c` 的已确认提案（`graph_revisions.version=1`，4891 字节）与本次运行的 events/invocations 记录。

**焦点**：只评 worker-3 的成果，不评其它车道。不改任何实现文件。

---

## 1. 判定

**correctness = pass**（有 1 条 moderate、不阻断的准确性缺陷，见 §5）。

三条硬结论（批量返工真的发生、synth 写汇总并自判、评审节点被换模型）全部经我独立复现为真；代码/测试行号逐条核对无误；文件边界干净（提交只动两个 md）；全量 `check` 的红数字与它记录的一致到「失败集合完全相同」。上一轮的 F1（把静态写成实测）本轮已修，我逐行复核确认修法自洽。新发现 1 条缺陷：**运行快照数字被硬编码且已随运行推进而漂移**（§5），不影响任何结论方向。

---

## 2. 本轮复跑的证据（我自己跑/查的，不采信其转述）

| 主张（其文件里的原话） | 我的复现 | 结果 |
|---|---|---|
| 只新增/修改两个 md | `git show --name-only 003f0be` | 恰好 `docs/evidence/v40-mechanisms-report.md`、`notes/complex-tier-v40-mechanisms.md`；`git status --porcelain` 空 ✅ |
| 车道 1 的 v40 全形 E2E 绿（R1：8 passed） | `node --run test -- tests/console/complex-tier-v40.test.ts` | `Test Files 1 passed (1)` / `Tests 8 passed (8)`，**EXIT=0**（52.9s），与其 R1 一致 ✅ |
| 5 个钉子文件绿（R2：5 passed / 19 tests） | `node --run test -- review-as-router node-deliverable human-prereview human-prereview-e2e design-examples` | `Test Files 5 passed (5)` / `Tests 19 passed (19)`，**EXIT=0**（15.1s），与 R2 一字不差 ✅ |
| 否证脚本输出从 0 变 2 组（R3） | 原样重跑 §3-4 的 python | **输出「同 from 同 case 的 loop 组数: 2」**：`('synth','fail')` 三条（v40）+ `('plan-reviewer','replan')` 跨文件同名 ✅ |
| 全量 `check` 红且失败集合与本车道无关（§5.1 A/B） | `node --run test -- context-model predecessor-handoff-production` | `Test Files 2 failed (2)` / `Tests 9 failed \| 12 passed (21)`，**EXIT=1**，与它 A/B 记录的数字完全一致 ✅ |
| 全量 `check` 红（`CHECK_EXIT=1`，42/128） | 我自己跑 `node --run check` | `Test Files 42 failed \| 187 passed (229)` / `Tests 128 failed \| 1413 passed (1541)`，**CHECK_EXIT=1**；失败数 42/128 与它完全相同，总数差 +1 文件 +8 用例（正是车道 1 的 `complex-tier-v40.test.ts` 8 条用例，其合并晚于 worker-3 写作）✅ ——见 §4 |
| 本次运行真的发生过批量返工 | 查 `tasks.sqlite` events | `graph.rework{"from":"synth","route":"fail","to":["worker-1","worker-2","worker-3"],"via":"route"}` 存在 ✅ |
| `summaries/synthesis` 已发布 | 同上 | `artifact.published{name:"synthesis",namespace:"summaries"}` 存在 ✅ |
| 评审节点被换模型、synth 未被换 | 同上 + invocations join | `model.switched` 对 plan-reviewer/review-1/2/3 全部成立；`synth` invocations = `space-bunny-free` 24 次，未被换 ✅ |

---

## 3. 代码/测试行号逐条核对（全部对上）

我在本工作树逐处 `sed`/`grep` 核对，无一错位：

- `src/core/graph.ts:34,45-46`：`const conditions = node.when ? [node.when] : []` / `Branch must select a declared router case` / `dependencies.push(condition.node)` ✅
- `src/core/graph.ts:72-76`：loop 唯一性键 `from->to#case` + `Loops must be unique` + `Loop must return to an upstream node` ✅（#4/#11 引）
- `src/core/graph.ts:127-136`：`readiness` 的 `skip`/`waiting` 三分支，`execution.ts:567-576` 落 `node.skipped{reason:'inactive_route'}` ✅（#5a/#5b/#2-②引）
- `src/core/operation-lifecycle.ts:1115`：`plan.loops.filter(loop => loop.from === operation.nodeId && loop.case === result.route)`（**filter 非 find**）✅（#11 引 1114-1116）
- `src/core/operation-lifecycle.ts:1284`：`reactivate(this.store, operation.taskId, routed.map(loop => loop.to))` + 紧随的 `graph.rework{from,to,via,route}` ✅（#11 引 1283-1289）
- `src/core/operation-lifecycle.ts:1108`：`throw new RuntimeError('invalid_result', 'Router must return a declared case')` ✅（#10 引 1106-1108）
- `src/core/operation-lifecycle.ts:159`：`if (record['declared'] === null) return spec.kind === 'agent' ? { declared: null } : null;` ✅（#10 引，program 仍被拒）
- `src/core/proposal.ts`：全文件 **73 行**；验收校验 `:61` 起、`invalid('Each acceptance item requires an assigned mandatory program check or Agent router')` 在 **`:71`** ✅（#12 引 61-72、invalid 在 71 —— 与它 §6 对 M2 的更正一致）
- `src/core/execution.ts:1157`：`declaredDeliverable` 解析点；`593-628` 拒空交付 ✅（#1/#9 引）
- `src/core/execution.ts:718-728`：`graph.human_check` 未绑定答复 → `block(node,'human_check',…)` ✅（#13 引）
- `src/core/execution.ts:744,751`：写回 `instances.model` + `model.switched` ✅（#16 引）
- `src/core/model-selection.ts:12-17`（`isReviewer`）、`20-48`（`implementerModels`）、`51-76`（`pickModel` 组 exclude）✅（#16 引）
- `src/catalog/models.ts:167-174`：`const blocked = new Set(input.exclude ?? [])` 先过滤、`requested = usable.find(...)` ✅（#16 引 169-170）
- `src/core/predecessor-handoff.ts:510`（source 必须是直接依赖）、`:518`（独立评审只允许 `evidence_only`）✅（#7 引 495-521）
- `src/core/context.ts:53,94`（`PURPOSES`、`PREDECESSOR_MODES`）✅（#7 引）
- `src/core/question-routing.ts:304-317`：`approveHumanCheck` 只写 `preReview` + 发 `human.prereview_approved` ✅（#14 引）
- `src/core/task-runtime.ts:2181-2192`：`approve:false` 插 `kind:'rework'` 问题 ✅（#14 引 2163-2192）
- `src/runtime/agent-tool-definitions.ts:262`：`"…before the user is asked. This is NOT acceptance: the check stays open…"` ✅（#14/§2-④ 引）
- 测试文件：`complex-tier-v40.test.ts` 的 105/155/238/256/268/281/298/314/328/347 逐行对上是它自述的那些用例（FM1/2/3/4 + 各阴性对照）✅；`design-examples.test.ts:48` ✅；`context-model.test.ts:74` ✅；`human-prereview.test.ts:48-57`（`owner:'user'`,`status:'open'` + `human_check` 唤醒）✅

---

## 4. 全量 check 的红：与它记录一致到失败集合，是环境既有（独立复核）

我跑了完整 `node --run check`：`CHECK_EXIT=1`，`Test Files 42 failed | 187 passed (229)`、`Tests 128 failed | 1413 passed (1541)`。

它记录的是 `42 failed | 186 passed (228)`、`128 failed | 1405 passed (1533)`。**失败文件数与失败用例数完全相同（42/128）**；总数差 +1 文件 / +8 用例，正是车道 1 的 `complex-tier-v40.test.ts`（8 条用例，`grep -c '^test('` = 8）在其写作之后才合并进工作树。也就是说：**红的部分（42/128）没有变，只是分母涨了**。

我另外独立复现了它 §5.1 的 A/B：只跑 `context-model.test.ts` + `predecessor-handoff-production.test.ts` 得 `2 failed (2)` / `9 failed | 12 passed (21)`，失败原因是 `provider.requests[1]` 为 `undefined`、`context` 为 `null`——节点回合没跑起来，属沙箱/依赖环境问题，与本车道的两个 markdown 无关。其「不为了变绿去改别人的测试、只记原始失败清单」的做法符合计划 §4 预案与仓库既有标准做法。**这一条判它正确。**

---

## 5. 发现（唯一一条 moderate，不阻断）

**F2 · 运行快照数字硬编码且已随运行推进漂移（影响：中等，不阻断）**

- 位置 1：`docs/evidence/v40-mechanisms-report.md` §3.1 正文与代码块——
  `「本次运行的产品自带记录（不是我的推断），返工时重读，已从 1 次涨到 **6 次**」`、`events.model.switched（6 条）`、`events.review.independence_checked（7 条…）`、`planner 71 / worker-1 248 / worker-2 162 / worker-3 224 / synth 24`、`plan-reviewer 46 / review-1 104 / review-2 125 / review-3 68`。
- 位置 2：`notes/complex-tier-v40-mechanisms.md` §2-① 同款（`（共 6 条）`、`7 条`、`248/162/224`、`104/125/68`）；§0 状态表（`worker-2 / worker-3 running`、`review-1 running`、`review-2 / review-3 / synth / deliver pending`）。
- **实测（我查 `tasks.sqlite`，本轮冻结时刻）**：`model.switched` = **7**、`review.independence_checked` = **8**；invocations 实际为 `worker-1 248 / worker-2 167 / worker-3 255 / review-1 109 / review-3 115`；节点状态为 `worker-3 succeeded`、`synth succeeded`（第二轮）、`worker-2 dispatched`、`review-1/review-3 dispatched`、`review-2` 第二轮未派发。**它与它引用的运行记录对不上。**
- 根因：这些是**写作时刻的快照**，而任务图在其写作后继续推进（让步道 2/1 与第二轮继续跑），计数只会涨。worker-3 自己在 §0 写了「读表前先知道哪些行还没走到」，说明它知道是快照，但 §3.1/§2-① 把数字写成「本次运行（不是我的推断）」，**读者 grep DB 会得到不同的数**。
- 影响：一个下游读者（尤其 synth 与车道 2）若照 §2-① 抄「本次运行 6 次切换 / 7 条 independence_checked」进汇总，会写下一个下一轮就对不上的数；更严重的是 §0 状态表说 `synth…pending`，而实况 `synth` 已在第二轮 `succeeded` 并已发布 `summaries/synthesis`——**「synth 尚未结算」这个判断已经被运行本身推翻**（#8/#9 的备注里还留着「本次真实运行 synth 未结算」）。
- **不影响结论方向**：三条硬结论（批量返工真的发生、synth 写并发布汇总、评审节点被换模型且 synth 未被换）全部仍为真，且部分比我复现时时更确凿。漂移的是计数与状态快照，不是机制判断。
- 建议修法（若返工，二者选一）：(a) 给每组运行数字加一个**读点时刻**并注明「该读数之后图继续推进，计数会变」；(b) 用**判据而非计数**表述（例如「`model.switched` 对 plan-reviewer/review-1..3 各至少一次」），把具体次数移到脚注。§0 状态表同理，或直接删掉「哪些节点还没走到」那几列，只留「读点时刻 + DB 查询语句」。

**files（若 F2 需修）**：`docs/evidence/v40-mechanisms-report.md`、`notes/complex-tier-v40-mechanisms.md`

---

## 6. F1 是否已修：已修，且修法自洽（我逐行复核）

上一轮我给的 F1 是「第 16 行的判据（本次有没有走到）与 #9/#10 的实测标签自相矛盾」。本轮主件第 16-23 行已把判据重写为「**本行主体**有没有被走到 / 被以 v40 全形为对象的绿测钉住；别的节点碰过同一段代码只能写备注作佐证，不抬档」，并在 §1 表内给 #3、#4、#5b、#9、#10、#11、#13 每行补了重标理由。#9 现在有「本次运行 `artifact.published` 里有 `summaries/synthesis`」的实况支撑（我已核实），#10 有「plan-reviewer `accept` 已落库 + 车道 1 绿测」支撑——**这两条的实测标签现在成立**，不再是「规则禁止的写法」。F1 关闭。

---

## 7. 与共享测试标准的核对（rules/common.md）

- **R22/R23（先测后码、E2E、可复跑产物）**：本车道是**分析与文档类**成果，不存在新增可执行行为，故「先写测试后写代码」不适用。它对既有机制的验证走的是**复跑既有 E2E 套件 + 复跑否证脚本 + 查本次运行 DB 记录**，并留下可复跑命令（主件 §3 自检 8 条 + 报告 §5）。我按它的命令逐条复跑，全部可重复，符合「留可复跑证据、不以断言拼信心」。
- **R24（隔离测试先写失败模式）**：本车道无新增系统，不适用；其 §4「交付后仍未覆盖清单」每条写清补它需要哪个断言，是等价的好实践。
- **R27（测试层级，不许绑实现细节）**：本车道未新增测试、未触碰 `tests/**`；它引用的车道 1 测试全部从公开行为（事件流、派发记录、节点状态）断言，含 4 条阴性对照，符合底线。
- **反例对照（加分项）**：其 §3-4 否证脚本是真正的阴性对照——先证明「全仓同 from 同 case 的 loop 组数」，再据此把 #11 标实测，而不是拿「我以为」当证据。本轮我复跑得 2 组，与其一致。

---

## 8. 结论汇总

| 维度 | 结论 |
|---|---|
| correctness | **pass**（1 条 moderate 缺陷，不阻断） |
| 文件边界 | 干净：提交 `003f0be` 只动 2 个 md；未碰 `src/**`、`tests/**`、`docs/**` |
| 关键主张 | 全部独立复现为真（批量返工事件、synthesis 发布、模型切换、车道 1 E2E 绿、5 文件钉子绿、否证 2 组） |
| 代码/测试引用 | 逐条核对无误（见 §3，含上一轮 review-2 指出的 `proposal.ts` 行号，本轮确认为 61-72/invalid@71） |
| 全量 check 红 | 独立复现：失败集合 42/128 与它一致，总数差 +8 用例 = 车道 1 后合并的用例，与环境无关 |
| 上一轮 F1 | **已修**，修法自洽（§6） |
| 新缺陷 | 1 条 moderate（F2 运行快照数字硬编码且漂移），不阻断 |
| 验收缺口披露 | 诚实：列 2 条未覆盖（#6、#15）+ 2 条与需求冲突（#14、#16），各给补法 |

**建议**：本成果可判 **pass**；F2 作为「本轮即可顺手修」的准确性缺陷交给 synth 汇总——它不影响三条硬结论，但下游若照抄会写进下一轮就对不上的数，值得在汇总里显式改写为判据式表述。

**files**（若 F2 需修）：`docs/evidence/v40-mechanisms-report.md`、`notes/complex-tier-v40-mechanisms.md`
