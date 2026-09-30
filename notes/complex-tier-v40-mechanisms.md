# 复杂档 v40：需求 → 图字段 → 运行时强制点 → 测试 机制对照

**本文件是 worker-3 车道（`notes/complex-tier-v40-mechanisms.md`）的交付物。**

对象是任务 `4c251059-89d9-4876-a281-380c9559c88c` 的已确认图提案（`graph_revisions.version = 1`，4.9 KB）与**本次真实运行**的记录。
方法：把使用者需求逐句拆开，每句去找三样东西——图里哪个字段承载它、运行时哪一行强制它、哪个测试钉住它；找不到就写「无」，不许编。

**证据强度只有三档，含义固定：**

| 档 | 含义 |
|---|---|
| **实测** | 有绿测试钉住该机制；或本次真实运行的事件/表记录直接证明了它（两者在表里分别注明） |
| **静态** | 代码路径读得出来且唯一，但**没有任何测试**钉住，本次运行也没走到 |
| **未覆盖** | 没有强制点，或强制点与需求原文不符 |

**不许把静态写成实测**：本次运行里 `synth` / `review-1..3` / `deliver` 尚未结算，凡是只有它们才能证明的行，即使强制点清楚，也标「静态」。

---

## 0. 本次运行的实况（读表前先知道哪些行是「还没走到」的）

```sh
sqlite3 "$GRAPH_STATE/tasks.sqlite" "
  select node_id, datetime(dispatched_at/1000,'unixepoch','localtime'), state from operations
  where task_id like '4c251059%' order by dispatched_at;
  select type, data from events where task_id like '4c251059%' and type in
    ('artifact.published','model.switched','review.independence_checked','graph.rework','node.skipped');
"
```

| 节点 | 状态 | 本次是否已结算 |
|---|---|---|
| planner | succeeded | 是（21:38:48 → 21:48:05） |
| plan-reviewer | succeeded，`route = accept` | 是（21:48:05 → 21:51:08） |
| worker-1 / 2 / 3 | running | 否 |
| review-1 / 2 / 3、synth、deliver | pending | 否 |

所以：**`replan` 回边、`fail` 三回边、人工验收门这三条 v40 独有的边，本次运行一次都没有走过**。它们的证据只能来自代码 + 既有测试，写「静态」或「未覆盖」时不要手软。

---

## 1. 主表：需求逐句对照

（同一句里有两个可分开的机制时拆成两行，因为它们的证据强度不同。）

