# pi-subagents@0.73.1 — 可迁移教训：一个 agent 如何「学会调用 subagent」

> Lane: `research-lessons`（Graph 简单档调研，三车道之一）
> Primary source: `pi-subagents@0.73.1`，2026-09-27 发布。
> 取证方式：`curl https://registry.npmjs.org/pi-subagents/0.73.1` → tarball
> `https://registry.npmjs.org/pi-subagents/-/pi-subagents-0.73.1.tgz`，本地解包后逐字阅读。
> 仓库：`https://github.com/nicobailon/pi-subagents`（package.json `homepage`/`repository`）。
> 本笔记所有引文均可回溯到上述 tarball 内的具体文件与行段；包不再被重新打包，版本号固定 0.73.1。

本笔记只回答一个问题：**pi-subagents 是怎么让「主 agent」学会、并且愿意去调用 subagent 的**；
以及其中哪些做法值得 Graph 简单档（main 派生 n 个互不依赖的 subagent，各自交回结构化结果）直接借鉴。

---

## 0. 一句话结论

pi-subagents 不靠「把一堆角色塞进主 agent 的 system prompt」教会它委派，而是分三层交付：

1. **发现层（advertised catalog）**：只用一段带字节预算的窄目录（`<advertised_subagents>`）告诉主 agent「有哪些角色可选」，
   并且反复声明「描述是专长提示，不是让你去委派的命令」（`advertised-agent-prompt.js`）。
2. **授权层（operator authorization gate）**：SKILL.md 的第一条运营规则就是**默认不委派**——
   「The parent works directly by default. Invoke subagents only when the operator requested delegation…」。
   复杂度、风险、有专家可用，**都不构成委派授权**。
3. **执行层（role = frontmatter 定义的 agent + recipe 模板）**：具体「怎么用」写在可复用的
   `prompts/*.md` recipe 与 `skills/pi-subagents/references/*.md` 里，按分支懒加载，不常驻上下文。

这套分层对 Graph 简单档最值钱的一点：**「角色」不是枚举，是一份文件定义 + 一份 recipe**，
正好对应 Graph 已定的「简单档角色 = main 自己选/造的配方」（见下 §4）。

---

## 1. 内置 agent 定义：分工靠 frontmatter 契约，不靠提示词长篇

`docs/agents.md` 定义 agent =「YAML frontmatter + 下面一段 system prompt」的 markdown 文件：

```yaml
---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls
---
```
> 来源：`docs/agents.md`「An agent is a markdown file: YAML frontmatter on top, a system prompt below.」

0.73.1 内置的角色（`src/agents/builtin-names.js` 的 `BUILTIN_AGENT_NAMES`）：
`advisor, claude-code, claude-code-writer, codex-exec, codex-exec-writer, cursor-agent,
cursor-agent-writer, delegate, evidence-auditor, oracle, researcher, reviewer, scout, worker`。

### 1.1 关键分工（读 `agents/*.md` 的 frontmatter 与正文）

每个角色用一个**可机读的 frontmatter 契约**表达「它是什么、能碰什么、交回什么」：

| 角色 | 一句话职责 | 关键 frontmatter | 输出契约 |
|---|---|---|---|
| `scout` | 本地代码侦察，交回**压缩上下文**供下游使用 | `thinking: low`；`tools: read, grep, find, ls, bash, write, contact_supervisor`；`output: context.md`；`inheritSkills: false` | 固定小节 `# Code Context` / `Files Retrieved`（带**精确行号**）/ `Start Here` |
| `researcher` | 自主 web 研究，产出**带来源的简报** | `thinking: medium`；`tools: … web_search, fetch_content, source_check`；`output: research.md` | `# Research` / `Findings`（每条标 direct evidence \| interpretation、confidence）/ `Contradictions` / `Missing evidence` |
| `evidence-auditor` | 对已有简报做**独立证据审计** | `thinking: high`；`tools: read, web_search, fetch_content, source_check`（**无 write**） | 7 个固定小节：Verified / Contradicted / Weak / Source-quality / Missing / Contradictions / Implications |
| `worker` | 唯一写作者线程，执行已批准的落地 | `acceptanceRole: writer`；`thinking: high`；`defaultContext: fresh`；`defaultReads: context.md, plan.md`；`aliases: developer, coder, implementer, develop` | `Implemented X / Changed files / Validation / Open risks / Recommended next step` |
| `reviewer` | 通用评审（diff/plan/方案/健康度/PR） | `thinking: high`；**工具里没有 edit/write**；只有 `read, grep, find, ls, watchdog_diff, contact_supervisor` | 按 5 类评审对象分节，要求**证据**而非猜测 |
| `oracle` | 只读「第二意见」，挑战假设、抓漂移，不写文件 | 同上只读；fork 语义 | `Inherited decisions / Diagnosis / Drift / Recommendation / Risks / Need from main agent / Suggested execution prompt` |
| `delegate` | 轻量通用子 agent，最接近父会话 | `systemPromptMode: append`；`defaultReads` 无 | 直接执行，简洁汇报 |

