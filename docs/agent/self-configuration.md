<!-- graph:allow-large-file: 它的 22 KB 早于预算；本次只替换「未提交改动」那一段，拆分是单独的编辑工作 -->
# Graph Self Configuration

> **2026-11-08: Graph 不再有权限分级。** 标准/完全访问这一对已被删除：后端只有一种姿态（host 读、host 写、不受限网络、host 命令、apple events 开启），`access` 配置字段不再读取，控制台也不再提供切换。本文其余内容描述的是删除前存在的标准模式，仅作历史记录保留。

## 目标

Graph 把 Agent 可编辑上下文集中到固定目录：

```text
~/.graph/prompts/
  agents/
  tools/
  rules/
  runtime/
  defaults/
  tools.json
```

首次启动播种默认文件，之后不覆盖用户修改。用户可以通过聊天头部查看最终拼装结果、编辑来源文件、开关工具，或恢复某个文件的原始默认版本。Graph 自身文档不在这里，而是作为只读源码保存在仓库的 `docs/agent/`，并随应用一起打包。

聊天头部「Agent 上下文」抽屉里的 **实际发出** 标签展示的是**某一次真实模型请求**，而不是预览：提示词文本取自该请求的系统消息，工具声明取自同一个请求体的 `tools` 字段，两者都在 provider 调用点（`backend/internal/graph/runtime_controlled_openai.go` 的 fetch 包装器）写入 `operations.system_prompt` / `operations.tool_declarations`。它们是只读展示，不参与发送，也不会使模型多收一份声明。会话里没有真正发过请求（或该请求早于记录功能）时，该标签会明确说「尚未记录到」，而不会拿预览顶替。

`defaults/` 保存用户点击「设为默认」后的基线。该动作同时保存当前内容；空文件也是合法默认值。后续「恢复默认」优先回到用户默认，未设置用户默认时才回到代码内置原版；存在自定义默认时，「恢复内置」会清除该文件并回到代码原版。

**生效层与仓库种子的区别**：`agents/*.md`、`rules/*.md` 等 editable 文件一旦存在于 `~/.graph/prompts/`，就**整份覆盖**代码内置的默认文本（`backend/internal/graph/runtime_agent_context_assembly.go` 的 `input.library?.prompt(...) ?? DEFAULT_*`）。所以仓库里只有一份很短的种子：在仓库里 grep 规则编号（例如 `R18`）会一无所获，但这并不代表规则没有生效。判断一条规则是否真的生效，要看 `~/.graph/prompts/rules/<role>.md` 的实际内容（或聊天头部「Agent 上下文」的最终拼装视图），改规则也应该改那里。

## 全 Agent 测试编写规则

main、工作节点、审查节点和辅助 Agent 只能新增或改写真实 E2E 测试，禁止编写单元测试和集成测试。E2E 驱动真实浏览器、HTTP、CLI 或公开应用运行时，验证完整业务流程与真实持久化；只能替代外部服务。已有测试可运行和审计，必要契约迁入真实 E2E 后才能退休，不能靠改名或伪造回执满足规则。无法执行时报告具体环境阻碍。

该规则由宿主在实际发送前加入，编辑身份、rules/common.md、角色规则或自定义配方均不能移除它；与这些来源冲突时以宿主规则为准。旧内置默认规则会迁到新默认，自定义内容仍保留。辅助建议与技能沉淀请求同样携带该规则。正在运行的旧请求不会被追溯改写；更新运行中的 Graph 后，从下一次实际请求生效。

## 结构化 Composer

Graph 自己组装最终 system prompt，顺序为：

```text
identity -> tools -> rules -> docs -> project_context -> capabilities -> cwd
```

Pi 在 0.85.1 中还会自动追加 `Current working directory`。UI 必须把这段标成 Pi-generated，不把它和 Graph 可编辑文件混在一起。

## 可编辑、生成和 Pi 内容

- **editable**：用户维护的 identity、tool guidance、rules 和 runtime prompt 文件。
- **generated**：从当前 definition、实际工具、capability load facts、项目 instructions、worktree 和源码 docs 路径拼出的内容。
- **pi**：Pi 自身自动追加的 system prompt 内容，例如 cwd。

用户编辑 editable 文本不能改变 generated 事实，也不能改变 host-enforced authority。
Docs section 由源码 `docs/agent/README.md`、topic 索引和阅读协议动态生成；docs 正文不进入可编辑来源列表。

`<tools>` section 先列 Pi 原生 coding tools，再以过渡段引出 Graph tools。工具清单只保留名称与简短说明；参数、版本、权限摘要和运行时可用性保留在 UI 工具详情中。

