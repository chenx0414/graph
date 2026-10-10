# Synthesise：v40 三车道评审汇总与判定（attempt 2）

**节点**：synth（agent 路由器）
**上游**：review-1 / review-2 / review-3（三份到齐，无缺）
**判定**：**pass**

---

## 0. 收齐的报告（逐份点名）

| 评审 | 操作 | 交接给的产物 | 产物**实际最后写入**时刻 | 报告自身判定 |
|---|---|---|---|---|
| review-1 | `6e39d0f1-bd65-426d-8dda-93698d392d03` | `review-1/deliverables/review-1.md` | `3f09d8b` @ 00:02:00 ✅ **新鲜** | **PASS** |
| review-2 | `53dd9b44-1881-49b0-b603-d9005b75b8b5` | `review-2/deliverables/review-2.md` | `8c974b4` @ 22:42:02 ⚠️ **陈旧**（早于 worker-2 返工） | PASS（附 2 条必修） |
| review-3 | `026f035e-c39a-462a-b7c7-65fe71302944` | `review-3/deliverables/review-3.md` | `43e7833` @ 23:42:33 ✅ 新鲜 | pass（1 条 moderate） |

**⚠️ 本轮最重要的一件事：交接给我的 review-2 产物是陈旧的。**

时间线（`git log` 实测）：

```
22:23:26  742ce4b  worker-2 v1        ← review-2.md 评的就是这个
22:26:43  5468270  review-2 op 45703e9b
22:42:02  8c974b4  review-2 op 04986504  ← review-2.md 最后一次被改写（attempt 2 正文）
23:20:38  0a1faba  synth（上一轮判 fail）
23:34:28  f56a779  worker-2 op db8a55bf  ← worker-2 返工，修了文档
23:35:51  b826927  review-2 op 53dd9b44  ← 本次交接的 review-2；只新增了 recheck 脚本
```

`git show b826927 --name-only` 显示本次 review-2 **只提交了 `deliverables/review-2-recheck.mjs`**，没有重写 `review-2.md`。所以 `review-2.md` 正文描述的是 **返工前的 742ce4b**，而它声明的两条必修项在 23:34 已被修掉。

我把 review-2 **本次操作真正产出的证据**取出来自己跑了（见 §2），它才是对当前树有效的判断。

---

## 1. 各方一致点（三方独立互证，可直接采信）

| 事实 | review-1 | review-2 | review-3 |
|---|---|---|---|
| 全量 `check` 红是**环境基线**，非本车道造成 | 42 failed/187 passed (229)，128/1413 (1541) | 42 failed/186 passed (228)，128/1405 (1533) | 42 failed/187 passed (229)，128/1413 (1541) |
| 各自目标文件**不在**失败集内 | `complex-tier-v40` 出现 0 次 | `design-examples.test.ts` 不在失败集 | 独立跑出 42/128，失败集合相同 |
| 文件边界干净 | `8117681` 只 2 文件，`src/**` 零改动 | `742ce4b` 只 2 文件 | `003f0be` 只 2 个 md |
| 机制说法与源码逐条对得上 | 7 条逐条回源码，零错 | 18 处引用逐条开行 | 代码/测试行号逐条 `sed` 核对，无一错位 |
| 车道 1 目标 E2E 绿 | 8 passed (8) exit 0 | — | 8 passed (8) EXIT=0 |

**读数差异不是冲突**：229/1541 vs 228/1533 的 +1 文件 +8 用例，review-3 给出解释并被我证实——正是车道 1 的 `complex-tier-v40.test.ts`（`grep -c '^test('` = 8）在 worker-3 写作之后才合并。**红的部分（42 文件 / 128 用例）三方逐位相同，只有分母涨了。**

失败原因（`@earendil-works/pi-ai` 模块找不到、`spawnSync git ENOENT`、m8 真起进程）是沙箱/工作副本 `node_modules` 软链越界所致，与三条车道的产出无关。

---

## 2. 我本轮亲自重跑的检查（不是转述）