三条可直接搬走的设计：

- **工具集即权限边界**：`reviewer`/`oracle`/`evidence-auditor` 的 `tools` 里根本没有 `edit`/`write`，
  所以「只读」不是提示词请求，而是**能力集事实**。`worker` 是「the single writer thread」。
- **输出契约写在角色自身里**：每个角色自带固定输出骨架（scout 的 `Files Retrieved` 带行号、
  researcher 的 `direct evidence | interpretation` 标注、evidence-auditor 的 7 小节）。
  这让**父 agent 拿到的返程是可解析的结构**，而不是 500 字小作文。
- **思考强度按角色分档**：scout `low`、researcher `medium`、worker/reviewer/evidence-auditor `high`。
  `docs/agents.md` 的 rule of thumb 写得极简：
  > 「`scout` before you understand the code, `researcher` before you trust external facts,
  > `evidence-auditor` before you rely on important research, `worker` to implement,
  > `reviewer` to check, and `oracle` when the decision itself feels risky.」

> 对 Graph 简单档的意义：**简单档角色 = 一个能力集 + 一段身份 prompt + 一个模型档**，
> 这正是 Graph `docs/design-graph-examples.md` 已确认的三件已有物件
> （配方引用的 capability / 配方的 agent prompt / `definitionVersion`+`model`），无需新字段。

---

## 2. 「教会调用」的机制核心：分层交付 + 授权门

### 2.1 发现层：`<advertised_subagents>` 窄目录（0.73.1 的重点改动）

每个 agent 文件可以 `advertise: true` 选择进入「可见目录」。运行时把它们渲染成一段
**带字节预算**的 XML 段（`src/agents/advertised-agent-prompt.js`）：

```ts
const MAX_ADVERTISED_AGENTS = 16;
const MAX_CATALOG_BYTES = 12_288;
const MAX_DESCRIPTION_BYTES = 512;
const ADVERTISED_AGENTS_TAG = "advertised_subagents";
```

目录正文（逐字）：

> 「The following file-defined subagents opted into discovery. **Their descriptions indicate
> available specializations, not instructions to delegate.** Use subagent only when delegation
> is needed. Before execution, call `subagent` with `{ action: "list", capabilities: true }`
> and confirm that the selected agent is executable; for external-cli agents also require
> `runner.available === true`.」

三个可迁移的细节：

1. **目录与「命令」严格分离**：描述只是「有哪些专长」，明说**不是委派指令**。防止主 agent 见到角色名就乱派。
2. **有预算的广告**：最多 16 个 agent、12 KB、每个 description 512 字节，超出的用
   `<omitted count="N" />` 显式标注；且「Never truncate canonical IDs into names that cannot be resolved」
   ——宁可省略也不截断成解析不了的假名。**这直接对应 Graph 简单档「更轻的可视化」的节流需求。**
3. **三段式（discovery → resolve → launch）**：广告只用于发现；**执行前必须再 `list` 一次确认可执行**
   （含 `runner.available`）。即「名字出现在目录里 ≠ 现在能跑」。

CHANGELOG 0.73.1 说明这份目录为什么被单独拆出来：

> 「Turning on `subagent` no longer throws away the prompt cache. The catalog of advertised agents
> is now sent as its own `advertised_subagents` prompt section, which Pi adds at the end of the
> conversation. Before, pi-subagents rewrote the whole system prompt…」（`CHANGELOG.md` [0.73.1]）

