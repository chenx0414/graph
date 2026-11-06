<!-- graph:allow-large-file: 历史机制复盘记录，按主题已成篇；拆分需重写内容而非搬迁 -->
# 复杂档 v40：需求 → 图字段 → 运行时强制点 → 测试 机制对照

**本文件是 worker-3 车道（`notes/complex-tier-v40-mechanisms.md`）的交付物。**

对象是任务 `4c251059-89d9-4876-a281-380c9559c88c` 的已确认图提案（`graph_revisions.version = 1`，4.9 KB）与**本次真实运行**的记录。
方法：把使用者需求逐句拆开，每句去找三样东西——图里哪个字段承载它、运行时哪一行强制它、哪个测试钉住它；找不到就写「无」，不许编。

**证据强度只有三档，含义固定：**

| 档 | 含义 |
|---|---|
| **实测** | 本行的 **v40 主体**（那个节点 / 那条边 / 那个产物）要么在本次真实运行中真的发生，要么被一条**直接以 v40 全形为对象**的绿测试断言（该测试本次跑绿） |
| **静态** | 强制点读得出来且唯一，但本行主体既没在本次运行发生，也没有以 v40 全形为对象的绿测试 |
| **未覆盖** | 没有强制点，或强制点与需求原文不符 |

**不许把静态写成实测**：判据是**主体本身**有没有被走到 / 被以它为对象的绿测钉住，不是「同一个强制点有没有别的测试碰过」。别的节点碰过同一段代码，只能写在备注里作佐证，不抬档。
**返工后本表重标过一次**（见 §6）：车道 1 的 `tests/console/complex-tier-v40.test.ts` 合并进来后，v40 三条独有分支第一次有了以全形为对象的绿测试，§3 自检 4 的否证输出也从 `0` 变成 `2` 组。上一版把 #3#4#5b#9#10#11#13 标成「静态」/「未覆盖」，是按「本次没走到」记的；那个口径和第 16 行的定义打架（F1），现已按上面这三条重标。

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

**返工时（attempt 2）重新读了一次，图已经走到第二轮**（synth 判了 fail，三个 worker 被整批打回）：

| 节点 | 状态 | 说明 |
|---|---|---|
| planner / plan-reviewer | succeeded（`accept`） | 第一轮，没重跑 |
| worker-1 | succeeded（第二轮） | 第一轮 23:20:38 被 synth 判 fail 打回，23:26:00 重跑完 |
| worker-2 / worker-3 | running | 正在跑第二轮 |
| review-1 | running | 第二轮第一棒 |
| review-2 / review-3 / synth / deliver | pending | 第二轮尚未轮��� |

所以返工时**已经有三条 v40 独有的边在真实运行里走过了**：`graph.rework{from:'synth',to:['worker-1','worker-2','worker-3'],route:'fail'}`、`summaries/synthesis` 产物发布、`model.switched` × 6。下面的表已经把这几行的依据从「绿测」升级为「绿测 + 本次运行记录」。

上一版（本车道第一轮）读到的实况是「synth / review-1..3 / deliver 尚未结算」，当时据此把 #3#4#5b#9#10#11#13 记为静态；那些数字已经按当前实况重标（见 §6）。

---

## 1. 主表：需求逐句对照

（同一句里有两个可分开的机制时拆成两行，因为它们的证据强度不同。）

