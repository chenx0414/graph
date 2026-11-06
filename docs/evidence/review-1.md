# 评审 1：worker-1 成果的独立审查（attempt 3）

**审查对象**：`tests/console/complex-tier-v40.test.ts`（362 行，commit `8117681`，sha256 `e91bb896…`）与其报告 `docs/evidence/v40-shape-e2e.md`（v2，282 行，含 §8 返工回执）
**上游**：`plans/plan@1` §2 车道 1；`docs/evidence/plan-review@1` 判 **accept**
**本节点 focus**：只评 worker-1 的成果
**当前 tip**：`e051db4`（工作树 `git status` 干净）
**结论**：**PASS**

---

## 0. 判定摘要

| 维度 | 结论 | 我本轮独立跑出的证据 |
|---|---|---|
| 目标用例可复跑 | ✅ | `node --run test -- tests/console/complex-tier-v40.test.ts` → **8 passed (8)**，exit 0（含 4 条阴性对照） |
| 静态门 | ✅ | `typecheck` exit 0；`lint` exit 0（`No unawaited expect()...`）；`check:evidence` exit 0（`Acceptance evidence is unchanged.`） |
| 全量 `check` 红与车道无关 | ✅ | 独立复现 42 failed / 187 passed (229)、128 / 1413 (1541)，与 attempt 2 基线逐字一致；目标文件在输出中出现 **0** 次 |
| 阴性对照非套套逻辑 | ✅ | 4 条阴性对照在用例内自做退化（FM1 在 `:260` 真删 `when` 并有 `:261` 断言把门守卫住），且全部通过 |
| 机制引用属实 | ✅ | 逐条回源码核对（见 §2），零处把静态证据写成实测 |
| 文件边界 | ✅ | `git show 8117681 --name-only` 只含声明的 2 个文件；`src/**` 零改动 |
| 先写失败模式（R24） | ✅ | 文件头 30+ 行逐条写死 FM1–FM4，再写用例 |

无阻塞缺陷、无回归、无未支撑的声明、无验收缺口。

---

## 1. 本轮复核方式（只读，不动实现文件）

```sh
node --run test -- tests/console/complex-tier-v40.test.ts            # 8/8 exit 0
node --run test -- tests/console/complex-tier-v40.test.ts --reporter=verbose
                                                                     # 8 条用例名逐条列出，exit 0
node --run typecheck && node --run lint && node --run check:evidence # 全 exit 0
node --run test                                                      # 42 failed | 187 passed (229)
git show 8117681 --name-only --format=''                             # 仅 2 文件
git status --short                                                   # 空（干净）
```

**返工触发原因与本节点无关**：本轮返工是 synth 判 fail（两条必修项落在 `docs/design-graph-examples.md`，车道 2）。worker-1 不在返工面内，**零改动复跑**。被测文件 sha256 在 `8117681` / `12b9a81` / `HEAD` 三处逐字节相同（`e91bb896…`），报告只追加了 §8 回执文本。

---

## 2. 机制引用逐条回源码核对（本轮重核）

| 报告/用例头声称 | 我本轮查到的 | 判定 |
|---|---|---|
| `when` 只**加依赖**并校验 case | `src/core/graph.ts:41-46`：`dependencies.push(condition.node)` + `Branch must select a declared router case` | ✔ |
| 真正**阻断**下游的是 `readiness()` 的 `skip`（FM1 根据） | `src/core/graph.ts:125-131`：`if (this.states.get(condition.node)!.route !== condition.case) return 'skip'` | ✔ |
| 同 `from`+`case` 多回边**一起**触发 | `src/core/operation-lifecycle.ts:1114-1116`：`.filter(loop => loop.from === … && loop.case === …)`，是 filter 不是 find | ✔ |
| agent 可当路由器 | `src/core/operation-lifecycle.ts:1118`：`operation.kind === 'agent' && Boolean(nodeSpec.routes?.length)` | ✔ |
| 批量返工真重跑全部目标 + 写 `graph.rework` | `src/core/operation-lifecycle.ts:1283-1290`：`reactivate(… routed.map(loop => loop.to))` + `graph.rework {from, to, via:'route', route}` | ✔ |
| FM4：`deliver` 无 `when`，守住验收门的是**返工连带重置** | `src/core/graph.ts:205-217`：`reactivate` 循环 `for (const dependent of graph.plan.dependents(targetId)) affected.add(dependent)` 重置下游；调用点 `operation-lifecycle.ts:957/1284`。用例文件头 `tests/console/complex-tier-v40.test.ts:41-46` 正确引 `src/core/graph.ts` | ✔ |
| FM4 原阴性对照（摘 `checkNode`）会在 `validateProposal` 被拒 | `src/core/proposal.ts:64-71`：`const check = nodes.get(item.checkNode)` → `mandatory` 假 → `invalid(...)` | ✔ |

