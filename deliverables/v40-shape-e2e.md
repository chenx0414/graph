# 车道 1 报告：v40 形状的可执行 E2E

**交付物**：`tests/console/complex-tier-v40.test.ts`（本文件）
**计划**：`plans/plan@1` §2 车道 1 ｜ **计划评审**：`deliverables/plan-review@1` 判 **accept**
**未改任何 `src/**`**（计划 §2 车道 1「明确不做」；本车道没有撞出运行时缺陷，见 §5）

---

## 1. 做了什么

把本任务 proposal 的 **v40 规格原样**（10 个节点、4 条回边、1 条只绑 `deliver` 的验收项，逐字照抄）
喂给**真实运行时**：`TaskStore` + `openTaskRuntime` + 真实 `OperationLifecycle`；只有 Agent 车道换成脚本化
适配器（`tests/fixtures/lane.ts` 记的三个坑：`user.begin` 需要已知项目、车道结果要合规、结算异步要轮询
——三条都按夹具的规矩处理）。

脚本化车道按 `operation.nodeId` 分派（v40 里 worker-1/2/3 共用 `action: 'implement'`、review-1/2/3 共用
`action: 'review'`），每次派发都记进 `dispatched.log`，并且**把自己节点声明的 deliverable 真写进工作副本**
——没被派发的车道表现为「记录里没有」，而不是「断言恰好成立」。

节点、4 条回边、1 条验收项逐字照抄提案；绑定也照抄：planner/worker 是 `coder@10`、plan-reviewer 与
review-1..3 是 `reviewer@8`、synth 是 `synthesizer@1`，全部 `opencode-go:space-bunny-free`。

四条 FM 全部写成「正向断言 + 阴性对照」两段，阴性对照就是计划 §2 那一列要求的退化变体。

---

## 2. 四条失败模式与钉住它们的用例

| # | 失败模式 | 正向用例断言（黑盒可观测量） | 阴性对照 |
|---|---|---|---|
| FM1 | 计划门形同虚设：`replan` 后 worker 仍被派发 | replan 那一轮 `dispatched.log` 里 `worker-N`/`review-N`/`synth`/`deliver` 一个都没有；同时 `graph.rework {from:'plan-reviewer', to:['planner'], route:'replan'}` 真的写了；`accept` 之后三个 worker 各跑 1 次 | 删掉 `when` → 同一断言**红**（`expected [ 'worker-1','worker-2','worker-3' ] to deeply equal []`） |
| FM2 | synth 的 `fail` 落进死写法，回边不触发 | `graph.rework {from:'synth', to:['worker-1','worker-2','worker-3'], via:'route', route:'fail'}`；三个 worker 与三个 review 各跑 2 次 | synth 回未声明的 `nope` → 被拒（`Router must return a declared case`），**零** rework，worker 不重跑 |
| FM3 | 批量返工退化成单点返工 | 两轮 fail 产生两条 `to: [worker-1, worker-2, worker-3]`（长度、顺序都断言），三个 worker 各跑 3 次 | 只声明一条 `synth--fail-->` → `to: [worker-1]`，`countOf(workers) === [2,1,1]`（另两条**从未**被送回） |
| FM4 | 人工验收门被绕过：fail 后 `deliver` 仍被派发 | fail 结算后再扫 3 轮派发，用户收件箱里 `deliver` 的 `human_check` 提示**为 0**；`pass` 之后恰好 1 条、`owner: 'user'`、任务未 completed | 删掉三条 `synth--fail-->` 回边 → 同一个 fail 判定下提示照样打开（1 条），证明正向断言量的是返工门不是时钟 |

### 关于 FM4 阴性对照的改写（采纳 plan-review 的 M1）

计划原文写的是「把 acceptance 的 `checkNode` 从 `deliver` 摘掉」。plan-reviewer M1 已实测该变体被
`validateProposal` 在提案阶段就拒（`src/core/proposal.ts:63-72`，`Each acceptance item requires an assigned
mandatory program check or Agent router`），证的是静态规则、不是运行期门控。本车道按 M1 的建议改成
**运行期可观测**的退化，并选用「删掉三条 `synth--fail-->` 回边」这一种：同一个 fail 判定、同样的派发
轮数，验收提示照样打开（见 §3 的 FM4 红段）。理由写在用例文件头。

