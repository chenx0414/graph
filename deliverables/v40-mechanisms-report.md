# worker-3 车道报告：v40 机制对照与证据表

**交付物**：`notes/complex-tier-v40-mechanisms.md`（主件，逐句对照表 + 机制坑 + 自检命令 + 未覆盖清单）、本报告（摘要）。
**对象**：任务 `4c251059-89d9-4876-a281-380c9559c88c` 的已确认提案 `graph_revisions.version=1`（4891 字节）与**本次真实运行**的事件/表记录。

---

## 1. 一句话结论

v40 的图**形状**成立：`when` 门、agent 路由器自述分支、`fail` 批量回边、人工门都能在代码里指出唯一强制点，17 行需求里 11 行有绿测试或本次运行记录钉着。
但有 **3 行未覆盖**（worker 成果无强制点、replan 时 worker 被 skip 的完整形状、"向用户汇报"）、**3 行只有静态代码**，并且有 **2 行实测下来与需求原文相反**——这两条必须让 synth 知道，因为它们直接决定「v40 能不能照抄」。

---

## 2. 对照表摘要

完整表在 `notes/complex-tier-v40-mechanisms.md` §1（列：需求原句 / 图里的字段 / 运行时强制点 / 钉住它的测试 / 证据强度）。分布：

| 证据强度 | 行数 | 指的是哪几行 |
|---|---|---|
| **实测**（有绿测试或本次运行记录） | 11 | #1 计划落盘、#2 审查、#3 返工 planner、#4 直到通过、#5a 放行才分发、#7 一一对应评审、#9 写汇总、#10 自判 pass/fail、#12 验收绑 deliver、#14 主 Agent 审证据、#16 全节点同模型 |
| **静态**（只有代码路径，本次没走到） | 3 | #8 synth 收齐三份评审、#11 三条回边全部返工、#13 人工门实际打开 |
| **未覆盖**（无强制点或强制点与需求不符） | 3 | #5b replan 时 worker 及下游 skip、#6 三个 worker 各产出一份成果、#15 再向用户总结汇报 |

三条车道都要用的两个硬事实：

- **#6 是真缺口**：v40 的 `worker-1/2/3` **没有声明 `deliverable`**，所以运行时对"每个 worker 产出什么"零强制。本轮 worker 的成果只是工作副本里的文件，靠 review-N 读。车道 2 写文档时若写成"每个 worker 产出一份成果"，那是**约定**不是机制。
- **#11 没有任何测试**：全仓 `tests/` 里搜不到任何一个提案写过"同 from 同 case 的两条 loop"（否证脚本见主件 §3-4，输出为 0 组）。批量返工目前是**只靠代码读出来的**。

---

## 3. 两条与需求原文相反的实测结果（请 synth 重点看）

### 3.1 「全部节点用 space-bunny-free」在评审节点上不成立

本次运行的产品自带记录（不是我的推断）：

```
events.model.switched
  {"nodeId":"plan-reviewer","from":"opencode-go:space-bunny-free",
   "to":"opencode-go:deepseek-v4.1-flash","instanceId":"df5af0f1-…"}
events.review.independence_checked
  {"nodeId":"plan-reviewer","independence":"model-excluded",
   "policy":{"excludedModels":["opencode-go:space-bunny-free","space-bunny-free"], …}}
invocations: planner 71 次 space-bunny-free / plan-reviewer 46 次 deepseek-v4.1-flash
```

链路：`presets/manifest.json` 的 `reviewer` 定义带 `review:true` → `src/core/model-selection.ts:12-17` `isReviewer` 命中 → `:20-48` `implementerModels` 把依赖节点**实际调用过**的模型收进 `exclude` → `src/catalog/models.ts:169-170` 先按 `exclude` 过滤再找 `requested`，找不到就退到 grade 默认 → `src/core/execution.ts:751` 发 `model.switched`。

**这是需求冲突，不是实现缺陷**：v40 要求"评审也用 space-bunny-free"，而运行时要求"独立评审不得用实施者的模型"。二者只能选一个，现在选的是后者。
按当前图，`review-1/2/3` 与 `synth` 都在各自上游结算之后才派发，届时它们的 `exclude` 里也会有 `space-bunny-free`，**预计同样被换掉**。
**给 synth 的判断建议**：文档里不要照抄"全部节点 space-bunny-free"；要么写清"评审节点会被换成别的模型（这是设计）"，要么这条需求本身就该改。

