# worker-3 车道报告：v40 机制对照与证据表

**交付物**：`notes/complex-tier-v40-mechanisms.md`（主件，逐句对照表 + 机制坑 + 自检命令 + 未覆盖清单）、本报告（摘要）。
**对象**：任务 `4c251059-89d9-4876-a281-380c9559c88c` 的已确认提案 `graph_revisions.version=1`（4891 字节）与**本次真实运行**的事件/表记录。

---

## 1. 一句话结论（返工后）

v40 的图**形状成立，而且已经被真实运行走过一遍**：`synth` 判 `fail` 后，`graph.rework{to:['worker-1','worker-2','worker-3']}` 在本次任务的事件流里真的出现了，`summaries/synthesis` 也真的发布了。
17 行需求里 **15 行实测、0 静态、2 未覆盖**（返工前是 11/3/3：当时车道 1 的 E2E 还没合并进来，我按「本次没走到」保守记了几行）。
剩下的 2 行未覆盖（worker 成果无强制点、"向用户汇报"无通道）和 2 行**实测下来与需求原文相反**（评审节点被换模型、"先审后问"不是门），是 synth 判 fail 时点名的两条，必须让下一轮看到。

---

## 2. 对照表摘要

完整表在 `notes/complex-tier-v40-mechanisms.md` §1（列：需求原句 / 图里的字段 / 运行时强制点 / 钉住它的测试 / 证据强度）。返工后分布：

| 证据强度 | 行数 | 指的是哪几行 |
|---|---|---|
| **实测**（本次运行发生过，或有以 v40 全形为对象的绿测） | 15 | 全部，除下面两行 |
| **静态** | 0 | 车道 1 的 `complex-tier-v40.test.ts` 合并进来后已无此类 |
| **未覆盖**（无强制点） | 2 | #6 三个 worker 各产出一份成果、#15 再向用户总结汇报 |

三条车道都要用的三个硬事实：

- **#6 是真缺口**：v40 的 `worker-1/2/3` **没有声明 `deliverable`**，所以运行时对"每个 worker 产出什么"零强制。车道 2 写文档时若写成"每个 worker 产出一份成果"，那是**约定**不是机制。
- **#11 现在有三重证据**：车道 1 的绿测（含阴性对照）+ 本次运行的 `graph.rework` 事件。上一版写的"全仓零测试"已经被自己的否证脚本推翻（输出从 0 变 2 组），已按实测重写。
- **#13 的关门靠返工连带重置**，不是 `deliver` 自己有 `when`——这一点已写进 §2-③ 之外的备注，车道 2 写文档时别把它写成一个不存在的条件门。

---

## 3. 两条与需求原文相反的实测结果（请 synth 重点看）

### 3.1 「全部节点用 space-bunny-free」在四个评审节点上不成立

本次运行的产品自带记录（不是我的推断），返工时重读，已从 1 次涨到 **6 次**：

```
events.model.switched  （6 条）
  plan-reviewer  opencode-go:space-bunny-free → opencode-go:deepseek-v4.1-flash
  review-1 ×2 / review-2 ×2 / review-3   同上
events.review.independence_checked  （7 条，excludedModels=["opencode-go:space-bunny-free","space-bunny-free"]）

invocations 实际用量
  planner 71 / worker-1 248 / worker-2 162 / worker-3 224 / synth 24   → opencode-go:space-bunny-free
  plan-reviewer 46 / review-1 104 / review-2 125 / review-3 68         → opencode-go:deepseek-v4.1-flash
```

链路：`presets/manifest.json` 的 `reviewer` 定义带 `review:true` → `src/core/model-selection.ts:12-17` `isReviewer` 命中 → `:20-48` `implementerModels` 把依赖节点**实际调用过**的模型收进 `exclude` → `src/catalog/models.ts:169-170` 先按 `exclude` 过滤再找 `requested`，找不到就退到 grade 默认 → `src/core/execution.ts:751` 发 `model.switched`。

**`synth` 反而保住了 space-bunny-free**（上一版这里是推测，现已被实况解释）：`implementerModels` 只走 `spec.dependsOn`。四个评审节点的依赖链里通着 `planner`/`worker-1..3`，命中 exclude；`synth` 的依赖只有三个评审节点，而那三个已经被换成 deepseek，于是 `space-bunny-free` 不在 synth 的 exclude 里。**换过一轮之后，换过的模型不会再被排除。**

**这是需求冲突，不是实现缺陷**：v40 要求"评审也用 space-bunny-free"，运行时要求"独立评审不得用实施者的模型"。二者只能选一个，现在选的是后者。
**给 synth 的判断建议**：文档里不要照抄"全部节点 space-bunny-free"；要么写清"评审节点会被换成别的模型（这是设计，`instances.model` 还会骗你）"，要么这条需求本身就该改。

