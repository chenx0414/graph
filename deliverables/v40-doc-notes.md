# 车道 2 报告：复杂档章节改写为 v40（`docs/design-graph-examples.md`）

**节点**：worker-2（`implement`，`dependsOn: [planner]`，`when: { node: 'plan-reviewer', case: 'accept' }`）
**依据**：`plans/plan@1`（`ef7b5e42…`）§2 车道 2；`reviews/plan-review@1`（`cbce30b6…`）结论 accept
**独占文件**：`docs/design-graph-examples.md`（本报告 `deliverables/v40-doc-notes.md` 除外）
**结论**：**完成**。复杂档一节已改写为 v40，照抄 JSON 被产品自己的 `validateProposal` 接受；只动了这一个文档。

---

## 1. 交付：主文件 `docs/design-graph-examples.md`

`git diff --stat`：**1 file changed, 194 insertions(+), 81 deletions(-)**。`git status --porcelain` 只有 `M docs/design-graph-examples.md`——**没有碰** `tests/**`、`src/**`、`package.json`、`docs/architecture.md`、简单档与中等档两节。

### 1.1 逐条对计划 §2 车道 2 的完成判据

| 计划要求 | 落在哪 | 状态 |
|---|---|---|
| 1. 把「完整初稿」换成 v40 的 JSON（planner / plan-reviewer(accept\|replan) / worker-1..3 带 `when` / review-1..3 / synth agent 路由器 / deliver `graph.human_check`；loops 四条；acceptance 只绑 `deliver`） | `## v40 完整初稿` | ✔ 与本任务真跑的 proposal **同构**（`requirementVersion 15`，10 个节点、4 条 loop、1 条验收项） |
| 2. 加一张「和 `graph.verify` 形状差在哪」 | `## 和 graph.verify 形状差在哪（别照抄错的那张）` | ✔ 6 行对照表（执行者 / 仲裁节点 / 分支来源 / 计划与执行关系 / 返工粒度 / 验收挂点） |
| 3. 硬规则补三条，每条带「不这么写会怎样」 | `## 五条硬规则` 1/2/3 | ✔ 三条都在，每条都写了后果 |
| 4. 保留旧 `graph.verify` 写法一小段 + 注明适用场景 | `## 旧形状（graph.verify 机械判定）——保留，仍然合法` | ✔ jsonc 片段原样保留，并写明「什么时候仍然选它」+ 两条仍有效的规则（`required:true` 语义、禁用 `byStatus`） |
| 5. 同步更新档位一句话；不动简单档与中等档 | 开头「各档一句话」 | ✔ 只改了那一句；两节一字未动 |
| M3（plan-review 的次要偏差）：显式标注只有 ` ```json ` 整图受测、jsonc 不受测 | `## 本页 JSON 的受测范围` + jsonc 片段下方的提示 + 证据表「守不住」列 | ✔ 正面回应，避免假绿 |

### 1.2 与真跑 v40 的对照

我从运行时库里取出了本任务实际被接受的 proposal（`tasks.sqlite` → `proposals` 表，task `4c251059`），逐节点比对文档 JSON：

| 字段 | 真跑 v40 | 文档 v40 | 说明 |
|---|---|---|---|
| `requirementVersion` | 15 | 15 | 一致 |
| 节点集 | planner / plan-reviewer / worker-1..3 / review-1..3 / synth / deliver | 同 | 一致（**没有** `main`、**没有** `plan-report`、**没有** `verify-delivery`——与决定的删除项相符） |
| `loops` | `plan-reviewer--replan-->planner` + `synth--fail-->worker-1/2/3` | 同 | 一致，四条 |
| `acceptance` | 单条 `human-accept` → `checkNode: deliver` | 同 | 一致 |
| worker 的门 | `dependsOn:['planner']` + `when:{node:'plan-reviewer',case:'accept'}` | 同 | 一致 |
| `synth` 路由 | `routes:['pass','fail']` + `input.route.declared:null` | 同 | 一致 |
| `model` | `opencode-go:space-bunny-free` | `<模型 id>` | **故意不同**：文档用占位符（测试会替换成 `example:model`），与本页其它三档写法一致 |
| `planner` 的 action | `plan` | `plan` | 一致 |

差异只有模型占位符这一处，是文档惯例而非机制差异。

---

## 2. 证据：红 → 绿（先失败，再修，最后全量）

计划的完成判据是「`design-examples.test.ts` 全绿 = 新 JSON 被产品自己的 validator 接受」。因为这道门**在改文档之前就已经存在**（`tests/console/design-examples.test.ts` 以本页为输入），我按 R22 先让它红、再让它绿。