另外，v40 的 `deliver` **没有 `when`**，只有 `dependsOn: ['synth']`——而失败的判定同样满足这个依赖。
所以 FM4 真正钉住的是：**守住验收门的是返工本身（`reactivate` 沿 `GraphPlan.dependents` 把 `deliver`
一起重置），不是 `deliver` 上的条件**。这一点也写进了用例文件头的 FM4 段与 FM2 段的机制引用。

### 关于 FM1 的机制引用（采纳 plan-review 的 M2）

FM1 真正依赖的是 `GraphState.readiness()` 里的 `skip`（`src/core/graph.ts:125-131`），
`GraphPlan` 那段（33-46 行）只负责**加依赖**。文件头两处都引了，并据此说明为什么阴性对照要删 `when`
而不是删 `dependsOn`：只删 `dependsOn` 那条边会被 `GraphPlan` 拒绝，测不到阻断语义。

---

## 3. 红 → 绿 记录（四条 FM 各一段）

红段的产生方式都是**把该 FM 的正向用例指向它的退化变体**再跑一次，所以红的原因就是缺陷本身，
不是用例写法。原样摘录（`node --run test -- tests/console/complex-tier-v40.test.ts -t "<FM>"`）。

### FM1 红（删掉 worker 的 `when`）

```
FAIL  tests/console/complex-tier-v40.test.ts > FM1: a replan verdict sends the plan back and dispatches no worker at all
AssertionError: expected [ 'worker-1', 'worker-2', 'worker-3' ] to deeply equal []
- []
+ [
+   "worker-1",
+   "worker-2",
+   "worker-3",
+ ]
 ❯ tests/console/complex-tier-v40.test.ts:218:102
```

### FM2 红（`fail` 分支声明了但没接任何回边）

```
FAIL  tests/console/complex-tier-v40.test.ts > FM2: synth answering `fail` really fires the declared edges and the batch runs again
AssertionError: expected [] to deeply equal [ { from: 'synth', …(3) } ]
- [
-   {
-     "from": "synth",
-     "route": "fail",
-     "to": [
-       "worker-1",
-       "worker-2",
-       "worker-3",
-     ],
-     "via": "route",
-   },
- ]
+ []
```

### FM3 红（三条 `fail` 回边只剩一条）

```
FAIL  tests/console/complex-tier-v40.test.ts > FM3: one `fail` verdict sends all three workers back, in the declared order
AssertionError: expected [ [ 'worker-1' ], [ 'worker-1' ] ] to deeply equal [ …(2) ]
  [
    [
      "worker-1",
-     "worker-2",
-     "worker-3",
    ],
    [
      "worker-1",
-     "worker-2",
-     "worker-3",
    ],
  ]
```

### FM4 红（删掉三条 `synth--fail-->` 回边）

```
FAIL  tests/console/complex-tier-v40.test.ts > FM4: the human acceptance gate stays shut until synth passes, and opens exactly once
AssertionError: expected [ { …(8) } ] to deeply equal []
- []
+ [
+   {
+     "answer": null,
+     "data": {
+       "activationId": "b54cd40d-4945-4dc7-a10c-f7b6d26b4381",
+       "commitSha": "ab1a8851b7d4b7cc0e23aca2e2048ba746c1e480",
+       "prompt": "A human acceptance check is required",
+     },
+     "id": "bd25ea79-9066-44e1-832e-69dd9d3ad5cd",
+     "kind": "human_check",
+     "nodeId": "deliver",
+     "operationId": null,
+     "owner": "user",
+     "status": "open",
+   },
+ ]
```

### 绿（本车道用例文件，exit 0）