`tools/main.md` 默认留空，不再附加内置的 capability-awareness 长说明；用户添加内容后才会出现在工具清单之后。

## 工具选择

Main Agent 的工具选择保存为 disabled list。关闭工具时：

- provider tool schema 不再提供该工具；
- Agent session allowlist 不再启用；
- system prompt 的 tools/capabilities section 同步更新。

Pi 原生工具 `read/bash/edit/write/ls/find/grep` 以及 Windows 上的 `powershell` 同样可以被 disabled list 关闭，但不能通过 Prompt 绕过它们对应的 host/sandbox 权限。
首次启动时 `powershell` 默认关闭；在支持的 Windows 平台上，用户可以在工具选择中显式开启。

工具详情应显示来源、版本、参数、权限摘要和当前可用性。UI 不伪造实际 tool surface；如果需要 operation 运行后才能确认的动态工具，应明确显示 unknown 或 unavailable。

## 系统变更

直接编辑可编辑 prompt 文件是用户配置行为。安装、更新或替换 capability 属于系统变更：

1. 用户或 Main Agent 明确写出提案（problem / change / impact / risk）；
2. 用户批准；
3. Host 重新扫描并验证。

`propose_system_change` 与 `apply_system_change` 两个工具已于 2026-11-07 删除；系统变更改由控制台设置页与 RSI 提交完成，不再经过模型工具。

完全访问模式会自动批准运行授权，但仍应保留提案、应用验证和审计记录。暂停、预算、未知用量和恢复问题不阻塞调用；并发上限、人工验收、模型订阅决策和任务图确认仍独立。

## Harness 自我改进（RSI）

在完全访问模式下，Main Agent 同时是 Graph Harness 的改进者。RSI 不限于修 bug：只要它能给出理由，修缺陷、重构、新增功能、改进命令或文档都可以改。它用 `inspect_rsi_status` 读取源码 checkout、当前分支、待重载请求、仍在运行的 operation 及其身份（task/node/request/archived），再用 `apply_rsi_change` 提交一次结构化改动：

- 修改 Graph 源码 checkout 内的文件（`write` / `replace` / `copy` / `delete`）；`write` 的正文可以内联，也可以用 `fromPath` 取自 checkout 里你已经写好、跑过的那个文件（不再重贴一遍）。`.git` 与路径逃逸被拒绝；不属于这次改动的未提交文件仍然阻塞（见下）；
- 运行检查（自定义 `node` 检查、`node --run check`，`activate` 时再加 `node --run app:build`）；
- 提交到专用 `rsi/*` 分支；
- `activate` 为真时写出 `<stateDir>/rsi/restart.json`，由桌面进程在 operation 停稳后重启 daemon 让改动生效；`force` 为真时跳过等待、立即重载，可能中断在途 operation。

调用形状是固定的（写错会白跑一个来回，报错会点名缺哪个字段）：`title`、`problem`、`changes`、`checks` 都是**顶层**字段；`changes[]` 的每个条目必须带 `path`（仓储相对路径）与 `action`（`write` / `replace` / `delete`），`write` 配 `content` 或 `fromPath`、`replace` 配 `edits` 或 `fromPath`；`checks` 里每项是 `{ command, args }`，也放顶层，不要塞进单个 change 里。SDK 的校验**一次列全部问题**（每行一条，并回显收到的参数），所以两处错误会同时出现，不必改一条试一次。改动里的多个 `edits` 也一样：所有匹配不上的锚点（`found 0` / `found 2`）在同一条报错里列出，改一次就能重发，而不是一次只发现一个。嵌套写错的那种会另行点名（`changes[0] is one file change… "checks" belongs at the top level of the call - it is nested one level too deep.`），因为 schema 只能描述结果、说不出原因。

**别人未提交的改动不会挡住你的提交，也不会被吞进去**：共用 checkout 里另有一路未提交的文件时，`apply_rsi_change` 在 HEAD 上开一个只带本次声明路径的临时 worktree，把改动写进去、在那里跑检查、在那里提交；随后只把当前分支移到那个提交（并刷新索引），**其余文件一个字节都不动、依旧未提交**。所以检查证明的仍然是提交里的东西，而你不必为别人的工作等它先提交。这条路径不可用时（比如未能在 HEAD 上建 worktree）才回落成拒绝，消息依旧是 `Uncommitted changes outside this RSI change`。**这次改动自己要写的路径**：你用自己的工具把文件落盘、跑通，再用 `{path, action: "write", fromPath: "<同一个文件>"}` 命名它，提交的就是磁盘上的那些字节，收据会在「其中提交前已在工作区」里点名。