| # | 需求原句 | 图里的字段 | 运行时强制点（文件:行） | 钉住它的测试 | 证据强度 |
|---|---|---|---|---|---|
| 1 | planner 出计划 | `nodes[planner].deliverable = {path:'plans/plan.md', namespace:'plans', name:'plan'}` | `src/core/execution.ts:1157`（结算时取声明）→ `593-628`（没写 / 是空文件 → 拒结果） | `tests/console/node-deliverable.test.ts:63,157` | **实测**（本次运行 `artifact.published` 2 条，plans/plan.md 与 reviews/plan-review.md 各一） |
| 2 | plan-reviewer 审查计划 | `plan-reviewer.routes=['accept','replan']` + `input.route={declared:null}` | `src/core/operation-lifecycle.ts:149-161`（只有 agent 能自述 case）、`1106-1108`（未声明的 case 拒收） | `tests/console/review-as-router.test.ts:103,115` | **实测**（本次 `plan-reviewer` 的 `route=accept` 已落库） |
| 3 | 不通过就返工 planner | `loops=[{from:'plan-reviewer',to:'planner',case:'replan'}]` | `src/core/operation-lifecycle.ts:1114-1116`（按 `from+case` 取 loop）→ `1283-1289`（`reactivate` + `graph.rework{from,to:[…]}`） | `tests/console/complex-tier-v40.test.ts:238`（v40 全形：replan 轮出现 `graph.rework{from:'plan-reviewer',to:['planner'],route:'replan'}`，且 planner 真的被重新激活）；通用机制见 `review-as-router.test.ts:103` | **实测**（绿测；本次真实运行没走 replan 轮） |
| 4 | 直到通过 | 同 #3，且 `planner` 可被重复激活 | `src/core/operation-lifecycle.ts:1284`（一次 reactivate 目标列表）；`src/core/graph.ts:72-76`（loop 唯一性键、`case` 必须是 `from` 声明过的分支、`to` 必须是上游） | `tests/console/complex-tier-v40.test.ts:238`（plan 路线给的是 `['replan','accept']`，两轮都跑完后才放行 worker） | **实测**（绿测） |
| 5a | 通过后计划才分发给三个 worker | `worker-N.dependsOn=['planner']` + `when={node:'plan-reviewer',case:'accept'}` | `src/core/graph.ts:34,45-46`（`when` **只是把条件节点加进依赖**并校验 case 合法）、`127-132`（条件节点未成功→`waiting`；route≠case→`skip`） | `tests/console/review-as-router.test.ts:115`（agent 路由器 `pass` 放行 `when` 下游） | **实测**（本次三个 worker 确实在 plan-reviewer `accept` 之后 21:51:09 才被派发） |
| 5b | 判 replan 时 worker 及下游 skip | 同 #5a 的 `when` | `src/core/graph.ts:129-131`（条件节点 `skipped`/非本 case → 本节点 `skip`）、`src/core/execution.ts:567-576`（落库 `status='skipped'` + 事件 `node.skipped{reason:'inactive_route'}`） | `tests/console/complex-tier-v40.test.ts:238`（replan 轮里 `worker-1..3`/`review-1..3`/`synth`/`deliver` 一次都没被派发）；`:256` 阴性对照（删掉 `when` 后同断言必须失败） | **实测**（绿测；**它断言的是「没被派发」，没有钉 `node.skipped{reason:'inactive_route'}` 落库那一下**，差的那一条见 §4-7） |
| 6 | 三个 worker 各产出一份成果 | `worker-1/2/3` **没有 `deliverable` 字段** | 无。`execution.ts:593-628` 只对声明了 `deliverable` 的节点生效 | 无（车道 1 的 E2E 也只能在 `test('FM1…')` 头部的 v40 节点表里看到 worker 无 deliverable） | **未覆盖**（补法见 §4-2） |
| 7 | 每个 worker 有一个对应评审 | `review-N.dependsOn=['worker-N']` + `context.predecessors=[{source:'worker-N',mode:'evidence_only'}]` + 各自 `deliverable` | `src/core/predecessor-handoff.ts:495-521`（source 必须在 `dependsOn` 里（`:510`）、mode 合法（`context.ts:94`）、**独立评审只允许 `evidence_only`**（`:518`））、`src/core/context.ts:53,94` | `tests/console/context-model.test.ts:74`（纯 validator，本次跑绿）、`tests/console/predecessor-handoff-production.test.ts:102`（运行时投影，**在本工作树环境红**，故不作为依据） | **实测**（依据是本次运行的事件：`context.handoff_policy_selected` 4 条 + `context.evidence_only_frozen` 4 条，plan-reviewer 与三个 worker 全是 `evidence_only`） |
| 8 | Synthesise 收齐三份评审 | `synth.dependsOn=['review-1','review-2','review-3']` + 3 条 `predecessors` | `src/core/graph.ts:133-136`（全部依赖 `succeeded` 才 `ready`）、`predecessor-handoff.ts:510`（policy 的 source 必须是直接依赖） | `tests/console/complex-tier-v40.test.ts:268,298`（`review-1..3` 的派发次数 `[2,2,2]`/`[3,3,3]` 之后才轮到 synth） | **实测**（绿测；本次真实运行 synth 未结算） |
| 9 | 写汇总 `summaries/synthesis.md` | `synth.deliverable={path:'summaries/synthesis.md',namespace:'summaries'}` | 同 #1：`execution.ts:1157,593-628` | `tests/console/node-deliverable.test.ts:63,157`（声明了却没写就失败）；v40 全形见 `complex-tier-v40.test.ts:105,155,268`（synth 带该 deliverable 且结算成功）；**本次运行 `artifact.published` 里有 `summaries/synthesis`** | **实测**（绿测 + 本次运行记录） |
| 10 | 自己判定 pass/fail | `synth.kind='agent'` + `routes=['pass','fail']` + `input.route={declared:null}` + `definitionVersion='synthesizer@1'` | `operation-lifecycle.ts:159`（`declared:null` 只对 `kind==='agent'` 成立，program 仍被拒）、`1106-1108`（`Router must return a declared case`） | `tests/console/complex-tier-v40.test.ts:268,281`（答 `fail` 触发回边；答未声明的 `nope` 被拒并带出 `Router must return a declared case`）；本次 `plan-reviewer` 答 `accept` 已落库 | **实测**（绿测 + 本次运行记录） |
| 11 | 判 fail 时三条回边**全部**返工（不按名单） | `loops` 三条 `{from:'synth',to:'worker-1\|2\|3',case:'fail'}` | `operation-lifecycle.ts:1114-1116`：`plan.loops.filter(...)` 是 **`filter` 不是 `find`**，同 `from`+`case` 的三条全取；`1283-1289`：一次 `reactivate(store, taskId, routed.map(loop => loop.to))` + 事件 `graph.rework{from:'synth',to:[三条]}` | `tests/console/complex-tier-v40.test.ts:268,298`（`to` 恰为三条、顺序稳定、两轮 fail 都是同三条）；阴性对照 `:314`（只留一条 loop 时只重跑 worker-1）；**本次运行真的发生过一次**：`graph.rework{"from":"synth","route":"fail","to":["worker-1","worker-2","worker-3"],"via":"route"}` | **实测**（绿测 + 阴性对照 + 本次运行事件） |
| 12 | 验收项只绑 deliver | `acceptance=[{id:'human-accept',checkNode:'deliver'}]` | `src/core/proposal.ts:61-72`（`invalid` 在 `:71`；每个验收项必须绑一个 mandatory program 节点或 agent router） | `tests/console/design-examples.test.ts:48`（验收项指向的必须是图里的节点）；本次提案被接受时已过这道 validator | **实测**（绿测 + 本次运行） |
| 13 | 通过后进入人工验收 | `deliver{kind:'program',action:'graph.human_check',dependsOn:['synth']}` | `src/core/execution.ts:718-728`：没有绑定本次 `activationId+commitSha` 的已解决 `human_check` 答复 → `block(node,'human_check','A human acceptance check is required')` | `tests/console/complex-tier-v40.test.ts:328`（fail 后 `acceptancePrompts()` 为空，`pass` 后恰好一次且 `owner='user'`、phase 仍未完成）；阴性对照 `:347`；`tests/m4/acceptance.test.ts:190,221` | **实测**（绿测；注意 FM4 证明的是**返工连带把门关住**，不是 `deliver` 自己有 `when`） |
| 14 | 先由主 Agent 审证据 | **无图字段**（工具层） | `src/runtime/agent-tool-definitions.ts:261-262`、`src/runtime/agent-tools.ts:438-449`、`src/core/question-routing.ts:304-317`（`approve:true` 只写 `human.prereview_approved`，check 仍 `open`）、`src/core/task-runtime.ts:2163-2192`（`approve:false` → 插一条 `rework` 问题把节点打回） | `tests/console/human-prereview.test.ts:48,59,75,88,99`、`tests/console/human-prereview-e2e.test.ts:57` | **实测**，但**结论与需求有出入**：见 §2-④ |
| 15 | 再向用户总结汇报 | **无** | 无强制点。`answer` 唤醒只来自用户答复（`src/core/wake-ledger.ts:12,130`）；图节点没有「向用户汇报」的工具或事件 | 无 | **未覆盖**（补法见 §4-3） |
| 16 | 全部节点用 space-bunny-free | 每个 agent 节点 `model='opencode-go:space-bunny-free'` | `src/core/model-selection.ts:51-76`（评审节点把上游实际用过的模型放进 `exclude`）→ `src/catalog/models.ts:167-174`（`requested` 命中 `exclude` 就被丢弃，退到 grade 默认）→ `src/core/execution.ts:744,751`（写回实例并发 `model.switched` 事件） | 无针对性测试 | **实测——且实测结论与需求相反**：本次运行 6 次 `model.switched`，`plan-reviewer`/`review-1..3` 全部被换成 `deepseek-v4.1-flash`；只有 `planner`/`worker-1..3`/`synth` 保住。见 §2-① |

