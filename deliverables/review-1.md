# 评审 1：worker-1 成果的独立审查

**审查对象**：`tests/console/complex-tier-v40.test.ts`（362 行，commit `8117681`）与其报告 `deliverables/v40-shape-e2e.md`（233 行）
**上游**：`plans/plan@1` §2 车道 1；`deliverables/plan-review@1` 判 **accept**
**本节点 focus**：只评 worker-1 的成果
**结论**：**PASS**

---

## 0. 判定摘要

| 维度 | 结论 | 我独立跑出的证据 |
|---|---|---|
| 目标用例可复跑 | ✅ | `node --run test -- tests/console/complex-tier-v40.test.ts` → **8 passed (8)**，exit 0 |
| 静态门 | ✅ | `typecheck` exit 0；`lint` exit 0；`check:evidence` exit 0（`Acceptance evidence is unchanged.`） |
| 全量 `check` 红与车道无关 | ✅ | 独立复现 42 failed / 187 passed（229）、128 / 1413（1541）；**放射性证明**：在干净副本里带上本车道文件后 m8 两条失败用例照样绿（11/11），红是沙箱环境不是本文件 |
| 阴性对照非套套逻辑 | ✅ | 我用变异实验独立证明：删 `when` → FM1 红；单条 fail 回边 → FM3 红（见 §3） |
| 机制引用属实 | ✅ | 逐条回源码核对（见 §2） |
| 文件边界 | ✅ | commit 只含声明的那 2 个文件，`src/**` 零改动 |
| 先写失败模式（R24） | ✅ | 文件头 30+ 行逐条写死 FM1–FM4，再写用例 |

无阻塞缺陷、无回归、无未支撑的声明、无验收缺口。下文给出可复核证据，并诚实登记 1 条非阻塞的措辞级偏差。

---

## 1. 复核方式（只读，不动实现文件）

```sh
# 在 review-1 工作副本内，全程只读
node --run test -- tests/console/complex-tier-v40.test.ts      # 8/8 exit 0
node --run typecheck && node --run lint && node --run check:evidence   # 全 exit 0
node --run test                                                # 42 failed | 187 passed (229)
git show 8117681 --name-only --format=''                       # 仅 2 文件
git status --short                                             # 空（干净）
```

**独立性声明**：阴性对照的判别力不是靠读代码下的结论，而是我在 `/tmp` 的 `cp -al` 副本里**对正向用例注入退化**、复跑并观察它变红（§3）。所有临时副本已删除，仓库工作树 `git status` 干净。

---

## 2. 机制引用逐条回源码核对

| 报告/用例头声称 | 我查到的 | 判定 |
|---|---|---|
| `when` 只**加依赖**并校验 case | `src/core/graph.ts:41-46`：`dependencies.push(condition.node)` + `Branch must select a declared router case` | ✔ |
| 真正**阻断**下游的是 `readiness()` 的 `skip`（FM1 根据） | `src/core/graph.ts:125-131`：条件节点 route ≠ case → `return 'skip'` | ✔（引对了，且比计划原文只引 33-45 更准） |
| 同 `from`+`case` 多回边**一起**触发 | `src/core/operation-lifecycle.ts:1114-1116`：`.filter(loop => loop.from === … && loop.case === …)`，是 filter 不是 find | ✔ |
| agent 可当路由器 | `operation-lifecycle.ts:1118`：`kind === 'agent' && Boolean(nodeSpec.routes?.length)` | ✔ |
| 批量返工真重跑全部目标 + 写 `graph.rework` | `operation-lifecycle.ts:1283-1290`：`reactivate(… routed.map(loop => loop.to))` + `graph.rework {from, to, via:'route', route}` | ✔ |
| FM4：`deliver` 无 `when`，守住验收门的是**返工连带重置** | `operation-lifecycle.ts:217`：`reactivate` 沿 `graph.plan.dependents(targetId)` 重置下游，`deliver` 因此被一起重置 | ✔（这是本车道最有价值的独立发现，见 §4） |
| FM4 原阴性对照（摘 `checkNode`）会在 `validateProposal` 被拒 | `src/core/proposal.ts:64-71`：`const check = nodes.get(item.checkNode)` → `mandatory` 假 → `invalid('Each acceptance item requires an assigned mandatory program check or Agent router')` | ✔（报告引 `63-72` 属实；`plan-review` 引的 `100-104` 是错行号，worker-1 反而更正了它） |

所有引用都能 grep 到，**零处把静态证据写成实测**。

---

## 3. 阴性对照的判别力（我做的变异实验）

这是本次评审的关键复核：用例能过 ≠ 用例在测东西。我在 `/tmp` 副本里对**正向用例注入退化**，确认它变红：