### 3.2 「先由主 Agent 审证据、再向用户汇报」里的"先"不是一道门

`tests/console/human-prereview.test.ts:48-57`（本次跑绿）钉住的事实：human check 打开的瞬间，`questions` 行的 `owner` 已经是 `user`、`status` 已经是 `open`，**同时**主 Agent 被 `human_check` 唤醒。
`approve:true` 只是追加 `preReview` 字段并发 `human.prereview_approved` 事件（`src/core/question-routing.ts:304-317`），check 仍然 open、仍然归用户；`approve:false` 是给该节点插一条 `rework` 问题（`src/core/task-runtime.ts:2181-2192`），走返工而不是"拒绝验收"。

所以机制能保证的是"主 Agent 被叫醒并拿到证据"，**保证不了用户一定等到他审完**。工具描述里那句 "before the user is asked" 描述的是注意力顺序。

---

## 4. 交付之后仍然没有测试钉住的（补法）

车道 1 的 `complex-tier-v40.test.ts` 合并进来后，上一版的 4-1/4-4/4-6 已经被它盖住。

| # | 状态 | 未覆盖 | 补它需要哪个测试 |
|---|---|---|---|
| 4-1 | 已覆盖 | replan 时 worker 及下游不派发 | 差一条：再钉一下 `node.skipped{reason:'inactive_route'}` 落库三次（见 4-7） |
| 4-2 | **未覆盖** | 三个 worker 各产出一份成果 | 给三个 worker 各加 `deliverable`，用 `node-deliverable.test.ts:157` 已有的"声明未写即失败"语义写断言；或保持现状并在文档里明写这是约定 |
| 4-3 | **未覆盖** | 再向用户总结汇报 | 图节点没有面向用户的汇报通道，**目前写不出有意义的断言**；建议把这条需求从图机制里拿掉，或改写成"节点结论先出现在主 Agent 的 task view" |
| 4-4 | 已覆盖 | synth 判 fail 三条回边一起触发 | 无（绿测 + 本次运行 `graph.rework` 事件） |
| 4-5 | **未覆盖** | 「同模型评审」的期望行为没被钉死 | 给"同模型做评审"写一条测试，明确期望是切换并记 `model.switched` 还是拒绝派发；否则每次都可能悄悄变 |
| 4-6 | 已覆盖 | deliver 人工门只在 pass 后开 | 无（FM4 + 阴性对照） |
| 4-7 | **新发现的窄缺口** | `node.skipped{reason:'inactive_route'}` 落库本身 | 全仓无测试断言过这个事件；在 4-1 那条里补一次即可（车道 1 的文件） |

---

## 5. 本车道跑过的命令与 exit code

工作树：`state/worktrees/fu-za-dang-v40-planner-chu-ji-hua-plan-r-4c251059/worker-3`（`node_modules` 由宿主建立的符号链接，按 ADR 0027 授权）。

| # | 命令 | exit | 结果 |
|---|---|---|---|
| 1 | `node --run test -- tests/console/review-as-router.test.ts tests/console/node-deliverable.test.ts tests/console/human-prereview.test.ts tests/console/human-prereview-e2e.test.ts tests/console/design-examples.test.ts` | **0** | `Test Files 5 passed (5)` / `Tests 19 passed (19)`（12.05s）——表里 #1#2#3#4#5a#7#9#10#12#14 引用的钉子全绿） |
| 2 | `node --run test -- tests/m4/acceptance.test.ts tests/console/context-model.test.ts tests/console/predecessor-handoff-production.test.ts` | **1** | `Test Files 2 failed \| 1 passed (3)` / `Tests 9 failed \| 20 passed (29)`；`tests/m4/acceptance.test.ts` 全过（#13 的钉子） |
| 3 | `node --run check` | **1** | typecheck、lint 无报错；vitest `Test Files 42 failed \| 186 passed (228)` / `Tests 128 failed \| 1405 passed (1533)`（Duration 206.68s）。详见 §5.1 |

### 返工（attempt 2）复跑的证据