---

## 2. v40 相对旧形状新引入的三个机制点，及各自的坑

### ① 「全部节点同一个模型」和「评审必须独立于实施者」在 v40 里互斥，运行时选了后者

这不是推测，是本次运行记下来的（返工时重读，数字已经涨到 6 次切换）：

```
events.model.switched  （共 6 条）
  plan-reviewer  opencode-go:space-bunny-free → opencode-go:deepseek-v4.1-flash
  review-1  ×2   opencode-go:space-bunny-free → opencode-go:deepseek-v4.1-flash
  review-2  ×2   opencode-go:space-bunny-free → opencode-go:deepseek-v4.1-flash
  review-3       opencode-go:space-bunny-free → opencode-go:deepseek-v4.1-flash

events.review.independence_checked  （7 条，policy.excludedModels = ["opencode-go:space-bunny-free","space-bunny-free"]）

instances.model / invocations 实际用量
  planner        opencode-go:space-bunny-free        71 次
  worker-1/2/3   opencode-go:space-bunny-free   248/162/224 次
  plan-reviewer  opencode-go:deepseek-v4.1-flash    46 次
  review-1/2/3   opencode-go:deepseek-v4.1-flash 104/125/68 次
  synth          opencode-go:space-bunny-free        24 次   ← 没被换
```