### 2.1 基线（改文档前）

```
$ node --run test -- tests/console/design-examples.test.ts
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

### 2.2 RED #1 — 跨 agent 边漏写 handoff `mode`（synth）

删掉 `synth` 的 `context.predecessors`：

```
$ node --run test -- tests/console/design-examples.test.ts
AssertionError: example #3 (复杂档 v40：planner 出计划 → plan-reviewer 审（不过就返工 planner)；…):
  expected 'refused: Fresh predecessor edge revie…' to be 'accepted'
Received: "refused: Fresh predecessor edge review-1 requires an explicit handoff policy"
 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
```

**红在正确的原因上**：正是硬规则 2 写的那条，而不是别的错。修回 → `2 passed`。

### 2.3 RED #2 — `when` 引用了路由器没声明的 `case`

把 `worker-2` 的 `when.case` 从 `accept` 改成 `approved`：

```
Received: "refused: Branch must select a declared router case"
      Tests  1 failed | 1 passed (2)
```

修回 → `2 passed`。

### 2.4 GREEN（最终）

```
$ node --run test -- tests/console/design-examples.test.ts
 Test Files  1 passed (1)
      Tests  2 passed (2)

$ node --run typecheck        # exit 0
$ node --run lint             # exit 0（仅输出 "No unawaited expect().resolves/.rejects chains found."）
```

**受测块清单**（`design-examples.test.ts` 实际抓到 3 个含 `"nodes"` 的 ` ```json ` 块，全部 ACCEPTED）：

```
block 1: ACCEPTED  并行调研 pi-subagents@0.73.1…      （简单档，原样未动）
block 3: ACCEPTED  两条车道并行实现，各自评审…          （中等档，原样未动）
block 4: ACCEPTED  复杂档 v40：planner 出计划…          （本车道新增）
```

### 2.5 全量门禁

```
$ node --run check
```

见 §4 原文。

---

## 3. 过程中被证据纠正的两处（重要，synth 请重点看）

我先按计划 §2 车道 2 的措辞写了硬规则 2 与硬规则 5，**两处后果写错了**，被实测打回来，已在文档里改正。这两条是本车道唯一的实质产出差异。

### 3.1 硬规则 2 原写法是「漏写就拒」——错的

计划让我写「跨 agent 的边必须在 `context.predecessors` 声明 `mode`」。我第一次照抄时用 worker-1 做 RED-1 阴性对照，**结果没有红**。查 `defaultPredecessorHandoffMode`（`src/core/predecessor-handoff.ts:41-51`）后实测出真实默认表：

| 接收方 | 默认 `mode` | 漏写后果 |
|---|---|---|
| `action: 'implement'` 的 worker（无 context） | `result_handoff` | **不红**——静默拿到 `result_handoff` 而不是 `evidence_only` |
| `context.purpose: 'implement'` 的 worker | `result_handoff` | 同上 |
| `action: 'review'` 的评审 | `evidence_only` | 不红 |
| `action: 'review-plan'` + `reviewer@8` 的 plan-reviewer | `evidence_only` | 不红 |
| `action: 'synthesize'` + `synthesizer@1`（无 context） | **无默认** | **被拒**（`missing: ["planner"]`） |
| 同上 + `context.purpose: 'review'` | `evidence_only` | 不红 |

原文档里那句「少写就直接被拒」**只对最后两行成立**。已改成三行默认表 + 结论「显式写 `mode`，不要依赖默认」。**这比原写法更有用**：第一行那个坑（worker 静默拿到 `result_handoff`）比拒了更危险，而原文完全没提。

### 3.2 硬规则 5 原写法「漏 `case` 会对任何分支触发」——**反了**

我先写的是「漏掉 `case`，这条边会对任何分支都触发——返工会在你不返工的时候发生」。实测（`plan.loops.filter(l => l.from === 'synth' && l.case === 'fail')`）：

```
{ validates: "constructed (GraphPlan threw nothing)",   // 校验期合法
  selectedForFail: ["w2"],                              // 只有带 case 的那条命中
  selectedForPass: [] }
```

真实语义是**死边**：校验期合法，运行时**永远不触发**。已改正，并把「只重跑一条 vs 整批重跑的区别在于挂了几条 loop，不在于 `case` 怎么写」写进去。

### 3.3 另外三处 runtime 说法也做了实测（`resolveRouteCase` / `agentChoosesItsOwnRoute`）