| # | 需求原句 | 图里的字段 | 运行时强制点（文件:行） | 钉住它的测试 | 证据强度 |
|---|---|---|---|---|---|
| 1 | planner 出计划 | `nodes[planner].deliverable = {path:'plans/plan.md', namespace:'plans', name:'plan'}` | `src/core/execution.ts:1157`（结算时取声明）→ `593-628`（没写 / 是空文件 → 拒结果） | `tests/console/node-deliverable.test.ts:63,157` | **实测**（本次运行 `artifact.published` 2 条，plans/plan.md 与 reviews/plan-review.md 各一） |
| 2 | plan-reviewer 审查计划 | `plan-reviewer.routes=['accept','replan']` + `input.route={declared:null}` | `src/core/operation-lifecycle.ts:149-161`（只有 agent 能自述 case）、`1106-1108`（未声明的 case 拒收） | `tests/console/review-as-router.test.ts:103,115` | **实测**（本次 `plan-reviewer` 的 `route=accept` 已落库） |
| 3 | 不通过就返工 planner | `loops=[{from:'plan-reviewer',to:'planner',case:'replan'}]` | `src/core/operation-lifecycle.ts:1114-1116`（按 `from+case` 取 loop）→ `1283-1289`（`reactivate` + `graph.rework{from,to:[…]}`） | `tests/console/review-as-router.test.ts:103`（`impl-a` 成功两次，中间是 `fail`） | **实测**（同一强制点；v40 的 `replan` 轮本次没走） |
| 4 | 直到通过 | 同 #3，且 `planner` 可被重复激活 | `src/core/operation-lifecycle.ts:1284`（一次 reactivate 目标列表）；`src/core/graph.ts:72-76`（loop 唯一性键、`case` 必须是 `from` 声明过的分支、`to` 必须是上游） | `tests/console/review-as-router.test.ts:103` | **实测** |
| 5a | 通过后计划才分发给三个 worker | `worker-N.dependsOn=['planner']` + `when={node:'plan-reviewer',case:'accept'}` | `src/core/graph.ts:34,45-46`（`when` **只是把条件节点加进依赖**并校验 case 合法）、`127-132`（条件节点未成功→`waiting`；route≠case→`skip`） | `tests/console/review-as-router.test.ts:115`（agent 路由器 `pass` 放行 `when` 下游） | **实测**（本次三个 worker 确实在 plan-reviewer `accept` 之后 21:51:09 才被派发） |
| 5b | 判 replan 时 worker 及下游 skip | 同 #5a 的 `when` | `src/core/graph.ts:129-131`（条件节点 `skipped`/非本 case → 本节点 `skip`）、`src/core/execution.ts:567-576`（落库 `status='skipped'` + 事件 `node.skipped{reason:'inactive_route'}`） | `tests/console/router-action-e2e.test.ts:78` 只覆盖 program 路由器「匹配分支变 ready」；**v40 这个 agent 路由器 + 三 worker 的 skip 形状无测试** | **未覆盖**（补法见 §4-1） |
| 6 | 三个 worker 各产出一份成果 | `worker-1/2/3` **没有 `deliverable` 字段** | 无。`execution.ts:593-628` 只对声明了 `deliverable` 的节点生效 | 无 | **未覆盖**（补法见 §4-2） |
| 7 | 每个 worker 有一个对应评审 | `review-N.dependsOn=['worker-N']` + `context.predecessors=[{source:'worker-N',mode:'evidence_only'}]` + 各自 `deliverable` | `src/core/predecessor-handoff.ts:495-521`（source 必须在 `dependsOn` 里（`:510`）、mode 合法（`context.ts:94`）、**独立评审只允许 `evidence_only`**（`:518`））、`src/core/context.ts:53,94` | `tests/console/context-model.test.ts:74`（纯 validator，本次跑绿）、`tests/console/predecessor-handoff-production.test.ts:102`（运行时投影，**在本工作树环境红**，故不作为依据） | **实测**（依据是本次运行的事件：`context.handoff_policy_selected` 4 条 + `context.evidence_only_frozen` 4 条，plan-reviewer 与三个 worker 全是 `evidence_only`） |
| 8 | Synthesise 收齐三份评审 | `synth.dependsOn=['review-1','review-2','review-3']` + 3 条 `predecessors` | `src/core/graph.ts:133-136`（全部依赖 `succeeded` 才 `ready`）、`predecessor-handoff.ts:510`（policy 的 source 必须是直接依赖） | `tests/console/predecessor-handoff-production.test.ts:102`（多前驱混合投影；该文件在本工作树环境红） | **静态**（synth 本次未运行） |
| 9 | 写汇总 `summaries/synthesis.md` | `synth.deliverable={path:'summaries/synthesis.md',namespace:'summaries'}` | 同 #1：`execution.ts:1157,593-628` | `tests/console/node-deliverable.test.ts:63,157` | **实测**（强制点本身本次已在 planner / plan-reviewer 上生效；synth 自己的那次还没发生） |
| 10 | 自己判定 pass/fail | `synth.kind='agent'` + `routes=['pass','fail']` + `input.route={declared:null}` + `definitionVersion='synthesizer@1'` | `operation-lifecycle.ts:159`（`declared:null` 只对 `kind==='agent'` 成立，program 仍被拒）、`1106-1108`（`Router must return a declared case`） | `tests/console/review-as-router.test.ts:103,115`；program 版拒绝路径见 `router-action-e2e.test.ts:111,127` | **实测**（同一强制点由本次 `plan-reviewer` 走通；synth 未运行） |
| 11 | 判 fail 时三条回边**全部**返工（不按名单） | `loops` 三条 `{from:'synth',to:'worker-1\|2\|3',case:'fail'}` | `operation-lifecycle.ts:1114-1116`：`plan.loops.filter(...)` 是 **`filter` 不是 `find`**，同 `from`+`case` 的三条全取；`1283-1289`：一次 `reactivate(store, taskId, routed.map(loop => loop.to))` + 事件 `graph.rework{from:'synth',to:[三条]}` | **无**。全仓 `tests/` 里没有任何一个提案写过「同 from 同 case 的两条 loop」（见 §3 自检命令 4） | **静态** |
| 12 | 验收项只绑 deliver | `acceptance=[{id:'human-accept',checkNode:'deliver'}]` | `src/core/proposal.ts:63-70`（每个验收项必须绑一个 mandatory program 节点或 agent router） | `tests/console/design-examples.test.ts:48`（验收项指向的必须是图里的节点） | **实测**（提案被接受时已过这道 validator） |
| 13 | 通过后进入人工验收 | `deliver{kind:'program',action:'graph.human_check',dependsOn:['synth']}` | `src/core/execution.ts:718-728`：没有绑定本次 `activationId+commitSha` 的已解决 `human_check` 答复 → `block(node,'human_check','A human acceptance check is required')` | `tests/m4/acceptance.test.ts:190`（用户拒绝后 check 保持 blocked 并把 rework 交给主 Agent）、`:221`（human check 绑定当前 activation 与 commit） | **静态**（deliver 未运行） |
| 14 | 先由主 Agent 审证据 | **无图字段**（工具层） | `src/runtime/agent-tool-definitions.ts:261-262`、`src/runtime/agent-tools.ts:438-449`、`src/core/question-routing.ts:304-317`（`approve:true` 只写 `human.prereview_approved`，check 仍 `open`）、`src/core/task-runtime.ts:2163-2192`（`approve:false` → 插一条 `rework` 问题把节点打回） | `tests/console/human-prereview.test.ts:48,59,75,88,99`、`tests/console/human-prereview-e2e.test.ts:57` | **实测**，但**结论与需求有出入**：见 §2-④ |
| 15 | 再向用户总结汇报 | **无** | 无强制点。`answer` 唤醒只来自用户答复（`src/core/wake-ledger.ts:12,130`）；图节点没有「向用户汇报」的工具或事件 | 无 | **未覆盖**（补法见 §4-3） |
| 16 | 全部节点用 space-bunny-free | 每个 agent 节点 `model='opencode-go:space-bunny-free'` | `src/core/model-selection.ts:51-76`（评审节点把上游实际用过的模型放进 `exclude`）→ `src/catalog/models.ts:167-174`（`requested` 命中 `exclude` 就被丢弃，退到 grade 默认）→ `src/core/execution.ts:744,751`（写回实例并发 `model.switched` 事件） | 无针对性测试 | **实测——且实测结论与需求相反**：见 §2-① |

