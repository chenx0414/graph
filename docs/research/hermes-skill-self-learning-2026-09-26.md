# Hermes Agent「Skill 自学习」实现研究（2026-09-26）

## 研究范围

- 上游：`NousResearch/hermes-agent`，本地副本 `/Users/macmini/Downloads/hermes-agent`，HEAD `d0288be5`（2026-09-26），`--depth 1`。
- 一手来源：仓库源码（`agent/`、`tools/`、`hermes_cli/`）、仓库自带文档（`website/docs/`）。**未运行 Hermes**：下文所有机制均以源码与官方文档为准，不推测其运行时表现。
- 目标：搞清它「Skill 自学习（自动生成技能）」到底由哪些机制组成，并评估迁移到 Graph 的可行性。

## 结论（先看这个）

Hermes 的自学习**不是单一算法，而是四个独立机制的组合**，它们彼此解耦、可单独取舍：

| # | 机制 | 一句话 | 关键文件 |
|---|---|---|---|
| 1 | **写入面** | 给模型一个自己的技能工具 `skill_manage`（含强制守卫） | `tools/skill_manager_tool.py`、`tools/skill_manager_guards.py` |
| 2 | **读取面** | `skills_list` / `skill_view` + 系统提示词里的技能索引（描述截断 60 字符） | `tools/skills_tool.py`、`agent/skill_utils.py:761` |
| 3 | **主动沉淀** | **每回合结束后 fork 一个 AIAgent 重放对话**，问「该保存/更新哪个技能」 | `agent/background_review.py`、`agent/turn_finalizer.py:716` |
| 4 | **持续进化** | 后台 **curator**：确定性 stale/archive + 可选 LLM 合并（默认关） | `agent/curator.py` |

外加两个不承担核心逻辑的入口：`/learn`（把任意来源喂成技能）、learning graph（可视化）。
**真正的「主动」来自机制 3**：它是每回合的自动自省；机制 4 只负责不让库腐烂。

---

## 1. 写入面：`skill_manage` —— 模型的程序性记忆

> "the agent's **procedural memory** — when it figures out a non-trivial workflow, it saves the approach as a skill for future reuse"
> —— `website/docs/user-guide/features/skills.md:612`

**动作集**（`skills.md:653` 表格）：`create` / `patch`（定向，首选）/ `patch`+`content`（整篇重写）/ `delete` / `write_file` / `remove_file`。
每个动作**各自成套**：文本槽只属于一个动作（`content`→create、`new_string`→patch、`file_content`→write_file）。带了别的动作的槽，**在任何一条被应用之前就整体拒绝**，错误里点名「文本落在哪个键、该挪到哪」。

**形态约束**（文档 `skills.md:643` + 代码 `tools/skill_linter.py`）：写入时跑 advisory linter，三条规则专治坏形状——
- `incident-log-shape`：正文里堆 PR/issue 号；
- `references-sprawl`：`references/` 文件超过 60 个；
- `oversized-body`：`SKILL.md` 正文超过 ~24k 字符（`skill_view` 全文进上下文并停留整场会话）。

**只警告，不阻断写入**（`skills.md:643`）——这是刻意的：形态是判断，不是门槛。

**强制守卫**（这些会拒绝，`tools/skill_manager_guards.py`）：
- **读后写**（`:220`）：后台 review fork 在改 SKILL.md 前**必须在本次 review 内** `skill_view` 过该目标；对话里早先引用过不算数。错误信息里点名「对 SKILL.md 调 `skill_view(name)`，对支持文件调 `skill_view(name, file_path=...)`，然后重试」。
- **pin 守卫**（`:143`）：pinned / ESSENTIAL 技能**禁止删除**，但**允许 patch**——「Pin only guards DELETION」。
- **合并删除守卫**（`:241`）：curator 合并 pass 里，**没有 `absorbed_into` 目标的删除一律拒绝**（fail closed）。注释记录了真实事故（#29912）：去掉这条后，pass 曾把成簇的活跃技能归档掉而**零个真实合并**。

