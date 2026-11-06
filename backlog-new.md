<!-- graph:allow-large-file: 这是待办清单，删条目不改变它跨多个主题的目的；拆分等于制造两处待办 -->
# Graph harness backlog

RSI 的输入清单：一行一项，带状态（open / fixed@<commit> / rejected / deferred）与证据。项目级可见。本版取代 `@144`。

---

## ▶ 跨会话交互工具（使用者提问 → 定权限 → 交付并现场验收）

**缺口（使用者的提问）**：产品有全套会话通路（`/api/conversations*`：list/create/messages/steer/pause/resume/archive/events+SSE），但 master 的 36 个工具里**一个都不涉及别的会话**——`control_task`/`get_task_status`/`get_graph_state` 全是本会话，`ask_user` 是问人。我此前那些「观察跑」的会话就是 `run_command` + curl 打的：**通路在，身份不在**（无类型、不过政策、不进遥测、UI 看不见，而且 curl 发的消息在目标会话里长得就像使用者说的）。

**使用者定的权限：任何项目、任何会话，完全访问即放行**（选项 b）。交付形状（沿用「深模块 + 少工具」）：

| 部件 | 内容 |
|---|---|
| 深模块 | `src/runtime/conversation-tools.ts`：`conversationWriteRefusal`（**只剩两道**：必须完全访问、不能给自己发）、`agentMessageText`（署名文案）、`openConversationTools`（每次写入都记一条 `conversation.handed_off` 到调用方转录） |
| 两个工具 | `conversation_read`（list / read / follow，`follow` 用 `after` 游标继续）与 `conversation_write`（send / steer / pause / resume，都带 `requestId` 幂等） |
| 署名 | 消息文本首行写明「来自另一个 Agent（会话 …/节点 …）」，同时写进 `messages.data.source = {kind:'agent', conversationId, nodeId, taskId, chain}`——**目标模型与账本都能看出这不是使用者** |
| 护栏（**使用者 9/26 决定取消两条**） | 保留：必须完全访问；不能给自己发；署名（绝不冒充使用者）。**取消**：转发链不得回流、单次操作上限 4 条 |
| 接线 | pi-adapter 在 master 回合里开通道（caller=本会话/任务/节点，hostWrite=完全访问，`onHandoff` 记 `conversation.handed_off` 事件）；task-runtime 以 thunk 挂 `channels.conversations` |
| 提交 | 模块 `139ef977`、接线 `2414ff9f`、预览一致 + E2E 竞态 `bd4665bb`、同族浏览器竞态 `48800a5f` |

**现场验收（本轮真跑，不是装置）**：
1. 建靶场会话 `28ed4d56…`；用 `conversation_read list` 列会话 ✓；用 `conversation_write send` 发一条 ✓；
2. 事件 `conversation.handed_off` 落库（caller `193ce3e1…` / target `28ed4d56…` / action send）✓；
3. 目标消息 `b2944a9d…`：`seq 32202`、`state: delivered`、`turn 2`，文本带署名、`data.source.chain = ["193ce3e1…","28ed4d56…"]` ✓；
4. 靶场会话**第二轮** operation `400f43eb` 跑完 `succeeded`，它的回复说明它读到了我方会话与这条消息；而且它**自己主动调用了两次 `conversation_read`**（新工具对别的会话同样可用）✓。

**自由通信（使用者决定，fixed@0cd0f9b6）**：使用者原话——「agents 之间应该自由的通信，这些限制也没有真的起到什么作用，所以取消这两个限制」。我的判断与它一致，两点都成立：① 两条规则**在一次现场都没触发过**；② 回流链那条**禁止了一个正常行为**（B 回话给 A 被判为「回流」），代价是每次写多读一次对方转录。改动：`conversationWriteRefusal` 只剩「必须完全访问」与「不能给自己发」；`source` 只记**直接发送者**（血缘仍可从 `conversation.handed_off` 事件重建）；写入不再多读一次转录；工具描述同步改口（界面文案 ≠ 实际能力是不允许的）。**现场验证**：让靶场会话 `28ed4d56…` 回信给我的会话——23:51:43 出现 `conversation.handed_off`（caller = 靶场、target = 我的会话），消息落到我这条会话（署名 + `source.kind = agent`）✓ —— **这正是旧规则会拦截的方向**（我方消息链里含 target）。保留的两条规则 + 署名已在同一现场复用：写入仍要完全访问、署名让目标模型与账本都看得出「来自另一个 Agent」。**往返完整**：那条回信随后**作为一轮用户消息驱动了我的会话**（它在我会话里是 `seq 32290`、`state: queued`，之后成为新回合的用户消息）——旧规则下它在发送侧就被拦，根本到不了。

**HB-127（harness，fixed@4a69123b）`read` 默认给的是「最早的 N 条」**：现场读靶场会话时返回 seq 32183–32199，而我刚发的那条（32202）不在其中。根因是我总传 `after: 0`，而服务的 `after` 分支就是「从最早开始」。改为**只在游标 >0 时传 after**：无游标 = 最新窗口。**现场复验**：用 `conversation_read read` 读本会话转录，返回窗口从 `seq 32198`（turn 452）到最新 ✓。

**新工具的大输出懒加载（本轮补上）**：`conversation_read` 一次读的是**一整个会话**（含工具行），可能一次就把提示词灌满。所以给它加了**首视图上限** `CONVERSATION_READ_LIMIT = 8_000`（与 `bash` 的 `SHELL_OUTPUT_LIMIT`、系统清单的 `SYSTEM_SUMMARY_LIMIT` 同一张表），超出即给「摘要 + handle 路径」。**现场复验**：`conversation_read read` 读本会话自己的转录（**218,978 字符**）时，我收到的正是上限摘要 + `…/instances/<id>/tool-results/7334dea2c5ce9436.txt` 的 handle ✓。

---

## ▶ HB-120 收口：激活回合也评审（材料是变更本身）+ HB-112 门禁预算

**HB-120（为什么这是缺口）**：`apply_rsi_change(activate:true)` 的回合从 RSI 收据处**早返回**（`pi-adapter` 旧 1058 行），跳过建议与评审块；而这类回合恰恰做了最多真实工作，并且**没有 assistant 回复**（应用之后不再叫模型，见 `tests/console/rsi-reload.test.ts` 的「Any further provider request after the activation recreates the observed self-blocking loop」）。所以修法不是简单地把返回挪后：必须先把「本回合的材料」从收据解耦。

- 实现：`rsi.ts` 新增 `rsiChangeMaterial(receipt, reply)`（标题 / 文件 / 验证 / `report`（含「为什么」）/ diff，截 6,000 字符，逐字段防御式读取），pi-adapter 把重载返回挪到建议与评审之后，评审载荷对激活回合用变更材料。`fixed@0f272d5e`；红测试 `tests/console/rsi-sediment.test.ts`（断言评审**被问到的内容**含变更标题/原因/文件名，而不是收据），`rsi-reload` 8 个用例仍全绿。
- **现场验证（两次）**：①上一回合就是这个路径——operation `c59acdb0` 的 `skill_sediment.reviewed`：`reviewed: true`、`toolCalls: 7`、材料 2056 字符；②它提出 `{"action":"update","id":"diagnosing-bugs"}`，被**结构性守卫**拒掉：`refused: ["skill 'diagnosing-bugs' was not written by us (no created-by: graph-agent); it is somebody else's text"]`、`written: []`，磁盘上该技能未被改（mtime 仍是 9/10）。即：激活回合现在会被评审，而评审**不会**动别人的技能。

**HB-112**：满负载全量门禁下 `tests/m8/app-shell-ux.test.ts > the composer suggestion and queue steering follow the three Enter states` 的 60s poll 偶发超时（失败日志 62,350ms、`expected +0 to be 1`；同一次门禁 112s、旁边跑着 174 个文件）。断言的真意来自它前面已断言的前置条件，秒级预算回答的是负载；poll 抬到 150s、外圈 net 240s → 420s，注释里的算式同步。`fixed@ce5bc59b`

**HB-126（harness，fixed@4a69123b）格式会把合法决定整份丢掉**：operation `411f4e93`（18:39）的回复 `replyChars: 4363`、`replyHead` 是**看着合法**的一行元数据，却记为 `proposed: null`。真因这轮定下了：旧解析取「第一个 `{` 到最后一个 `}`」——**正文里出现 `{"a":1}` 这种花括号就把元数据切歪了**。修法两处：① 改成**括号配平扫描**（字符串内的花括号算内容）取第一个完整 JSON 对象；② **无 fence 时，元数据行之后的正文就是 body**（未闭合 fence 仍不算正文——这条既有规则由既有测试守住，我第一版实现正是被它抓出来的）。证据：`sedimentReplyShape()`（`metadataLine` / `fence` / `chars` / `tail`）随每次评审写入 `skill_sediment.reviewed` 的 `replyShape`，下一次「不可读」自带形状。测试：单测（无 fence 正文 + 正文含花括号不遮元数据 + 旧形状仍可读）+ 端到端（无 fence 回复真的写出技能）。

**同族补充（HB-112 第二处，fixed@48800a5f）**：全量并行门禁（177 文件、112s）下 `app-shell-ux.test.ts > interrupted retry streams are removed before the durable final answer` 也会偶发——`waitFor()` 只保证元素出现，而文本与元素来自同一条流、稍后才应用，读到空串（`expected '' to contain '最终回答'`）。改为轮询内容。**同一文件的同一族问题本轮共两处，都只有「满载并跑」才暴露**：单跑永远绿。

---

## ▶ 本轮收口（HB-121 + HB-113，两项都由使用者指定，"先检测、不阻塞"）

- **HB-121（建议决定可见）**：`generatePromptSuggestion` 原先把一切塌成 `undefined`（provider 拒答与「模型没建议」是同一个外部事实）。现在返回 `PromptSuggestionReply {text, raw, stopReason, error}`（异常也带上真因），pi-adapter 每回合记 `prompt_suggestion.decided`：`model / asked / stopReason / error / chars / suggestion / replyHead`——与 `skill_sediment.reviewed` 同一套字段，两个「一次性副调用」第一次可以说同一种话。`fixed@e1abffce`；测试 `tests/m8/conversation-suggestion.test.ts`（两条：调用失败带真因、模型明确没建议则 `stopReason:"stop"` 且 `error:null`，都先红）。
- **HB-113（打包前报空间）**：新增 `src/runtime/disk-space.ts`（`MIN_FREE_BYTES=4 GiB`、`formatBytes`、`freeBytesAt`、`diskSpaceWarning`），`scripts/package-app.mjs` 在 **staging 拷贝之前**打印可用空间；不足时给出回收指引并**继续构建**（按使用者记录的选择：先检测、不阻塞）。**现场证据**：RSI 侧与本次应用线 `node --run app:build` 日志第 21 行都是 `packaging: 5.1 GiB free on the output volume (needs ~4.0 GiB)`，构建 exit 0；单元测试锁住「786 MiB 那次失败会被这条文案解释」与单位格式。`fixed@e1abffce`
- **HB-125（harness，rejected）「push 真因不可见」是我的误判**：那次 push 失败可见输出只剩测试摘要，我据此写了这条；查 `.githooks/pre-push` 后发现 hook **本来就**写了「pre-push gate failed; full log: …」「this failure kept at: …」并 tail 40 行，而且真的把失败日志另存为 `graph-pre-push-check.failed-20260926-183632.log`。真因是 **HB-112**（该日志：`app-shell-ux.test.ts > … three Enter states` 62,350ms 超时、`expected +0 to be 1`）。是**我只看了捕获输出的最后 3 行**。教训：命令失败时先读完整输出，再读它指向的日志文件——别把「我没看到」写成「没有」。：本轮第一次 `git push origin main` 失败，可见输出只剩门禁里 `check` 的测试摘要，最后才是 `error: failed to push some refs`——看不到是「门禁失败」还是「远端拒绝」。**同一条命令重跑即成功**（`3862b92..2df97a7`）。建议：抛错时把真因放最后一行，并显式区分门禁与远端。

---

## ▶ 技能沉淀与进化：P1–P4 全部交付（单点实现，不经任务图）+ 一个真缺陷收口

规格：`skill-sedimentation-spec-2026-09-26.md`（制品 `plans/skill-sedimentation-spec@1`）。使用者选定的 P3 形状：**操作收尾后的受限副调用**（不是图上的显式节点）。