### 3.2 「先由主 Agent 审证据、再向用户汇报」里的"先"不是一道门

`tests/console/human-prereview.test.ts:48-57`（本次跑绿）钉住的事实：human check 打开的瞬间，`questions` 行的 `owner` 已经是 `user`、`status` 已经是 `open`，**同时**主 Agent 被 `human_check` 唤醒。
`approve:true` 只是追加 `preReview` 字段并发 `human.prereview_approved` 事件（`src/core/question-routing.ts:304-317`），check 仍然 open、仍然归用户；`approve:false` 是给该节点插一条 `rework` 问题（`src/core/task-runtime.ts:2181-2192`），走返工而不是"拒绝验收"。

所以机制能保证的是"主 Agent 被叫醒并拿到证据"，**保证不了用户一定等到他审完**。工具描述里那句 "before the user is asked" 描述的是注意力顺序。

---

## 4. 交付之后仍然未覆盖的（补法）

| # | 未覆盖 | 补它需要哪个测试 |
|---|---|---|
| 4-1 | plan-reviewer 判 `replan` 时三个 worker **及其下游**被 skip | 车道 1 的 `complex-tier-v40.test.ts`：跑 v40 全形，断言 `replan` 轮次 `briefings` 不含任何 `worker-N`、出现三次 `node.skipped{reason:'inactive_route'}`；阴性对照＝删掉 `when` 后同断言必须失败 |
| 4-2 | 三个 worker 各产出一份成果 | 给三个 worker 各加 `deliverable`，用 `node-deliverable.test.ts:157` 已有的"声明未写即失败"语义写断言；或保持现状并在文档里明写这是约定 |
| 4-3 | 再向用户总结汇报 | 图节点没有面向用户的汇报通道，**目前写不出有意义的断言**；建议把这条需求从图机制里拿掉，或改写成"节点结论先出现在主 Agent 的 task view" |
| 4-4 | `synth` 判 `fail` 时三条回边一起触发 | 车道 1 同一份 E2E：断言 `graph.rework{from:'synth',to:['worker-1','worker-2','worker-3']}` 且三个 worker 的 `briefings` 各 +1；阴性对照＝只留一条 loop 时断言必须失败 |
| 4-5 | 「全节点同模型」在评审节点上的期望行为没有被钉死 | 给"同模型做评审"写一条测试，把行为钉死（切换并记 `model.switched`，还是拒绝派发），否则每次都可能悄悄变 |
| 4-6 | `deliver` 人工门在 synth 判 `pass` 后才开、判 `fail` 时不开 | 沿用 4-4 的同一条 E2E：`fail` 轮次后 `deliver` 派发次数 0，`pass` 之后 1 |

---

## 5. 本车道跑过的命令与 exit code

工作树：`state/worktrees/fu-za-dang-v40-planner-chu-ji-hua-plan-r-4c251059/worker-3`（`node_modules` 由宿主建立的符号链接，按 ADR 0027 授权）。

| # | 命令 | exit | 结果 |
|---|---|---|---|
| 1 | `node --run test -- tests/console/review-as-router.test.ts tests/console/node-deliverable.test.ts tests/console/human-prereview.test.ts tests/console/human-prereview-e2e.test.ts tests/console/design-examples.test.ts` | **0** | `Test Files 5 passed (5)` / `Tests 19 passed (19)`（12.05s）——表里 #1#2#3#4#5a#7#9#10#12#14 引用的钉子全绿） |
| 2 | `node --run test -- tests/m4/acceptance.test.ts tests/console/context-model.test.ts tests/console/predecessor-handoff-production.test.ts` | **1** | `Test Files 2 failed \| 1 passed (3)` / `Tests 9 failed \| 20 passed (29)`；`tests/m4/acceptance.test.ts` 全过（#13 的钉子） |
| 3 | `node --run check` | **1** | typecheck、lint 无报错；vitest `Test Files 42 failed \| 186 passed (228)` / `Tests 128 failed \| 1405 passed (1533)`（Duration 206.68s），随后 `check:evidence` 未执行到。详见 §5.1 |

### 5.1 全量 check 的失败是环境既有失败，与本车道无关（A/B 证明）

`node --run check` 在本工作树红（`CHECK_EXIT=1`），**跑了两次，两次的失败数字一字不差**（`42 failed | 186 passed (228)`、`128 failed | 1405 passed (1533)`）。