**来源标记**（`tools/skill_provenance.py` 全文 44 行）：一个 ContextVar 区分「后台 review 写的」与「前台用户要求写的」——`background_review` vs `foreground`。**为什么需要**：curator 只维护「自省 fork 创建的」技能；用户手写/安装的技能归用户，后台不许改。另有一个正交维度 `review_attended`：`/refine` 这种用户主动发起的 fork **仍算 background review**（所有 curator/ledger/审批守卫照旧生效），但「无人值守才禁的删除」对它不适用。

**usage 侧写**（`tools/skill_usage.py:1`）：遥测写在 `~/.hermes/skills/.usage.json`（**按技能名，绝不写进 frontmatter**，避免污染用户手写文件与 bundled/hub 技能）；计数器写入 best-effort（失败只记 DEBUG，绝不打断工具调用）；「curator 可管理」是**显式**的 `created_by: agent` 标记，**从不从位置推断**。

## 2. 读取面：渐进披露

- `skills_list`（`tools/skills_tool.py:234`）列索引；`skill_view`（`:573`）按需**全文**载入——所以「大技能」的代价是它整场会话都占上下文（这正是 linter 那条 24k 规则的原因）。
- 系统提示词里的技能索引**把描述截断到 60 字符**（`agent/skill_utils.py:761-773`），因此 curmator 的提示词专门提醒：「检索是按 description 匹配，长描述会被截断——把触发类别放进这个窗口」（`agent/curator.py:296-299`）。

## 3. 主动沉淀：每回合后的 background review（核心）

**触发**（`agent/turn_finalizer.py:716-741`）：

```python
_should_review_skills = (
    agent._skill_nudge_interval > 0
    and agent._iters_since_skill >= agent._skill_nudge_interval
    and "skill_manage" in agent.valid_tool_names
)
```

- 间隔默认 **10 次工具迭代**（`agent/agent_init.py:1369`，可配 `skills.creation_nudge_interval`）；memory 侧另有 `_memory_nudge_interval`（默认 10）。
- 判据是本回合**实际用掉的工具迭代数**，注释明确写了这一点。
- 附加门：有最终回复、未被中断、未 `skip_background_review`（cron 会跳过，理由写在代码里：「fork 每次事件约 30K tokens，且没有人在环里受益」）。
- 排队机制：`agent/review_idle_queue.py:160` 在**空闲**时补跑。

**做法**（`agent/background_review.py:1-6` 模块 docstring）：fork 一个 `AIAgent`，把对话快照**结构性复制**后重放，向它提问「should any skill/memory be saved or updated?」；写入直接落 memory + skill store；**主会话与提示词缓存永不被触碰**（fork 继承父的 provider/model/凭据/缓存 system prompt，从而命中同一 prefix cache）；派发侧有**工具白名单**（`:1078`，含只读文件工具），fork 自身的 nudge interval 清零（`:990`）以免自我递归。

**提示词**（`agent/background_review.py:417` `_SKILL_REVIEW_PROMPT`）——这是最有迁移价值的部分，它的设计要点：

1. **明确禁止「什么都不做」当默认**：
   > "Be ACTIVE — most sessions produce at least one skill update, even if small. A pass that does nothing is a missed learning opportunity, not a neutral outcome."
   同时保留出口：「'Nothing to save.' is a real option but should NOT be the default.」
2. **目标形状**：class-level 伞技能（SKILL.md 常驻规则 + 少量 topical `references/`），**不是**一会话一技能，也**不是**每吸收一个兄弟就加一个 reference 文件的垃圾桶。
3. **触发信号清单**（任一即行动）：用户纠正了风格/语气/格式/啰嗦度（「stop doing X」「太啰嗦」「别解释了」都被列为**一等技能信号**）；用户纠正了流程/顺序；出现了非平凡技术、绕坑、调试路径或工具用法；会话中**读取过的技能本身是错的/缺步骤/过时** → 立刻 patch。
4. **优先级顺序**：①先 patch **本会话真的读过/加载过**的那个技能（否则会写出重复技能）②否则 patch 已有的伞技能 ③否则给伞技能加支持文件（`references/` 按**主题**命名并**就地扩展**、`templates/` 可复制改、`scripts/` 可直接复跑）④都没有才**新建 class-level 伞技能**，且名字**不能**是 PR 号、错误串、功能代号、库名或 `fix-X/debug-Y/audit-Z-today` 这类会话残渣——「如果这个名字只在今天说得通，就是错的」。
5. **读后写**：见 §1 的强制守卫。
6. **用户偏好要写进技能正文**，不能只进 memory：
   > memory captures「who the user is and what the current situation is」；skills capture「how to do this class of task **for this user**」。
   并解释原因：「When they complain about how you handled a task, the skill that governs that task needs to carry the lesson.」