所有引用都能 grep 到，**零处把静态证据写成实测**。

---

## 3. 阴性对照的判别力

用例把阴性对照**内建**在同一条断言的正反两面，且自身守卫退化真的发生：

- `tests/console/complex-tier-v40.test.ts:260` `const ungated: NodeSpec[] = v40Nodes.map(({ when: _gate, ...node }) => node);`
- `:261` `expect(ungated.some(node => 'when' in node)).toBe(false);` —— 先证明门真的被删掉，再用同一判定复跑。

本轮 verbose 复跑逐条确认 **8/8 通过**，4 条正向 + 4 条阴性对照全部在位：

```
✓ FM1: a replan verdict sends the plan back and dispatches no worker at all
✓ FM1 negative control: with `when` deleted, the same replan verdict dispatches all three workers
✓ FM2: synth answering `fail` really fires the declared edges and the batch runs again
✓ FM2 negative control: an undeclared case is refused, and no rework happens at all
✓ FM3: one `fail` verdict sends all three workers back, in the declared order
✓ FM3 negative control: one `fail` loop instead of three reworks exactly one worker
✓ FM4: the human acceptance gate stays shut until synth passes, and opens exactly once
✓ FM4 negative control: with the `fail` loops deleted, the same failed verdict opens the gate
```

这满足 R27「不是套套逻辑」：正向断言与阴性对照是同一条断言的正反两面，且我在 attempt 1 用外部变异实验独立证明过删 `when` → FM1 红。本轮用例内建的 `:261` 守卫使这条证据**自包含可复跑**，不再依赖评审的外部实验。

---

## 4. 实质正面发现（值得 synth 收录）

worker-1 独立撞出并正确写进文件头与报告的一条机制，**计划原文没有**：

> v40 的 `deliver` **没有 `when`**，只有 `dependsOn: ['synth']`，而「失败」判定同样满足这个依赖。真正守住人工验收门的是**返工本身**——`reactivate` 沿 `GraphPlan.dependents` 把 `deliver` 一起重置（`src/core/graph.ts:205-217`）。

报告 §8.2 明确提醒车道 2：若把验收门描述成「`deliver` 挂了条件」就与实测不符。我本轮逐条核对 `graph.ts:205-217` 属实。这是**新增知识**，不是复述计划。

---

## 5. 全量 `check` 红的孤立性（本轮独立重做）

| 运行 | Test Files | Tests |
|---|---|---|
| 本轮 `node --run test` | **42 failed / 187 passed (229)** | **128 failed / 1413 passed (1541)** |
| attempt 2 基线 | 42 / 187 (229) | 128 / 1413 (1541) |

逐字一致。失败清单里 `complex-tier-v40` 出现 **0** 次（`grep -c` 与失败文件列举均确认）。失败集中在 `tests/m0`（`ERR_MODULE_NOT_FOUND: @earendil-works/pi-ai`，工作副本 `node_modules` 软链越出副本所致）、`tests/m3`、`tests/m7`（`spawnSync git ENOENT`）、`tests/m8`（真起进程/daemon）。红是沙箱环境基线，不是本文件。

**诚实登记**：与 attempt 2 一样，本轮仍未能重做「m8 绿/红随本车道文件取放不变」那条隔离实验（`cp -al` 副本的测试发现面与工作树不一致）。本轮确定性证据改为：(a) 目标用例单跑 8/8 exit 0；(b) 全量运行后 `complex-tier-v40` 在失败输出中零出现；(c) 该文件在三处 tip 逐字节相同。三条足以支撑「红与本文件无关」。

---

## 6. 非阻塞偏差（登记，不扣分）

**N1（上一轮遗留，措辞级）**：报告 §5 引的精确计数与我的两次全量读数有轻微出入（环境失败集在 m8 进程用例上抖动）。报告的**结论**（本车道不引入任何新失败）经我独立验证成立，且报告已诚实标注「唯一多出来的是抖动」。这是**不精确的读数**，不是不实声明。

**files**：`docs/evidence/v40-shape-e2e.md`

---

## 7. 独立判定

对 worker-1 成果：**correctness = pass**。目标 E2E 8/8 绿、static gates 全 0、阴性对照判别力成立、机制引用零错、文件边界干净、失败模式先写（R24）/E2E 优先（R23）/非套套逻辑（R27）均满足。无阻塞缺陷、无回归、无未支撑声明、无验收缺口。
