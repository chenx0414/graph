# plan-review：对 planner 计划（`plans/plan@1`）的独立审查

**审查对象**：`plans/plan.md` —— `ef7b5e42e8b603b450608165d7e097a992e2bd612f33b17c02dbb9c98c589c2c`（artifactId `2cfe45a2-6a96-42ba-bc20-f7713a47a628@1`）
**工作副本**：`fu-za-dang-v40-planner-chu-ji-hua-plan-r-4c251059/plan-reviewer`
**结论**：**accept**（放行）。计划可行、证据链基本可复核、三条车道互斥文件切分正确；发现 1 个实质缺陷（FM4 阴性对照写错机制）与若干次要偏差，均可在执行期由对应车道自行修正，不构成返工理由。下文逐条给出可复核证据。

---

## 1. 复核方式

计划 §1 声明「plan-reviewer 可按此复核」。我按该表逐条回到仓库源码，并对计划想落成的 v40 形状**用一个临时探针用例喂给产品自己的 `validateProposal`**（探针已删除，工作副本 `git status` 干净）。

```sh
# 探针（临时文件 tests/console/__probe_v40.test.ts，已删）
# 按计划 §2 车道 2 描述的 v40 形状构造 proposal，调用 src/core/proposal.ts 的 validateProposal
node --run test -- tests/console/__probe_v40.test.ts   # → ACCEPTED
```

---

## 2. 计划 §1 事实表逐条复核

| 计划声称 | 我查到的 | 判定 |
|---|---|---|
| `when: {node, case}` 给节点加依赖，且 case 必须是路由器声明过的分支 | `src/core/graph.ts:41-46`（`conditions` 循环 + `Branch must select a declared router case`） | ✔ 属实 |
| **关键**：`when` 不只是加依赖，还要阻断下游 | `src/core/graph.ts:125-131` `readiness()`：条件节点 status 非 succeeded → `waiting`；route ≠ case → `skip`。这是 FM1 成立的根据 | ✔ 属实（计划没引这一行，见 §4-M2） |
| 同 `from` 同 `case` 的多条回边一起触发 | `src/core/operation-lifecycle.ts:1114-1116` 用 `.filter(...)` 取全部 loop | ✔ 属实 |
| 批量返工真重跑全部目标 | `operation-lifecycle.ts:1281-1289` `reactivate(routed.map(loop => loop.to))` + `graph.rework { from, to: [...] }` | ✔ 属实 |
| agent 节点可当路由器 | `operation-lifecycle.ts:1118` `operation.kind === 'agent' && Boolean(nodeSpec.routes?.length)`；`src/core/proposal.ts:70` 同判据 | ✔ 属实 |
| `review_human_check` 已存在 | `src/runtime/agent-tool-definitions.ts:261`、`src/runtime/agent-tools.ts:438` | ✔ 属实 |
| 文档里每个含 `"nodes"` 的 ```json 块都被喂给 `validateProposal` | `tests/console/design-examples.test.ts:18-45`，正则以 ```json 开头，且 `body.includes('"nodes"')` | ✔ 属实 |
| 已有复杂档 E2E 测的是另一种形状 | `tests/console/complex-tier-shape.test.ts` 文件头：`Pass?` 是 `graph.verify` + `multiview`，1 worker + reviewer-1..2，计划评审是**并列**回路 | ✔ 属实 |
| 跑真实任务图的夹具与三个坑 | `tests/fixtures/lane.ts` 文件头 1-13 行 | ✔ 属实 |
| `node --run check` + 工作树里 `cp -al node_modules` | `package.json` `check` = typecheck+lint+test+check:evidence；`docs/guides/checks.md` 明文要求 `cp -al` | ✔ 属实 |

**计划 §1 全部结论均可复核，没有发现把「静态」写成「实测」的情形。**

---

## 3. 计划想落成的 v40 形状：validator 实测通过

我按车道 2 的描述（planner / plan-reviewer(routes accept\|replan) / worker-1..3（`when:{node:'plan-reviewer',case:'accept'}`）/ review-1..3 / synth(agent router) / deliver(`graph.human_check`)，loops 四条，acceptance 只绑 `deliver`）构造 proposal，喂给 `src/core/proposal.ts`：

```
ACCEPTED
```

即计划的核心方向**结构性成立**：agent 路由器、`when` 门、`synth--fail-->worker-1/2/3` 三条同 case 回边、`deliver` 作为唯一验收 `checkNode`，都被产品自己的 validator 接受。这消除了车道 2 的最大风险（照抄形状被拒）。

---

## 4. 发现（按影响排序）

### M1 —— 实质缺陷：FM4 的阴性对照写错了机制（会得出与声称相反的东西）

**位置**：计划 §2「车道 1」失败模式表 FM4 的「阴性对照」列：
> 「把 acceptance 的 `checkNode` 从 `deliver` 摘掉，验收项不再成立（用例会红）」

**问题**：`acceptance.checkNode` 摘掉后，**提案在 `validateProposal` 阶段就被拒**，图根本不会跑起来。我实测（探针，已删）：

```
REFUSED: Each acceptance item requires an assigned mandatory program check or Agent router
```

证据：`src/core/proposal.ts:100-104` —— `const check = nodes.get(item.checkNode)` 对 `undefined` 取不到，`mandatory` 为假，直接 `invalid(...)`。

**影响**：这条阴性对照证明的是「validator 会拒绝缺 checkNode 的 acceptance」，**不是**「人工验收门会被绕过」。它把一条 `invalid_proposal` 静态拒绝冒充成运行期门控退化，属于 R27 明令禁止的套套逻辑（子句「用例会红」是真的，但它红在 validator 上，与 FM4 要防的退化解耦）。若照抄，车道 1 会以为自己守住了「验收门被绕过」，实际没守住。