```
declared:null, agent 交了 pass  -> refusal（该函数只读图上的 source，不读 agent 的 route；真实 route 由别处注入）
declared:"pass"                  -> {"case":"pass"}          // 写死 = 固定路由，agent 说什么都没用
declared:null, 没交 route        -> refusal（非静默默认）
declared:"nope"                  -> refusal（未声明的 case）
agentChoosesItsOwnRoute(declared:null)=true   agentChoosesItsOwnRoute(declared:"pass")=false
```

最后一行给了硬规则 1 一条更强的理由：写死 `declared` 不仅固定了路由，还**关掉了 briefing 里「结果里必须带 route」那句提示**——agent 根本不会被告知要交 route。

---

## 4. `node --run check` 原文

`node --run check`（= typecheck + lint + test + check:evidence）在本工作树里 **exit 1**。失败全部来自**环境**，与本车道无关。原文：

```
$ node --run check
 Test Files  42 failed | 186 passed (228)
      Tests  128 failed | 1405 passed (1533)
   Duration  200.26s (tests 88%, import 11%, transform 1%)

 FAIL  tests/m7/page.test.ts > B站 page requires login, shows live collect progress, …
Error: ENOENT: no such file or directory, copyfile
  '…/worktrees/fu-za-dang-v40-planner-chu-ji-hua-plan-r-4c251059/12-MediaBookmarks/src/config.js'
  -> '/private/var/folders/…/T/graph-m7-page-6aNbhb/src/config.js'
 ❯ tests/m7/page.test.ts:18:3

 FAIL  tests/m7/production.test.ts > production Pi writes the Bilibili web on a clone …
Error: spawnSync git ENOENT
 ❯ tests/m7/production.test.ts:20:32

=== check exit=1 ===
```

### 4.1 「不是我改红的」——按计划 §4 风险预案做的前后对照

计划 §4 风险表最后一行要求：环境红时「**证明加自己的文件前后一致**」。做法：把 `docs/design-graph-examples.md` 单独 `git stash` 回到改写前，跑同一套全量 `node --run test`，比失败文件清单。

| | 失败文件数 | 失败用例数 | 失败文件清单 |
|---|---|---|---|
| **改写前**（`git stash` 掉本文档） | 42 | 128 / 1533 | `/tmp/before-files.txt` |
| **改写后**（本文档在位） | 42 | 128 / 1533 | `/tmp/after-files.txt` |

```
$ diff /tmp/before-files.txt /tmp/after-files.txt
（无输出 —— 两个清单逐字节相同）
```

**`tests/console/design-examples.test.ts` 不在那 42 个文件里**（`grep -c design-examples` = 0），即本车道的目标用例在全量运行里也是绿的。

### 4.2 失败根因分类（采样）

| 症状 | 次数 | 与本车道的关系 |
|---|---|---|
| `spawnSync git ENOENT` | 2 | 工作树沙箱里 `git` 不可见 |
| `ENOENT ... copyfile ../12-MediaBookmarks/...` | 1 | 测试要读**兄弟工作树**，本工作树里不存在 |
| `Test timed out` / `timed out` | 8 | 沙箱内网络/进程受限 |

**结论**：本车道**没有**为了让 check 变绿去改任何别人的测试或 `src/**`。改写前后失败集合**完全一致**，符合计划 §4 的标准做法。

### 4.3 定向门禁（收尾时全绿）

```
$ node --run test -- tests/console/design-examples.test.ts
 Test Files  1 passed (1)
      Tests  2 passed (2)

$ node --run typecheck        # exit 0
$ node --run lint             # exit 0
$ node --run check:evidence
Acceptance evidence is unchanged.
                               # exit 0
```

---

## 5. 给 synth 的三句话

1. **本车道只交文档**，没有改任何 `src/**` 或 `tests/**`；`git status` 只有 `M docs/design-graph-examples.md`。
2. **计划里车道 2 的 M3 偏差已正面处理**：文档现在自己声明了「只有 ` ```json ` 整图受测、jsonc 片段不受测」，并且新增了一张「哪条机制说法是这道测试真的守得住」的表——**把静态说法和实测说法分开列**，避免读者把「测试全绿」误读成「每句机制都被测过」。
3. **文档里每个机制说法都指回了 `src/` 的文件:行**（见文档末尾两张表）。**车道 3 的对照件如果发现任何一处行号或结论对不上，请判 fail**——我按车道 3 的对照表收敛，不自行改车道 3 的结论。