```
 ✓ tests/console/complex-tier-v40.test.ts > FM1: a replan verdict sends the plan back and dispatches no worker at all 1779ms
 ✓ tests/console/complex-tier-v40.test.ts > FM1 negative control: with `when` deleted, the same replan verdict dispatches all three workers 1453ms
 ✓ tests/console/complex-tier-v40.test.ts > FM2: synth answering `fail` really fires the declared edges and the batch runs again 3378ms
 ✓ tests/console/complex-tier-v40.test.ts > FM2 negative control: an undeclared case is refused, and no rework happens at all 2294ms
 ✓ tests/console/complex-tier-v40.test.ts > FM3: one `fail` verdict sends all three workers back, in the declared order 4313ms
 ✓ tests/console/complex-tier-v40.test.ts > FM3 negative control: one `fail` loop instead of three reworks exactly one worker 2742ms
 ✓ tests/console/complex-tier-v40.test.ts > FM4: the human acceptance gate stays shut until synth passes, and opens exactly once 3280ms
 ✓ tests/console/complex-tier-v40.test.ts > FM4 negative control: with the `fail` loops deleted, the same failed verdict opens the gate 2322ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Duration  22.98s
```

---

## 4. 跑过的命令与 exit code

| 命令 | exit | 结果 |
|---|---|---|
| `node --run test -- tests/console/complex-tier-v40.test.ts` | **0** | `Test Files 1 passed (1)` ／ `Tests 8 passed (8)` |
| `node --run typecheck` | **0** | 无输出 |
| `node --run lint` | **0** | `No unawaited expect().resolves/.rejects chains found.` |
| `node --run check:evidence` | **0** | `Acceptance evidence is unchanged.`（本轮不跑 `GRAPH_UPDATE_EVIDENCE=1`，符合计划 §3） |
| `node --run check` | **1** | 见 §5：红在**仓库既有的环境失败**上，本车道文件全绿 |

`git status --short` 只有本车道的两个文件：

```
?? deliverables/v40-shape-e2e.md
?? tests/console/complex-tier-v40.test.ts
```

工作树依赖：本次工作树已有 `node_modules`（指向 `/Users/macmini/workspace/13-Graph/node_modules` 的链接，
可解析、`vitest`/`tsc` 正常），因此没有再执行计划 §3 的 `cp -al`。未跑 `GRAPH_UPDATE_EVIDENCE=1`。

---

## 5. 全量 `check` 的红是既有的，不是本车道造成的

计划 §4 风险预案：全量 check 因环境红时，要**证明加自己的文件前后一致**。做法与结果：

```
加本车道文件： Test Files  42 failed | 187 passed (229)
                Tests      128 failed | 1413 passed (1541)
移走本车道文件： Test Files  43 failed | 185 passed (228)
                Tests      129 failed | 1404 passed (1533)
```

失败**文件清单**逐行 diff：

```
$ diff fail-without.txt fail-with.txt
15d14
< tests/m1/recovery.test.ts
```

即：**加了本车道文件之后失败清单少了一个，没有多任何一个**。唯一多出来的
`tests/m1/recovery.test.ts` 是抖动——单独连跑两次全绿：

```
$ node --run test -- tests/m1/recovery.test.ts
      Tests  5 passed (5)      # 第一次
      Tests  5 passed (5)      # 第二次
```

其余 42 个失败是本工作树的环境问题，形状与本车道无关，例如：

- `tests/console/simple-tier-e2e.test.ts`：`expected [] to include 'submit_result'`（模型目录/凭据缺失）
- `tests/m8/startup.test.ts`：`Error: Test timed out in 15000ms.`（真起 CLI 进程，沙箱里超时）
- `tests/m8/system-self-improvement.test.ts`：`provider.requests[1]` 是 `undefined`

按计划 §4 的预案，**没有为了变绿去动别人的测试**。

---

## 6. 本车道结论

- v40 的四个新机制（`when` 计划门、agent 路由器的 `fail` 触发回边、同 case 多回边=批量返工、
  返工连带关住人工验收门）在真实运行时里**全部成立**，四条 FM 各有红→绿两段记录与阴性对照。