| 阶段 | 内容 | 提交 | 验证 |
|---|---|---|---|
| **P1** | 技能写作契约 + advisory lint（默认只查自著技能 `created-by: graph-agent`，硬规则 6 + 建议规则 2）；`node --run skills:lint`；`docs/agent/skill-authoring.md`；好样本 fixture | `10ffc8c8` | 黑盒测试 5 例全绿；fixture 过 `--strict`；默认范围零警告 |
| **P2** | `tool_calls` 迁移 38 加 `target`；两条写入通路都记 target（≤256，解析为绝对路径）；`skillUsage()` 派生；`GET /api/skill-stats`；工具页「技能使用」区块 | `9394e5f7`、`59ced2a3`、`84be6329` | typecheck + 测试 + **真浏览器 E2E 全绿** |
| **P3** | `src/runtime/sediment.ts`：`sedimentSettings`/`shouldSediment`/`selectSedimentModel`/`parseSedimentProposal`/`existingSkillSummaries`/`applySedimentProposal`（结构性写盘守卫）/`generateSkillProposal`/`runSedimentReview`；提示词键 `runtime/sediment.md`（`DEFAULT_SEDIMENT_PROMPT` + 回退）；pi-adapter 在提示词建议之后挂钩（仅 master、廉价模型、同一 gate、`InvocationPurpose: 'skill_sediment'`）；`scripts/skill-sediment-e2e.ts` + `node --run e2e:sediment` | `fb0bb830`（红）、`96091edf`、`25f6d49b` | 单测 5 + 沉淀 E2E 7 组断言（含真实 `skills:lint --strict`）全绿 |
| **P4** | `src/runtime/skill-promotion.ts`：`promoteProjectSkill`/`promoteSkillFromProjects`（整目录复制 + `capability.json` 带 `createdBy: graph-agent`、`source: graph:project`、版本=内容摘要 12 位、幂等）；`task-runtime.promoteSkill()`；`POST /api/skills/promote` | `86eab65c`（红）、`43c386f0` | 单测 3 全绿；现场 400 `skillId is required` 证明路由在 |

**沉淀默认关闭**（`skills.sedimentation.enabled: false`，阈值 `afterToolCalls: 10`、`model: 'low'`、`budgetTokens: 40000`、`roles: ['master']`）。写盘由我们自己的代码做，守卫是结构性的，不靠提示词。

---

## fixed

- **HB-102（真缺陷，已修）生产 `tool_calls` 恒为 0 行的真因**：worker 车道收到的 `stateDir` **就是它自己的实例目录**，所以 spool 落在 `<root>/instances/<id>/tool-calls/`；而守护进程只扫 `<root>/tool-calls/` → 写入端正常、读取端永远空。**现场证据**：实例 spool 已有 294 行、同一 state 目录的 `tasks.sqlite` 里 `tool_calls` 0 行（此前我误判为「需要真回合才落行」）。修法：吸入与清空按同一约定看两处（根 + 每个实例目录），不新增协议、不放宽 worker 写权限（worker 仍只写自己的实例目录）。`fixed@bb5beffe`（+ E2E 播种改到车道真实位置 `fixed@19778c5a`）。**现场复验**：重载后 `tool_calls` 0 → 309 行；工具页 13 个工具/角色组合、320 次调用、98.4% 成功率；一次真实 `read` 技能文件后 `skill-creator` 显示 `能力库 / 1 / 刚刚`。
- **HB-105（已修）** 读取时吸入不是并发安全的：页面并行取 `/api/tool-stats` 与 `/api/skill-stats` 时两个 `ingestToolCallSpools` 从同一偏移读同一批行 → 同一次调用被记两次。修法：按 stateDir 合并并发吸入。**教训：任何「读取时做事」的派生端点，只要可能被并发调用，就必须幂等或串行。** `fixed@59ced2a3`
- **HB-108（教训，已修）** 块状 `oldText` 替换会连带删掉块内与目标无关的行（本轮误删一句注释）。**教训：整块替换前，把块内每一行都当「将被删除的内容」核对一遍。** `fixed@84be6329`
- **HB-109（教训，已修）测试必须走真实写入端的约定**：浏览器 E2E 把 spool 播到守护进程**根目录**，而生产 worker 播到**实例目录** → 只验了读取端一半，缺陷就这样活过门禁。**教训：凡「两端各自持有一份约定」的通路（写入端/读取端、发送端/接收端），验证必须在真实写入位置播种，或直接用真实写入端。** `fixed@19778c5a`
- **HB-110（教训，已修）迁移必须对「fixture 用降版本号模拟旧库」幂等**：裸 `ALTER TABLE ... ADD COLUMN` 在重跑迁移链时 `duplicate column name` → 整个库打不开（本轮全量门禁抓到两例）。修法：迁移 38 先查 `PRAGMA table_info` 再 ALTER。`fixed@54c06ab1`

## ▶ 现场观察一次真实沉淀（使用者指定：打开开关 + 用一次真实操作观察）

**开关已打开并生效**：`skills.sedimentation = {enabled: true, afterToolCalls: 3, model: "deepseek-flash", budgetTokens: 40000}`（config rev 216；`model` 也可省，则按 grade 自动选最便宜的可用项）。

**这次观察跑了 5 次真实评审**（每次都是新开一个绑定 13-Graph 的会话，让主 Agent 真做 6~20 次工具调用，然后读库里的决定）：

| 现场看到 | 说明 |
|---|---|
| 第 1~2 次：`replyStop: "error"` | 评审确实被派出（廉价模型、`skill_sediment` 调用已入库），但被账户额度挡住：`429 Go usage limit exceeded`（opencode-go）/ `command-goat` 处于 warning |
| 第 3 次：`proposed: "nothing"`、`replyChars: 422` | 机制跑通，模型给出可解析回答并**正确拒绝**（「结果只是复述仓库已写着的事实」） |
| 第 4 次：`proposed: null`、`replyChars: 2843`、`replyHead` 是完整的 `{"action":"create","id":"browser-e2e-acceptance",…}` | **决定要写、但我的解析器读不了** → 这是最关键的现场证据 |
| 第 5 次（修完格式后）：`proposed: "nothing"`、`replyChars: 495` | 解析与理由都完整：按「绝不沉淀环境故障/一次性叙事」规则正确拒绝 |

**结论**：机制端到端真实可用（触发 → 选廉价模型 → 调用 → 解析 → 结构化守卫 → 落盘/拒绝 → 记录）。这 5 次里拒绝了 4 次，唯一一次「决定写」当时被格式缺陷吃掉（已修）。

### ▶ 真实写出：已经自然发生（不需要我再构造操作）

发布前一版制品的那次操作（`9cf26ab8-c6a1-4229-a906-17adc6056a93`，本会话 master 回合）在收尾时，评审**真的写出了一个技能**：

| 事实 | 值 |
|---|---|
| 事件 | `skill_sediment.reviewed` @ **2026-09-26 17:28:15** |
| 决定 | `proposed: "create"`、`written: [{"id":"parsing-llm-decisions","replaced":false}]`、`refused: []` |
| 回复 | 3476 字符，作答模型 `deepseek-flash` |
| 落盘 | `/Users/macmini/workspace/13-Graph/.agents/skills/parsing-llm-decisions/SKILL.md`（`created-by: graph-agent`） |

**教训**：它接受的正是那次操作里最可迁移的教训（解析 LLM 决定的结构与守卫），**不是**复述型任务。所以「真的写出一份技能」不需要构造场景，它由**真实纠错**喂出来。

## open