链路：`presets/manifest.json` 的 `reviewer` 定义带 `review:true` → `model-selection.ts:12-17` `isReviewer` 命中 →
`model-selection.ts:20-48` `implementerModels` 把**依赖节点实际调用过的模型**收进 `exclude` →
`catalog/models.ts:169-170` 先按 `exclude` 过滤目录，**再**找 `requested`，找不到就退到 `grade` 默认模型 →
`execution.ts:751` 发 `model.switched`。

**为什么 `synth` 反而保住了 space-bunny-free**（上一版这里是推测，现已由实况解释）：`implementerModels` 只走 `spec.dependsOn`。
`plan-reviewer`/`review-1..3` 的依赖链里通着 `planner`/`worker-1..3`，它们的 invocations 都是 `space-bunny-free` → 命中 exclude → 被换。
`synth` 的依赖只有三个评审节点，而那三个评审节点自己已经被换成 `deepseek-v4.1-flash`，所以 `space-bunny-free` **不在** synth 的 exclude 里 → 照用。
换句话说：**「评审不跑实施者的模型」是按依赖闭包逐层生效的，换过一轮之后，换过的模型反而不会再被排除。**

**坑**：需求第 16 句在四个评审节点上**不成立**，而且 `instances.model` 在派发前看起来是对的（值就是 `space-bunny-free`），只有 `model.switched` 事件和 `invocations` 说实话。
**要真让「全部节点 space-bunny-free」成立，只能放弃独立评审**（去掉 `context.purpose:'review'` / `reviewer@8` / `synthesizer@1` 的 review 标记），或者接受评审节点换模型——这是需求冲突，不是实现缺陷。

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

# 4) 批量回边现在有钉子了吗：全仓 tests/ 里「同 from 同 case」的 loop 组
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
# 期望输出：2 组。
#   ('synth','fail')    → complex-tier-v40.test.ts 三条 worker-1/2/3  ← 车道 1 返工后新增，表里第 11 行因此从「静态」升为「实测」
#   ('plan-reviewer','replan') → 跨文件同名 loop（v40 形状 + 旧形状各一处），不是重复声明
# 上一版本文件写的是「期望输出：0 组」，那是车道 1 合并进来之前的数字，已按实测重写。

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

## 4. 本次交付之后仍然没有测试钉住的东西（每条写清楚补它需要哪个断言）

车道 1 的 `complex-tier-v40.test.ts` 合并进来后，原 4-1/4-4/4-6 已经被它盖住（见下方「已覆盖」），剩下的才是真的缺口。