---

## 2. v40 相对旧形状新引入的三个机制点，及各自的坑

### ① 「全部节点同一个模型」和「评审必须独立于实施者」在 v40 里互斥，运行时选了后者

这不是推测，是本次运行记下来的：

```
events.model.switched
  {"nodeId":"plan-reviewer","from":"opencode-go:space-bunny-free",
   "to":"opencode-go:deepseek-v4.1-flash","instanceId":"df5af0f1-…"}

events.review.independence_checked
  {"nodeId":"plan-reviewer","independence":"model-excluded",
   "policy":{"freshRequired":true,"evidenceOnly":true,
             "excludedModels":["opencode-go:space-bunny-free","space-bunny-free"]}}

invocations 实际用量
  planner        opencode-go:space-bunny-free        71 次
  plan-reviewer  opencode-go:deepseek-v4.1-flash    46 次
  worker-1/2/3   opencode-go:space-bunny-free
```

链路：`presets/manifest.json` 的 `reviewer` 定义带 `review:true` → `model-selection.ts:12-17` `isReviewer` 命中 →
`model-selection.ts:20-48` `implementerModels` 把**依赖节点实际调用过的模型**收进 `exclude` →
`catalog/models.ts:169-170` 先按 `exclude` 过滤目录，**再**找 `requested`，找不到就退到 `grade` 默认模型 →
`execution.ts:751` 发 `model.switched`。