- **HB-106（harness，open）** `apply_rsi_change` 的 `changes[]` 结构错误报错不够指向：连续两次写错结构（①把 `checks` 嵌进 change ②把第三个 change 嵌进前一个的 `edits`），报错只说 `changes.2.path: must have required properties path`，没说「多嵌了一层」。建议：识别 `edits` 里出现 `{path, action}`、或 change 里出现 `checks/title/problem` 时直接点名。
- **HB-107（harness，open）** RSI 回滚不恢复索引状态：`delete` + `write` 组合因 gitignore 被拒后回滚把文件恢复到磁盘，但留下**悬空的 staged deletion**（`git status` 显示 `D`）。建议：回滚时同步复位索引（`git reset -- <paths>`）。
- **HB-111（harness，open）** 工具校验报错本身可以更早、更完整：本轮一次 `apply_rsi_change` 调用同时踩了两个独立问题（把 `title`/`problem` 漏掉、`checks[1]` 少了 `command`），报错一次只列一条（`title: must have required properties` + `checks.1.command`），我先修了结构再补字段。同时手工 `edit` 过的文件不能搭这趟车（"Uncommitted changes outside this RSI change"）——这条**报错很指向、行为正确**，但值得写进 `docs/agent/self-configuration.md`：手改的文件必须先 `git restore`，再把同样的编辑作为 change 传入。
- **HB-112（harness，fixed@ce5bc59b + fixed@48800a5f）** 门禁偶发率仍未清零：本轮全量 `node --run check` 一次失败在 `tests/m8/app-shell-ux.test.ts > the composer suggestion and queue steering follow the three Enter states`（62s poll 超时、整套跑 112s），单跑同一测试 1.5s 通过。与 HB-74 同类（满载下的时间预算）。建议：该测试的 poll 上限按负载抬高，或把它从「全套同跑」里分离。
- **HB-113（ops，fixed@e1abffce）磁盘压力会打断 `app:build`**：本轮收敛应用线时 `node --run app:build` exit 1 —— DMG 步骤报 `hdiutil: create failed - 设备上无剩余空间`（当时 `/` 只剩 **786 MiB** / 228 GiB、94% 满）。回收我自己工具链的临时目录（`~/.agent-browser/tmp` 中 1 天以上的 1,184 项 / **5.2 GB**）后，同一条命令 exit 0 且 `app:verify` 通过（`/` 升到 6,126 MiB）。**建议**：`app:build` 起手做一次可用空间检查并给出明确提示；已知的「定期回收入口」优先做 `~/.agent-browser/tmp`（一次就能放出 GB 量级）。证据：`/tmp/appline-build.log`（失败）、`/tmp/appline-build2.log`（成功）、`df -h` 前后对比。
- **HB-114（已修，本轮现场暴露）P3 的开关无法通过配置文档打开**：`parseGraphConfig` 只挑已知字段、`sanitizeConfig` 也只吐已知字段 → `skills.sedimentation` 被静默丢掉，运行时读取者只能看到默认（关）。`fixed@465a0e9b`（+ round-trip 修正 `fixed@99f94e90`）
- **HB-115（已修）沉淀阈值数错了对象**：适配器用 `SELECT count(*) FROM tool_calls`，而该表只在「有人读统计页」时从车道 spool 吸入 → 全新会话永远数到 0、沉淀静默不跑。改为数**这次操作自己的**工具调用。`fixed@022228c1`
- **HB-116（已修）评审的决定不可见**：跑过没有、决定了什么、为什么没写，全都无处可查（调用记录里 usage 空、cost unknown、事件流空白）。现在写 `skill_sediment.reviewed` 事件：模型、本操作工具调用数、阈值、`proposed`（create/update/nothing/**null=不可读**）、written、refused、`replyStop`/`replyChars`/`replyHead`/`replyError`。`fixed@7186b52d`、`fixed@e9b068ba`、`fixed@8488e3ac`
- **HB-117（已修，真缺陷）要求模型「把 markdown 放进 JSON 字符串」等于要求它正确转义 markdown**：现场 2843 字符的合法意图因正文里的字面换行/引号被整份丢弃。改为**元数据一行 JSON + 正文放进 fenced 块**（解析器仍兼容旧形状，并做一处窄修复：转义裸控制字符）。`fixed@7e0e4278`、`fixed@cdf99bd1`
- **HB-118（已修，真陷阱）改常量改不动线上提示词**：提示词库读的是**可见文件**（`<promptRoot>/runtime/sediment.md`），它还是旧格式 → 新格式永远不会生效。加入 `LEGACY_PROMPT_REPLACEMENTS` 迁移。`fixed@d2755801`
- **HB-119（harness，fixed@21b1c205）一次拒答不再作废整次评审**：`selectSedimentModel` 按 grade 取第一个候选，可能正好是**被限流**的账户（现场：opencode-go 429、command-goat warning）。改为**候选故障切换**：`sedimentCandidates(main, directory, preferred)` 给出有序候选（配置的优先 → 其次按 grade 最便宜的 → 再补一个；上限 `SEDIMENT_ATTEMPT_LIMIT = 2`；**主模型永不入选**）；一个候选没有可用文本就换下一个；每次尝试（模型 / `stopReason` / `error` / 字符数）与**最终作答模型**都记进 `skill_sediment.reviewed` 的 `attempts` 与 `model`。红测试：`tests/m8/conversation-sediment.test.ts`「a review survives one cheap model refusing it by asking the next one」+ 纯函数单测覆盖候选顺序与「主模型不入候选」。
- **HB-122（教训，fixed@21b1c205）集成测试把我带偏时，是「纯函数最小单测」定出真因**：HB-119 的真机测试只记到一次尝试，我先追「循环为什么提前停」（改空文本判定）仍然一次；给 `sedimentCandidates` 补一条纯函数单测立刻显示 `['main-model','cheap-model']`——**真因是候选列表把主模型当成了配置项**。**教训：一个失败横跨「纯逻辑」与「集成路径」两层时，先给不依赖装置的那一半写最小单测，把问题切成两半。**
- **HB-123（教训，fixed@21b1c205）装置的「错误状态码计划」会被传输层重试吃掉**：用 `{status: 429}` 表达「额度用尽」时，传输层对可重试错误的若干次重试会把 fixture 计划吃干，被考察的那次调用落到兜底文本（200 + 文本 = 可用），断言随计划数漂移。**教训：有重试的通路不要用「精确计划数」断言；把失败态表达成确定性的东西（多份空回复 / 明确错误文本），并多备计划。**
- **HB-128（harness，fixed@055d06fd）红跑之后的 `replace` 锚点**：一次检查失败（红）会把改动留在工作区（`pendingFiles`），而**下一次调用的 `replace` 是按「工作区当前内容」匹配 `oldText`，不是按已提交内容**；报错只说 `found 0`，没说匹配对象是「上一轮未提交的那一版」，也没提示 `write` 这条出路（本轮为此白跑一次调用）。现在该文件属于上一轮未提交集合时，错误文本会追加「该文件当前是上一轮未提交（检查失败保留）的内容：oldText 要按它现在的样子匹配，或改用 action "write" 直接给全文」——它与 receipt 的 `error`/`report` 一起到使用者面前。红测试顺带纠正了我的一个错预期：**`apply` 在这条路径上返回 `rolled_back` receipt 而不是抛错**。
- **HB-124（harness，fixed@6d2bf11b）制品源文件的只读权限**：对象库里的字节是 0444，`cp` 过来的副本同样只读 → 原地编辑会以 `PermissionError` 失败且报错不指向真因。`docs/agent/artifacts-and-git.md` 新增「重新发布一份已有制品」：文本制品直接改内容后用 `content` 发新版，必须走文件时先 `chmod u+w`，版本号由发布推进、退役不释放。
- **HB-120（harness，fixed@0f272d5e）以 `apply_rsi_change(activate: true)` 收尾的回合不做沉淀**：那条路径从 RSI 收据处早返回，跳过评审块；而这类回合恰好承载了最多真实工作。修法需先把「本回合的材料」从收据文本里解耦（否则评审只看到收据），成本中等。
- **HB-121（harness，fixed@e1abffce）提示词建议（composer suggestion）用同样的静默吞错**：`generatePromptSuggestion` 出错时返回 `undefined`，没有记录、没有区分「模型没建议」与「调用失败」。既然评审这边的证据链已经建好，这里可以用同一套字段。
- **HB-78（fixed，见文档）快检必须含 typecheck**：早已写进 `docs/agent/self-configuration.md:83`（「快检的下限」那段，含两次真实漏掉的例子），本轮复核确认它仍在生效。
- **HB-85（fixed，见机制）写「人工步骤」之前先 grep 机制是否存在**：`src/git/integration.ts` 的 `outOfScopePaths` / `restoreOutOfScope` 与 `tests/console/git-baseline.test.ts` 都在，教训照旧成立（先查代码再写规则）。
- **HB-101（fixed@6d2bf11b）产物核对并进 `app:build`**：`package-app.mjs` 末尾 spawn 同一个 `app-verify.mjs`，失败即 build 失败；独立入口保留（给别的 checkout 用）。**现场**：本轮 `app:build` 日志末尾直接打出 `verifying the packaged app` + 六个标记全 ok，不再需要单独一步。
- **HB-88（fixed@69901186）真回合的工具遥测进页面**——**前提先被证伪了**：原条目说「E2E 只覆盖 spool 通路，master 直写通路（`pi-adapter` → `recordToolCall`）只有单位测试」。现场查下来 daemon 里 **master 也跑在 worker 进程**、工具调用同样落 spool，而 spool **只在有人读统计时**才被吸入——不是两条通路，是同一条通路的两端（我生产实例 `e9d3a42b…/tool-calls/*.jsonl` 当场在更新，而在进程内 `afterToolCall` 上打的探针一次都没触发）。新 E2E 段因此改成让 throwaway 守护进程**真跑一个回合**：脚本化 provider → 控制台 HTTP 面建会话 → `page.reload()` 触发吸入 → 断言页面上唯一的记录就是那次回合的 `bash`／主 Agent（清空后重建，排除种子数据），并核对表里恰好一行。截图 `tool-stats-real-turn.png`。**三个踩过的坑已写进脚本注释**：守护进程默认 **view-only**，不加 `--execute` 真回合根本不跑（这一轮先在这里空转了一次）；同一个带 hash 的 URL 用 `goto` **不会导航**（HB-90 同族）；`tool_calls` 不能直接查库等——它是「页面读过统计」的结果。
- **HB-98（fixed，见上）**：教训（任何「地址/身份不变」的优化都要配「新会话下页面仍可用」的端到端验收）已落到实现与测试：`desktop/lib.ts: consoleReloadAction`（同地址 → reload）+ `tests/app/desktop.test.ts` 三个断言 + `app-verify` 标记 `consoleReloadAction`；console E2E 每次都是**新会话**加载页面；本会话的多次 RSI 重载都复用同一端口且页面照常工作。
**磁盘回收（使用者批准，已完成）**：`~/.agent-browser/tmp` 3.1 GB（1057 个每次运行的临时目录 + 一个 9/24 的旧 chrome profile）与 `state/tasks.sqlite.bak-1790332615` 1.2 GB（9/25 备份，删前核对过它与生产库是两个文件）一并清掉：`/` **5.9 → 10 GiB** 空闲，随后两次 `app:build` 都成功（12.8 GiB 空闲时打印 `needs ~2.0 GiB` 且无告警）。

- **HB-79（fixed@de07614a）低于派发预留的预算上限必须说明后果**：agent 节点一次派发预留 2,000,000 tokens，而 `set_budget` 回执只回「已设置」。实测后果比预想更直接：**这条上限会当场挡住自己那一回合的下一次模型请求**（红测试里 `provider.requests` 只有 1 次就是证据），随后节点停下来问人。修法：`Execution` 暴露 `reserveTokensFor(action)`（用与派发**完全相同**的查表规则——第一版我取 `options.actions` 取错了，m8 装置里它是空的、master 由 fallback 适配器承担），`set_budget` 的回执与 `instance.budget_changed` 事件都带上那句警告并点名那个数。
- **HB-62（fixed@01c1d181）配方四条路由的 API 级测试**：`tests/m8/recipe-compile.test.ts` 新增一条走 `app.inject` 的真实路由测试——description 更新后定义必须跟着走（`definition.version = 2`，否则库里显示的文字与编译身份不一致）、`DELETE` 正确形式返回 200 并从文件里真的删掉、而**带 JSON content-type 的 `DELETE` 被 Fastify 以 400 拒**（把这坑钉住，正是该条目要求补的那条）。我第一版断言形状写错（描述在 `combination` 下），既有测试当场纠正。
- **HB-77（fixed@3593e93e + 活的身份文件）剪贴板指引改成实测结论**：现场实测（Chrome for Testing 153）`writeText` / `readText` / `execCommand('copy')` **全部** `NotAllowedError`，而 `navigator.permissions.query({name:'clipboard-write'})` 同时报 `granted`、`document.hasFocus()` 为 `true`——**那个权限状态根本不是证据**。改了三处：仓库 `docs/agent/capabilities.md`（把「可能被拒」写成实测）、`presets/bootstrap/master/agent.md`、以及**活的身份文件 `~/.graph/prompts/agents/main.md`**。**踩到的真陷阱（HB-129）**：我以为改仓库预设就够了——重载后核对注入我的身份文本，**仍是旧那句**；`~/.graph/prompts/` 里的可编辑文件**整份覆盖**内置文本（docs/agent/self-configuration.md 早就写了「改规则也应该改那里」），仓库预设只影响**新装**。教训：改「注入我的文本」＝改 `~/.graph/prompts/<key>`；想靠 `LEGACY_PROMPT_DEFAULTS` 迁移则**只在该键的 `descriptor.content` 是完整文本时安全**——`agents/main.md` 的不是（它是那句短身份），所以把它当 legacy 会把长身份**缩成一句话**，幸好动手前先核对了。
- **HB-61（fixed@c52fab02）切账户后模型列表不跟随**：设置页「① 配置厂商」里改凭据 id 后，「② 选择模型」的行仍是**上一个账户端点**取回来的——表单在配 B、屏幕上是 A 的模型，保存时就把 A 的模型按到 B 头上。修法：凭据 id 变化（非首次挂载）时清掉已探测列表与提示，并把 ② 的厂商切到同名账户（随即自动获取一次，列表真的跟着换）。真浏览器测试用两个各带 `/models` 的 stub 厂商复现并钉住。**顺带的口径收紧**：既有测试里两处「请求次数必须等于 N」的断言被这次跟随行为打破——按 R27 改成**按路径的内容断言**（`/v1/chat/completions` 存在、`/v1/models` 被取过、且 ① 本身就已跟随取过），计数本来就不是契约。
- **同族竞态又一处（fixed@13371c9a）**：应用线门禁偶发红在 `tests/m8/integration.test.ts`「等待 API 名额」——先 `waitForFunction` 命中、再**重新读一次** DOM，而「等待名额」是瞬态（槽位一空就变「执行中」），满载下第二次读合理地读到下一个状态。改成断言**满足等待的那份文本**。隔离连跑两次都过，确认是满载竞态而非产品缺陷。
- **HB-60（fixed@06e8b351）平台凭据无值静默降级**：具体形态——① 卡片「凭据已解析」的药丸把**平台级**旗标（该平台某个账户的 env 变量存在）与本账户的真实解析状态做了 OR，于是**本账户没有任何值**时也报「已解析」；而无值凭据的模型会被 `live-config` 静默丢掉，用户看到的只剩「模型就是不派发」。修法：守护进程按账户给出的答案优先于平台旗标。真浏览器测试（平台变量在、账户变量不在）钉住药丸必须说「凭据缺失」，并点出**这个账户**需要的 env 变量名。
- **HB-57（fixed@8e5adc83 + 后续@41fd5cf7）厂商卡片字段挤**：先在生产控制台截图看清病灶——①「环境变量（credentialRef）」输入框把 `GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY` **截断**（正是用户要复制的名字）；② hint 与 label 同一行，标签被挤成孤字（「…id 不同即不 / 账户」）。修的四处：hint 独立成行；长标识字段在 card-grid 里占满整行（273 → **420px**，`scrollWidth <= clientWidth`）；卡片网格底对齐（`align-items: end`），于是同一行里只有一个字段带 hint 时，**同行控件仍然齐平**——第一版修完截图暴露出「挤」被我换成了「错位」，这条是第二刀。测试量三件事：`envFits`、`sharedLineHints`、`misalignedRows`（后者只在三列布局出现，所以测试视口设 1400px，1000px 会漏）。**现场复验**（真 app、新包）：`misalignedRows: 0`、`envFits: true`、字段宽 420、截图 `/tmp/hb57-env-field.png`。
- **HB-130（harness，open）现场自验的 web 目录不是应用线的**：运行中的 daemon `--web-dir` 指向 **`graph-rsi/dist/web`**，而我在 `13-Graph` 里跑 `app:build` 只更新应用线那份 → 现场仍是旧包，我差点把自己的修复读成「没生效」（实测：服务端给的 CSS 里没有新规则、`envWidth` 仍是 273；在 RSI 根跑 `node --run build:web` 后立刻变 420 ✓）。建议写进 repo 文档（web 改动的现场自验必须在 RSI 根重建 web）。
- **HB-76（fixed@17030bfa）新增一列的第三件固定动作机械化**：加列要做三件事（升 `SCHEMA_VERSION`、加 `version < N` 块、更新每个「倒回旧形状」的 fixture），第三件是人会漏的，而信号来得太晚——落在某个碰巧踩到该列的测试里红。现在 `tests/console/schema-version.test.ts` 对照两个来源：`store.ts` 每个迁移块加了哪些列 × `tests/**` 里带 `PRAGMA user_version=N` 的降级 SQL。规则是**两轮校准**出来的：① 只查**无守卫**的加列（带 `table_info` 的迁移能吞掉残留列，留着不会红）；② 只把**含 DROP** 的 fixture 算作「倒回形状」（`schema-upgrade.test.ts` 是**从零手写旧库**，那是另一种声明——离线扫描先把它误报成 8 处缺口）。真实来源零缺口，所以另加故障注入用例（缺一次 DROP 会报、守卫列与 `DROP TABLE` 覆盖都可豁免、从零造的库不归这条管）来证明检查真的会响。顺带两处踩坑：检查会扫到自己文件里的合成样例（明确跳过并写明原因）；我的正则只追踪 `ALTER TABLE ADD COLUMN`，不追踪建表列（合成期望值据此校准）。
- **HB-72（fixed@439924ff）懒加载收益复测**：溢出文件就是**没进提示词**的字节。实测（2026-09-27，本机保留窗口内）：**5 个 / 0.3 MiB**，最大一个 **233 KiB**（正好是 master 读自己整段转录那次，218,978 字符），最小 5.3 KiB。最小那个只比阈值高一点 → `TOOL_RESULT_LIMIT = 4,000` 正在拐点附近，**不调**；复测命令写进 `docs/agent/execution-model.md`（含「这是一段窗口而非长期均值」的说明，因为 `state-retention` 会裁旧实例）。
- **HB-81（fixed@439924ff）控制台 HTTP 自验配方**：`docs/agent/capabilities.md` 新增一节——`/api/*` 要**会话 cookie**（先 `GET /`）与**本地 `Origin`**；地址只在 `<stateDir>/console.json`；**要写任何东西就另起一个 throwaway daemon**，绝不把自验指向生产 state。
- **HB-130（fixed@439924ff）现场自验的 web 目录**：同一节写下这个真实陷阱——运行中的 daemon 服务的是**它自己那个 checkout** 的 `dist/web`，所以在本仓库跑 `app:build` 之后现场仍是旧包（实测：服务端给的 CSS 里仍没有新规则、字段宽仍是 273；在运行中 checkout 里 `node --run build:web` 后立刻变 420）。差点把我的修复读成「没生效」。
- **HB-106（fixed@61ca90dd）结构错误点名——用 `prepareArguments` 接缝**：`changes[]` 的嵌套错误过去只得到 schema 事实（`changes.0.path: must have required properties path`）。SDK 在**校验之前**会调 `tool.prepareArguments`（`pi-ai/dist/utils/validation.js` 与 `harness/execution/tools.js` 都走这条路），而它抛出的消息**直接变成工具结果**——这是唯一能在 schema 之前说话的缝。新增 `rsiChangeShapeHint(args)`（`src/runtime/rsi.ts`）并对 `apply_rsi_change` 接线：顶层字段嵌进 change（`"checks" belongs at the top level of the call - it is nested one level too deep.`）、change 嵌进 `edits[]`（`belongs in changes[], not inside edits[] - one change is nested inside another.`）、数组当对象用、文件改动落进 `checks[]` 四种点名；合法调用原样放行，只缺字段的仍交给 schema。**先红后绿**：单元四条（`tests/console/rsi-change-shape.test.ts`）+ **真 Pi 会话一条**（`tests/m0/pi-calls.test.ts`：今天嵌套调用会**直接落地执行**——测试证明它现在被点名且 handler 一次都没跑）。类型接线踩了四个真错：声明字面量的上下文类型 `Declaration` 得带上 `prepareArguments`（否则 `Object literal may only specify known properties`）、`describeAgentTools` 的返回注解会把 `name` 宽化成 `string` 从而打断 `handlers[declaration.name]` 的字面量索引（返回类型改成 `AgentToolDeclaration & { name: AgentToolName }`）、测试里的 `main: true` 不是 `AgentToolFeatures` 字段（master 由 `role: 'master'` 表达）。
- **HB-107（fixed@61ca90dd）回滚复位索引**：回滚只恢复文件、不动索引，而**索引条目比那次尝试活得久**——`git add -A -- 好路径 被忽略路径` 会先把好路径暂存再在被忽略路径上报错（实测 `add exit=1` 且 `A newfile.txt` 已入索引），于是失败一次就留下 `A path`，下一次尝试把它读成「别人的未提交改动」（`Uncommitted changes outside this RSI change`）而拒绝运行。修法：catch 里恢复快照后 `git reset -q -- <uniquePaths + owned>`（harness 起手就拒绝无主脏路径，所以这里只可能撤掉我们自己的暂存）。**先红后绿**：`tests/console/rsi.test.ts` 新增用例——失败后 `git status --porcelain` 为空（红时是 `AD src/fresh.ts`），且紧接着的那次干净重试 `applied`。
- **HB-111（rejected，前提被证伪；文档部分已落地）**：条目说「报错一次只列一条」。实测：`typebox/value` 的 `Errors()` 返回**全部**问题（漏 `title` 与 `checks[1].args` 同时给出 2 条），而 `pi-ai` 的 `validateToolArguments` 把它们逐行拼进同一条消息，**并回显收到的参数**。我当初看到「一条接一条」是两次调用各有一处错，不是工具漏报。**证据**：探针（`describeAgentTools(...)` 真声明 + `Errors()`，见本轮对话）+ 本轮我自己那次失败调用的原文回执（`- changes.0.path: must have required properties path` + `Received arguments:` 全量）。**保留的部分**已写进 `docs/agent/self-configuration.md`：手工改过的文件不能搭 RSI 这趟车（先 `git restore --staged --worktree -- <path>`／未跟踪的 `rm`，再把同样的编辑作为 `changes[]` 传入）——本轮我自己就撞了一次。
- **HB-106 续（fixed@91daf2b7）——现场自验证伪了「已修复」**：第一次提交（`61ca90dd`）把 `prepareArguments` 接在**父进程**的声明上，重载后我拿真嵌套调用去验，**它居然正常落地并提交了**——于是查出真实路径：Agent 跑在 **worker 子进程**里，工具是**从 JSON 重建**的（`pi-process.ts: serializedTools()` → `pi-worker.ts` 的字段清单，函数过不了线），所以那条接缝在真实路径上根本不存在。修法：提示改成**按名字查的一张表**（`AGENT_TOOL_ARGUMENT_HINTS` + `prepareToolArguments(name)`），父进程与 worker 两侧从同一张表接上（worker 能 import 我们的 src，线协议不用改）。**教训（CS 型）**：接缝/字段加在父进程不等于在现场存在——**跨进程边界的东西必须按「它会被重建」来验**。测试补到**真 worker 层**（`tests/m0/pi-process.test.ts`：真子进程 + 真 fixture provider，断言模型收到的工具结果就是点名句、且父进程 handler 一次没跑）；旧的在声明处直连的测试（`pi-calls.test.ts`）留着，但它**证明不了**现场——这正是这轮踩的坑。两次探针留下的 `probe-hb106.ts`（误加 + 删除）已随修复提交，净值零。
- **HB-132（fixed@36c2d20a，使用者发起的奥卡姆剃刀）提示词来源审计：13 个来源里 2 个是死实体**。现场控制台 API 显示 **13 个可编辑来源**（不是 12），逐条核对代码后：
  - **真死（从不注入）**：`runtime/main-conversation.md`、`runtime/main-graph.md`。证据三处：代码里只出现在类型联合/描述符/默认解析，没有任何注入点；现场两者有效内容为 **0 字符**；`tests/m8/conversation-pi.test.ts` 本来就断言 `CONVERSATION SENTINEL` **不会**被发出（那个键正是为了证明「不注入」而活着）。连带删掉 `DEFAULT_MAIN_CONVERSATION_PROMPT` / `DEFAULT_MAIN_GRAPH_PROMPT` 两个死常量——**实测 6,932 + 2,103 = 9,035 字符**死提示词文本，加两条 LEGACY 替换条目、两个 defaults 字段与两行解析。
  - **看似冗余但必须留**：其余 10 个来源的活文件与内建默认**逐字相同**，本想当副本删掉——查 `ensure()` 发现它用 `flag: 'wx'` 把每个来源文件重新种回来，所以「与内建相同的活文件」**是设计**（可见即可编辑），删了也会长回来；真正不能删的是 `tools/main.md`：它的 legacy 回落路径 `tool-awareness.md` 仍是活的（有测试专门覆盖那条迁移），删了主文件会让那份**旧版文本**顶上来。
  - **顺手清掉的真垃圾（不在任何描述符里、从不被读）**：`docs/` 8 个**过期副本**（代码只读 `<appRoot>/docs/agent`，副本比真文档短一半）、`rules/*.pre-pi-format.md` 4 个、`rules/*.md.bak-*` 7 个、`.DS_Store`、两个死键的活文件与 `defaults/` 条目——库从 **44 个文件缩到 14 个**（备份 `/tmp/prompts-backup-1790479250.tgz`）。
  - **验收（可量）**：删文件后立刻对比基线，**11 个保留来源的有效内容 0 处变化**（逐字节相同）；全量门禁 180 文件 / 1279 测试 exit 0。
  - **测试同步**：typecheck 反过来把 12 个调用点列全了（死键不再属于 `AgentStaticPromptKey`）——控制台编辑流程改用活键 `runtime/worker.md`、默认渲染测试改用 `runtime/sediment.md`、去掉只为「证明不注入」而存在的哨兵。
  - **留给使用者的设计问题（未动）**：来源仍有 11 个，其中 `rules/main.md` 只有 296 字符（一行）、`tools/{main,worker,reviewer}.md` 各 135–336 字符。要不要继续合并（例如三个 tools 文件并成一个）是**设计选择**，不是死实体，等使用者决定。
- **HB-106 现场救了一次（新证据）**：我自己把 `title`/`problem` 嵌进 `changes[0]`（正是 HB-106 描述的那个错），工具当场回 `"title" belongs at the top level of the call - it is nested one level too deep.` ✓ 上一轮修的那条接缝在真实工作流里生效了。
- **HB-133（fixed@6eb443b5 + 675117f1 + 8f6158e8，使用者发起的 subagent 简报奥卡姆）**：先把真实数据量清（5 个真实任务重建简报 + 现场会话），再按使用者逐条确认的 5 个决定动手。**实测构成**：Task graph 占 **56–71%**（4.8–9.3 KB，主体是**同族 lane 的文件清单**），Decisions 11–14%，Acceptance 6–11%，User messages 6–16%，Request 2–6%，`Summary` 与 `Request` **逐字相同（4/4）**，`Requirement version` 23 字符；`Predecessor handoffs` 首道工序为 0（不进简报）、review 节点 1,214 字符；`Conversation and execution status`（12.7 KB！）只在 `phase=chatting` 注入，**worker 不拿**。
  - **① 节点视角裁图**：`briefing()` 新增 `focus`，图改为「自己的节点（input 渲染成可读行：`files:` / `focus:`…）+ 会读自己产出的检查（渲染成可读命令 `check-types: node --run typecheck`，而非 JSON）+ 同族只列 id」；`execution.ts` 对非 master 的 agent 节点传 `focus: spec.id`。
  - **② 去主 Agent 专属噪音**：节点简报不再渲染 `Requirement version` 与消息锚点 `[id] (v1)`；`Summary` 与 `Request` 相同时删（不同的仍保留）。
  - **③ 收益（真实数据）**：17 份真实 subagent 简报 **9,667 → 4,655 字符，省 52%**（逐任务：−56% / −28% / −56% / −51% / −46%）。
  - **④ 返工增量**：同会话重跑不再重发全量简报，改为 `reworkBriefing()`——只给「失败的读者节点证据（输出截断 4,000 字符 + 本实例 `rework/` 目录里的全文句柄）+ 被它挡住的验收条目 + 其余不变」；会话丢失（无 `node_sessions` 行）仍发全量。可达性判定抽成导出的 `nodesReading()`，与节点视角共用一套（不再各写一份）。
  - **⑤ TDD 要求**：`rules/common.md` 本就含 R22/R23/R27 且**所有角色共享**（所以标准已经一样），缺的是 worker 侧的显式指令 → 写进**活的** `~/.graph/prompts/rules/worker.md`（使用者指定落点，未写进内置默认，所以只影响本机）。
  - **测试**：11 条（节点视角的读己/同族/噪音/Summary 两态 + 主 Agent 回归护栏 + `nodesReading` 可达性 + 返工增量的内容/截断/句柄/无失败不编造）。**先红后绿**，并且过程中我两次把测试期望写错（`check-all` 也确实读 `impl-b`；`- check-all` 含子串 `- check-a`）——都由测试本身暴露，实现无误。
  - **诚实标注**：节点视角与返工增量的**内容**由单元测试 + 真实数据离线重建验证；**现场路径**（下一个真实 feature task 的 worker 简报、以及一次真实返工）还没跑到，会在发生时报告。返工分支的 E2E（脚本化一次「检查失败 → retry」）是本条的下一增量。
- 仍待做：**HB-65（提示词来源是否合并）、定期回收入口**；HB-134 已 fixed（见下）。
- **HB-137（fixed@9412d6ec，中，本次实测）**：**已修：`defaultValidate` 识别网络/下载失败并只重跑打包一次。** 先把真因读清：我那次改动**确实包含 `src/web/`**，所以打包本来该跑（`buildRelevant` 是对的），缺陷在「下载中断」与「构建失败」被判成同一件事。现在失败输出命中网络特征（`aborted pending request`/`SSL_ERROR`/`ECONNRESET` 等）时只重跑 `app:build`，两次都失败仍如实判失败并在报告里写清是哪一种；真编译错误不重跑。证据：先红后绿（禁用判据时 `expected 'failed' to be 'passed'`），另有「真编译错误仍拦下」一条；测试用真实 `scripts/build.mjs` 跑真 `defaultValidate`。**激活路径上的 `app:build` 让一次纯网络抖动挡住重载** —— 我在 `apply_rsi_change{activate:true}` 里只改了运行时与 web，`typecheck`/`check` 都绿、web 也构建成功，却因为 electron-builder 下载被中止（`The server aborted pending request`，同时段 `git push` 也报 `SSL_ERROR_SYSCALL`）整次激活判失败、**不重载**；重跑一次即过（13 分钟 npm install + 下载白烧一轮）。问题不在改动而在判据：桌面打包与「运行时/web 已改」无关，本该按改动范围决定是否打包（与「改 desktop/ 才必须 app:build」同一条规则），或至少把下载失败与构建失败区分开、允许只重跑打包。
- **HB-136 = fixed@9394173（门禁竞态，已按 `e2e-race-conditions` 处方修）**：`tests/m8/conversation-history-ui.test.ts` 在满载下点击「载入更早消息」时元素被事件流替换 → `element was detached from the DOM` 后超时 30s，整轮门禁白跑。修法：抽一个 `clickOlder(page)` 只做**一次容错点击**（元素已在/点击时被换掉都不算失败），两处调用都改成**等待结果**——第一处等 `count() < 280` 的循环继续、第二处等 `PENDING-000` 真正出现；其后的断言保持严格（`count() === 280`、逐条唯一）。**验证按处方第 5 条**：在同一棵树、同一全量并行调用下 **4 次全绿**（全量 check ×2：182 文件 / 1289 测试；`tests/m8` 并行 ×2：各 245 测试），而不是只跑单文件（单文件在修之前也是绿的）。
- **HB-135 = rejected（前提证伪，2026-09-27 实测）**：原本诊断为「子进程发送的 system prompt 从未回传」，**不成立**。证据：①生产库最新的**非 master 操作是 2026-09-24 08:13**，而记录钩子（`operations.system_prompt` 列 + `pi-adapter.ts` 的 `onSend` 记录）落地于 **2026-09-25 13:57** —— 自钩子上线以来**还没有任何 subagent 跑过**，所以「0 / 21,094」是**时间窗口**而不是结构性缺失（159 条记录全是我这个 master 今天的回合）；②`tests/m8/node-prompt.test.ts` 里的节点走的就是**默认受限进程 transport**（`openPiProcess` 真 spawn 子进程；`createRestrictedProcessAgentSessionTransport` 是唯一实现，仓库里没有同进程回退），而它**记录成功**且与请求体逐字节一致。收尾：把面板那句臆造的原因（「也可能是在工作进程里发送、记录尚未回传」）删成中性陈述（commit `ee0d0ab`）。教训：**空记录先比时间戳，再改代码**——「结构性缺失」与「时间窗口」在库里的形状完全一样；本次差点按错的诊断去动子进程回传协议。
- **两条线状态（已收敛，含 HB-119/121/113 + HB-120 + HB-112）**：`rsi/product-line` = `b6cb49bf`，已 merge 进 `main` = `4694203`；应用线全量门禁 **180 文件 / 1286 测试 exit 0**（纯运行时改动，按同一规则跳过 app:build）（一次满载红：`integration.test.ts` 的瞬态状态断言，已按同族竞态修掉）；`app:build` exit 0 且**日志尾部自带产物核对**（HB-101 已生效，六个标记全 ok）；`app:build` exit 0（阈值已按实测收口为 2 GiB，见下；本次打印 `packaging: 3.2 GiB free on the output volume (needs ~2.0 GiB)` 且**不再告警**——上一版在同一尺寸上会喊「很可能失败」）+ `app:verify` 通过；安装包内 `src/runtime/{sediment,pi-adapter,disk-space,rsi,conversation-tools,tool-results}.ts` 逐字节含各轮修复（该 app 直接跑 TS 源码）；已推送 origin（`4694203`，pre-push gate passed）。校验点：`3862b92` = HB-119；`2df97a7` = +HB-121/HB-113；`fd0d4f9` = +HB-120；`ce47815` = +HB-112；`7dde8de` = +跨会话工具；`bb24dc9` = +HB-126/HB-127/新工具上限；`9004efc` = +自由通信（取消回流链与单次上限）；`d1b49ae` = +空间阈值按实测收口为 2 GiB；`d42453d` = +HB-101/124/128 + HB-88 真回合遥测 E2E；`431c467` = +HB-79/HB-62/HB-77；`d559589` = +HB-61 与 integration 竞态修复；`57d33ea` = +HB-60/HB-57；`c724784` = +HB-57 续（同行齐平）；`cb8c765` = +HB-76 迁移降级对照 + HB-81/72/130 文档；`61ca90dd` = +HB-106 嵌套结构点名 + HB-107 回滚复位索引 + HB-111 文档（**纯运行时，不需重建前端**；已激活重载）。

- **提示词库读的是可见文件，不是常量**：`prompt(key)` = 可见文件 ?? userDefault ?? 内建常量。改了默认文本**必须**同时加 `LEGACY_PROMPT_REPLACEMENTS`（或 `LEGACY_PROMPT_DEFAULTS`）迁移，否则只有全新安装才吃到新文本（现场踩到）。
- **一次性副调用的账是「空 usage + cost unknown」**：提示词建议与沉淀评审都这样，**不能**把「usage 为空」当成调用失败的证据（要看 `replyStop`/`replyError`）。
- **账户额度会打断评审**：`GET /api/usage` 的 `status`（ok / warning / limited）是选模型时的现实依据。
- **评审的形状**：元数据一行 JSON + fenced ` ```markdown ` 正文；`proposed: null` 表示「回复不可读」，与 `"nothing"`（模型明确说不用存）不是一回事。

- **HB-138（open，中，本轮实测）**：**手写的能力目录必须先刷新目录才能被配方引用** —— 我按 `docs/agent/agent-recipes.md` 的写法在 `~/.graph/capabilities/agent-md/<id>/` 手写了两个身份能力（`capability.json` + `agent.md`），随后 `POST /api/catalog/combinations` 直接被拒：`Missing required capability matt-pocock-implement@1.0.0 (identity)`——**报错只说能力缺失，不说要先刷新**。真相是目录缓存了能力清单，得先 `POST /api/catalog/refresh`（返回 408 个能力）才看得见新写的目录。`agent-recipes.md` 没写这一步，任何人手写身份都会撞一次。修法二选一：文档补一句「手写能力后先刷新」+ 报错里带上提示；或让配方创建时自动刷新一次。
- **HB-139（open，中，本轮实测）**：**`build:web` 之后普通重载可能仍跑旧 bundle，现场自验会被自己骗到** —— 改完 web 我按既有流程在 RSI 根 `node --run build:web`（产出 `dist/web/index-<hash>.js`），随后用 `agent_browser` 打开控制台：**新加的标签标题逻辑完全不生效**（标签仍显示占位名），我差一点就去查代码。真相是浏览器缓存了旧的 `index.html`（引用了旧 hash 的 JS），换成带查询串的地址 `http://127.0.0.1:65146/?cb=2#/...` 立刻正确。教训：**web 改动的现场自验必须带 cache-busting 参数**（或强制无缓存重载），否则「改动没生效」这个结论本身就是假的。

- **HB-140（open，低，本轮实测）**：**改「抽屉默认页」会静默藏掉只在与默认页不同时才渲染的控件** —— 我把右侧抽屉的页面从「验收项/节点/决策/任务图」收成「任务图 + 共享产物」、并把默认页从 `acceptance` 改成 `graph` 之后，草稿卡的头与「确认草稿 / 目标分支」被 `{drawerPage !== 'graph' && ...}` 整块挡在默认页之外：**用户打开抽屉再也看不到确认入口**（不是崩溃，是静默消失，UI 测试里只有一个超时）。教训：默认值改动前先 grep「以旧默认值为条件的渲染分支」；把这类条件改成「始终渲染、只是不重复」。
- **HB-141（open，低，本轮实测）**：**删掉 UI 测试里那个「等某元素」的等待点，等于拆掉一个隐式同步点** —— 我把抽屉任务区的节点清单换成状态摘要后，用例提前约 1 秒往下跑，原来靠等节点清单「顺带」同步的下一步（连发两条消息、断言第二条也被处理）在并行满载下变成 flake。按 `e2e-race-conditions` 的处方改成**等状态**（等第一条消息真的落到记录里再发第二条）即稳定。教训：替换等待点时，先问「这个等待是否也在同步后面的步骤」。

- **HB-142（open，低，本轮实测）**：**删掉一个页面会让「以它为断言主体」的测试集体失效，并且会连带丢掉夹在里面的独立断言** —— 删任务详情页与节点诊断后，门禁一次红 8 个文件 / 14 个用例：多数是「goto `#/tasks/:id` 再断言该页内容」，但也有夹带品，例如 `records-ui` 里那条**「外部输出按文本渲染、绝不执行成 HTML」**（`__pwned`）与 `unlimited-ui` 的「不限不折零」——它们与页面无关，却住在页面用例里，跟着一起没了。教训：**删页之前先扫一遍该页的测试，把与页面无关的断言搬到新家**（我这次是事后补救，`__pwned` 那条已经随文件删除）。下一轮做同类删除时，先跑一次 `grep -l '<被删 testid>' tests/` 列出全部受影响文件，逐条标注「改指 / 搬走 / 随页删除」再动手。
- **本轮补记**：删除后必须逐个判断「功能没了」还是「只是搬家」——`#/tasks/:id` 与 `#/tasks/:id/graph` 合一（任务地址就是任务图）、「提升到项目共享」从被删的整页工作区搬进产物详情标签（能力不丢）、预算问答改走问题收件箱、节点状态改读任务图的节点卡。判断错了就会把「只是搬家」误当成「功能没了」而删掉有用的覆盖。

- **HB-143（open，低，本轮实测）**：**删掉一个 UI 区块后留下的死代码，`tsc` 一声不吭** —— 我删掉任务图的节点检查卡后，`waitingForSlot`、`useLimits`、`OperationRow`、`Limits` 以及若干 state（`opsBefore`/`chatNode`/`reloadOps`）全部变成死代码，`node --run typecheck` 与 `lint` 都通过（仓库没开 `noUnusedLocals`，lint 只查 floating promise），我是靠手工 `grep -c '<name>'` 才发现的。建议：要么开 `noUnusedLocals`（会暴露一批历史死代码，需要一次性清理），要么在删除区块后固定跑一遍「被删区块引用的名字是否还有第二处引用」。后者成本低，可以写成一个 `scripts/dead-refs.mjs` 检查。

- **HB-144（fixed@2f9dea4，本轮实测）**：**复用既有面板组件时，它依赖的属性契约必须一起带上** —— 我给壳级抽屉写了同样的 `class="detail-drawer"`，却漏了 `data-open="true"`；而 `.detail-drawer` 的默认值是 `pointer-events:none; opacity:0`，只有 `[data-open="true"]` 才可交互。真机症状是「抽屉点不动」：E2E 只报 `<div class="window-drawer-layer"> intercepts pointer events`，肉眼看着像正常渲染（元素在、`isVisible()` 也为真），`document.elementFromPoint()` 才暴露命中的是层而不是链接。教训：搬 UI 区块 = 搬**整份契约**（class + 状态属性 + aria/inert），少一个属性就是静默不可用。
- **HB-145（fixed@2f9dea4，本轮实测）**：**把「抽屉里的全高板子」搬进标签后高度链断了** —— 标签内容区 `.content` 是块级、`.page` 只有 `height:100%`，板子上的 `flex:1 1 auto` 全部失效 → 任务图画布塌成 0 高，Playwright 报的正是 `locator resolved to hidden`（元素在、盒子为空）。修法：新增 `.window-fill { height:100%; display:flex; flex-direction:column }` 并让 `/conversations/<id>/graph` 走 conversation-first 路由（padding 0 / overflow hidden）。教训：**把一个区块换容器后必须重验它的高度链**，「hidden」这类 Playwright 措辞是塌陷而非缺失。同批还有一处搬家后的文案错：产物列表改成项目级索引后空态仍写「这个任务还没有发布产物」→ 改成按分组说话（`各任务的产物` / `不属于任何任务`）。
- **HB-146（fixed@2f9dea4，本轮实测）**：**窗口地址里的版本参数必须在数据获取层兑现** —— 草稿任务图窗口地址是 `#/conversations/<id>/graph?v=<n>`，但组件读的是会话视图里的 `proposal`（**永远是最新草稿**），于是 `?v=1` 显示 v2、门禁里那条「带版本打开」的断言按真相反了两次。修法：按地址里的版本读 `/api/conversations/<id>/proposals/<v>`（版本等于最新时复用会话视图，省一次请求）。教训：地址参数只在**取数**处算数，用它做展示是给自己看。
- **HB-147（open，低，本轮实测）**：**抽屉打开后盖住工作区横条右端，横条上的抽屉开关在那时点不到**（同一角落是抽屉自己的「关闭详情」）。① 的要求是开关「任何时候都可见」，现在是可见但被层压住。建议：抽屉展开时把横条开关隐藏（或让 `.window-drawer-layer` 不覆盖横条高度），让「同一角落的图标」始终是同一个语义。
- **HB-148（open，低，本轮实测）**：**`/api/tasks` 只列 `phase != 'chatting'` 的任务** —— 会话（含锚任务）不在其中，于是任何「按项目列任务/产物」的界面都会静默漏掉会话里发布的东西（本轮共享产物索引第一版就是这样：项目域部分对、任务域永远空）。本轮用后端聚合查询绕过（`GET /api/projects/:id/artifacts?include=task`），但**同族的界面还会踩**：凡「这个项目里有哪些产物/任务」的问题，数据源必须是项目聚合，不能拼 `GET /api/tasks`。
- **HB-150（fixed@5bbd4be，使用者报障）**：**窗口横条里新加的控件在桌面应用里点不动** —— 使用者报「工作区横条抽屉开关不可用」。真因是 `.workspace-bar { -webkit-app-region: drag }`（桌面应用把横条当窗口拖拽区），而只有 `.tab-bar` 标了 `no-drag`；我把开关放在 bar 里、tab-bar 之外，于是它是拖拽把手、永远收不到点击。**浏览器里的自验看不到这个**（app-region 只在 Electron 里有效），我上一轮的自验因此全绿。修法：新增 `.workspace-bar-actions { -webkit-app-region: no-drag }` 容器，开关放进去；UI 测试断言 `getComputedStyle(parent).getPropertyValue('-webkit-app-region') === 'no-drag'`。**教训：凡放进窗口横条的交互控件（tab 之外的一切）都必须显式 no-drag，且这条只能用计算样式断言，浏览器点击证明不了。**
- **HB-151（fixed@5bbd4be，使用者报障）**：**节点窗口的「格式」与主聊天不同** —— 它自带 `.agent-chat-window` 壳（宽 `min(680px,100%)`、自己的 `agent-chat-header`/`h3`/eyebrow、并把 `.message-stack` 压到 `min(86%,560px)`），所以看起来是另一个产品。现在页模式的转录只渲染主聊天的类（`conversation-thread-shell` > `conversation-thread` > `conversation-thread-inner`），窗口框架由节点标签自己给：一个 `conversation-header`（标题=Agent 名 + 节点 id，meta=状态·只读·模型）+ `conversation-body > conversation-main`，概述与提示词作为 `conversation-alert` 块置顶（提示词默认折叠，把空间留给对话）。路由 `/tasks/:id/nodes/:id` 也纳入 conversation-first，窗口才与对话页一样满宽。测试断言的是「同一套类 + 一个 header」而不是文字。
- **HB-152（fixed@94551f2，本轮现场抓到）**：**在没有草稿的任务上查未知节点 → 500** —— `nodeRun` 的容器回退先调用 `loadGraph`，而没草稿的任务没有图，于是抛 `Cannot read properties of undefined (reading 'spec')`。修法：回退只在真有图时尝试，否则保留原来的 `not_found`。红测试钉住「无图任务 + 未知节点 = 400 Unknown node」。
- **HB-153（fixed@4a0d6a9 + 279fffa）**：**共享产物索引默认开在「配置里的第一个项目」**，而用户产物多在别的项目 → 页面一片空，看起来像功能坏了。入口链接现在带上来源项目（对话/任务抽屉带会话项目，壳级目录带当前任务的项目，回落到第一个）。**诚实标注**：第一次提交的信息写的是「the project you are working in」，代码却读 `settings.projects[0]`（第二条修正 `279fffa`）——文案与代码不一致是我的错，值得记一条：提交信息里的行为描述必须逐字对照实现。
- **HB-154（open，中，本轮实测，扩展 HB-130）**：**「重建 web」不等于「服务端也是新的」** —— 使用者报 `GET /api/projects/<id>/artifacts?include=task&... not found`，而我同机新进程实测同一条 URL 是 200：界面连的 daemon 是几小时前启动的进程（它按磁盘读 `dist/web`，所以**页面是新版**），服务端路由来自进程，必须重载才会新 → 「页面新、路由旧」是这条的典型形状。另外：**重载后已经打开的页面会拿着旧会话 token，直到自己重载前每个请求都 401**（页面把 401 当硬失败显示「Authentication required」，我在核实过程中被它误导过一次；桌面 App 会自动重载页面，浏览器里不会）。建议：401 时页面自动重取一次 token 并重试；文档里把「web 改动 vs 服务端改动」的重载边界写清。
- **HB-155（open，低，本轮一次跑到）**：`app-shell-ux > the resource library groups reusable assets` 依赖**宿主能力库里的真实技能**（断言里点名 'Preserving Productive Tensions'）；本轮一次全量跑到「Skills 库 0 项」而红，同一门禁重跑即绿——夹具读的是运行机器的目录状态，属于环境依赖。建议：夹具自带一个临时能力目录，或缺失时明确跳过并打印原因。
- **HB-156（harness，open，低，本轮实测）**：**`agent_browser` 的 `wait --text` 对确实存在的文本报了「不存在」** —— 索引页 DOM 里含 `Graph harness backlog（v134）`，`--text "Graph harness backlog"` 等 25s 超时；同一页面用 `eval` 读 `textContent` 清楚看到它。断言文字用整段/全角括号混排时不可靠，建议改用明确的 `eval` 读取（或让 `--text` 做规范化匹配）。
- **HB-157（fixed@de67584，使用者本轮的三个功能）**：**多 Agent 协作的三项机制**（私有草稿纸 / 条形码清单 / 无冲突合流）。落点是**在现有 worktree 隔离之上增量**，不是单目录 + 写时复制：MiniMax Code 的子 agent 其实继承父目录（`workspaceDir: parentSession.workspaceDir`），并发安全靠事后快照重算 diff（`LocalTurnDiffRecord`/`LocalTurnDiffSnapshotEntry`）与写前比对（`LocalTurnDiffRewindCapability`），**真有并发写时没有硬隔离**；Graph 的路径层（`bounded-path.resolveBounded` 以 lane 为根）、OS 沙箱层（`restricted-process` 逐路径授权）与策略层（`access-policy.filesystem.write`）全部以 lane checkout 为锚，改成单目录会让这三层失效。三项机制：①每次写工具调用前后记录文件（sha256/size/存在性/限定内的文本），形成「磁盘说的变更集」，`bash` 故意不记（shell 可以经重定向或子进程写，单路径快照是把猜测当证据）；②`submit_result` 的 `changes[]` 与账本逐一核对——没动过的文件、与字节矛盾的 digest、漏报的真实改动全都拒收，且**比较的是 worker 原始 digest**（在 host 修复之前），否则一个与磁盘矛盾的声明会被悄悄改正；③同行走冲突时在集成 worktree 里给 merge Agent 两侧内容与共同祖先，**由 harness 判定**：两侧改动必须都存活、不得留冲突标记、冲突路径之外不得有改动，否则 `merge --abort` 并照旧 block。现场证据：`/tmp/occham-evidence/live-ledger.mjs`（诚实清单 ACCEPTED；漏报/错 digest/未动过 三种都 REFUSED）、`live-conflict.mjs`（真合并产生 2 父提交且两侧文本都在；丢掉一方 → blocked 且 tip 未变、工作树干净）、`focused-tests.txt`（5 文件 24 测试）。
- **HB-158（fixed@de67584，本轮顺带）**：**集成 tip 的读取缺陷** —— `restoreOutOfScope` 的基准取 `task.integration_sha`，而任务**第一条 lane** 时该列仍为 null，于是越界还原被静默跳过、lane 的野生文件照样落地。修：基准回落到集成分支的 HEAD（同一事实）。这是「无冲突合流可靠」的前提。
- **HB-159（fixed@de67584，本轮顺带）**：**新增迁移必须同步 `SCHEMA_VERSION`** —— 我加了 `user_version=39` 的迁移却漏改常量（仍是 38），于是新代码写的库被自己判定为「newer runtime」而拒开。已修并调整测试名（不再把版本号写进测试标题）。
- **HB-160（fixed@1b7bbfc，本轮接线）**：**合流 Agent 已接进运行时**。使用者定的三项（medium 模型、预算无限制、完全访问）按原话落地并被记录在代码注释里，避免日后被悄悄改掉。接入方式是复用派发自身的机件（agent context 装配、能力包、命令运行器、发送门），不是另开一条平行通路；判定仍由 harness 做，接线只负责产出那一次回合。**两道闸都是因为「沉默比停下更糟」**：①**必须给 prompt library**——不给时身份解析为空，Pi 会补一句通用 worker 兜底，于是「丢掉任何一侧都不是合并」这条纪律恰好在那次最不能自由发挥的回合里消失；②**必须完全访问**——更窄的策略写不进集成 checkout，于是明确按名字拒掉，而不是跑一半再含糊失败。**现场证据**（不是只有单测）：真实撞车经真实 runtime 发出 1 次模型请求，其 system prompt 就是以合流身份开头（`你是 Matt 工程流里的「合流」Agent…`），并带闸门命令行与「两边都要活着」那条；返回散文却没解冲突文件的 provider 被判「留下了冲突标记」而拒。证据文件 `/tmp/occham-evidence/merge-identity-live.txt`。
- **HB-161（harness，open，低，本轮实测）**：**`node --run check` 在机器负载高时会大量超时** —— load average ≈10 时 `shell-tabs-ui`/`planning`/`git-recovery` 等 8 个文件同时报 20–50s 超时（单跑全绿），另有两个 vitest 孤儿进程驻留。建议：门禁前置一项负载检查，或在超时消息里带上当时的 load，否则很容易被误读成代码回归。
- **HB-162（fixed@5e7a45d，本轮）**：**合流 Agent 配方 + merge 闸门 stage**。`matt-merge`（Frank_merger，medium，`review:false`——它会写文件，所以不是独立审查通道），身份 `matt-pocock-merge`，绑定 `code-review` 与 `fff`，与 `matt-review`/`matt-implement` 结构逐字同形。闸门新增 `node scripts/matt-flow.mjs --stage merge <ours> <theirs>`：不收 slug（撞击与规格无关），查「这次合并到底有没有冲突」，不带 ref 时读工作树里未完成的合并，并拒绝冲突之外的一切改动（含未跟踪文件）——那正是合流判定会拒的东西，提前说清就不让 Agent 白做一轮。**端到端验证**（不是只看磁盘）：真实派发一个引用 `matt-merge@1` 的节点，断言它收到的 system prompt 真的以合流身份开头且含闸门命令行（`tests/console/matt-merge-recipe.test.ts`）。**顺带修一个潜伏参数解析缺陷**：原解析器把第一个非 `--` 记号当 slug，于是 `--stage merge` 把 "merge" 读成 slug；现在带值的 flag 会被正确跳过，其它 stage 一并受益。
- **HB-163（harness，fixed@9412d6ec，低，本轮实测）**：**已修：机械守卫，而不是靠自觉。** 类型救不了这一类（把 Promise 交给 `JSON.stringify` 是合法的），所以 `scripts/check-floating-promises.mjs` 新增规则：只认**语句的根调用**（`await`/`void`/`return` 的根表达式不是 `CallExpression`，自然跳过），并带自测断言。**守卫已证明会响**：把漏 await 的写法塞进 `src/catalog/catalog.ts` → `lint` 报 `catalog.ts:125`，还原后干净；全仓当前零命中。第一版规则写成整句文本匹配，误报了 26 处（`test('…', async () => { await … })`），故锚定根调用——**会误报的守卫等于没有守卫**。**`saveAgentCombination` 是 async，忘记 await 会静默得到 `{}`** —— 我第一版测试漏了 `await`，返回的 pending promise 被 JSON.stringify 成 `{}`，表现为「配方没保存」而不是报错。同类 API（`updateAgentCombinationDescription`/`deleteAgentCombination`/`compileAgentCombination`）只有部分异步，容易踩。建议：要么统一同步语义，要么让返回类型在漏 await 时不可当对象用。
- **HB-164（fixed@c483f39，本轮接线时暴露并修掉）**：**合流回合的 token 不计入任务预算** —— 它不是 operation，于是不占名额、不写 ledger、不产出证据；无限预算下看不出来，但**一旦任务有有限上限，一次撞车里的合流会静默烧掉看不见的额度**。修法两条一起：①把每次 settle 的用量累加（同一回合内的重试也算）并在判定之前就记到任务上（`git.conflict.merge_attempt_usage`），**无论合并成功还是被拒**——模型都已经被付过钱了；②当任务的实例不是全部无上限时，**在发送前就以 `budget` 拒掉**并说清原因，因为「账上看不见的花费」比「一次能被人工处理掉的阻塞」更糟。现场证据：`/tmp/occham-evidence/merge-usage-live.txt`（一次合流请求在任务上留下 `input 25, output 10, cacheRead 15, total 50`，紧跟其后的是那次拒绝）。
- **HB-165（fixed@9412d6ec，中，本轮实测并已更正一次）**：**已修：控制台「常规」页新增「运行中的代码」卡片。** 新增 `src/server/source-identity.ts`，在**启动时读一次** git HEAD/分支/是否脏（打包应用无 `.git` → 返回未知而非编造；`git status` 输出为空**且成功**必须读成「干净」而不是「未知」），经 `StartupInfo.source` 送到页面。**现场证据**：用户 app（PID 41030）的 `/api/startup` 返回 `source{root:/Users/macmini/workspace/graph-rsi, commit:9412d6ec…, branch:rsi/product-line, dirty:false}`——这个字段旧代码根本没有，所以它的存在本身就是「新服务端代码在跑」的判据；控制台卡片四个 testid 全部可读，截图 `/tmp/occham-evidence/hb165-live-running-source.png`。**顺带看清一件旧事**：`ps` 显示 Electron 外壳来自 `13-Graph/dist/app`，而服务端源码来自 `graph-rsi` —— 这正是本条要消除的混淆。**「提交了」不等于「运行中的那份代码有」**，而真正的边界是 **运行中的 daemon 从哪个 checkout 加载源码**。**更正**：我在同一条里先写成「打包应用里跑的是构建时的 src 快照」，那是错的——`ps` 显示用户机器上的 daemon 是 `Graph.app/Contents/MacOS/Graph /Users/macmini/workspace/graph-rsi/src/server/cli.ts --web-dir .../graph-rsi/dist/web`，即 Electron 只当外壳，**服务端源码来自 graph-rsi 这个 checkout**（`GRAPH_RSI_ROOT=/Users/macmini/workspace/graph-rsi`），`Resources/app/src` 根本不是运行的那份。所以正确形状是：**提交到 13-Graph/main ≠ 生效**，要让 app 里生效必须 ①graph-rsi 这个 checkout 更新到该提交 ②重生 dist/web（若改了前端）③触发重载。我为此白跑了一次 13-Graph 的 `app:build`（约 2 分钟，而且它**不解决**问题）。**可核对的证据**（值得固化成检查）：新代码的迁移把 schema 从 38 提到 39，于是**看运行中 state DB 的 `PRAGMA user_version` 与 `node_write_captures` 表是否存在，就能判定 daemon 到底跑的是哪份代码**——比读进程启动时间可靠得多。建议：控制台「关于」显示运行中 checkout 的 HEAD 与源码根，让这件事一眼可查。
- **HB-149（open，低，早前实测，仍未修）**：**节点窗口的「概述」不随事件流刷新** —— `NodeChatTab` 的 `node-overview`（状态/用量/历时/记录数）只在打开时读一次，只有转录订阅了实时流；节点跑动时那些数字会停在打开的那一刻。建议：把 run 视图也接到同一个事件游标上，或让概述按 transcript 的最后一条记录重新取一次。
## 本环境的事实（避免重复踩）

- **技能三层来源**：项目 `<root>/.agents/skills`（免绑定、随 git）、Agent 目录 `~/.graph/agents/<recipe>/skills`（配方绑定技能的 symlink 镜像）、能力库 `<capabilityRoot>/skills`（需 `capability.json` + 配方引用）。
- **车道遥测的路径约定**：worker 车道收到 `stateDir` = **它自己的实例目录** → spool 在 `<root>/instances/<instanceId>/tool-calls/<id>.jsonl`；守护进程根目录 `<root>/tool-calls/` 也读（宿主跑的 check/fixture 收根目录）。吸入按文件字节偏移幂等，读取时按 stateDir 合并并发。
- **`.agents/` 被 .gitignore 忽略**（第 34 行）→ 想在仓库里放技能样本，别用项目布局，用 lint 的 `--skills <dir>`。
- **`.mjs` 脚本可以直接 `import` `src/**/*.ts`**（Node 24 原生类型剥离，本轮实测 `node -e "import('./src/runtime/sediment.ts')"` 通过）→ 纯逻辑仍放 `src/`（受 typecheck 与单测保护），脚本只做 IO 与打印。
- **`disable-model-invocation: true` ⇒ 不进 `<available_skills>`**（只可 `/skill:<name>`）；看到「绑了却没出现在提示词」先查它。
- **改配方必须走控制台 route**（`POST /api/catalog/combinations`）；`agentContextPreview` 预览「该配方最新版本」，`sent` 字段才是真实请求体。
- **RSI 变更的结构**：`changes[]` 每个条目必须自带 `path`；`edits` 里只能放 `{oldText,newText}`；**不要**把 `checks`/`title`/`problem` 放进 change 对象，也不要嵌套另一个 change；**顶层 `title` 与 `problem` 必填**。手工改过的文件要先 `git restore` 才能作为 change 传入。
- **`.mjs` 不受 typecheck 管辖**：语法错误只有运行它的测试/脚本能抓。
- **迁移清单**：①`SCHEMA_VERSION` +1 ②`if (version < N)` 块（**且要对降版本号重放幂等**）③降级测试是否要 DROP。
- **仓库里已有先例可循**：派生遥测、受限副调用（`prompt-suggestion.ts`）、程序节点、等待使用者问题（`kind:'waiting'`）。**先找先例，再设计**。
- **测试顺序**：先红（桩 + 真断言）→ 跑出红的证据 → 再实现（绿）。每阶段末跑全量门禁 + 真浏览器 E2E。
- **同一个带 hash 的 URL `goto` 不触发导航**（用 `location.reload()`）；**原生 dialog 必须显式接手**；**上下文体积必须标通道**；**断言失败先看「收到的值」**；**统计读取时剪枝 → fixture 的 `at` 用当前时间**。

## 本版现场事实

- 生产库 `PRAGMA user_version = 38`；`tool_calls` 表含 `target` 列；重载后 0 → 309 行（含 master 直写的 6 次 `read` 目标）。
- 控制台 `http://127.0.0.1:65146`（`<stateDir>/console.json`）；工具页 `#/tools` 显示「工具与角色」13 组合 / 320 次 / 98.4%，「技能使用」可显示真实被读次数。
- RSI 侧全量门禁（`node --run check` + `app:build`）exit 0（RSI 收据 `ccfa012a`）；沉淀 E2E `node --run e2e:sediment` exit 0。
- 沉淀现场：开关 `{enabled: true, afterToolCalls: 3, model: "deepseek-flash", budgetTokens: 40000}`（config rev 216）；已完成一次真实写出（见上表）；`skill_sediment.reviewed` 现带 `attempts[]` 与作答模型 `model`。
- 磁盘：`/` **5.1~5.4 GiB** 可用时 `app:build` 成功（HB-113 的反面证据：786 MiB 时 DMG 步骤失败）。