按「无下游被记为失败 → 重跑本节点喂给下游的检查」，我跑了 review-2 本次操作留下的黑盒复核脚本：

```
$ node deliverables/review-2-recheck.mjs
# document carries 3 graph blocks
PASS  v40 block exists
PASS  block #1/#2/#3 accepted        ← 三块 JSON 均被产品自己的 validateProposal 接受
PASS  v40 base accepted
PASS  synth carries context.purpose=review
PASS  MUT-516a: delete synth.predecessors -> ACCEPTED (doc says 守不住)
PASS  MUT-516b: delete synth.context -> REFUSED
PASS    ... error mentions handoff policy
PASS  MUT-acceptance ghost checkNode -> REFUSED
PASS  MUT-acceptance bound to ordinary agent -> REFUSED
PASS  MUT when.case undeclared -> REFUSED
PASS  MUT loop endpoint ghost -> REFUSED
PASS  all 36 src line refs point inside their files
SUMMARY pass=14 fail=0
RECHECK_EXIT=0
```

**14/14 通过，exit 0。** 这是针对当前树（`f56a779` = HEAD 祖先）的有效证据，且是**真阳性阴性对照**（`MUT-516a` 证伪旧断言、`MUT-516b` 证真新断言、其余 4 条变异证明 validator 会拒），不是套套逻辑。

### review-2 两条必修项的当前状态：均已修复

| 项 | review-2 指控（针对 742ce4b） | 我在 HEAD 实测 | 状态 |
|---|---|---|---|
| §3.1 假阳性证据声明 | 第 516 行称「守得住（删掉 `synth` 的 `predecessors` 即红）」，实测 ACCEPTED | 现第 **519** 行已改为「**守不住**——`synth` 带 `purpose:'review'`，`independentReviewReceiver`（`:30-33`）已归为评审、默认 `evidence_only`（`:49-53`），只删 `predecessors` 仍 ACCEPTED」，并给出真会红的变异（删整个 `context`）。`MUT-516a/b` 双向证实 | ✅ **已修** |
| §3.2 行号指向空处 | `proposal.ts:100-104` 出现两次（518、532 行），但该文件仅 73 行 | `grep -n "proposal.ts:100-104"` **零命中**；现第 540 行为 `proposal.ts:61-72`。我另直接核实：`wc -l src/core/proposal.ts` = 73，规则真在 `:61-72`，`invalid(...)` 在 `:71`。复核脚本第 7 项「36 处 `src/*.ts:行号` 引用全部落在文件内」通过 | ✅ **已修** |

### 其余三条建议项

- **§3.4（`requirementVersion: 15` 无解释）✅ 已修**：第 333 行现有一整段说明，讲清它是需求文本版本、须填自己这份的版本号、不要照抄 15。
- **§3.5（拿 `synth` 当「无默认」反例）✅ 已修**：第 453 行显式警告第三行不能拿本页 `synth` 当例子，因其 `purpose:'review'` 命中第一行。
- **§3.3（`operation-lifecycle.ts:1117` 偏一位）❌ 建议本身是错的，不要执行**：

  ```
  $ grep -n "const agentRouter" src/core/operation-lifecycle.ts
  1117:    const agentRouter = operation.kind === 'agent' && Boolean(nodeSpec.routes?.length);
  ```

  在当前树上 `agentRouter` **确实在 1117 行**，文档第 540 行的引用是**准确的**。review-2 的 §3.3 是在返工前的树上得出的，行号已随 `f56a779` 移位。**照它改反而会引入错误引用。** 这条明确不执行。

---

## 3. 冲突点

**没有影响可用性的评审间冲突。** 三份报告的被评对象互不重叠（车道 1/2/3），无任何一方对同一事实给出相反结论。