检查必须能证明它声称的东西：`node --run check` 同时跑 typecheck 与全部测试，是「快检」的下限。只拿单文件 vitest 当检查会漏掉类型错误（实际漏过两次：一次 TDZ、一次忘了提拔 `SCHEMA_VERSION`），所以快检至少写成 `node --run typecheck && node node_modules/vitest/vitest.mjs run <files>`，或者直接用 `node --run check`。

检查失败不会丢弃改动：文件保留在工作区、不提交、不重载，receipt 状态为 `checks_failed`。Main Agent 继续修复同一批文件，或传 `changes: []` 只重跑检查，直到通过；只有意外错误才恢复快照，且回滚会**连索引一起复位**（否则一次混合 `git add -A` 留下的已暂存条目会被下一次尝试当成别人的未提交改动而拒绝运行）。每次 RSI 操作都会写 `rsi.change` 事件，并在 conversation 中追加 `kind=rsi` 的可见报告，包含问题、证据、诊断、影响、风险、文件、验证、提交和重载状态。

**演练（`dryRun`）**：`dryRun: true` 把改动写进工作区、跑同一套检查，然后把工作区恢复到调用前——不提交、不建分支、不重载，收据状态是 `dry_run`，控制台显示「演练通过 / 演练未通过」并写明「没有提交，也不会重载」。它用同一套校验（给了 `checks` 就只跑它，没给就是 `node --run check`），回答的是「这次改动过不过得了门禁」；`dryRun` 隐含 `activate: false`，把 `activate` 写成真也不会生效。要真正交付就去掉 `dryRun` 再来一次（配合 `fromPath` 不必重贴正文）。

`status=applied` 表示提交完成。`activate=true` 成功后，工具会结束当前回合，`activation.state=pending_reload` 表示等待重载；不要继续调用工具、追加 RSI 改动或报告“已生效”。已有 operation 结束前，新消息保持排队。宿主确认新 daemon 的提交与请求匹配后，报告更新为 `activation.state=active`，`inspect_rsi_status.lastActivation` 返回该次确认，主管会自动恢复原请求，无需用户发送 continue 或“已重载”；排队的新消息在同一轮优先处理。暂停时延后续跑，归档或终止时不自动唤醒。需要先做多个中间提交时使用 `activate=false`（状态 `saved`），最后再请求激活。

RSI 只改"正在运行的这份代码"，所以：

- 在 checkout 里运行（`electron .` 或 CLI）：应用根就是 checkout，默认可用。
- 打包应用：`Graph.app/Contents/Resources/app` 是构建时复制出来的副本，不是 Git 仓库，默认不可用。把 `GRAPH_RSI_ROOT` 指向一个 checkout，启动器会改从该 checkout 运行 daemon，RSI 才会真正生效。
- 不可用时 `inspect_rsi_status` 仍返回 `available: false` 与原因，`apply_rsi_change` 不注册。

### Harness 探针：比较同一任务的多个候选

当一张图里同一任务有多个候选（多个节点、不同的 Agent 定义或配方），宿主可以给出**匿名行为对比**：

- `compare_harness_candidates`：读每个候选实际做了什么（提交了什么、调用了哪些工具、工具是否失败、
  花了多少 token、耗时多久、最终答复），给出与基线的差异，并把候选匿名成 A、B、C。
  匿名是刻意的：能看到"哪条车道产出了哪个答案"就会按车道选，而不是按答案选。
  传 `domain` 会同时带回该领域已采纳的经验。
- `record_harness_decision`：记录采纳了哪个候选，以及这条教训的**线索、做法与依据**。
  三者缺一不可——没有依据的教训会教坏下一个任务。记录会被提升到项目作用域。
  `axis` 决定这条教训**能走多远**：`general` 表示它对任何一类工作都成立（于是每个领域都能读到它），
  `specific` 表示它只在这个领域成立。不写默认 `specific`——跨领域的分量要靠证据去claim，不能顺手写。
- `record_harness_friction`：记录**还没解决的摩擦**——卡住的一次、误导了一次、浪费的一趟。
  它和已采纳的教训住在**同一个库**里，是同一条知识的两个阶段：这条是**遇到的摩擦**，那条是**采纳的做法**。
  摩擦只是怀疑，**不会**进后续任务的 prompt；只有已采纳的教训会。
  同一个 cue 再记一次并给 `status: fixed` 与 `ref`（比如修它的那个 commit），就是把它关掉。