## fixed（摘要）

`2faed549` **HB-134 返工分支的脚本化 E2E**（使用者点名：同会话发增量、无会话发全量）：`tests/m8/rework.test.ts` 新增真实路径用例——脚本化 program 检查第一轮返回 `{kind:'verification',outcome:'rework',blockers:[typecheck-failed]}`、第二轮通过，`loops: [{from:'check',to:'work'}]` 把 worker 送回第二刀。断言按**每轮最新一条 user 消息**读：第一轮（无会话行）拿到**全量**简报（`Your node: work (agent work)` / `files: src/a.ts` / `Request: 修掉类型错误`），第二轮（同会话）只拿到**增量**（`Rework (attempt 2, same session)` + 失败裁决 + 被挡住的验收，且**不含** `Your node` / `Task graph` / `Request:`）。

修东西过程中查出并修掉一个**真缺陷**：`reworkDelta()` 原来从**节点状态**取证据，而 loop 会在重派前重置 loop 点之后的所有节点（含那个要求返工的检查）——实测那一刻 `check` 还是 `running`、`result` 为 NULL，于是增量永远渲染成「没有失败证据」。改成从 **operations 台账**读每个读者节点最后一次已结算的 operation（`state === 'failed'|'blocked'` 或 `isReworkDecision(result.output)`），`verdict rework` 与否在行里标出。教训：**loop 点之后的节点状态会被重置，裁决只活在台账里**；`reworkDelta` 也因此不再需要 `GraphState`。