唯一需要点名的张力是**报告产物的新鲜度**：review-2.md 正文说「有 2 条必修」，而当前树显示两条都已修。这不是「评审错了」，而是**该报告评的是已被取代的提交**，其所属操作的最新证据是那份 14/14 全绿的复核脚本。我按「必须修的问题是否仍然未决」来裁：**已修且经独立复核证实 → 不构成 fail 依据。**

**流程缺陷（登记，不影响本轮判定）**：review-2 在返工后复跑并产出了新证据，但没有回头更新自己的 `review-2.md`，导致交接给 synth 的是一份描述旧提交的文档。建议后续让评审节点在复核后重写结论文件，或在 recheck 脚本旁附一份结论。

---

## 4. 遗留项：review-3 的 F2（不阻断，交给下游）

**F2 · 运行快照数字硬编码且已随运行推进漂移**（review-3 判 moderate，**明确「不影响结论方向」**）

- 位置：`deliverables/v40-mechanisms-report.md` §3.1、`notes/complex-tier-v40-mechanisms.md` §2-① 与 §0 状态表。
- 问题：`model.switched` 写作「6 条」、`review.independence_checked`「7 条」、invocations 计数等是**写作时刻的快照**，而任务图此后继续推进。review-3 实测为 7 条 / 8 条，invocations 也不符。§0 还写 `synth … pending`，而实况 synth 已 `succeeded` 并已发布 `summaries/synthesis`。
- **不构成 fail**：三条硬结论（批量返工真的发生、synth 写并发布汇总、评审节点被换模型而 synth 未被换）review-3 全部独立复现为真，漂移的是计数与状态快照，不是机制判断。review-3 自身也判 pass。
- **给下游的处理建议**：照抄进任何汇总前改写为**判据式**表述（如「`model.switched` 对 plan-reviewer/review-1..3 各至少一次」），或标注读点时刻；§0 状态表直接删掉「哪些节点还没走到」那几列。本汇总**不引用任何具体计数**。

---

## 5. 判定：**pass**

理由，逐条对应规则：

1. **有无未决的必修项？** 无。review-2 提出的 2 条必修（§3.1 假阳性证据声明、§3.2 空行号引用）**均已在 `f56a779` 修复**，并由 review-2 自己那次操作留下的黑盒脚本在当前树上 **14/14 全绿、exit 0** 独立证实；我另直接核实了 `proposal.ts` 的 73 行长度与 `:61-72` 真实位置。规则中「必修且未被其它证据驳回」的两个条件都不满足。
2. **有无影响可用性的评审间矛盾？** 无。三方对全量红、文件边界、机制引用的结论一致且互相印证。
3. **是否只是评级/风格之争？** 是的——review-3 的 F2 是 moderate、非必修；review-2 的 §3.3 建议经我实测为错误建议（`agentRouter` 确在 `:1117`），执行反而有害。两者都不构成 fail。
4. **车道 1、3 的结论**：review-1 判 PASS 且我复核 `tests/console/complex-tier-v40.test.ts` 的 sha256 = `e91bb896…` 与其声明逐字节一致；review-3 判 pass。均无未支撑声明。

三条车道的产出可进入 `deliver` 与人工验收。

---

## 6. 交给下游的待办（非阻塞）

| # | 谁 | 改什么 | 改到什么程度算通过 |
|---|---|---|---|
| 1 | worker-3 | 修 F2：运行数字改判据式表述或加读点时刻；§0 状态表删「哪些节点还没走到」的列 | 全文 `grep` 不再出现无标注时刻的具体计数断言；§0 不再声称任何节点 `pending` |
| 2 | 下游读者（deliver/人工） | 引用 worker-3 结论时**只引机制判断，不引计数** | 汇总中每条数字都带读点时刻或已改为判据式 |
| 3 | 流程（不指派给本图任一车道） | 评审节点复核后应重写结论文件，而非只加脚本 | 交接给 synth 的产物与所评提交一致 |

**明确不要做的事**：不要按 review-2 §3.3 把 `operation-lifecycle.ts:1117` 改成 `:1118`——当前树上 1117 是对的。

---

**files**：`summaries/synthesis.md`