- **没有撞出运行时缺陷**：四段红全部由「故意退化的图」造成，指回产品代码的断言（`graph.rework` 的
  `to` 数组、`readiness` 的 `skip`、回边批量触发）在退化变体下如实不成立。因此**没有需要主 Agent 定夺的
  src 缺陷**，也没有触发计划 §4 那条返工路径。
- 本轮未更新 `docs/planning/acceptance-evidence/`，`check:evidence` 绿。

## 7. 给 synth 的两处提醒

1. **车道 2 写文档时注意**：v40 的 `deliver` 没有 `when`，人工验收门是靠**返工连带重置**守住的。
   文档里若把人工验收门描述成「`deliver` 上挂了条件」，就与本车道的实测不符。
2. **plan-review 的 M3 与本车道无交集**（本车道不碰 `docs/design-graph-examples.md`），但车道 3 若要给
   「放行才开工」标证据强度，本车道这几条用例正好是它要的**实测**锚点：
   `tests/console/complex-tier-v40.test.ts` 的 FM1（`when` 门）、FM2/FM3（批量回边）、
   FM4（人工验收门）。

---

## 8. 返工回执（synth 判 fail 后的第 2 轮）

**本车道零代码改动。** synth 的 `rework['worker-1']` 只要求「复跑 + 留证」，本车道文件
（`tests/console/complex-tier-v40.test.ts`）在第 1 轮已合入 `8117681` 并在 HEAD 内，本轮**没有改它**。
本节即该回执。

### 8.1 复跑结果（本轮实测，原样摘录）

```
$ node --run test -- tests/console/complex-tier-v40.test.ts --reporter=verbose
 ✓ FM1: a replan verdict sends the plan back and dispatches no worker at all 1772ms
 ✓ FM1 negative control: with `when` deleted, the same replan verdict dispatches all three workers 1378ms
 ✓ FM2: synth answering `fail` really fires the declared edges and the batch runs again 3407ms
 ✓ FM2 negative control: an undeclared case is refused, and no rework happens at all 2208ms
 ✓ FM3: one `fail` verdict sends all three workers back, in the declared order 4381ms
 ✓ FM3 negative control: one `fail` loop instead of three reworks exactly one worker 2715ms
 ✓ FM4: the human acceptance gate stays shut until synth passes, and opens exactly once 3364ms
 ✓ FM4 negative control: with the `fail` loops deleted, the same failed verdict opens the gate 2363ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Duration  22.56s
TEST exit=0
```

| 命令 | exit | 结果 |
|---|---|---|
| `node --run test -- tests/console/complex-tier-v40.test.ts` | **0** | `Tests 8 passed (8)`（期望值 8，与第 1 轮一致） |
| `node --run typecheck` | **0** | 无输出 |
| `node --run lint` | **0** | `No unawaited expect().resolves/.rejects chains found.` |
| `node --run check:evidence` | **0** | `Acceptance evidence is unchanged.` |

**无回归**：8 个用例的名字、红→绿记录、阴性对照与第 1 轮逐条相同；本车道本轮唯一改动是本节回执文本。

### 8.2 对 synth 判定理由的回应

synth 判 fail 的两条必修项都在 `docs/design-graph-examples.md`（车道 2 的文件），**与本车道无交集**，
本车道不据此改动任何文件。本车道仅作两点澄清，供对齐用：

1. **synth 简报里的第 4 条（「验收门靠返工连带重置守住：deliver 无 `when`，由 `reactivate` 沿
   `dependents` 一起重置」）正是本车道 FM4 实测到的东西**，已写在本报告 §2 与用例文件头。
   车道 2 的 M1/M2 修的是同一节文档里的另外两处（`predecessors` 默认值、行号），与此条不冲突。
2. **synth 的 `vetoNote`（否决 review-2 §3.3 的 `operation-lifecycle.ts:1117` 行号建议）与本车道引用的
   行号不冲突**：本车道文件头引用的是 `:1090-1108`（分支只从已声明的 case 里取）与 `:1114-1116`
   （`routed` 用的是 `filter`），**从未引用 `:1117`**，因此照办 veto 不会让本车道文件产生新的错误引用。
   本车道本轮也没有动这三处引用。