`19778c5a` HB-109 E2E 播种改真实位置；`bb5beffe` HB-102 车道 spool 读取端；`54c06ab1` HB-110 迁移 38 幂等；`43c386f0`/`86eab65c` P4；`25f6d49b`/`96091edf`/`fb0bb830` P3；`84be6329` P2 清理；`59ced2a3` HB-105；`9394e5f7` P2 数据通路与 `/api/skill-stats`；`10ffc8c8`/`e27f9fea`/`ca9e6bc0` P1；`33c1ff8a` 制品上限 1,000；`7ba0c217`/`3a76bf80` HB-90；`172f4a85` HB-100；`23f83349` HB-97；`093d29b` 两条线收敛；`751bf38` 同端口重载刷新；`be0ebd46`…`767179c4` 端口复用；`ec2e20ed` read 截断 banner；`a043878b`/`b20736d3` RSI 缺 path；`29933d8e`/`253fd500` HB-89；HB-86；`19c044b4`…`67162fed` HB-82；`df2e348e` HB-87；`3fa0aae`…`33d2ae47` 真浏览器 E2E；`7f71119c`…`794eef9c` B1–B9；`fff69e7`/`c641a17`/`79fd064` 工具遥测；`72a37f5` HB-74；`5602a98`/`df43426`/`fc8642e` 控制面；`c8d2d18`/`ce45b89` HB-75；`481a5af`…`9d715f1` 大结果懒加载；奥卡姆三步；`44eeff3` 多账户用量；`49ecd89`/`5f1bfa8` Pi 升级；`4c4f49e`/`d55399c`/`984eb97`/`d25c668` 桌面与配置；`ffa4ac7` 状态库回收。