- **cue 是记录的身份**：一个 scope 里一个 cue 只有一条记录，再记一次是把它往前推，不是新增一条。
  所以你后来想清楚了做法，用**同一个 cue** 记一条教训，那条摩擦就**成为**这条教训——
  摩擦的来由留在记录里，读的人看得到整件事，而不是两条对不上的记录。
- `read_harness_experience`：读某领域该知道的全部：它自己的条目 + 普遍适用的那些，
  **一份列表**，每条自带 `axis` 与 `status`（open / fixed / adopted / rejected）说明它现在信不信；
  列表里还包括旧约定那份 `harness-backlog` 制品的条目——那是这个项目的摩擦史，
  它们**不是**教训，永远不进 prompt；不带领域则列出有哪些 scope。

对比只给事实，不给判决：选谁由你决定，因为这类任务通常没有标准答案可比。
判决之后记得用 `record_harness_decision` 沉淀，否则下一个同领域任务仍然从零开始。

### 真实模型评测

改了 harness 之后，除了门禁（`node --run check` 里的 `check:harness`），
还可以让**真模型**把冻结用例重跑一遍：

```sh
node --run eval:harness                        # 用 ~/.graph 那套真在跑的面
node --run eval:harness -- --cases parser,cli  # 只跑其中几个用例
```

它会冻结你现在的 harness 面（提示、配方、能力），用 config 里的模型把冻结用例跑完，
判决记进 `~/.graph/harness-eval-verdicts.json`，报告落在 `~/.graph/harness-eval-report.json`。
账本记着每个用例上次的判决，所以它会直接说**哪个用例回归了**。

报告是证据：读完之后用 `record_harness_decision` 把结论留下来（cue 写清楚"什么情况"，
lesson 写"这次改动该怎么做"，evidence 写报告里的那句判决），
下一个探针就能从这条教训起跑。

真模型要凭据（config 里 `secretRef` 指的环境变量得在你的环境里），所以它不在
`node --run check` 里：门禁那一层用替身模型，判"活儿还能不能干完"；
这一层用真模型，判"提示还管不管用"。两层的分工是这样。

### 领域与接续

- `declare_harness_domain {domain}`：告诉宿主**这个项目是做什么的**（parser、billing、code review…）。
  领域是**项目级**的：一个项目干的活不会因为换了个会话就变样。声明之后，
  项目里后续每个任务开工时，都会带上**该领域**的教训与普遍适用的教训。
- 探针可以**接续**：给 `probe_harness` 传 `baseHarness: "adopted"`，
  每个候选都从**这个项目已经采纳的 harness** 起跑，你自己的变体叠在上面。
  这样每一轮是在**上一轮的赢家**上试一个改动，而不是每次都从头手写覆盖。
  比较里会报出每个候选**实际跑的 harness**（合并后的），所以"哪一处改动造成了差异"看得见。

### 通用教训已经在场

上一轮写下的**通用**教训（`axis: "general"`）与**该项目领域**的教训，会直接出现在后续任务的 system prompt 里，
宿主自动注入，**不需要你记得去读**。它以一段 `Lessons earlier runs of this project learned`
出现，每条一行：什么情况 → 怎么办 → 依据是什么。

- 它只增加上下文，不改权限、闸门、预算。
- 它只说"发生过什么、依据是什么"，不说"你必须怎么做"——结论仍然是你的判断。
- 通用教训会这样进来。**领域教训**只有在项目声明了自己的领域（`declare_harness_domain`）时才会跟着进来；
  没声明的领域教训留在它自己的领域里，由 `read_harness_experience` 读。

所以：通用轴的价值不是"多记一条笔记"，而是"下一个任务开工前就已经带着它"。
摩擦与教训同库，是为了让"我遇到过什么"和"我最后怎么做"不再分散在两个地方——
一份知识，两个阶段，只有第二阶段会进 prompt。

### harness 改动的行为门禁

改了提示、工具或装配，`node --run check` 会自动把四个冻结用例重跑一遍：
`parser`、`cli`、`persistence`、`command`——每个都有独立的 verify 脚本，只看结果、不看 Agent 说了什么。
跑用例的是一个**只按 harness 行事**的替身模型：它做每一步之前先看 harness 还给不给这个工具、
还告诉不告诉它该怎么用；不给就停下来说明原因。

所以门禁红的时候，多半是 harness 少了什么，而不是用例坏了。它会指名说：

```
the agent said: I cannot continue: the harness no longer says "Use edit for precise changes".
```

判决记在 `tests/harness-surface.json`：被判过的 harness 面（逐文件 sha256）与每个用例的判决。
面变了又变红，就是**回归**。