7. **受保护对象**（不许改）：bundled / hub 安装 / `skills.external_dirs` / pinned / **用户自有（非 curator 管理）**——并解释了为什么 pin 也拦后台写入：「You are an autonomous no-user-present actor, so pin blocks your writes too... Only the user, in a foreground session, can change a pinned skill.」；若该改的恰好是受保护技能，就**在回复里说明并建议 `hermes curator adopt <name>`**，而不是硬改。
8. **`_LESSON_LAYER_BLOCK`（什么算「课」）**：技能是「做一类任务最省事又正确的做法，按**这个用户**的规格」；**pitfall = 可泛化的规则 + 一句 why（机制）**，命令式、挂在受影响的那一步上、只说一遍；**禁止** PR/issue 号、日期、票号、引述的聊天记录作为内容——「规则必须脱离事件本身而立得住」；**同一个课第二次学到就是同一条规则**（先搜再写，加强而不是追加副本）；**不重复环境已经教过的东西**（仓库 AGENTS.md、工具 schema、其它常驻上下文）；技能出问题就**就地改那句话**，不要在下面追加「UPDATE: 其实……」。
9. **`_DO_NOT_CAPTURE_BLOCK`（什么不该沉淀）**——这条直接对治「幻觉式学习」：
   - 环境相关失败（缺二进制、未装包、路径不匹配、`command not found`、凭据未配）；
   - **对工具/功能的负面断言**（「浏览器工具不能用」「X 坏了」）——理由是它们会固化成模型日后引用来拒绝自己的约束；
   - 会话内自行恢复的临时错误（「如果重试就好了，课是重试模式，不是原始失败」）；
   - 一次性任务叙述；
   - **未解决的失败**：会话结束时并没有真正找到可行方法，就**不许**把那些尝试写成「可靠流程/推荐做法」——「要么说 Nothing to save，要么只写你独立确信的真实替代方案，绝不写死路，也绝不包装成最佳实践」。

**成本与人机边界**：约 **30K tokens/事件**（`turn_finalizer.py:731-733` 注释）；默认**无人值守直接写**，需要人看时用 `skills.write_approval: true` 把每次写入**暂存**到 `~/.hermes/pending/skills/`，用 `/skills pending|diff|approve|reject` 审（`skills.md:670-700`）。

## 4. 持续进化：curator（后台维护 pass）

> "It exists so that skills created via the self-improvement loop don't pile up forever... Without maintenance, you end up with dozens of narrow near-duplicates that pollute the catalog and waste tokens."
> —— `website/docs/user-guide/features/curator.md`

- **触发**（`curator.md` + `agent/curator.py:160-178`、`:1170`）：**不是 cron**，而是「不活跃检查」——距上次运行 ≥ `interval_hours`（默认 **7 天**）**且**空闲 ≥ `min_idle_hours`（默认 **2 小时**）。CLI 会话启动、gateway 例行、`hermes serve` 维护定时器（第一次轮询在 90s 后）都会检查；同一 profile 有回合在跑就跳过；**首次观测只播种 `last_run_at` 并整整推迟一个间隔**（给用户时间来 pin 或退出）。
- **第 1 阶段：确定性迁移，无 LLM**（`agent/curator.py:208`）。状态机 `active → stale → archived`：
  - 14 天未用 → `stale`；30 天未用 → 归档到 `~/.hermes/skills/.archive/`；
  - **绝不删除**（「the worst outcome is archival」，可恢复）；
  - **pinned** 与**被任何 cron 任务引用**的技能跳过（后者理由很实在：cron 停用/低频会让技能被动过期，从而把任务脚下的技能抽走）；
  - **`use_count == 0` 是「没有证据」而不是「没用」**：从未用过的技能不到 `stale_after_days` 老**绝不归档**；
  - bundled 技能首次进入统计时把时钟**锚在当下**（否则会在 epoch 处被瞬间归档）；`prune_builtins` 默认关，hub 安装的技能**永远**豁免。