- 新增教训：**loop 重派前会重置 loop 点之后的节点**——需要「刚刚那次返工为什么失败」这类证据时，读 operations 台账（`state` + `result`），不要读节点状态。
- 返工两条分支的现场证据：`tests/m8/rework.test.ts` 的 `the second round of a rework reads the failure, not the briefing its session already holds`（`node node_modules/vitest/vitest.mjs run tests/m8/rework.test.ts -t "the second round of a rework"`）。

- **HB-166（harness，open，低，本轮实测）**：**UI 组件会静默丢掉认不出的 prop** —— 我给 `<Pill>` 写 `data-testid="source-dirty"`，而 `Pill` 只接受 `testid`；React 对组件不转发未知 prop，于是 testid **凭空消失且不报错**，卡片文字照常渲染、断言 `get('source-dirty')` 返回 null。同类：`Card` 也是 `testid`。建议：`Pill`/`Card`/`StatusDot` 接受 `data-testid` 作为别名，或让 props 类型对未知键报错（`exactOptionalPropertyTypes` 管不到这个）。**这条正是「浏览器里读 DOM 而不是看截图」抓出来的**——截图里那句「有未提交改动」看起来完全正常。
- **HB-167（harness，open，低，本轮实测）**：**测试辅助函数用 mock 当默认参数，会让「跑真路径」的测试其实没跑真路径** —— `tests/console/rsi.test.ts` 的 `service(root, stateDir, validate = passing)` 默认注入 mock 校验器，于是 `service(root, dir)` 看起来像走 `defaultValidate`，实际没有。我为它白花一轮（新用例断言 `app:build` 结果，却得到 `validation: []`）。建议：默认值去掉（强制调用点显式选择），或把函数改名 `mockService` / 另给 `realService`，让「用真校验器」成为显式意图。