**坑**：需求第 16 句在 v40 的评审节点上**不成立**，而且 `instances.model` 在派发前看起来是对的（值就是 `space-bunny-free`），只有 `model.switched` 事件和 `invocations` 说实话。
按现在的图，`review-1/2/3` 与 `synth` 都会在各自 worker 结算之后才派发，届时它们的 `exclude` 里也会有 `space-bunny-free`，预计同样被换掉。
**要真让「全部节点 space-bunny-free」成立，只能放弃独立评审**（去掉 `context.purpose:'review'` / `reviewer@8`），或者接受评审节点换模型——这是需求冲突，不是实现缺陷。

### ② `when` 门加的是依赖，不是阻断

`src/core/graph.ts:34,45-46`：`when` 做的两件事是把条件节点 push 进 `dependencies`、校验 `case` 在那个路由器的 `routes` 里声明过。**它不阻止 plan-reviewer 跑，也不阻止 planner 跑。**
真正放行/跳过在 `graph.ts:127-136` 的 `readiness`：

- 条件节点不是 `succeeded` → `waiting`（还没到判它的时候）；
- 条件节点 `skipped`，或 `route !== case` → `skip`；
- `execution.ts:567-576` 把 `skip` 落库并发 `node.skipped{reason:'inactive_route'}`，然后 `while(true)` 重扫，直到没有新的 skip —— 下游的 skip 是这样级联出来的。

**坑**：`when` 写错成引用一个不声明该 case 的节点，整个提案在 `graph.ts:45` 就被拒（`Branch must select a declared router case`），报错信息不提「when」这个字段名，容易被误读成「节点 id 写错」。
另一个坑：`readiness` 的 skip 只看**直接**依赖，所以 v40 里 worker 因 `replan` 被 skip 后，review-N → synth → deliver 是靠上面那个 while 循环逐级级联的，不是靠一条规则。

### ③ 同 `from` 同 `case` 的多条 loop 是**同时**触发的；写一条就只返工一个

`operation-lifecycle.ts:1114-1116` 用的是 `filter`：

```ts
const routed = result.outcome === 'completed' && result.route !== undefined
  ? loadGraph(this.store, operation.taskId).plan.loops.filter(loop => loop.from === operation.nodeId && loop.case === result.route)
  : [];
```

`1283-1289` 把 `routed.map(loop => loop.to)` 一次性 `reactivate`，并发 `graph.rework{from, to: [...], via:'route', route}`。

**坑**：`graph.ts:72-74` 的 loop 唯一性键是 `from->to#case`，也就是说
**「同一个 target、同一个 case 写两条」会被 `Loops must be unique` 拒**，
想批量返工只能写**三个不同 target 的三条 loop**（v40 正是这么写的，写法正确）。
另一个坑：这是**图形状**上的批量，不是运行时按名单挑的——`synth` 判 `fail` 时它拿不到「哪三条不合格」这个信息，只能整批打回；这与需求「不按名单」一致，但也意味着 `synth` 的汇总里写了谁不合格也没用。

### ④ （附加）验收只绑 `graph.human_check` 时，「主 Agent 先审」不是一道门