**A/B 证明**：把当时已存在的 `notes/complex-tier-v40-mechanisms.md`（本报告当时还没写）移出工作树后，重跑命令 2 里失败的那两个文件：

```
mv notes/complex-tier-v40-mechanisms.md /tmp/worker3-hold/ && rmdir notes
git status --porcelain          # 空输出
node --run test -- tests/console/context-model.test.ts tests/console/predecessor-handoff-production.test.ts
→ EXIT=1   Test Files  2 failed (2)   Tests  9 failed | 12 passed (21)
```

**同样这 9 条、同样的数字**，与加上我的文件时一字不差。两个文件都是 `notes/` 与 `deliverables/` 下的新 markdown，没有任何测试读它们；这些 E2E 失败的原因是节点回合没跑起来（`provider.requests[1]` 为 `undefined`、`context` 为 `null`），属沙箱环境问题。
按计划的预案：不为了变绿去改别人的测试，只记原始失败清单。完整 42 个失败文件清单见 §5.2。

### 5.2 全量 check 失败的 42 个文件（原文清单）

```
tests/console/chain-depth.test.ts            tests/console/predecessor-handoff-production.test.ts
tests/console/compaction.test.ts             tests/console/presets.test.ts
tests/console/context-model.test.ts          tests/console/schema-upgrade.test.ts
tests/console/handoff-response.test.ts       tests/console/simple-tier-e2e.test.ts
tests/console/matt-merge-recipe.test.ts      tests/console/stranded-nodes.test.ts
tests/console/node-run.test.ts               tests/m0/agent-session-contract.test.ts
tests/m0/pi-process.test.ts                  tests/m0/restricted-process.test.ts
tests/m3/capabilities.test.ts                tests/m3/models.test.ts
tests/m3/production.test.ts                  tests/m3/retrieval.test.ts
tests/m3/workspace-command.test.ts           tests/m7/delivery.test.ts
tests/m7/harness.test.ts                     tests/m7/page.test.ts
tests/m7/production.test.ts                  tests/m8/agent-control.test.ts
tests/m8/concurrency.test.ts                 tests/m8/conversation-capability-access.test.ts
tests/m8/conversation-multimodal.test.ts     tests/m8/conversation-pi.test.ts
tests/m8/conversation-readonly.test.ts       tests/m8/conversation-sediment.test.ts
tests/m8/conversation-skill.test.ts          tests/m8/conversation-suggestion.test.ts
tests/m8/conversation-ui.test.ts             tests/m8/conversation.test.ts
tests/m8/credentials.test.ts                 tests/m8/integration.test.ts
tests/m8/node-prompt-ui.test.ts              tests/m8/node-prompt.test.ts
tests/m8/pi-native-tools.test.ts             tests/m8/rework.test.ts
tests/m8/startup.test.ts                     tests/m8/system-self-improvement.test.ts
```

注意：其中 `context-model.test.ts` 与 `predecessor-handoff-production.test.ts` 失败的是 **E2E 部分**；我在表里引用的
`context-model.test.ts:74`（纯 `validateProposal` 的策略校验）**本次跑绿**。#7 的运行时投影那一半（`predecessor-handoff-production.test.ts:102`）在本环境红，因此 #7 的"实测"依据是**本次运行的 `context.handoff_policy_selected` / `context.evidence_only_frozen` 事件**（plan-reviewer、worker-1/2/3 各一条 `evidence_only`），而不是那条红测试。

---

## 6. 边界

- 本车道只新增两个文件：`notes/complex-tier-v40-mechanisms.md`、`deliverables/v40-mechanisms-report.md`。`git status --porcelain` 原文：

  ```
  ?? deliverables/
  ?? notes/
  ```

  （`deliverables/plan-review.md` 是 plan-reviewer 车道的既有 tracked 文件，不是本车道产物。）
- 没有改 `src/**`、`tests/**`、任何 `docs/**`；没有跑 `GRAPH_UPDATE_EVIDENCE=1`；没有动 `docs/planning/acceptance-evidence/`。
- 没有替车道 1 写用例：`tests/console/complex-tier-v40.test.ts` 归车道 1，本车道只在 §4 点名它必须钉住哪几条。
- 没有碰计划/评审车道与其它 worker 车道的工作树或文件。