- **第 2 阶段：LLM 合并，默认关**（`curator.md`「Consolidation is opt-in」；`agent/curator.py:145`）。开启后 fork 一个 agent 跑 `CURATOR_REVIEW_PROMPT`（`agent/curator.py:289`），一次全量 sweep 通常 **50–100 次 API 调用**，走 `auxiliary.curator` 槽（可指到便宜模型）。
  提示词的要点：**这是建伞的 pass，不是查重 pass**（「查重」被明确否定：判据不是「两两是否重叠」，而是「一个人会把它写成 N 个技能还是一个技能里的 N 个小节？」）；要给候选列表里的**前缀簇**（`hermes-config-*`、`gateway-*` 等，预期 10–25 簇）建伞并吸收；**放弃「每个技能触发不同」这个反理由**；**不许拿 use_count 当跳过合并或删除的理由**（「计数器很新、大多为 0，按内容判断」）；**合并 = 蒸馏**（吸收内容变成规则、同一课合成一条、丢掉事件叙述），把文件原样挪到 `references/` 只是**归档**不是合并；有 `references/templates/scripts/assets` 或相对链接的技能必须**整包**处理（要么保持独立、要么重挂支持文件并改写路径、要么整包原样归档），不许只把 SKILL.md 拍平进别人的 references。
- **安全网**：`hermes curator backup|rollback`（技能目录快照）、每技能 `pin/unpin`、`adopt`（把非托管技能交给 curator）、`dry-run`（**同样的报告、零改动**）、per-mutation `ledger`（含 rollback 某条 ledger 记录），以及 `agent/curator.py:17` 的不变量声明：「only curator-managed skills are touched; never delete, only archive; pinned skills bypass all auto-transitions; the fork uses the auxiliary client and **never touches the main session's prompt cache**」。

## 5. 两个辅助入口

- **`/learn`**（`website/docs/user-guide/features/skills.md:140-190`）：把「你已经知道的东西或一堆参考资料」变成技能，**没有独立的摄取引擎**——它只是把一段标准化的提示词当普通回合并交给 agent，由 agent 用它已有的工具去读，最后用 `skill_manage` 落盘（因此写审批门照样生效）。大来源（书、论文堆、规范、大文档目录）会变成**知识库技能**：精简 SKILL.md（核心心智模型 + 索引）+ 按章/主题蒸馏的 `references/` 文件，**按需**载入；同主题再跑一次会**折进已有技能**而不是造重复；蒸馏只合成结构（框架、定义、决策规则、反模式），**绝不复制原文段落**。
- **learning graph**（`agent/learning_graph.py:1-8`）：把「学到的东西」做成可见图——非基础技能（agent 创建或用过的）+ `MEMORY.md`/`USER.md` 片段作为一等内容；技能间的边来自声明的 `related_skills`，memory→skill 的边由**词面重叠**推导。这一块是给人看的，不参与自学习逻辑。

---

## 6. 迁移到 Graph 的可行性评估

### 6.1 对照表