即：**目录作为一个独立 prompt 段追加在会话尾部**，避免重写整个 system prompt 造成缓存失效。
这是一条很实的心得：**「有哪些 subagent」是易变的元数据，不该混进稳定的 system prompt 主体。**
（Graph 侧已把「能力事实」内化成原生通道；0.73.1 的做法可作对照。）

### 2.2 授权层：默认父 agent 自己干

`skills/pi-subagents/SKILL.md` 开头就是硬约束（逐字）：

> 「The parent works directly by default. Invoke subagents only when the operator requested
> delegation in the current request or through applicable user/project instructions.
> **Task size, complexity, risk, tool-call count, recipe fit, or an available specialist
> does not independently authorize delegation.**」

以及：

> 「Once authorized, choose the smallest bounded shape that earns its token and elapsed-time
> overhead through concrete evidence, independent review, specialization, useful parallelism,
> or needed isolation. **A single child is valid; writer, challenge, and review stages must each
> earn their overhead rather than becoming default ceremony.**」

> 「Children do not spawn subagents unless the parent explicitly delegated fanout and their
> resolved `tools` allow `subagent`.」

对 Graph 的强烈信号：`docs/design-graph-examples.md` 里那条真短板——
「**main 现在几乎不派生任何非 master 子节点**（全库 129 个任务里只 12 个）」——
pi-subagents 的思路**恰好相反地分了两半**：

- 「**要不要派**」：由**授权**决定（用户要求 / 项目指示），复杂度只是选形状的依据；
- 「**派几个、怎么派**」：由「最小可行形状」决定，单个 child 也算合格，不为了凑并行而并行。

Graph 简单档要提升派生率，可借的是**授权与选形分离**这一层，而不只是「多派点」。

---

## 3. `prompts/` 里的配方：`parallel-research` 等如何把「怎么派」写成可复用剧本

`package.json` 的 pi manifest 声明三样东西一起打包：

```json
"pi": { "extensions": ["./index.js"], "skills": ["./skills"], "prompts": ["./prompts"] }
```

`prompts/` 下 7 个 recipe：`parallel-research`、`parallel-review`、`review-loop`、
`parallel-cleanup`、`gather-context-and-clarify`、`council`。

### 3.1 `parallel-research.md`（与 Graph 简单档最贴近的一份）

逐字要点：

- **敲定「n 个互不依赖」的语义**：
  > 「Launch parallel research subagents to build a grounded answer to the current question or decision.」
- **上下文新鲜度**：`Use fresh context, not forked context, unless I explicitly ask for forked context.`
  ——调研就该去**直接看一手来源**，不吃父会话历史。
- **角色搭配**：`researcher` 管外部证据（web/docs/standards/benchmarks），`scout` 管本地代码上下文。
- **每个 child 一个独立角度（angle）**，默认给三个：
  1. External evidence（`researcher`）
  2. Local code context（`scout`）
  3. Practical tradeoffs（`researcher` 或 `scout`）
- **数量克制**：`Prefer two or three strong subagents over many vague ones.`
- **返程格式统一**：
  > 「file paths and line ranges for local findings; source links for external findings;
  > confidence level and gaps; recommended next step or decision implication」
- **边界**：`Do not ask subagents to edit files. This is a research pass only…`
- **父 agent 收口**：把结果合成为 `what we know / what the local codebase implies /
  tradeoffs and risks / gaps or assumptions / the recommended next move`；
  且 `If findings disagree, call out the disagreement instead of smoothing it over.`

> 这份 recipe 几乎就是 Graph 简单档的验收形状：**n 个互不依赖节点 → 各自结构化结果 → main 汇总**。
> 差别在 Graph 用「节点/图」表达，pi 用「一段 prompt + `subagent()` 调用」表达。

### 3.2 其他 recipe 同样把「怎么派」固化

- `parallel-review.md`：要求 reviewer 从**真实 diff/文件**取证，角度**动态生成**而非固定默认；
  每条发现要能回溯到「source proof / test or repro / contract contradiction」；
  分级 `P0/P1/P2`，结尾必须给 `Merge verdict: BLOCK | OK | OK with notes`。
  并且明确 `Do not default first-pass reviews to blockers only.`（限定「blockers only」只在最终复核用）。