- **HB-168（fixed@71d059c4，多 Agent 协作第 1 项）**：**harness 自动唤醒 main agent 的四类事实**。唤醒机制其实早已存在（把 master 置 pending + `execution.kick`，UI 守护进程已开 `autoWake`），但只有 4 个唤醒点（main 拥有的问题 / 配置恢复 / 重载后 / 点继续后）；真正缺的是**任务结束**（`task.completed` 只写事件，没人叫醒 master，`execution.ts:1049`）、**节点阻塞**（问题归用户时只进人工收件箱，`question-routing.ts:203`）、**待验收**（用户点通过连 `human.accepted` 事件都不存在，只有 `human.rejected`）。落点：`src/core/wake-ledger.ts` 一张 `wake_intents` 表，**幂等由主键保证**（`PK(task_id,node_id,kind,dedupe_key)` + `INSERT OR IGNORE`），状态机 `waiting→ready→consumed` 与 `rsi_continuations`/`pause_continuations` 同形；`wakeMaster()` 是唯一投递通路（四个产生点不再各自改节点状态）。**现场证据**（在真实 state 库副本上跑，不改用户数据）：同一事实连送 5 次 → 返回值 `[true,false,false,false,false]`、表 1 行、`wake.ready` 事件 1 个、master 只置一次 pending；消费后再观察同一事实 → 不重放（仍 `consumed`）；另一条真事实（真实 blocked 节点）产出 `node_blocked`，去重键 `task:node:permission`。判据：运行中库 `user_version=40` + `wake_intents` 表与索引存在，表结构与迁移逐字一致。**为什么不用 Pi 的 hooks**：Pi 的 hook 面是**会话内**生命周期（`session_*/turn_*/tool_call/message_*`，`core/extensions/runner.js`），而唤醒 master 恰好发生在**没有任何 Pi 会话在跑**的时刻（master 回合已结束，这正是要叫醒它的原因），所以没有对象可挂——Pi hook 的用武之地是第 4 项（subagent 在自己回合里找 main / 别的 subagent）。**有意不做**：`human_check` 的「打开」不唤醒（那是第 2 项「main 先验收」的挂点，届时才知道 master 在那一步该审查什么）。**顺带修的两个真缺陷**：①master 回合一旦真被派发就在 `graph.sources(node.id)` 上抛异常——master 节点不在它自己会话的图里，而 `sources()` 用 `!` 断言，说明这条路以前几乎没被真跑过；②`migration 34/35` 是裸 `ALTER ... ADD COLUMN`，使「降 `user_version` 模拟旧库」的 fixture 在版本 25 处中止——**两个既有用例本来在测「中止」而不是它们声称的行为**（`question-routing` 的版本断言、`skill-usage` 的硬编码 39），现已改成测真行为并绑定 `SCHEMA_VERSION`。E2E 按使用者确认的 (a) 与第 2 项合并做（届时共用一个「已确认任务 + 验收契约 + 上下文交接」的 fixture）。