| # | 命令 | exit | 结果 |
|---|---|---|---|
| R1 | `node --run test -- tests/console/complex-tier-v40.test.ts` | **0** | `Test Files 1 passed (1)` / `Tests 8 passed (8)`（车道 1 的 v40 全形 E2E，含 4 条阴性对照） |
| R2 | `node --run test -- tests/console/review-as-router.test.ts tests/console/node-deliverable.test.ts tests/console/human-prereview.test.ts tests/console/human-prereview-e2e.test.ts tests/console/design-examples.test.ts` | **0** | `Test Files 5 passed (5)` / `Tests 19 passed (19)`（与 attempt 1 的数字一致，无回归） |
| R3 | §3-4 的否证脚本（全仓 `tests/` 里同 `from`+`case` 的 loop 组） | 0 | **输出从 `0` 变成 `2` 组**——因为车道 1 的 `complex-tier-v40.test.ts` 已随门禁合并进本工作树，其中一组正是 v40 的三条 `synth--fail-->worker-N`。我上一版写的"全仓零测试"到此作废 |
| R4 | 强制点行号复核（`graph.ts:34`/`execution.ts:573`/`operation-lifecycle.ts:1127,1284`/`predecessor-handoff.ts:518`/`proposal.ts` 61-71、文件共 73 行） | 0 | 全部对上。**本车道从未引用 `operation-lifecycle.ts:1117`**（引用的是 `1114-1116` 与 `1127`），因此 review-2 §3.3 那条建议对本车道不适用，按 synth 的 veto 不动 |
| R5 | 本次任务的真实事件：`graph.rework` / `artifact.published` / `model.switched` / `invocations` | 0 | `graph.rework{"from":"synth","route":"fail","to":["worker-1","worker-2","worker-3"]}` 真的发生过；`summaries/synthesis` 已发布；`model.switched` × 6（详见 §3.1） |

### 5.1 全量 check 的失败是环境既有失败，与本车道无关（A/B 证明）

`node --run check` 在本工作树红（`CHECK_EXIT=1`），**跑了两次，两次的失败数字一字不差**（`42 failed | 186 passed (228)`、`128 failed | 1405 passed (1533)`）。

**A/B 证明**：把当时已存在的 `notes/complex-tier-v40-mechanisms.md`（本报告当时还没写）移出工作树后，重跑命令 2 里失败的那两个文件：

```
mv notes/complex-tier-v40-mechanisms.md /tmp/worker3-hold/ && rmdir notes
git status --porcelain          # 空输出
node --run test -- tests/console/context-model.test.ts tests/console/predecessor-handoff-production.test.ts
→ EXIT=1   Test Files  2 failed (2)   Tests  9 failed | 12 passed (21)
```

**同样这 9 条、同样的数字**，与加上我的文件时一字不差。两个文件都是 `notes/` 与 `docs/evidence/` 下的新 markdown，没有任何测试读它们；这些 E2E 失败的原因是节点回合没跑起来（`provider.requests[1]` 为 `undefined`、`context` 为 `null`），属沙箱环境问题。
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

## 6. 返工记录（attempt 2）

synth 判 `fail`，分给本车道的是"零改动，仅复跑复现证据；可选修正 F1"。本轮实际做了三件事（详细版在主件 §6）：

1. **复跑复现证据**（R1、R2、R4、R5，全部 exit 0），并把本次任务已经走到第二轮的实况重新读了一遍。
2. **修 F1，并把同款矛盾一起修**：旧规则拿"本次有没有走到"当判据，新判据统一成"**本行主体**有没有被走到 / 被以 v40 全形为对象的绿测钉住"，否则"实测 + 备注写着没走到"就是自相矛盾。#3、#4、#5b、#9、#10、#11、#13 七行重标，每行都补了理由，没有只改标签的。
3. **改掉已经过期的结论**：车道 1 的 E2E 合并进来之后，我上一版的"全仓零测试写过同 from 同 case 的 loop"和"本次一次都没走过 v40 独有的边"都不成立了。#11 因此升为实测（绿测 + 阴性对照 + 真实 `graph.rework` 事件），分布从 11/3/3 变成 15/0/2。

**没有做的事**：没有碰 `docs/design-graph-examples.md`（车道 2 的文件；M1/M2/M3/M4 是 synth 给车道 2 的必修项）。顺带说一句：M2 说 `proposal.ts:100-104` 不存在，本车道核对过——该文件只有 73 行，真实位置是 `61-72`（`invalid` 在 `:71`），主件里引的就是这一处，可以直接对齐。

## 7. 边界

- 本车道只动两个文件（返工前是新增，返工后是修改）：`notes/complex-tier-v40-mechanisms.md`、`docs/evidence/v40-mechanisms-report.md`。`git status --porcelain` 原文：

  ```
   M docs/evidence/v40-mechanisms-report.md
   M notes/complex-tier-v40-mechanisms.md
  ```

  （工作树里还有车道 1 / review 车道随门禁合入的**已提交**内容，例如 `tests/console/complex-tier-v40.test.ts`；那些不是本车道产物，本车道也没有改过它们。）
- 没有改 `src/**`、`tests/**`、任何 `docs/**`；没有跑 `GRAPH_UPDATE_EVIDENCE=1`；没有动 `acceptance-evidence/`。
- 没有替车道 1 写用例：`tests/console/complex-tier-v40.test.ts` 归车道 1，本车道只在 §4 点名它还差哪一条断言（4-1、4-7）。
- 没有碰计划/评审车道与其它 worker 车道的工作树或文件。