**修法建议**（车道 1 自行改，不需要返工 planner）：FM4 的阴性对照应改为**运行期可观测**的退化，例如：把 `deliver` 的 `when` 去掉（它会在 `synth` 判 fail 后仍然 ready、被派发），断言该变体下 `deliver` 派发次数 > 0，从而证明原用例的「fail 轮次 deliver 派发为 0」不是永真。

**files**：`tests/console/complex-tier-v40.test.ts`

---

### M2 —— 次要有害偏差：FM1 的核心根据没引导线

**位置**：计划 §1 表用 `src/core/graph.ts:33-45` 说明 `when` 是受支持的节点门。属实，但 33-45 只覆盖「校验/加依赖」，**没有覆盖** FM1 真正依赖的「阻断」语义——`readiness()` 的 `skip`（`src/core/graph.ts:125-131`）。计划通篇没有引用这一行。

**影响**：车道 1 若要按 FM1 写「replan 轮次里不含任何 worker-N」，依据应是 `readiness()` 而非仅 `when` 的校验。缺了这条引导，实现者可能误以为 `when` 只影响依赖排序、不会 skip，从而写出过强或过弱的断言。**建议**车道 1 在用例文件头注释里补引 `src/core/graph.ts:125-131`。

**files**：`tests/console/complex-tier-v40.test.ts`

---

### M3 —— 次要：车道 2 的完成判据把 jsonc 块误当成被测对象

**位置**：计划 §2「车道 2」写明「每一个含 `"nodes"` 的 json 代码块都会被喂给 `validateProposal`」，并把「`design-examples.test.ts` 全绿」当作「新 JSON 被 validator 接受」的完成判据。

**事实**：`docs/design-graph-examples.md` 里复杂档现有的「判定节点关键两处」是 ` ```jsonc `（`docs/design-graph-examples.md:328`）——`design-examples.test.ts:24` 的正则只匹配 ` ```json `，**jsonc 块被跳过**。计划的「完整初稿」（`:353`）才是 ` ```json ` 且含 `"nodes"`，会被测。

**影响**：计划让车道 2「把完整初稿换成 v40 的 JSON」，方向正确（该块确实被测）。但如果实现者顺手改到 328 的 jsonc 片段，测试**不会**报错，完成判据会给假绿。建议在 §2 车道 2 显式标注「只有 ```json（非 jsonc）且含 `"nodes"` 的块受测；jsonc 片段不测」，避免假绿。

**files**：`docs/design-graph-examples.md`

---

### M4 —— 次要：`docs/evidence/` 既当仓库报告目录、又撞产品 namespace 名

**位置**：计划 §2 三条车道分别产出 `docs/evidence/v40-shape-e2e.md`、`docs/evidence/v40-doc-notes.md`、`docs/evidence/v40-mechanisms-report.md`；同时 §5 交付物清单也列为「报告」。

**事实**：仓库当前**不存在** `docs/evidence/` 目录（`ls deliverables` → No such file or directory）；`deliverables` 在产品里是节点 `deliverable.namespace` 的合法取值之一（`src/core/proposal.ts:33`）。两者同形但语义不同。

**影响**：低。这些是仓库工作树内的报告文件，不是节点 deliverable，放在 `docs/evidence/` 不违反任何规则；但容易被误读成「节点产出物命名空间」。不阻塞放行，仅提示各车道写文件时自建目录即可（`git status` 已确认当前工作副本干净，这些目录尚不存在）。

**files**：`docs/evidence/v40-shape-e2e.md`、`docs/evidence/v40-doc-notes.md`、`docs/evidence/v40-mechanisms-report.md`

---

## 5. 未发现问题的点（防止验收缺口）

- **三条车道的文件互斥性成立**：worker-1 独占 `tests/console/complex-tier-v40.test.ts` + `docs/evidence/v40-shape-e2e.md`；worker-2 独占 `docs/design-graph-examples.md` + `docs/evidence/v40-doc-notes.md`；worker-3 独占 `notes/complex-tier-v40-mechanisms.md` + `docs/evidence/v40-mechanisms-report.md`。三组无交集，可真并行。
- **计划没有把「静态」冒充「实测」**，车道 3 还专门要求三档标注（实测/静态/未覆盖），符合 R27/R24 精神。
- **不更新 `acceptance-evidence/`**：计划 §3 明说本轮不跑 `GRAPH_UPDATE_EVIDENCE=1`，与 `scripts/check-evidence.mjs` + `docs/guides/checks.md` 一致，`node --run check` 不会因证据被动改而红。
- **不自行改 `src/**`**：计划 §2 车道 1「明确不做」与 §4 风险预案一致——撞出运行期缺陷写红测试交 synth 判 fail，符合职责边界。
- **测试纪律**：各车道要求先红后绿、阴性对照留文件、用 `settle(...)` 轮询而非固定 sleep，符合 R22/R23/R27。

---

## 6. 判定

**accept。**

计划可独立执行：三条车道的目标、独占文件、验证命令、完成判据都可验证；核心 v40 形状经我用产品自己的 validator 实测通过；§1 事实表全部可复核。发现的 4 个问题——

- M1 是实质缺陷但**局限在车道 1 的一条阴性对照**，修法是重选运行期退化，不需要返工 planner；
- M2/M3/M4 是引导与措辞层面的偏差。

它们在执行期由对应车道各自收敛即可，不构成返工的充分理由。放行，worker-1..3 可以开工。