`tests/console/human-prereview.test.ts:48-57` 直接钉住了这件事：human check 打开的瞬间，
`questions` 行的 `owner` 已经是 `user`、`status` 已经是 `open`，
**同时**主 Agent 被 `human_check` 唤醒。工具描述里那句 "before the user is asked"（`agent-tool-definitions.ts:262`）
描述的是**注意力顺序**，不是强制顺序。

**坑**：`approve:true` 之后 check 仍然 open、仍然归用户（`question-routing.ts:304-317` 只追加 `preReview` 字段并发事件）；
`approve:false` 也不是「拒绝验收」，而是给该节点插一条 `rework` 问题（`task-runtime.ts:2181-2192`），走的是返工路径。
所以「先由主 Agent 审证据、再向用户汇报」这条需求，**机制上只能保证主 Agent 被叫醒并拿到证据**，保证不了用户一定等到他审完。

---

## 3. 自检命令（可重复执行，逐条对应上面引用的行）

```sh
cd <本工作树>

# 1) when 门只是加依赖 + 校验 case（graph.ts:34,45-46）
grep -n "const conditions = node.when\|Branch must select a declared router case\|dependencies.push(condition.node)" src/core/graph.ts

# 2) readiness 的 waiting/skip 判定（graph.ts:127-136）
grep -n "readiness(id: string)" -A 10 src/core/graph.ts
grep -n "inactive_route" src/core/execution.ts

# 3) 批量回边：filter 而非 find + 一次 reactivate 全部（operation-lifecycle.ts:1114-1116,1283-1289）
grep -n "plan.loops.filter(loop => loop.from === operation.nodeId && loop.case" src/core/operation-lifecycle.ts
grep -n "reactivate(this.store, operation.taskId, routed.map" -A 7 src/core/operation-lifecycle.ts

# 4) 关键否证：全仓 tests/ 里没有任何「同 from 同 case 的两条 loop」
python3 - <<'PY'
import re,os,collections
hits=collections.defaultdict(list)
for root,_,files in os.walk('tests'):
    for f in files:
        if f.endswith('.ts'):
            p=os.path.join(root,f); s=open(p,encoding='utf8').read()
            for m in re.finditer(r"\{\s*from:\s*'([^']+)'\s*,\s*to:\s*'([^']+)'\s*,\s*case:\s*'([^']+)'\s*\}", s):
                hits[(m.group(1),m.group(3))].append((p,m.group(2)))
dupes={k:v for k,v in hits.items() if len(v)>1}
print('同 from 同 case 的 loop 组数:', len(dupes))
for k,v in dupes.items(): print(k, v)
PY
# 期望输出：0 组。这正是表里第 11 行标「静态」的原因。

# 5) agent 自述 route / 未声明 case 被拒（operation-lifecycle.ts:159,1106-1108）
grep -n "record\['declared'\] === null" src/core/operation-lifecycle.ts
grep -n "Router must return a declared case" src/core/operation-lifecycle.ts

# 6) 独立评审排除实施者模型（models.ts:167-174 / model-selection.ts:20-76 / execution.ts:744,751）
grep -n "const blocked = new Set(input.exclude" -A 6 src/catalog/models.ts
grep -n "model.switched" src/core/execution.ts

# 7) human check 打开即归用户、主 Agent 同时被唤醒
grep -n "owner: 'user'" tests/console/human-prereview.test.ts
grep -n "export function approveHumanCheck" -A 12 src/core/question-routing.ts

# 8) 本次运行的实况（§0 的表、§2-① 的事件）
sqlite3 "$GRAPH_STATE/tasks.sqlite" "
  select type, data from events where task_id like '4c251059%' and type in
    ('artifact.published','model.switched','review.independence_checked','graph.rework','node.skipped');
  select o.node_id, i.model, count(*) from invocations i join operations o on o.id=i.operation_id
  where o.task_id like '4c251059%' group by 1,2;"
```

---