这份记录**不会在检查时被自动重写**：门禁每次都会跑，而一个检查顺手改动被跟踪的文件，会让“检查”本身弄脏工作区——RSI 提交会因为工作区不干净而拒收，人就卡在这里。所以记录是一件刻意的事：面变了就自己刷一次，然后当普通提交入库。

```sh
GRAPH_HARNESS_GATE_RECORD=1 node --run check:harness
```

门禁判的是仓库里的出厂面——你自己的 `~/.graph/prompts` 不在仓库里，所以门禁只报告它。
要判自己那一套，先冻结一份上下文再指给门禁：

```sh
node scripts/harness-eval-context.mjs ~/.graph /tmp/my-harness-context
GRAPH_HARNESS_GATE_SNAPSHOT=/tmp/my-harness-context node --run check:harness
```

### 读自己的证据

RSI 要基于证据，而不是基于回忆。`read_harness_evidence` 把这次运行的证据读成一份摘要：

- 每个节点：走了多少步、调用了哪些工具、**哪些工具调用失败了**、最后的答复是什么；
- 这次运行里**被挡住或失败**的节点及原因；
- 当前挂着的内部问题（main 拥有的那部分）；
- 最近一次应用改动**检查跑得怎么样**；
- 这次运行花了多少请求、多少 token。

默认读自己的这次运行；`graphId` 读自己拥有的一张图，`nodeId` 只看一个节点，
`kind: "trajectory"` 按顺序读某个节点的每一步。摘要只给事实，不给判决：改什么仍然是你的判断。

改 harness 之前先读一次，改完行为不对时再读一次——这是"证据驱动"与"凭感觉改"的区别。

### 探针：同一个任务跑在几个 harness 下

`probe_harness` 让你不必自己建图派发就能做一次对照实验：

- 给一个 **task** 和 **两到六个变体**。每个变体有一个 label，和它要替换的提示文本
  （`rules/common.md`、`rules/worker.md`、`tools/worker.md`、`runtime/node.md`、`agents/<definition-id>.md`），
  可选地指定自己的 recipe 与 model。
- **一次提两个轴**：一个 `axis: "general"`（这条改动应当对任何一类工作都成立），
  一个 `axis: "specific"`（只对当前领域成立）。对比会告诉你哪一轴真的划算，
  而赢的那一轴决定这条教训将来能被谁读到。
- 宿主建一张内部图：每个变体一个节点，同一个任务，同一个输入，只有 harness 不同。
  它等所有候选停稳，然后把每个候选做了什么、差在哪里报回来——和 `compare_harness_candidates` 同一个形状。
- 候选仍然是匿名的：按它们产出的东西选，不要按哪条车道产的选。
- 变体的 recipe 必须是真实存在的 Agent 定义（`read_system_capabilities` 能列出）；写错的名字会在
  花掉任何 token 之前被拒绝。

想自己控制实验过程（更多节点、分阶段投递、留证据）时，仍然用 `graph_create` + `graph_send`，
再调 `compare_harness_candidates`。

## 何时不建图任务（R20）
单点的产品行为、默认值或文案调整（不需要并行车道、独立审查闸门与人工验收闭环）由 Main Agent 用 `apply_rsi_change` 亲力亲为：一次提交 + 宿主完整门禁 + 重载 + 现场自验（真浏览器读 DOM + 截图）+ 交人工验收即可，**不建图任务、也不留待确认的草稿**。只有需要多车道并行、独立审查与人工验收闭环的较大改动才建图。这类改动的草稿若已被取代，用 `withdraw_draft` 作废它，不要挂着误导后续回合。

## 原版恢复

Graph 在代码/preset 中保留每个可编辑 prompt 文件的原始版本。`defaults/` 只保存用户明确设为默认的内容；恢复默认只覆盖对应可编辑文件，不修改能力缓存、用户工具清单或项目文件。只读 Agent docs 直接来自源码，不存在需要恢复的用户覆盖版本。

## Runtime Prompt 注入时机

- `runtime/worker.md`：每次非 Main Agent operation 组装 system prompt 时，注入 `<rules>` 的 runtime 部分。
- `runtime/prompt-suggestion.md`：Main Agent 完成回复后，为下一条输入建议启动独立模型请求时作为该请求的 system prompt。
- `runtime/main-conversation.md`、`runtime/main-graph.md`：早期 Main Agent 工作流文本，当前版本不注入任何 system prompt，仅保留编辑和迁移用途。

## 不应宣称

- 不能宣称 prompt 文件就是权限。
- 不能宣称关闭工具就卸载了 extension 的全部 hook。
- 不能宣称生成内容可以由用户直接编辑。
- 不能把未读取的 docs 内容当成当前事实。