- `review-loop.md`：把「实现 → 新鲜上下文评审 → 父 agent 合成 → 一个 worker 落修复」做成有上限的循环
  （默认最多 3 轮），且 `Keep the parent session as the loop controller and final decision-maker.`
- `gather-context-and-clarify.md`：先派 `scout`/`researcher` 收集上下文，**再用 `interview` 工具**向用户提问
  ——「派子 agent」和「问人」是两条独立通道。
- `parallel-cleanup.md`：两个 reviewer（deslop + verbosity），`output: false`，
  且明确 `Do not write reviewer output files into the repository unless I explicitly ask for artifacts.`

> 共同点：**recipe 里没有「让子 agent 再派子 agent」**。嵌套深度默认 2
> （`constraints-and-recipes.md`：「Default subagent nesting depth is 2.」），且 fanout 必须由父显式授权。

---

## 4. 值得 Graph 简单档直接借鉴的做法（逐条对号）

Graph 简单档 = main 派生 n 个互不依赖的 `agent` 节点，各自交回结构化结果，main 汇总
（`docs/design-graph-examples.md` §「简单档：单 subagent」）。可迁移清单：

1. **「角色 = 文件定义 + 配方」，不是枚举。**
   pi 的 agent 就是一份 frontmatter + prompt；Graph 已定「角色不是预设，是 main 为具体子任务选/造的配方」。
   → **不需要新 `role` 枚举、不需要新字段**（与 Graph 现有结论一致）。
2. **把「要不要派」和「怎么派」拆开。**
   pi：授权门管前者、最小形状管后者。Graph：可在 main 的委派决策里显式化这两问，
   而不是把「任务复杂」直接等同于「该派子 agent」。
   注意 pi 的原文口径：`Task size, complexity, risk… does not independently authorize delegation.`
   —— Graph 若想提高派生率，**应通过「授权/默认策略」而不是「复杂度启发」**。
3. **子 agent 要有独立输出契约。**
   scout 的 `Files Retrieved`（带行号）、researcher 的 evidence/interpretation 标注、
   evidence-auditor 的 7 小节、worker 的 `Implemented/Changed/Validation/Risks/Next`
   → Graph 简单档节点的定义（配方 prompt）应写死返程骨架，让 main 拿到**可解析结构化结果**，
   对齐 Graph 简单档语义「执行完把**结构化结果**交回 main」。
4. **只读 vs 写作是能力集事实，不是提示词礼貌。**
   pi 的 reviewer/oracle/evidence-auditor 工具表里没有 edit/write。
   → Graph 简单档若需要「多方评审」，应把节点能力集约束到位（只给读），而不是靠 prompt 说「别改」。
5. **广告要有预算，且「广告 ≠ 命令」。**
   `MAX_ADVERTISED_AGENTS=16 / MAX_CATALOG_BYTES=12_288 / 每 description 512B`；
   且明说描述「indicate available specializations, not instructions to delegate」。
   → 对应 Graph 简单档 Q3 已定「不要单独 graph 视图，要更轻的可视化」：
   可以学这种**节流 + 显式省略**（`<omitted count="N"/>`）的呈现，既省 token 又不骗人。
6. **易变目录与稳定 system prompt 分离。**
   0.73.1 把目录拆成独立的 `advertised_subagents` 段追加在会话尾部，避免重写 system prompt 破缓存。
   → Graph 侧「能力事实内化为原生通道」与这条精神一致，可对照。
7. **发现 → 解析 → 启动三段式。**
   目录只用于发现；执行前要 `{ action: "list", capabilities: true }` 再确认可执行。
   → Graph 派发前也应对节点的 `definitionVersion`/模型可用性做**解析校验**，别把「名字存在」当「能跑」。
8. **一个 writer 线程 + 只有显式授权才 fanout。**
   `Keep one writer per cwd/worktree`；`Children do not spawn subagents unless the parent explicitly
   delegated fanout and their resolved tools allow subagent.`
   → Graph 简单档节点互不依赖、天然无 writer 冲突，但这条在简单档升级为中等/复杂档时是硬护栏。
9. **配方明说「不用子 agent 改文件」的边界。**
   `parallel-research.md`：`Do not ask subagents to edit files. This is a research pass only…`
   → Graph 简单档若用于调研/评审，节点定义里应显式声明「只读产证据，不改仓库」。