- **HB-169（fixed@b356355b，多 Agent 协作第 2 项，含第 1 项遗留 E2E）**：**main 先验收**。原状：`graph.human_check` 打开时把 owner='user' 的问题直接交给使用者，仓库里没有「main 先审」这个概念（`human_check` 的 answers 只有 acknowledge/reject，main 无法对它表态）。使用者确认语义 **(a) main 是过滤器不是代签**：只能放行或打回，**用户仍必须自己点通过**。落点：①新唤醒种类 `human_check`（与 `node_blocked` 分开——main 不是在解阻塞，而是在看证据）；②`approveHumanCheck()` **不改 owner、不改 status**，只在问题 data 上写 `preReview` 记录 + 发 `human.prereview_approved` 事件，使「main 何时看过、放行还是打回」可追溯；幂等（已放行再放行返回 false 且不写第二份）；③打回复用既有 `rework` 问题（它已表示「退回给 main 修」且会到达该节点自己的回合），不新造第二种「驳回」表达；④master 新增 `list_human_checks` / `review_human_check`，同时接进真实回合与预览（预览与真实工具面必须一致）。**现场证据**（真实 state 库副本，不动用户数据）：①打开后待送达唤醒 = `["human_check"]`；②待审清单列出该检查；③放行后 `owner/status` 仍是 `user/open`——**放行不等于验收**；放行后再列不再出现，事件 1 个；④再放行一次返回 false、事件仍 1 个（幂等）；⑤`human.accepted` 计数 0（没有替用户批准）。**运行中 app 的活证据**：`/api/startup` 的 `source.commit = b356355b…`（新代码在跑），且 `/api/agent-context` 的工具面里 `list_human_checks` / `review_human_check` 都在（50 个工具）——用的正是本会话，所以预览与真回合一致。**同时补上第 1 项欠的 E2E**（`human-prereview-e2e.test.ts`，真 server + 真模型请求）：验收点打开 → master 被幂等唤醒 → 真回合被派发，发出去的工具含这两个、briefing 含「You were woken by the harness」与「human acceptance check」→ 检查仍 open 且 `human.accepted` 为 0。
- **HB-170（fixed@b356355b，当场证据是运行中 daemon 的两条真实唤醒）**：**我自己上一轮的唤醒收窄错了三处**，且是**真实运行**暴露的：唤醒原文写着「Node **master** stopped and only a person can unblock it (waiting)」+「The user answered waiting on node master」——那其实是我自己的 `ask_user` 提问。三个独立缺陷：①**user-owned 的问题也唤醒了 master**（本意只是「图卡住了要告诉 main」，但当时把「归用户」当成「不该叫 main」，于是连 master 自己的提问也触发）；②**master 自己提的问题（`selfOwned`）会唤醒它自己** ——自我循环，因为唤醒检查只排除了 human_check 没排除 selfOwned；③**归 main 的问题只置 pending，没有幂等记录**，于是同一次事实可被观察多次而无人记账。修复：所有唤醒路径统一走 `wakeMaster` 并各自排除 `selfOwned`；按「归属决定谁回答，不决定 main 是否知情」把语义写进用例（user-owned 的 permission 仍 `node_blocked` 告知 main）。教训：**「引擎跑起来」不等于「引擎接对了」——新机制上线后第一件事应是读它自己产生的真实记录**，本轮正是靠读 `wake_intents` 内容才发现三处收窄错误，而机制层 8 个用例当时全绿。

---

## HB-171（**已撤回 @df96341**）任务结束卡片：运行时间 / tokens / 费用 / 结果

**问题**：第 3 项（使用者清单）。任务结束后没有任何回执——用户要自己翻事件流或节点面板才能知道一个任务花了多少、交付了什么。

**关键决定（使用者纠正了我一次）**：卡片由 **harness 拼**，不经过 master。我原先设想「master 被唤醒后写卡片」，使用者指出这些信息 harness 本身就有，让 master 转述只是多余的中间人。采纳后设计更干净：投影是纯读账本，不可能与账本不一致。

**实现（数据全部来自既有记录，零新埋点、零新列、零新增模型调用）**：
- `src/core/task-summary.ts`：服务端投影。运行时间 = 任务首事件 → `task.completed`/`task.abandoned` 时间戳；tokens = 各节点 instances.used 之和；费用 = `sumCosts(invocations)`（多币种不相加）；结果 = phase + integration_sha + 通过的验收证据。
- `/api/tasks/:taskId/summary` 暴露同一份投影，供不开页面的调用方直接读事实。
- `src/web/format.ts`：把 `costText` / `formatTokens` 从 `shared.tsx` 搬到无 JSX 的模块（原实现让一个普通模块为了格式化费用而 import 一个 .tsx，`tsc` 直接报 TS6142）。一份措辞，不是两份。
- `src/web/task-card.ts` + `TaskEndCard.tsx`：纯投影 + 卡片，只读控制台**已经在轮询**的会话视图——没有新 SSE、没有新 fetch。
- 语义守卫：**被中止（abandoned）是结束但不是交付**，卡片写「已中止」且不显示交付块；未记录用量一律「未知」而非 0；运行中的任务**根本不渲染卡片**（卡片是对已结束之事的报告）。

**证据**：
- 真 daemon + 真浏览器 E2E `scripts/task-card-e2e.mjs`（EXIT=0）：DOM 读出 1 张卡片、`delivered`/已交付、`0.42 USD`、`8,200` tokens、节点明细、交付 `deadbeefca → main`、通过验收 `card-shows`；**仍在跑的任务没有卡片**（`hasLiveCard=false`）；无 pageerror。
- **生产数据实况**：在运行中的 app（`source.commit=35f6530`）里打开本会话，DOM 读出 **10 张卡片**——5 张「已交付」（带 sha 与通过验收项）、4 张「已中止」（正确地未被说成交付）、真实 token 合计（如 `2,885,073`）。截图 `item3-live-card.png`。
- 先红后绿：`task-summary` 9 例、`task-card` 8 例。全门禁 **1400 passed / 202 files**。

**顺带发现的真缺陷（HB-172，open）**：多币种费用显示。生产数据里出现 `0.993084 USD（另有未知价格调用）`——这是既有 `costText` 的行为（把没有币种的价格当 '' 拼进去），卡片沿用了它。金额本身是对的、也没把两种币种相加，但「USD」数量级看着像很多币种的混合。属于既有显示措辞问题，不阻塞本次交付，留作待办。

---

## HB-173（fixed@df96341）撤回任务结束卡片：使用者改主意，功能下线

**决定**：HB-171 交付后使用者明确表示不再需要「任务结束卡片」，要求取消上线。以 `git revert --no-edit 35f6530` → `df96341` 保留历史地撤回（未改写已发布的提交），推送 main，并强制重载。

**已核实下线**：`/api/tasks/:id/summary` 返回 **404**（路由已移除）；`dist/web` 重新构建后 bundle `index-84lFlM50.js` 中 `task-end-card` 出现 **0** 次；全新浏览器会话打开会话页 `task-end-card` 数量 **0**；页面里残留的「已交付/已中止」字样全部落在我自己的聊天消息里（`inCard:false`）。门禁回到撤销前基线 1385 tests / 200 files。

**顺带暴露的真缺陷（HB-174，已修）**：源码回退 + 重载之后，**运行的 app 仍在渲染卡片**。原因不是回退没生效，而是 `dist/web` 是**构建产物**，回退源码不会重建它——`apply_rsi_change` 的校验跑的是 `app:build`（Electron 外壳），**不重建 `dist/web`**，而运行的 daemon 正是从这个目录发前端资源。我第一次的判断还错了一度：把一个陈旧被服务的 `index-84lFlM50.js` 当成了「服务端已无卡片」的证据，其实那个文件当时并不在磁盘上（`ls` 只有 `index-J1vgpayS.js`，含卡片）。教训：**回退前端改动时，重建 `dist/web` 是交付的一部分**；并且判断「服务端发的是什么」要 `ls` 磁盘 + 读实际 bundle，不能只看一次 curl。

---

## HB-175（诊断结论，open）第 ④ 项：subagent 之间的对话**没有打通**——只有 main 能跨会话说话

**使用者的判断**：认为 `conversation_read` / `conversation_write` 已经把「不同 agents 直接对话」打通了。

**结论：工具与深模块都在，但只挂在 master 回合上。subagent 一个都用不了。**

证据（读代码 + 生产数据 + 运行中 app 三条独立来源，互相印证）：

1. **唯一的 role 门**：`src/runtime/pi-adapter.ts:445` —— `...(channels?.conversations && conversation && spec.role === 'master' ? { conversations: openConversationTools(...) } : {})`。通道只在 `spec.role === 'master'` 时打开。
2. **worker 连会话身份都没有**：同文件 `:327` —— `const conversation = task.phase === 'chatting' ? conversationForTask(...) : undefined`。只有 anchor task 处于 `chatting`；图的 worker 节点不在这个 phase，所以 `conversation` 是 undefined，第 445 行的 `conversation &&` 也直接把它挡掉。**两道独立的门，都指向同一个结论。**
3. **生产数据零反例**：`conversation.handed_off` 事件共 3 条，caller 全是 master 节点的会话 id（`193ce3e1…` ↔ `28ed4d56…`），**没有一条来自 subagent**。
4. **运行中 app 实测**：master 会话工具面 50 个，含 `conversation_read`/`conversation_write`/`control_task`（三者都 `available: main && …` 或 role 门控）。
5. **设置页的预览也是写死的 `role: 'master'`**（`task-runtime.ts:1382`），所以面板永远只显示 master 的工具面——**这个面板无法用来发现 worker 少了什么**，是个观测盲区。

**这意味着第 ④ 项的现状**：
- 「subagents 向 main 提问」：❌ 不通。subagent 没有 `ask_user` 之外的上行通路去问 main（`ask_user` 是问**用户**）。
- 「subagents 之间互相协作」：❌ 不通。worker 之间没有任何通路。
- 「共享产物」：**部分已通**——`artifact_publish/read` 对同一 task 内所有节点可见（`assertScope`：`scope==='task'` 时 `ownerId === taskId`，即**同一图任务的所有节点都能读**），且 `agentArtifactAccess` 按 role 给不同命名空间与 `canPromote`。所以同图内的产物交换**不需要新机制**；跨图/跨会话才需要（那正是 `conversation_*` 的用途）。

**我建议的最小改动（待使用者确认）**：把 `pi-adapter.ts:445` 的 `spec.role === 'master'` 放开为「任何有会话身份的回合」，并给 worker 回合补一个会话身份。但不建议直接放开——需要先定三件事：① worker 能不能**写**别的会话（能写就等于能指挥别的图，权限面比 main 大）；② 署名链怎么防环；③ 出现 A→B→A 时谁负责收尾。

## HB-176（open）共享产物重构是否有必要：**没有必要**（评估结论）

使用者让我评估「共享产物重构」。结论是**不做**：

- 同图任务内，所有节点已能通过 `artifact_publish` / `artifact_read` 互相看到产物，作用域判定就在 `artifact-workspace.ts:299` 的 `assertScope`，语义清晰（task scope = 本任务所有节点可见；project scope = 同项目可见）。
- 「重构」会新增的唯一价值面是**跨图/跨会话共享**——那件事的真名叫「会话间对话」，正是 HB-175 要放开的那道门，不该另起一套产物机制去做。
- 奥卡姆：一个已经够用的作用域判定 + 一个待放开的 role 门，比一套新的「共享产物层」少两个实体。