| Hermes 机制 | Graph 现状（已核对源码/现场） | 差距性质 | 迁移成本 |
|---|---|---|---|
| 技能目录 + 标准 front-matter | **已有**：SDK 原生加载器；agent 目录 `~/.graph/agents/<recipe>/skills`（配方绑定的技能 symlink 镜像）+ **项目级免绑定** `<cwd>/.agents/skills`、`<cwd>/.pi/skills`、`~/.agents/skills` | 无 | — |
| 技能与 agent 的绑定 | **已有**：recipe `resources[role=skill]` + 定义版本（今天刚把 skill-creator 绑进 main@16） | 无 | — |
| `skill_manage` 工具（含 linter/守卫） | **无**：agent 直接用 `write`/`edit` 写 SKILL.md，没有形态校验、没有读后写守卫、没有 pin | 缺一层工具与守卫 | 中 |
| 每回合 background review（主动沉淀） | **无**：Graph 靠「主 Agent 的 identity 指令 + 我人工沉淀」与图的回合制 | **缺核心机制** | 中～大 |
| usage 遥测（什么被读过/用过） | **已有底座**：`tool_calls` 表 + worker 车道 spool（`<stateDir>/tool-calls/*.jsonl`）；技能读取本身还没被归因 | 派生即可，几乎零埋点 | 小 |
| provenance（自建 vs 用户/导入） | **已有雏形**：`capability.json` 的 `tags`（如 `imported`）、`agent-skills.ts` 的 owned roots（能区分 Graph 自己建的 link 与手放的） | 补一个显式 `created_by` 标记即可 | 小 |
| staleness/归档 | **无**（也不需要照搬，见 6.3） | 视需要 | 小～中 |
| LLM 合并（伞化） | **无** | 视需要 | 中 |
| 写审批门（暂存 + 审） | **已有机制可复用**：等待使用者确认的问题（`kind='waiting'` + `requestType='user_decision'`）、`ask_user`、完全访问开关 | 复用，不必新造 | 小～中 |
| 快照/回滚/账本 | **已有更强的东西**：项目技能天然在 git 里（可 PR、可过门禁）；制品库（不可变版本 + digest）；`apply_rsi_change` 的提交与门禁 | 无 | — |
| 走便宜模型的辅助槽 | **已有**：模型分级（low/medium/high）+ 节点预算 + `set_budget`/pause/steer | 无 | — |

### 6.2 关键判断

1. **最值得迁移的是机制 3（每回合后的自省 pass），而不是机制 4（curator）**。Graph 的技能库是**按配方显式引用 + 版本钉住**的，不会像 Hermes 那样被 agent 无界写入而膨胀——所以「防腐烂」的确定性 prune 在 Graph 里解决的不是真问题。反过来，「主动沉淀」在 Graph 里目前**完全靠主 Agent 的自觉**，这才是缺口。
2. **Graph 有一个 Hermes 没有的更好落点：项目技能在 git 里**。Hermes 的自建技能落在 `~/.hermes/skills/`（库外、无版本、只能靠 ledger/快照回滚）；Graph 的 `<project>/.agents/skills` 可随代码走 PR、过快门、可 review、可回滚——**「沉淀」的产物天然可审计**。因此 Graph 的默认去处应当是项目技能，跨项目复用的再晋升到能力库（补 `capability.json`）。
3. **不能照搬「无人值守直接写」**。Hermes 的理由是「有人看着就不叫后台」；但 Graph 有更便宜的表达：自省 pass 产出的可以是**一个待确认的写入提案**（复用现有 waiting question / 草稿机制），或**一个显式的图节点**（低成本模型 + 预算 + 受限工具面），而不是一个隐形的 fork。后者还有个额外好处：**它出现在图里、可观测、可暂停、可计费**，而不是每回合悄悄烧 30K tokens。
4. **Hermes 提示词里那两块「什么算课 / 什么不该沉淀」是可直接借用的资产**（`_LESSON_LAYER_BLOCK`、`_DO_NOT_CAPTURE_BLOCK`）。它们治的是同一个病：模型把**一次性的失败、环境问题、对工具的负面断言**写成「经验」，日后又拿它当理由拒绝工作。这一块的价值与实现语言无关，几乎可以逐条翻译成 Graph 的规则/技能写作契约。
5. **触发与节流必须比 Hermes 更保守**：Hermes 的 10 次工具迭代 / 30K tokens 是按「人机对话回合」计的；Graph 的回合更重、更贵（多 Agent、多节点）。更合适的触发是**操作级**（一次操作/任务收尾）或**空闲级**，且默认走低成本模型 + 预算上限。

### 6.3 Graph 侧不建议照搬的部分（附理由）

- **curator 的确定性 prune（14/30 天归档）**：Graph 的库技能由配方显式引用，不存在「几十个窄技能污染目录」的成因；照搬会带来**误伤风险**（把低频但关键的技能归档掉），而收益接近零。
- **LLM 合并成伞**：Graph 的 `main`/`coder`/`reviewer` 各自只绑少量技能，簇化压力小；且合并是**破坏结构化改动**，Hermes 自己也把它默认关掉、还配了 dry-run/backup/ledger 三重安全网。要做也应当排在 P1–P3 之后。
- **`~/.hermes/skills/.usage.json` 这种侧写遥测**：Graph 已有 append-only 遥测表 + 读取时剪枝，直接复用比再引入一个侧写文件更一致。