| 变异（只动正向用例的图） | 复跑结果 | 说明 |
|---|---|---|
| FM1 正向：删掉 worker-1..3 的 `when` | **1 failed**，报错正是 `expected [ 'worker-1','worker-2','worker-3' ] to deeply equal []` | FM1 量的确实是 `when` 计划门，不是永真 |
| FM3 正向：三条 `synth--fail-->` 只留一条 | **1 failed**，`reworks.map(...to)` 与三元素数组不符 | FM3 量的确实是批量返工，单点退化会被抓 |

对照报告 §3 的红段原样摘录，与我的复现一致。因此 **FM1/FM2/FM3/FM4 的正向断言 + 阴性对照是同一条断言的正反两面**，符合 R27「不是套套逻辑」的要求。

---

## 4. 实质正面发现（值得 synth 收录进汇总）

worker-1 独立撞出并正确写进文件头与报告的一条机制，**计划原文没有**：

> v40 的 `deliver` **没有 `when`**，只有 `dependsOn: ['synth']`，而「失败」的判定同样满足这个依赖。真正守住人工验收门的是**返工本身**——`reactivate` 沿 `GraphPlan.dependents` 把 `deliver` 一起重置（`src/core/operation-lifecycle.ts:217`），而不是 `deliver` 上的条件。

这解释了计划/文档里容易写错的一处（车道 2 若把验收门描述成「`deliver` 挂了条件」就与实测不符），worker-1 已在 §7 明确提醒 synth。这是**新增知识**，不是复述计划。

---

## 5. 全量 `check` 红的孤立性证明（我独立重做）

报告 §5 声称红是既有的、本车道文件前后一致。我用**更强的方式**验证（而不是只看失败清单 diff，因为 m8 进程用例本身抖动）：

```sh
cd /tmp && cp -al <review-1 工作副本> v40b && rm -f tests/console/complex-tier-v40.test.ts
node --run test -- tests/m8/integration.test.ts tests/m8/startup.test.ts   # 11 passed (11)
# 再把 worker-1 的文件放回去，同样复跑：
node --run test -- tests/m8/integration.test.ts tests/m8/startup.test.ts   # 11 passed (11)
```

即：在干净副本里，**带上本车道文件后这两条 m8 也全绿**——它们在 review 工作树里失败是沙箱里真起 daemon/CLI 进程所致，与 worker-1 的文件无关。目标用例文件**不在任何失败清单**里。

**非阻塞偏差 N1（措辞级）**：报告 §5 引的精确计数（"42 failed | 187 passed (229)" vs "43 failed | 185 passed (228)"，diff 只有 `tests/m1/recovery.test.ts` 一行）我**无法逐字复现**——环境失败集本身在抖动（我两次全量分别得到 42 与 40 个失败文件，差异落在 m8 进程用例）。报告的**结论**（本车道不引入任何新失败）经我独立验证成立，且报告已诚实标注「唯一多出来的是抖动」并给出 `tests/m1/recovery.test.ts` 单跑两次全绿（我复核：`5 passed (5)`）。因此这是**不精确的读数**，不是不实声明，不阻塞。
**files**：`deliverables/v40-shape-e2e.md`

---

## 6. 准入线与边界核验

- **文件边界**：commit `8117681` 仅 `tests/console/complex-tier-v40.test.ts` + `deliverables/v40-shape-e2e.md`，与计划 §5 交付清单一致；`src/**` 零改动（`git show --name-only | grep '^src/'` 无输出），遵守计划车道 1「明确不做」。
- **R22/R24 先写失败模式**：文件头 30 余行把 FM1–FM4 及其阴性对照、机制引用逐条写死，随后才是用例——顺序正确。
- **R27 层级**：全部断言从公开可观测面取（`dispatched.log` 派发记录、`graph.rework` 事件、`task.view()` 的 `questions`/`phase`/`nodes`），**没有断言私有变量或内部函数**；退化与重命名内部实现不需要改写这些断言。
- **不碰他人文件**：未改 `docs/design-graph-examples.md`（车道 2）、未碰 `complex-tier-shape.test.ts`（旧形状对照），符合车道互斥。
- **`when`/case 与用户约束一致**：图规格里 worker-1..3 的 `when: {node:'plan-reviewer', case:'accept'}`、`synth` 的 `route.declared: null`、三条 `synth--fail-->` 回边、acceptance 只绑 `deliver`，与本任务冻结的图规格逐字一致。

---

## 7. 判定

**PASS。**

worker-1 的成果可独立复跑（8/8 exit 0）、静态门全绿、文件边界干净、机制引用逐条属实、阴性对照经变异实验证明有判别力，并且独立发现了一条计划未写的机制（验收门靠返工连带重置守住）。唯一的 N1 是读数不精确（环境抖动导致计数不可逐字复现），其结论已被我独立证实，不构成阻塞或返工理由。

无阻塞缺陷 / 无回归 / 无未支撑声明 / 无验收缺口。