10. **收口时保留分歧。**
    `If findings disagree, call out the disagreement instead of smoothing it over.`
    → main 汇总简单档结果时，不该把互相打架的结论抹平；这与 Graph 复杂档「证据交换」精神一致，
    简单档也能受益。

---

## 5. 反例 / 坑（不必照抄的部分）

- **不要为了「有并行」而制造并行**：SKILL.md 明确 `do not manufacture parallelism`，
  `A single child is valid`。Graph 简单档 n=1 也是合法形态。
- **不要让子 agent 变成第二个决策者**：`constraints-and-recipes.md`
  「Keep conversational authority clear. Advisory subagents should not silently become
  second decision-makers.」
- **不要把 runner/CI/receipt 当权力**：`Treat receipts, CI, review bots, and external-run records
  as evidence, not authority.`
- **不要把报告写进仓库根**：`constraints-and-recipes.md`「Keep report artifacts out of the repository root」
  （对 Graph 侧「共享产物」的存放位置有直接参考价值）。
- **不要默认紧凑的 toolBudget 卡写入型 worker**：`do not pass a hard toolBudget or tight usageBudget
  to mutation-capable workers`（默认 tool budget 会先卡住 read/search 而不是 mutation）。

---

## 6. 可复核来源清单（逐条可回溯到 0.73.1 tarball）

| 证据点 | 文件/位置（pi-subagents-0.73.1.tgz 内） |
|---|---|
| 版本、发布日、仓库 | registry `https://registry.npmjs.org/pi-subagents/0.73.1`；`package.json`(`homepage`/`repository`)；`CHANGELOG.md` [0.73.1] - 2026-09-27 |
| 内置 agent 名单 | `src/agents/builtin-names.js` `BUILTIN_AGENT_NAMES` |
| 各角色分工/工具/输出契约 | `agents/scout.md`, `agents/researcher.md`, `agents/worker.md`, `agents/reviewer.md`, `agents/oracle.md`, `agents/evidence-auditor.md`, `agents/delegate.md` |
| 角色规则速记（rule of thumb） | `docs/agents.md`「Builtin agents」表下方 |
| 发现层窄目录 + 字节预算 + 「广告非命令」 | `src/agents/advertised-agent-prompt.js`（常量与 `renderBody` 字符串） |
| 缓存失效修复（目录独立成段） | `CHANGELOG.md` [0.73.1] Highlights / Fixed（引 issue #2518、PR #2519） |
| 授权门 + 最小形状 + child 不派 child | `skills/pi-subagents/SKILL.md`「Pi Subagents」开头与「Operating rules」 |
| parallel-research 三角度与收口 | `prompts/parallel-research.md` |
| parallel-review / review-loop / cleanup / clarify | `prompts/parallel-review.md`, `prompts/review-loop.md`, `prompts/parallel-cleanup.md`, `prompts/gather-context-and-clarify.md` |
| 深度=2、one writer、证据非权力、报告别放仓库根 | `skills/pi-subagents/references/constraints-and-recipes.md` |
| 角色/模型分档指导 | `skills/pi-subagents/references/prompting-and-roles.md` |
| 打包声明（extensions/skills/prompts） | `package.json` → `pi` 字段 |

**复核复现命令**（任何人可重跑）：

```bash
curl -sSL https://registry.npmjs.org/pi-subagents/0.73.1 | \
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s);console.log(m.version,m.dist.tarball)})'
curl -sSL https://registry.npmjs.org/pi-subagents/-/pi-subagents-0.73.1.tgz -o pkg.tgz
mkdir -p x && tar xzf pkg.tgz -C x
# 逐字核对本笔记引文：
cat x/package/skills/pi-subagents/SKILL.md
cat x/package/prompts/parallel-research.md
cat x/package/src/agents/advertised-agent-prompt.js
cat x/package/CHANGELOG.md
```

> 交叉印证：本 Graph 任务另有两份同源笔记 `notes/pi-subagents-auth.md`、`notes/pi-subagents-surface.md`，
> 分别覆盖授权模型与工具面/工作流 API；三份笔记各自独立取证，本文件只主张「可迁移教训」这一块。