### 6.4 建议的最小迁移路径（分阶段，供取舍）

| 阶段 | 内容 | 成本 | 风险 |
|---|---|---|---|
| **P1** | **技能写作契约可检查**：把一个好技能的形状写成契约（front-matter、描述含触发条件且 ≤60 字符级、正文长度上限、references 按主题而非按会话、禁止事件叙述），落成一个 advisory 的 `skills:lint`（像 Hermes 一样只警告不阻断），并写进文档 | 小 | 低（不改运行时） |
| **P2** | **读侧遥测**：从已有 `tool_calls` 派生「哪些技能被读过/被用过、多久没被读」（技能读取就是 `read` 到 skills 路径），零新埋点 | 小 | 低 |
| **P3** | **主动沉淀通道**：设计并落地一个「收尾自省」——推荐形态是**显式节点/操作后钩子 + 低成本模型 + 受限工具面 + 预算**，产出先落成**提案**（复用 waiting question 或在项目技能目录里直接写、靠 git 审计），提示词直接借用 §3 的 lesson-layer / do-not-capture 两块 | 中 | 中（token 成本、误写；靠预算 + 提案/审批 + git 回退兜住） |
| **P4** | **晋升路径**：项目技能 → 能力库（补 `capability.json` + 配方绑定）的命令或按钮；顺带把 provenance 标记落成显式字段 | 中 | 低 |
| **P5** | **（可选）curation**：先只做「项目技能去重/合并建议」，确定性 prune 与伞化合并放在最后，且必须配 dry-run + 快照 | 中～大 | 中高 |

**总判断：迁移可行，但「Hermes 怎么做」只有一半能直接用。** 直接可用的是：写入侧的**形态契约与守卫设计**、主动沉淀的**提示词资产**、以及「同一个课只说一次 / 不沉淀环境问题与负面断言」这些判断规则。需要**按 Graph 的形状重写**的是：触发与节流（操作/空闲级，而非每对话回合）、产出去处（项目 git 技能优先）、以及「隐形 fork」到「显式节点 + 提案/审批」的形态转换——而这三处恰恰是 Graph 比 Hermes 更有条件做好的地方（图、预算、暂停、遥测、git 门禁都已具备）。

## 引用清单

- `agent/background_review.py`（模块 docstring `:1-6`；`_SKILL_REVIEW_PROMPT` `:417`；`_LESSON_LAYER_BLOCK` / `_DO_NOT_CAPTURE_BLOCK`；工具白名单 `:1078`；fork 继承与缓存命中 `:960`；fork 自身 nudge 归零 `:990`）
- `agent/turn_finalizer.py:716-741`（触发判据；30K tokens/事件 的注释）
- `agent/agent_init.py:1291,1315,1369-1371`（nudge interval 默认 10，可配）
- `agent/review_idle_queue.py:160`（空闲补跑）
- `agent/curator.py`（模块 docstring `:1-8`；常量 `:33-37`；触发与门 `:160-178`、`:1170`；`apply_automatic_transitions` `:208`；`CURATOR_REVIEW_PROMPT` `:289`；`_consolidation_pass` `:880`；`run_curator_review` `:914`）
- `agent/learning_graph.py:1-8`
- `tools/skill_manager_tool.py`（模块 docstring `:1-8`）
- `tools/skill_manager_guards.py`（读后写 `:220`；pin `:143`；合并删除 fail-closed `:241`）
- `tools/skill_provenance.py`（全文）
- `tools/skill_usage.py:1-40`（遥测与 provenance 原则）
- `tools/skills_tool.py:234,573,700-752`（`skills_list` / `skill_view`）
- `tools/skill_linter.py`（三条形态规则）
- `agent/skill_utils.py:761-778`（描述 60 字符截断）
- `website/docs/user-guide/features/skills.md:140-190,610-700`
- `website/docs/user-guide/features/curator.md`（全文要点）