| # | 状态 | 东西 | 现状 | 补它需要的断言 |
|---|---|---|---|---|
| 4-1 | **已覆盖** | plan-reviewer 判 `replan` 时三个 worker 及下游不派发 | `complex-tier-v40.test.ts:238` + 阴性对照 `:256` | 差一条：再钉一下 `node.skipped{reason:'inactive_route'}` 落库三次（现在只断言「没被派发」） |
| 4-2 | **未覆盖** | 「三个 worker 各产出一份成果」 | v40 的 `worker-1/2/3` **没有声明 `deliverable`**，运行时不知道成果是什么 | 两种改法二选一：(a) 给三个 worker 各加 `deliverable`，用 `node-deliverable.test.ts:157` 已有的「声明未写即失败」语义写断言；(b) 保持现状，则在文档里明写「worker 的成果靠评审读工作副本，不受运行时保证」 |
| 4-3 | **未覆盖** | 「再向用户总结汇报」 | 图节点没有任何面向用户的汇报通道（`answer` 唤醒只来自用户答复） | 要么删掉这句需求，要么给主 Agent 的汇报补一个可测的契约（结论先出现在 master 的 task view 里）——目前写不出有意义的断言 |
| 4-4 | **已覆盖** | `synth` 判 `fail` 时三条回边一起触发 | `complex-tier-v40.test.ts:268,298` + 阴性对照 `:314`（只留一条 loop 时只重跑 worker-1） | 无 |
| 4-5 | **未覆盖** | 「全节点同模型」在评审节点上的**期望行为** | 本次实测到一次 `model.switched`，但没有任何测试把这个行为钉死 | 写一条测试明确期望：是切换并记 `model.switched`，还是拒绝派发。否则这条需求每次都可能悄悄变；车道 2 写文档时不能直接照抄 |
| 4-6 | **已覆盖** | `deliver` 人工门在 synth 判 `pass` 后才开、判 `fail` 时不开 | `complex-tier-v40.test.ts:328` + 阴性对照 `:347`（FM4 还证明了关门靠的是返工连带重置，不是 `deliver` 自己的 `when`） | 无 |
| 4-7 | **新发现的窄缺口** | `node.skipped` 落库本身 | `graph.ts:129-131` 只给出 `skip` 判定，落库与事件在 `execution.ts:567-576`；全仓没有测试断言过 `reason:'inactive_route'` | 在 4-1 那条里补一次事件断言即可（车道 1 的文件，不在本车道） |

---

## 5. 本车道没有做的事（写清楚，免得被当成遗漏）

- 没有改 `src/**`、`tests/**`、任何 `docs/**`：本车道只动本文件 + `docs/evidence/v40-mechanisms-report.md` 两个文件，`git status --porcelain` 原文见报告 §7。
- 没有跑 `GRAPH_UPDATE_EVIDENCE=1`，没有动 `acceptance-evidence/`。
- 没有把「代码读得出来」写成「实测」：**判据已写死在 §1 的三档定义里**——本行主体有没有在本次运行发生，或有没有以 v40 全形为对象的绿测钉住；同一强制点被别的测试碰过只写在备注里，不抬档。返工重标后（§6）本表为 **15 实测 / 0 静态 / 2 未覆盖**，其中 2 条实测（#14、#16）的结论与需求原文不一致，已在 §2 写明。
- 没有替车道 1 改用例：`complex-tier-v40.test.ts` 归车道 1，本文件只指出它还差哪一条断言（§4-1、§4-7）。
- 全量 `node --run check` 在本工作树红（`42 failed | 186 passed`），是环境既有失败；把本文件移出工作树后重跑失败子集，数字一模一样。命令、exit code、A/B 原文见 `docs/evidence/v40-mechanisms-report.md` §5。

---

## 6. 返工记录（attempt 2）

synth 判 `fail`，分给本车道的是「零改动，仅复跑复现证据；可选修正 F1（#9/#10 证据强度标签与其第 16 行规则自相矛盾）」。本轮实际做了三件事：

1. **复跑复现证据**（见报告 §5，exit code 原文）：车道 1 钉住机制用的 5 个文件仍 `5 passed / 19 tests`、`exit 0`；车道 1 自己的 `complex-tier-v40.test.ts` 仍 `8 passed`、`exit 0`。
2. **修 F1，并把它暴露出的同款矛盾一起修**：旧规则用「本次有没有走到」当判据，新判据统一成「**本行主体**有没有被走到 / 被以 v40 全形为对象的绿测钉住」，否则「实测 + 备注写着没走到」就是自相矛盾。受影响重标的有 #3、#4、#5b、#9、#10、#11、#13（详见 §1 表内每行的理由列），没有一条是只改标签不改理由的。
3. **把已经过期的结论改掉**：车道 1 的 `complex-tier-v40.test.ts` 随门禁合并进本工作树之后，我上一版写的「全仓没有任何测试写过同 from 同 case 的两条 loop」**已经不成立**——§3 自检 4 的实测输出从 `0` 变成 `2` 组，其中一组正是 v40 的三条 `synth--fail-->worker-N`。据此 #11 从「静态」升为「实测（绿测 + 阴性对照）」，#3/#4/#5b/#13 同样升为「实测」。

**没有做的事**：没有碰 `docs/design-graph-examples.md`（车道 2 的文件，M1/M2/M3/M4 是 synth 给车道 2 的必修项，不在本车道）；没有按 review-2 §3.3 去改 `operation-lifecycle.ts` 的行号——本车道从未引用过 `1117`，它自己引的是 `1127`（`if (agentRouter && …`）和 `1114-1116`，均已重新 grep 核对（§3-3、§3-5）。