## 4. 本次交付之后仍然未覆盖的（每条写清楚补它需要哪个测试）

| # | 未覆盖的东西 | 现在为什么没被强制 | 补它需要的测试（建议落在车道 1 的 `tests/console/complex-tier-v40.test.ts`） |
|---|---|---|---|
| 4-1 | plan-reviewer 判 `replan` 时三个 worker **及其下游**被 skip | 只有 program 路由器的相邻形状有 E2E（`router-action-e2e.test.ts:78`）；v40 的 agent 路由器 + 三 worker 没有 | 用 `tests/fixtures/lane.ts` 跑 v40 全形，断言 `replan` 轮次里 `briefings` 不含任何 `worker-N`、且 `node.skipped{reason:'inactive_route'}` 出现三次；阴性对照：删掉 `when` 字段后同一断言必须失败 |
| 4-2 | 「三个 worker 各产出一份成果」 | v40 的 `worker-1/2/3` **没有声明 `deliverable`**，运行时不知道成果是什么 | 两种改法二选一并写进 E2E：(a) 给三个 worker 各加 `deliverable`，用 `node-deliverable.test.ts:157` 已有的「声明未写即失败」语义做断言；(b) 保持现状，则在文档里明写「worker 的成果靠评审读工作副本，不受运行时保证」 |
| 4-3 | 「再向用户总结汇报」 | 图节点没有任何面向用户的汇报通道（`answer` 唤醒只来自用户答复） | 要么删掉这句需求，要么给主 Agent 的汇报补一个可测的契约（例如：节点结论必须先出现在 master 的 task view 里，再由 master 决定说什么）——目前没有可写的断言 |
| 4-4 | `synth` 判 `fail` 时**三条**回边一起触发 | 全仓无任何测试写过同 from 同 case 的多条 loop（§3-4 的否证输出为 0） | 直接跑 v40 全形：断言事件流出现 `graph.rework{from:'synth',to:['worker-1','worker-2','worker-3']}` 且三个 worker 的 `briefings` 各 +1；阴性对照：只留一条 loop，断言必须失败 |
| 4-5 | 「全部节点用 space-bunny-free」在评审节点上成立 | `catalog/models.ts:169-170` 会把被 exclude 的 `requested` 丢掉（本次已实测到一次切换） | 给「同模型做评审」写一条明确的测试，把**期望行为钉死**（是切换并记 `model.switched`，还是拒绝派发），否则这条需求每次都可能悄悄变；车道 2 写文档时不能直接照抄这句话 |
| 4-6 | `deliver` 这一道人工门真的会在 synth 判 `pass` 之后才开、判 `fail` 时不开 | 本次 synth / deliver 都没运行 | 沿用 4-4 的同一条全形 E2E：`fail` 轮次后 `deliver` 派发次数为 0，`pass` 之后为 1 |

---

## 5. 本车道没有做的事（写清楚，免得被当成遗漏）

- 没有改 `src/**`、`tests/**`、任何 `docs/**`：本车道只新增两个文件（本文件 + `deliverables/v40-mechanisms-report.md`），`git status --porcelain` 原文见报告。
- 没有跑 `GRAPH_UPDATE_EVIDENCE=1`，没有动 `docs/planning/acceptance-evidence/`。
- 没有把「代码读得出来」写成「实测」：表里 3 条**静态**（#8、#11、#13）都是本次运行走不到的分支；2 条**实测**（#14、#16）实测出来的结论与需求原文不一致，已在 §2 写明。
- 没有替车道 1 写用例：`complex-tier-v40.test.ts` 由车道 1 拥有，本文件只提出它必须钉住哪几条（§4-1、§4-4、§4-6）。
- 全量 `node --run check` 在本工作树红（`42 failed | 186 passed`），是环境既有失败；把本文件移出工作树后重跑失败子集，数字一模一样。命令、exit code、A/B 原文见 `deliverables/v40-mechanisms-report.md` §5。
