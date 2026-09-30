# Graph harness backlog

RSI 的输入清单：一行一项，带状态（open / fixed@<commit> / rejected / deferred）与证据。项目级可见。本版取代 `@185`。

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

规格：`docs/planning/skill-sedimentation-spec-2026-09-26.md`（制品 `plans/skill-sedimentation-spec@1`）。使用者选定的 P3 形状：**操作收尾后的受限副调用**（不是图上的显式节点）。

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

## HB-175（诊断结论 → **fixed@dd2871a**）第 ④ 项：subagent 之间的对话

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

---

## HB-177（fixed@dd2871a）同一张图的 subagents 可以互相通信（第 ④ 项交付）

**使用者的方向**（纠正了我给的三个选项）：「加入 node_id，让 agent 知道其他 agent 在哪，然后增强相关工具，让 agents 之间可以互相通信；不需要只能对正在跑的节点说这个限制。」这个方向比我的选项好——**根因是缺字段，不是缺权限**。

**真根因**：`messages` 表只有会话寻址，没有收件人。同一张图的全部节点共用一个会话（实测 `eb3eeb92` 的三个 worker 任务 `conversation_id` 全同），所以「worker A 对 worker B 说话」在物理上无处落地。

**交付**：
- `store.ts`：`messages` 增 `node_id`（发件节点）/`to_node_id`（收件节点）/`request_id`；`SCHEMA_VERSION` 40→**41**。
- `src/runtime/agent-messaging.ts`：`peerNodes`（别的 agent 在哪）、`sendNodeMessage`（**先解析地址再落盘**，被拒时不留半条记录；按 `requestId` 幂等）、`nodeInbox`。
- `src/runtime/conversation-scope.ts`：`sameGraphReach` —— **只同一张图**。这一条约束正是取代先前移除的链条/上限护栏的东西：subagent 不能指挥别的图，因为它无法命名别的图。
- 三个工具 `list_peers` / `send_to_peer` / `read_peer_messages`，只对**非 master 的图节点**声明；设置页预览对 master 写 `peers:false`，不再撒谎。

**证据**：
- 真 E2E（`tests/console/agent-messaging-e2e.test.ts`，真 store + 真图行 + 真工具工厂）：worker 看到 `peers=[build,check]`（不含别的图）；对**尚未运行**的 `check` 发送成功；DB 里该行 `node_id='build'`/`to_node_id='check'` 逐字正确；`check` 从自己 inbox 读到；对 `gB:build` 被拒且 `request_id='e2e-2'` 计数为 **0**。
- **生产数据活体验证**（真实库副本，任务 `eb3eeb92`，8 个真实节点）：`impl-model-listing → impl-model-step-ux` 投递成功并出现在对方 inbox；同 requestId 重放后 inbox 仍为 1（幂等）；跨图被拒且写入行数 **0**；`node.message_sent` 事件落账。
- 先红后绿：`agent-messaging` 8 例、`conversation-scope` 5 例。全门禁 **1399 tests / 203 files** 全绿。
- 运行中 app 核实：`source.commit=dd2871a`、`user_version=41`、三个新列存在。

**顺带修的真缺陷（HB-178，fixed）**：v41 迁移里的 `CREATE INDEX` 没有守卫 `conversation_id` 列，让手工构造的 v22 fixture 整条迁移链中止（`schema-upgrade` 测试先红后绿）——与早前「migration 必须幂等」同一类坑。

## HB-179（**fixed@c014748**）harness 缺陷：`apply_rsi_change` 用 `changes: []` 会假装成功

**实测**：在 source checkout 停在 `b356355`、我的提交只在 13-Graph main 与远端的情况下调用 `apply_rsi_change({changes: [], activate: true})`，返回 `status:"applied"`、`activation.state:"active"`、报告写「该提交已是运行中的版本，无需重载」——**而运行中的代码里根本没有我的文件**（`agent-messaging.ts` 不存在、`SCHEMA_VERSION` 仍 40）。

`changes: []` 的语义实际只是「重跑 check 然后确认当前工作树」，它**不会把新提交带进 checkout**，也不校验 checkout 里有没有你要交付的东西。若不是我随后去 `ls` 那两个文件，这次会以「已上线」收尾而功能一行都没跑。**教训：`changes: []` 不是交付，它只是检查；来源对齐必须自己核实（`git log -1` + 关键文件存在 + grep 版本号）。**这正是本轮第二次栽在「别只看一次返回值就下结论」上（第一次是 HB-174 的 dist/web）。

**修复（c014748）**：新增 `describeActivation`，状态**由「本次调用是否产生了提交」推导，绝不由 HEAD 单独推导**：没产生提交 → `checked_only` +「这次调用只跑了检查，没有产生提交：源码是否需要更新，请自己核对后再判断」；`active` / `pending_reload` 只在本次确实产生提交时可达。报告文案改由该函数给出。被改的既有断言（`tests/console/rsi.test.ts` 里 `toEqual({state:"active"})`）**原本就是在断言那句误导读法**——它守护的真行为（只跑检查不写 restart.json、不打断用户）保留，只换标签为 `checked_only`。先红后绿 5 例（含「activation 状态在本次调用没有提交时永不被声称」），门禁 1420 tests / 207 files 全绿。

---

## HB-180（调研结论 → **fixed@a1dc11c**）第 ⑤ 项：减少 main 干预

**调研方法**：只读真实生产的 state 库（本会话锚任务 `52e92a78` + 全部 questions/tool_calls），不靠推测。

### 一、main 的时间几乎全花在「自己动手」，不在「监督图」

| 工具 | 次数 | 平均耗时 |
|---|---|---|
| `bash` | 2309 | 11.1 s（≈7.1 h） |
| `apply_rsi_change` | 217 | 40.5 s（≈2.4 h） |
| `agent_browser` | 154 | 2.5 s |
| `edit`/`write`/`read` | 207 | ~9 ms |

锚任务 master 节点消耗 **1.62e9 tokens、19,903 次模型调用**。也就是说：main 的上下文和时间被**自己的 shell/RSI 操作**吃掉，而不是被"监督 graph"吃掉。

### 二、被 graph 打断时，main 做的事**绝大多数是机械的**

全部 questions：`owner=main` **237** 条 vs `owner=user` 94 条。main 的 237 条按 kind：

- `execution_failed` 114、`recovery` 91 —— 这两个占 **205/237 = 86%**，且都是 `answers: ['retry']`
- 需要判断的只剩：`rework` 13、`unknown_usage` 5、`model_unavailable` 5、`stalled` 4、`result_noncompliant` 1 等

**决定性证据**：`execution_failed` 的 114 条里，**105 条答案是 `retry`、0 条需要判断**。逐条读错误内容后分类：

| 类别 | 条数 | 可自动重试？ |
|---|---|---|
| `agent-browser not found on PATH`（环境） | 61 | ✅ 环境问题，已随 HB-165 `widenProcessPath` 修掉 |
| 网络中断 / 限流 / 上游 5xx / 超时 | ~40 | ✅ **全部是瞬时故障** |
| `thinking 回传协议` / `上下文压缩失败` / `result_handoff_invalid` | ~4 | ❌ 真需要判断 |

即：**main 被叫去的 105 次里，约 101 次只是一个「重试」按钮**。

### 三、结论与建议的最小改动（待使用者确认方向）

**根因**：瞬时执行失败（网络抖动、限流、上游 5xx）与真错误走**同一条路**——都抛 `execution_failed`，都归 main，都各唤醒一次 master 回合。而通往"环境失败"的机械判据**已经存在**（`src/runtime/rsi.ts` 的 `isEnvironmentFailure`，HB-137 就在用它决定重跑 `app:build`），只是**没有用在节点执行失败上**。

**建议（沿用最小实体）**：把 `isEnvironmentFailure` 用到节点失败判定上——瞬时故障由 harness **有界自动重试**（例如每节点 2 次，退避），只有重试用尽或判定为真错误时才唤醒 main。这样第 ⑤ 项的实现是：**一个已有的判据 + 一个已有的重试动作，接到另一个已有的产生点**，零新概念。

**仍必须留给 main 的**（不能自动化，否则是「瞎编绿灯」）：`result_noncompliant`、`rework`、`stalled`、真编译/测试失败、`result_handoff_invalid` —— 这些是**判断**，不是重试。

**同时暴露的一条**：main 自己动手的成本（7.1h bash + 2.4h RSI）。这与第 ⑤ 项「减少 main 干预」是同一件事的两面——**main 亲自跑 11 秒的 shell 命令，等于把自己变成执行器**。这一条我没有建议改法，先如实记下。

---

## HB-181（fixed@a1dc11c）第 ⑤ 项交付：瞬时节点失败自动重试，不再唤醒 main

**按使用者批准的四步实现**：判据接到 `execution_failed` 之前 → 瞬时故障有界自动重试（上限 2 次）→ 用尽/真错误照旧交 main → 真 E2E 两种注入。

**交付**：
- `src/core/environment-failure.ts`：网络/限流判据从 `rsi.ts` **搬出**，`app:build` 与节点失败**共用一份实现**（原先各写一份）；且**无输出的失败不算抖动**（不知道不等于抖动）。
- `src/core/transient-retry.ts`：`retryDecision`——瞬时故障重试至多 `MAX_TRANSIENT_RETRIES`；判断类、用尽、静默三类立即交 main，且问题里**写明是哪一类**。
- `src/core/operation-lifecycle.ts`：判定放在 **usage 记账之前**（要重跑的回合，用量是否可核账已不重要）；计数**复用 `stall_count`**（手动 retry 本来就会清零）——**零新列、零新迁移**；节点回 `pending` 让调度器自己再派发。

**关键修正（第一版 E2E 全红的真实原因）**：我最初把判定放在 `settle` 末尾，但它**永远到不了**——`unknown_usage` 守卫先 `return` 了。把判定提前到 usage 记账之前才是对的。这是「读代码不如跑一遍」的又一次证明。

**证据**：
- 真 E2E 走真实 lifecycle（`tests/console/transient-retry-e2e.test.ts`，4 例全绿）：①网络中断 → 回 pending、**无 open problem**、记 1 条重试；②真编译错误 → 第 1 次即 blocked 给 main，`retryVerdict` 含「判断」；③第三次中断 → 用尽上级，`transientRetriesExhausted=2`；④无错误文本 → 立即交 main。
- **生产数据活体验证**（真实库副本，真实图任务 `2cc29f90` 的真实节点 `impl-library-split`）：网络中断 → `{status:pending, stall_count:1, open:[], retries:1}`；真编译错误 → `{status:blocked, open:['execution_failed']}`。
- 先红后绿：`transient-retry` 单测 7 例。全门禁 **1410 tests / 205 files** 全绿。
- 运行中 app：`source.commit=a1dc11c`。

**预期效果**：按真实数据，约 **101/105** 次 main 干预被消掉；仍需 main 的（判断类/用尽/静默）保留且理由可查。

---

## HB-182（调研结论 → **fixed@dbf9765**）Graph 设计范例第 1 项：返工回边与条件路由

**调研方法**：读实现（`src/core/graph.ts`、`src/core/operation-lifecycle.ts`、`src/server/layout.ts`、`src/web/GraphCanvas.tsx`）+ 真实生产库统计 + 跑现有测试。不靠推测。

### 一、两个机制都真实存在且真的生效

**返工回边（`loops`）**
- 定义：`Proposal.loops: {from,to}[]`；校验（`graph.ts:70-76`）：两端必须是不同且存在的节点、不得重复、**`to` 必须确实是 `from` 的上游**（`ancestors(from).has(to)`），所以回边只能指向真正的上游，不会凭空造环。
- 触发：`execution.ts` 在验收/校验判定 `rework` 时 `reactivate(...)` 把上游节点重新置 `pending`（`graph.ts:197/222` 会清掉 `output`/`route`）。
- **真实使用**：33 个 graph revision 中多个含 `loops`，**本会话的图 `52e92a78` 就用了**。
- 测试：`tests/m8/rework.test.ts`（2 例）、`tests/m2/scheduling.test.ts` 都覆盖，全绿。

**条件路由（`routes` + `when`）**
- 定义：路由器节点声明 `routes: string[]`；下游节点/容器用 `when: {node, case}` 选择分支；校验（`graph.ts:45`）**必须选中该路由器声明过的 case**。
- 生效点：`GraphState.readiness`（`graph.ts:125-131`）——条件节点未成功 → `waiting`；成功但 `route !== case` → **`skip`**；`operation-lifecycle.ts:1163` 把 `result.route` 写进 `nodes.route`，且 `:1055` 校验返回值必须是声明过的 case。
- 测试：`tests/m2/graphs.test.ts` 有 `routes: ['text','json']` 的用例，全绿。

### 二、**但生产数据里条件路由从未被真正使用**

| 事实 | 数字 |
|---|---|
| `nodes` 总数 | 216 |
| `route` 非 NULL 的节点 | **0** |
| `status='skipped'` 的节点 | **0** |
| 声明过 `routes` 的提案 | **0**（33 个 revision 里一个都没有） |

即：**回边是「用了且真的生效」，条件路由是「机制正确、测试覆盖、但从未上过生产」**。这两者的结论不同，不能合并成一句「都起作用」。

### 三、可视化：回边有，条件路由**缺**

- **回边有画**：`layout.ts` 把 loops 建成 `loop:from->to` 边；`GraphCanvas.tsx:181` 以 `gridLoop` / `.grid-loop-edge` 单独渲染（并且故意**不**把回边放进分层布局，避免主路径被倒置）。
- **条件路由缺画**：`layoutGraph` 的入参是 `{nodes, containers, loops}`——**没有 `conditions`**。`Graph.conditions`（含 `when` 的节点/容器）是运行时 `readiness` 真的在用的东西，但它**不出现在传给布局的任何输入里**，因此「哪个 case 通向哪条分支」在画面上不可见。

**这是本轮唯一一个我判定为「真缺口」的点**：机制层完整、生产未用，且**缺可视化**——三件事必须分开说。

### 四、待使用者确认的方向（我不想擅自选）

1. **可视化优先**：给 `layoutGraph` 加 `conditions` 入参，把「router —case→ 分支」画成带标签的边（区别于普通依赖边与回边）。**改动最小，且它同时让「没被用过的机制」变成看得见的能力。**
2. **先做生产验证**：造一个真的用条件路由的图任务跑一遍，先证明它在真实运行时也成立（我目前的证据只到测试层与静态阅读）。
3. **两者都做**：先按 2 验证，再按 1 可视化。

我的建议是 **3（先 2 后 1）**：条件路由在生产里 `route` 全为 NULL 意味着**我手上没有它在真实运行时成立的证据**，而「如无必要勿增实体」的前提是知道现有实体的真实状态。但在动手前想跟你对齐一件事：**你要的第 1 项是「验证真的起作用 + 有可视化」，那么对于「从未上过生产」的条件路由，你希望我造一个真实场景验证它，还是只做可视化？**

---

## HB-183（fixed@dbf9765）第 1 项 (ii)：条件路由补齐——路由器真的会分岔

**使用者的设计（原话）**：「路由上层可以是工具节点，也可以是 agent 节点；如果是工具节点就很简单，实现定义一下，根据节点结果判定路由到哪；如果是 agent 节点也很简单，在最后 agent 工作完成后，让 agent 调用一个工具，或者结构化声明，来决定路由到接下来的哪个节点。」

**真根因（HB-182 认定的）**：不是「没人用」，是**没有任何东西能产出 case**——`result.route` 唯一产出者是测试自己的脚本适配器。

**交付（一个动作、两个来源，正好对应使用者说的两类上层）**：
- `src/core/router-action.ts`：`resolveRouteCase`。工具节点用 `byStatus`（按自身状态）或 `byField`（按产物某字段的映射）；agent 节点用 `declared`（自述）。**无论哪来，case 必须是该节点声明过的**，否则拒绝，绝不编造。
- `operation-lifecycle.ts`：settle 时从节点的 `input.route` 解析 case（在既有的「必须是声明过的 case」校验之前）。**声明了分支却没说怎么选**的路由器被当作图缺陷拒绝；**失败的路由器**不落任何 route（它根本没得出判断），而不是被迫选一个。
- `pi-adapter.ts`：agent 在 `submit_result` 的产物里写 `route` 即为自述——这是 agent 节点那一半。
- `templates.ts`：`router()` 模板现在自带选法，是**可用形状而非空壳**（刻意保留 action 名 `route`，以免破坏既有脚本适配器契约）。

**实现中发现的三个真语义（都已固化为测试）**：
1. **`readiness` 只认 `succeeded` 作为条件** → 一个 `failed` 的非 optional 节点会让图停住，所以**「检查没过」必须通过产物表达**（`graph.verify` 的 `outcome: 'pass'|'rework'` 正是此形状），而不是靠节点失败。`byStatus` 适用于失败不致命的 optional 门。
2. **optional 只决定「图是否被这个失败挡住」，不决定是否路由**——失败的路由器 verdict 仍然可知，所以照样路由到失败分支。
3. **拒绝路径不静默**：缺字段、未声明 case、只声明分支不声明选法，三者都在 settle 时明确报错并保持 `route=null`，分支停在 `waiting` 而非假装走了某条。

**证据**：
- 先红后绿：`router-action` 单测 8 例（含「未声明 case 一律拒绝」「映射不到就拒绝，不静默兜底」）。
- 真 E2E `router-action-e2e`（真 store + 真 graph_revision + 真 `OperationLifecycle`）6 例：状态映射使匹配分支 `ready`、另一分支 `skip`；字段取值路由；缺字段拒绝；未声明 case 拒绝；只声明分支不声明选法被当图缺陷拒；失败的 optional 路由器不崩 settle。
- **生产数据活体验证**（真实库副本，真实任务 `eb3eeb92`，在其图上加路由器与两条分支）：`verdict=rework` → 决策 `{case:'fail'}`，`readiness(fail 分支)=ready`、`readiness(pass 分支)=skip`；未声明 case 返回明确拒绝文案；缺字段返回明确拒绝文案。
- 全门禁 **1434 tests / 209 files** 全绿；运行中 `source.commit=dbf9765`，checkout 与 main 零差异。

**(a) 可视化 → fixed@cb45aa9**（见 HB-184）。

---

## HB-184（fixed@cb45aa9）第 1 项 (a)：条件分支在图上可见

**缺口**：`layoutGraph` 的入参是 `{nodes, containers, loops}`——**没有导入运行时真正据以分岔的 `when` 条件**，所以「哪个 case 通向哪条分支」在画面上完全不可见。

**交付**（`when` 本来就在节点上，所以这是**纯投影、零新字段**）：
- `src/core/branch-edges.ts`：把节点与容器上的 `when` 投成 `branch:<router>-><target>:<case>` 边；**读的就是 `GraphState.readiness` 读的同一个 `when`**。被 `when` 门控的容器，其分支画到它的成员上（否则被门控的分支组仍然不可见）。
- `src/server/layout.ts`：在 `positions`/`edges` 之外返回 `branches`，**刻意不喂给 ELK**——理由与回边相同：它们描述运行时「选择」而非依赖顺序，放进分层布局会把主路径掰弯。
- `GraphCanvas`：分支边成为独立样式（虚线、青色、`case: <name>` 标签），与普通依赖边、返工回边三者可区分。

**顺带修一个既有真缺陷**：**所有边标签从来就没显示过**。React Flow 只为它**内置**的边渲染 `label`，而这里两个边组件都是自定义的（`GridEdge`/`GridLoopEdge`），传进 options 的标签被静默丢弃——所以既有的「结果交接」标签也一直是看不见的。现在由边组件自己画标签，两者都出来了。

**证据**：
- 先红后绿：`tests/console/branch-edges.test.ts` 5 例（含「没有 `when` 就不造边」「分支边与依赖边可区分」「容器门也算」）。
- 真 daemon + 真浏览器 E2E `scripts/branch-edge-e2e.mjs`（EXIT=0）：真实路由器图上从 DOM 读出 `case: pass` / `case: fail`；4 条边（2 依赖 + 2 分支）；无 pageerror。
- **运行中的 daemon 上核实**（另起一个真 daemon，喂一个 `classify → (bug) fix-bug | (feature) build-feature` 的真实路由图）：浏览器里读出 `case: bug` / `case: feature`，截图 `/tmp/occham-evidence/branch-edges-live.png`。
- 全门禁 **1441 tests / 210 files** 全绿；运行中 `source.commit=cb45aa9`。

**第 1 项至此完整**：返工回边（本来就有，且有画）＋ 条件路由（机制补齐 `dbf9765`，可视化 `cb45aa9`）。

---

## 本版新增（Graph 设计范例第 2 步的实测）

### HB-185（fixed@5900d47）依赖链在**单次 `runReady()`** 里会断掉

**症状**：一个节点只因**前驱刚完成**才变 ready 时，单次 `runReady()` 不会派发它。

**坐标**：`src/core/execution.ts` — `readyNodes()` 在派发前**只扫一次**；下游当时读到 `waiting`，前驱跑完后**无人重扫**。`drive()` 在 `running.size === 0` 时直接 `break`，同样漏掉「刚变 ready」的节点。

**实测证据**（真 daemon + 真模型服务器）：`master` succeeded、`research` readiness 实测=`ready`、状态却永远是 `pending`。

**为什么现在没炸**：生产 daemon 有**定时重驱动**，所以表现为「慢一拍」。但在 `runReady()` 路径上是真卡死（测试与部分宿主路径）。

**已尝试的修复：失败，已回退**。改 `runReady()` 为循环扫描至无新工作 + `drive()` 清空时再扫一次 —— 我的链式测试确实转绿，但**全门禁炸出 20 个失败**（`scheduling`/`graphs`/`conversation`/budget/git baseline）：循环**扫得太急**，在先前工作还在 settle 时就重新派发，破坏暂停/阻塞/重试语义。**已 `git checkout` 完全回退，未留下半个修复。**

**量化结果（已量，结论收窄）**：
- **生产不受影响**：生产宿主循环走 `pump()`（`src/server/host.ts:88`），**每 40ms** 重扫 `readyNodes()`，所以依赖链只是**下一拍**被拾起。`runReady()` 在 `src/` 里**零调用点**（只被测试用）。所以原判断「真卡死」是错的——生产是「慢一拍」。
- **真正的坑在测试**：任何用 `runReady()` 走依赖链的测试都会看到节点**静默停 pending**。我为它浪费了数小时。

### HB-186（rejected）「派生节点拿不到 submit_result」——**该结论是我的测试伪影，不是产品缺陷**

**我先前报告**：手工 `publishDefinition` 时，worker 的工具面里有 `artifact_promote`（master 专属）却没有 `submit_result`，而 handoff 策略又要求它提交结构化结果。

**复核后推翻**。用生产的手写形状（无 master 节点、`begin`+`accept`+`await drive()`）在真模型服务器上实测：

- `workerHasSubmit: true`、`downstreamHasSubmit: true` —— 派生 worker **确实**被给了 `submit_result`
- `workerHasPromote: false` —— master 专属工具**没有**泄漏
- 三个节点全部 `succeeded`，**恰好 3 次请求** —— 链在**一次 `drive()` 内**排空

**我当时看到的「master 工具面」来源**：我的测试在**同一文件里跑两个 probe**，第一个的 `cleanup` 把 runtime 关了，而 master 循环仍在 `drive()`，于是记录到 211 次 master 操作、`execution_failed: RuntimeError: Runtime is closed`。**是测试生命周期写错，不是产品问题。**

**教训（已回写本条）**：报告缺陷前必须先排除**自己的夹具**在制造它——尤其当「缺陷」只在我的脚本里出现、而生产形状的既有测试全绿时。这也正是我**没有**先动产品代码的原因。

---

### HB-187（rejected）依赖链**深度 ≥ 3** 时…——**又是我的夹具伪影，不是产品缺陷**

**我先前报告**：同样图、同样 payload、同样 `drive()`，只改链长——2 链条全 succeeded，3 链条 n1 `blocked`、n2/check 永远 pending。

**查到底后推翻**。逐步实测：

1. 提交**没有被吞**：`inspectResultHandoffSubmission` 收到 62 次**合法** payload（`direct=OK`）。
2. 校验上下文**也不是原因**：`ctxKeys=workspace,rebindArtifact`——**没有** `changeSet`/`scope`，`laneSubmissionContext` 并未介入。
3. 真正原因：**`n0` 一个 operation 内跑了 801 次模型调用**（`n1` 只 1 次）。我的夹具给**每一轮**都回 `tool_calls`，于是第一个节点永远在调 `submit_result`，直到 scripted 回复耗尽 → 后面的节点拿到兜底文本 `"Unexpected extra request"`。
4. **对照**：换成诚实夹具（先 submit、再纯文本，模拟真实 Agent 交完就停）→ **2 链与 3 链都完整排空**，每节点 3 次调用，全部 `succeeded`。

**≈ 与 HB-186 同类**：又一次把「只在我的夹具里出现」当成产品缺陷。这次不同的地方是——我在**动产品代码之前**先怀疑了夹具。

**留作资产**：`tests/console/chain-depth.test.ts`（2 链 + 3 链都必须完整排空）。

---

## 本版收口

**HB-185 fixed@5900d47**：新增 `Execution.strandedNodes()`（经 `runtime.host.strandedNodes()`）：报出「依赖都已满足却仍 `pending`」的节点。`runReady()`/`drive()` **行为未动**（上次那版过激的循环把 20 个测试搞坏，没有重新引入）。`tests/console/stranded-nodes.test.ts` 把两半都钉住：一次 `runReady()` **确实**会把第二个节点留在 `pending`（实测 `['n1']`），守卫**准确报出那个节点**——于是「静默挂起」不能再冒充「链已排空」。

**HB-187 rejected（第二次同类误判）**：我先报「链深 ≥3 时第二节点 blocked」。查到底是**我的夹具**：它给**每一轮**模型回复都塞一个 tool call，于是第一个节点**永远**在调 `submit_result`（一个 operation 内实测 **801 次调用**），直到脚本回复耗尽，后面的节点只拿到兜底文本而不是一个回合。真实 Agent 交完结果就停止说话；换成诚实夹具（先 submit、再纯文本）后 **2 链与 3 链都完整排空**。`tests/console/chain-depth.test.ts` 现在守的是「与深度无关」，不是一个缺陷。

**HB-186 与 HB-187 是同一类错误**：两次都把「只在我的夹具里出现」的现象报成产品缺陷。差别是这次我在**动产品代码之前**就先怀疑夹具——这是该有的顺序。

---

## ▶ decision_digest 回退：无界 → 保头保尾（A + C）

**HB-188（harness，fixed@8fe9c9ac）回退快照没有任何上限**：master 不显式声明 `decisions` 时，`propose()` 会把该会话已投递的使用者消息整段 dump 进 `proposals.decision_snapshot`，而那条查询**既无 LIMIT 也无字符预算**。实测任务 `95050211` 冻进去 **636 条**，其中约 50 条是纯噪音（`continue`、`/agent_browser`、压缩命令），而且这份快照发给**每一个节点**。改动：保头保尾窗口——最早 6 条 + 最近 14 条（总条数 ≤20），超 4000 字时**从中间开始丢**。`tests/console/decision-digest-cap.test.ts`（新）：80 条种子消息，未打补丁时红（`expected 80 to be less than or equal to 20`），打补丁后绿，并同时断言开头、结尾与上限三件事。

**为什么是保头保尾而不是「只留最近」**：`tests/m8/conversation.test.ts` 明确钉住「同一次绑定里，早期的约束在后续十轮讨论后仍然存活」。**最老的几条正是原始请求与早期约束所在处**，只留最近会恰好把这个特性的意义丢掉。

**HB-189（rejected）「子节点不该收到 decisions」——我的误判**：我曾报「这 636 条被发给每个节点含 3 个 subagent，而紧邻的 catalog/systemContext 都有 `role === 'master'` 守卫」，暗示缺守卫是疏漏。**错**：同一个测试文件里有两条测试**刻意钉住**相反的行为——「一个已确认任务把会话的 decisions 与约束带给它的 workers」（断言 worker 简报里必须有使用者说的「预算有限，登录先不改」）与上面那条早期约束存活。回退存在的理由就是**让使用者随口说的约束真的到达干活的节点**。另外，我原本要加的「不下发会话与执行状态」守卫**会是死代码**：那段状态只在 `task.phase === 'chatting'` 时重建（`src/core/execution.ts:699`），普通 feature task 的节点从来没有过。这条由 test-first 抓到——探针在**未改动的源码**上就通过了（它同时断言 worker 收到了 decisions 却没收到会话状态），这正是 test-first 该起的作用。该探针保留为回归守卫。教训：**「旁边有守卫而这里没有」不等于疏漏，先读测试**。

**HB-190（open）语义过滤（B），而不只是截断**：当前截断只治体量、不治内容——`continue`、slash 命令、短确认仍被当成「约束」挤占窗口。候选修法：在回退分支加判据（丢弃 slash 命令、纯空转词、极短确认）。**代价**：判据必须自证不误伤真约束——中文短约束可以极短（如「别动 login」），按长度过滤就会误杀，所以需要一条真 E2E 分别钉住「短但重要」与「短且空转」。未做，因为判据不该由我猜。

**HB-191（harness，open）交付物可以「验收通过但使用者看不见」**：任务 `95050211` 的验收项写「三份调研笔记**与一份汇总**真实写入仓库」，实际只写了 **3 个笔记、没有汇总**，而验收脚本 `check-pi-subagents-notes.mjs` 只检查那 3 个笔记（存在 / ≥400 字符 / 含一手来源）——**验收脚本比验收项更弱**，于是 `notes-exist:valid` 通过。更严重的是**可达性从未被任何断言覆盖**：3 个笔记只在任务分支 `graph/task/…95050211` 的提交 `2d753b1` 上（未并入主线），**只有 1/3 发布成产物**（`research/pi-subagents-auth-notes@1`），而且那个产物停在 `scope=task`、从未晋升。三个「表面」（主线工作树 / 任务分支 / 项目级共享产物）对使用者全都不可见，但门禁全绿。**教训 A（harness）**：验收检查必须与被验收的措辞同强度，并且至少要有一条断言覆盖**交付表面**（文件在主线、或产物在项目级），否则「真实写入仓库」可以指一个没人能打开的分支。**教训 B（我自己）**：我报告「3 份笔记在 2d753b1，95/259/301 行」时核了**内容**却没核**可达性**——与 HB-186/187 同一类：核实了手上有的东西，没核实结论指向的东西。

**HB-192（harness，open）晋升被绑死在「发布者自己的任务工作区」**：`agentArtifactAccess`（`src/runtime/agent-tool-definitions.ts:22-31`）把 `canPromote` 限为 `role === 'master'`，这是刻意的；但真正卡住的是第二层：**`artifact_promote` 只能晋升调用方自己任务工作区里的产物**。实测：工作者（任务 `95050211`）发布的 `research/pi-subagents-auth-notes@1`，我作为会话的 main agent 去晋升时被拒：`Artifact not found in this task workspace`。于是**一个已结束任务发布的产物，之后谁也晋升不了它**——包括把它派出去的那个 main agent。本次的绕法：从我自己的工作区按**同名重新发布**（内容 digest 一致 `87426548205c…`）再晋升，代价是留下一份同名的 task 级副本。**待定设计问题**：同一会话内的任务产物是否应当可晋升？以及「节点声明的交付物在验收时自动晋升」是否比“靠 main 记得去晋升”更可靠。

**HB-192 细化（可修点，已定位）**：控制台的晋升按钮走 `POST /api/tasks/:taskId/artifacts/:artifactId/:version/promote`，它传的是**产物自己那个任务**的 taskId（`ArtifactViews.tsx:145` 用 `artifact.taskId`），所以用户能在界面上晋升任何任务的产物；而 agent 工具 `artifact_promote(artifactId, version, requestId)` **没有 taskId 参数**，实现上被绑死在「调用方自己的任务」——于是对「main 晋升自己派生出去的任务所发布的产物」这个**最常见的场景系统性做不到**。建议修法：给工具加一个可选 `taskId`（默认调用方自己），并校验该任务属于同一会话；或直接由 artifactId 反查出它的工作区。

**可见性规则（实测，供后续人查证）**：`artifact-workspace.ts:449-469` —— agent 的 `artifact_list` 走 `list({taskId})`，范围是「**本任务**发布的 task 级 + 本项目 project 级」；控制台共享产物页走 `listProject(projectId, {includeTaskArtifacts: true})`，范围是「项目级 + **该项目所有任务**的 task 级」。**因此：用户不晋升就能看到 worker 的产物（页面「各任务的产物」段），main agent 反而看不到**；晋升的真正作用是**跨任务**（未来任务 + main 的发现面），而不是「给用户看」。

**HB-192 一半 fixed@a8b278dd**：可见性那半修好了——产物可见性现在跟**会话**而不是单个任务，一条规则同时给 `list()` 与 `assertScope()` 用：main 能 list/read 它派生的子任务所发布的 task 级产物，而不需晋升；跳会话仍不可见，晋升依旧是唯一的「变成项目级共享知识」的动作。新测试 `tests/console/artifact-conversation-scope.test.ts` 先红后绿（红时 `main should see the lane artifact: expected [] to include …`），并同时钉住“晋升仍是独立的显式动作”与“跳会话/无会话仍隔离”。**剩下的一半仍 open**：agent 工具 `artifact_promote` 没有 `taskId` 参数、被绑死在调用方自己的任务，所以「main 晋升自己派生去的任务所发布的产物」仍然系统性做不到（控制台能，因为它传产物自己那个任务的 taskId）。

**HB-193 fixed@b854d1a9**（原级别：open）：`NodeSpec` 新增可选 `deliverable: { path, namespace, name, title?, summary? }`；`validateProposal` 要求相对路径且不能走出工作区、namespace 限在 plans/research/reviews/deliverables/summaries、namespace 与 name 是 slug、title/summary 有界；节点成功结算时由 **harness** 发布成 task 级产物（producer = 该节点），**声明了却未写或为空 → 节点不会 succeeded**（探针实测到该失败原因透传：`{"outcome":"failed","output":{"deliverable":"notes/lane.md was declared as this node deliverable but was never written"}}`，且零产物）。新测试 `tests/console/node-deliverable.test.ts` 先红后绿（红时 `the declared deliverable should have been published: expected undefined to be truthy`），钉住两半：发布的字节 = 节点写的文件、producer.nodeId = 该节点、节点 succeeded；以及未写则节点不 succeeded 且不发布。门禁 1457 tests / 216 files 全绿（13-Graph `267d347`）。

**HB-193 负面结果（值得保留）**：第一版在**每一次**结算都 `await` 了发布，多出的微任务切换点把一条对时序敏感的调度测试打红了（`tests/m1/scheduling.test.ts` 观察到 master 还在 running 而不是停在 waiting，可重现 3/3）。修法是**先同步解出声明再决定是否 await**，于是不声明交付物的节点结算路径一步不变。教训：**在已有热路径上加 await 会移动时序**，能条件化就条件化。

**原 HB-193 记录（背景与使用者选定）**：任务 `95050211` 只有 1/3 发了产物，根因是**图根本没要求**——三个节点的 input 原文都只写了「写 `notes/xxx.md`」。**使用者选定（A）**：`NodeSpec` 加可选 `deliverable: { path, namespace, name, title?, summary? }`，节点成功结算时由 **harness** 发布成 task 级产物（producer = 该节点）；并且（我提、使用者未反对）**声明了交付物却路径不存在或为空 → 结算失败**，而不是静默跳过（否则又是 HB-191 那个病）。**未实现**，落点已测定（供下一次直接开工）：① `src/core/types.ts:140-156` NodeSpec 加字段；② `src/core/proposal.ts` 的 `validateProposal` 校验（namespace 合法、path 非空、name 是 slug）；③ ``Execution`` 当前没有 `artifacts`（只有 git/catalog/models），需照样把 ArtifactWorkspace 传进 `constructor`（`src/core/execution.ts:122`）；④ 异步落点在 `src/core/execution.ts:1017-1028`（dispatch → integrate → `report`）：在 `report(...)` **之前** 发布，于是丢异常 = 节点不会 succeeded（settle 本身是同步、不能 await，见 `operation-lifecycle.ts:959`）；⑤ workspace 取 `this.git?.workspace(node.task_id, node.instance_id, node.id, spec.kind, spec.action)`（`execution.ts:679`），无 git 时 fallback 到 project.root（与 `pi-adapter.ts:338` 一致）；⑥ `publish` 签名见 `artifact-workspace.ts:335`（需 title/summary 时由声明给出）。

**HB-191 补充证据**：实测那个图的三个节点 input 原文均为「写 `notes/pi-subagents-xxx.md`」——**没有任何一个节点被要求发布产物**，auth 那条是它自己额外发的。所以「只有 1/3 成为产物」不是 subagent 不能发，而是**图没让它发**。晋升后真机核实：在 13-Graph 项目的「共享产物」页面上，三张卡片均可见（`research/pi-subagents-{auth,surface,lessons}-notes · v1`）。**顺带发现**：该页面的「项目」逐选框**默认选中的是本会话项目之外的一个项目**（不是当前会话所属项目），于是使用者在自己项目里验收时会「看不到刚交付的产物」。

**门禁**：1453 tests / 214 files 全绿（13-Graph `496907f`；RSI checkout `8fe9c9ac`）。


---

## ▶ 抽屉草稿卡溢出（使用者报「抽屉格式混乱、看不到草稿任务图」）

**HB-194 open｜「仍在跑旧前端」这个陷阱会骗我两次测量。** 现场修抽屉时我先在 13-Graph 跑 `node --run build:web`，又用 `?cb=N` 重开页面，两次测量都仍显示**未修复**（`index-DM6VEDhQ.css`、重复 testid=2、卡片仍 78..164）。真实原因是**运行中的控制台不在 13-Graph**：daemon（打包的 `Graph.app` 二进制）以 `--web-dir /Users/macmini/workspace/graph-rsi/dist/web` 启动（ADR 0028），而浏览器还握着**缓存里的旧 index.html**；服务端 `curl /` 返回的其实已是新包 `index-CAEFaqF_.css`。**可由工具/证据消除**：判断「我看到的是不是我改的那份」应读**页面实际加载的资源 hash**（`link[rel=stylesheet]`）与**服务端 `/` 返回的 hash**，两者一致才算现场；`?cb=` 只破页面缓存，不破已缓存的 index.html。**建议**：控制台把「当前前端资源 hash + checkout + HEAD」显示在页面上（与 HB-165 同源），或给 `agent_browser`/控制台加一个「强制无缓存重载」的现成入口。证据：本次 `/tmp/drawer-draft-before.png`（旧）vs `/tmp/drawer-draft-after.png`（新），几何 before 卡 78..164 / TOC 298 / 链接 349 / 任务导航 176；after 卡 78..429（TOC 298、链接 349 **在卡内**）/ 任务导航 441。

**HB-195 open｜重复 `data-testid` 没有守卫。** `drawer-entry-links` 曾同时出现在**三处**（草稿卡 1 + TaskDrawerSection 2），现有测试从没发现；是我新加的几何断言被 playwright **strict mode** 撞红才暴露。这类重复会让定位器变得二义（也会让「改了某个 testid」看起来没生效）。**建议**：在一条渲染用例里对整页做一个**testid 唯一性检查**（`querySelectorAll('[data-testid]')` 按值分组，>1 即失败），或对 `src/web/**` 做一条源码级唯一性断言；成本很小，能提前抓住。证据：修复前 `document.querySelectorAll('[data-testid=drawer-entry-links]').length === 2`（现场实测），修复后为 1。

---

## ▶ 中等档 graph 形状 A 第 1 个真缺陷：三条返工回边在画面上重合（修法 1）

**HB-196 已查清并修复@068bcd1（原判据有误，已更正）｜「`apply_rsi_change` 静默丢掉 `path`」是我的误判。** 我先前报「工具在一条 change 同时带 `edits` 时会丢弃该条的 `path`」，并把「`path` 放末尾 + 一次一文件」当成绕法。**查到底后推翻**：工具从未丢过——SDK 校验器看到的参数与模型发出的完全一致。用 SDK 自己的会话转录（instance `e9d3a42b`，session `2026-09-27T07-10-47`）逐条核对最后 25 次 `apply_rsi_change`：**7 次**有一条 `action:'replace'` 的条目键只有 `[action, edits]`、**根本没有 `path`**（如 `chatcmpl-tool-a20c30eec3d4e2bb`、`89bb0c09cd785930`），另有 2 次在 `write` 上也漏了。也就是说**是我的生成漏了字段**，当时的「绕法」只是碰巧在更小的调用里没漏。**真正的缺陷在提示层**：`rsiChangeShapeHint` 只解释「嵌套错位」，并**明确声明「只缺字段的调用归 schema 管」**——可实测里「漏 `path`」正是最高频的形状错误，而 schema 只回一句 `changes[0].path: must have required properties path`（不说是哪条、不给可照抄的形状），于是同样的调用反复出现。**修法**：提示里补上缺 `path` 的判据，点名下标并给出三种合法形状；空白 `path` 属另一类错误，仍归 schema。**先红后绿**：`tests/console/rsi-change-shape.test.ts` 新增两例（`replace` 漏 `path` 要点名 `changes[0]`；第二条第 1 条要点名 `changes[1]`），并断言「空白 path 不被误报」「完好调用原样通过」。**真机核实**：经 `describeAgentTools` 同一接缝实测，漏 `path` 的负载得到 `changes[1] is missing "path": every change needs one path per file. Write it as {path, action: "write", content} | …`，完好负载原样通过。门禁 1461 tests / 216 files 全绿；13-Graph `068bcd1` 已推。**教训（第三次同类）**：报工具缺陷前先取「工具真正收到的输入」——这一次转录里就躺着答案，我却先写了绕法。

**HB-197 open｜控制台 `/api` 用的是 `graph_session` cookie，`x-graph-app-token` 在 `/api` 上必 401——而 401 的响应体被我的 JSON 解析静默吃成了「空图」。** 我用 `curl -H "x-graph-app-token: <磁盘上的 token>" /api/conversations/<id>/draft-graph` 得到 `{"code":"unauthorized"}`（HTTP 401），但我的 `python3 -c` 只取 `layout.edges/nodes`，于是**打印出 `nodes 0 edges 0`**——看起来就像「这张图没有边」，差一点让我下错结论。**可从工具/证据消除**：核对 API 时应先看 **HTTP 状态码**再看主体（`curl -i`），或改用**页面内 `fetch(..., {credentials:'include'})`**（本轮正是这样拿到真数据：`nodes 9 edges 12`，3 条 `loop:` 边无 `points`）。**建议**：把 `graph_session` cookie 的获取入口（或一个 `--api` 便捷方式）写进单证，避免每次都绕回浏览器。

**HB-198 open｜`.react-flow__edges` 在刚打开页面的一瞬是空的，会把「边没渲染」误报成缺陷。** 我在 `qa` 打开形状 A 后立刻读 DOM，得到 `children = [svg.react-flow__marker]`、**0 条边**，差一点报告「边根本没画出来」；随后（配合 API 确认有 12 条边）再读同一节点，得到 **24 条 path**（其中 3 条虚线 = 三条回边）。**属于 HB-194 同族（只信量了两次的东西）**：读画布几何前应先等边层稳定（或读两次取一致值），否则会把渲染竞态当成产品缺口。

**本节的真修复（fixed@e727a2d，graph-rsi；13-Graph 同步提交）**：三条 `loop:` 回边此前全部被送到**整幅图最左的 gutter**、彼此只差 24px，所以三车道并排时三条弧线**叠在一起**、且各自**横穿中间车道**。根因两处：`src/server/layout.ts` **刻意不把 loops 喂给 ELK**（回边描述运行期返工、不是依赖顺序），于是画布拿不到路由点；`src/web/GraphCanvas.tsx` 老代码 `leftX: minNodeLeft - 64 - loopLane++ * 24` 把每条回边都推到全局最左。修法：新增纯函数 `src/web/graph-edges.ts` 的 `loopChannels(loops, positions)`——**每条回边的竖直通道就落在它自己车道左侧的空隙里**（不在最左、不横穿别人），同车道多条按固定步距分离，**最左车道保留原全局 gutter**（单车道画面不变）。**先红后绿**：`tests/console/loop-channels.test.ts` 3 例（三车道三条不同通道且各在自己车道左侧、最左车道仍用 gutter、同车道分离 ≥16），模块不存在时红。**真机实测（运行中 daemon，形状 A v28，9 节点 / 12 边）**：三条回边通道实测 **x=8 / 216 / 440**（各自车道空隙内，彼此相距 ~200px，不再叠在最左），截图 `/tmp/loops-after-v28b.png`；API 实测 `draft-graph?version=28` 返回 `nodes 9 edges 12`、三条 `loop:` 边均 `noP`（正是本修法覆盖的情形）。门禁 **1463 tests / 217 files** 全绿。

**HB-199 open｜同一个 RSI checkout 上并发操作会互相挡住，而且没有工具能说出「这些改动是谁的」。** 我在 13-Graph 修完 HB-196（`068bcd1`，门禁 1461/216 全绿、已推）后，要在运行中的 `graph-rsi` 落同一处改动，`apply_rsi_change` 直接拒绝：工作树里有别人的未提交文件——`src/runtime/handoff-response.ts`、`src/web/transcript-model.ts`、`tests/fixtures/openai-server.ts` 等 5 改 + 1 新（`src/core/assistant-visible-text.ts`，时间戳显示 **12:59 仍在被写**）。这些不是我的改动，`inspect_rsi_status` 也**只报 running operation 的 id/task，不报「这些文件属于哪个操作」**，所以我只能靠文件主题去猜该等谁。工具拒绝是**对的**（它无法把一个含他人改动的树归因为一次已验证提交），缺的是可见性：谁在写这些文件、还要多久。**建议**：`inspect_rsi_status` 在 `activeOperations` 旁给出**每个操作声明要写/已写过的路径**，或至少在拒绝时点名「这些文件属于 operation `<id>`（会话 `<id>`，状态 `x`）」；否则 master 只能反复重试或误以为是自己弄脏的树。证据：本轮 `graph-rsi` 工作树 `git status --porcelain` 见 5 M + 1 ??，`inspect_rsi_status.activeOperations = 1`（`674f7199…`/task `52e92a78`，`canRestart:false`）。

---

## ▶ 第 ③ 步「验证可用」时撞到的两个真摩擦（HB-200 / HB-201）

**HB-200 open｜RSI 重载后控制台立刻失效，页面只显示「加载失败：Authentication required」，没有任何「刚重载过」的提示。** 本轮我之前落在运行中 `graph-rsi` 的 RSI 变更触发重载后，同一标签页的 `/api` 全部 401（会话 cookie 作废），页面变成一句错误文案；使用者无法从这个现象判断「是服务端崩了 / 我改坏了 / 还是只是需要重新登录」。**建议**：重载完成后由服务端主动给一个可读的「已重载，请重新登录」状态（或让 `/api` 401 时返回一个可辨识的 `code:'reloaded'` 让前端提示），否则每次 RSI activate 都会让使用者面对一个看起来像坏掉的界面。证据：重载后 `curl -i /api/...` 返回 401 `{"code":"unauthorized"}`，页面显示「加载失败：Authentication required」。

**HB-201 open（本轮真缺陷，机器已核实）｜「所有节点 succeeded、无待答问题、验收证据有效」的任务会卡在 `phase=running` 永不收口，并**占住唯一的运行时槽位**，把后面确认的任务全部挡在 `phase=queued`。** 复现：确认形状 A v32 后，新任务 `a2d46de9` 等了 ~3 分钟没有任何节点启动；查库发现 `runtime.active_task = 95050211`（旧的简单档调研图），而该任务**四个激活全部 succeeded**（`9c4e285f/df4577b7/b45d11ab/05b922d6`）、零待答问题、验收项 `notes-exist` 在 `2d753b1f` 上 `valid=1`，却仍是 `running`。**根因已定位到代码行**：`src/core/execution.ts` 的 `readyToComplete()` 在 `integration_sha !== target_sha` 时要求 `independentReviewReady(...)`——而 `95050211` 的 `integration_sha=2d753b1f`、`target_sha=cc43685a` **不相等**，且该图**根本没有 review 节点**（简单档 3 个 researcher + 一个 command 检查），于是 `independentReviewReady` 永远为 false → 永不 `completeTask` → 永不 `promoteNextTask()` → 槽位死锁。**两种可辩护的读法**：(1) 图欠规格（交付与目标不同的图必须有评审者），那这个任务本就该被 abandon；(2) harness 过度要求（**没有代码交付、也没有 review 节点**的图不该被强制要求独立评审）。**这是产品取舍，我没有自选**：图卡住期间我向使用者报告并请他定夺（见已发出的问题）。**建议修法（若选 (2)）**：`readyToComplete` 的评审要求只在「该图存在 review 角色节点」或「确有代码交付（`integration_sha !== target_sha` 且交付物含代码路径）」时生效；纯研究/纯文档图不强制评审者。**证据**：`tasks.sqlite` 中 `tasks.phase='running'`、`runtime.active_task='95050211-…'`、`activations` 四条 succeeded、`evidence` 一条 valid；新任务 `a2d46de9` 持续 `queued`（`get_task_status` 三次，最长等 120s）。

---

## ▶ 第 ③ 步验证形状 A 时暴露的真缺陷（HB-202）：门↔评审的版本契约太紧 + 返工不带评审正文

**HB-202 fixed@<pending>｜闸门把「评审报告引用的产物版本」绑死在 operationId/activationId 上，于是评审明明通过却被判返工；且返工简报里不含评审正文（`reports: []`），返工者收不到任何可修的信息，车道被 `stalled` 卡死。使用者选定 (A)：放宽版本判据 + 返工带上评审正文。**

**现象与证据（机器核实，均取自任务 a2d46de9 的真跑）**：
1. **误返工**：`gate-a`/`gate-b` 三次裁决原文完全一致 —— `{"outcome":"rework","blockers":[{"id":"invalid_evidence","reason":"Review does not apply to the current artifact version"}],"reports":[],"subjects":[]}`。可 `review-a` 的 verdict 是 **pass**（`dimensions.correctness.verdict="pass"`）。
2. **根因（行级）**：`src/core/verification.ts` 的 `sameArtifact()` 要求 6 项全等（`id/path/digest/nodeId/operationId/activationId`），`subject()` 用它比对评审报告里的 `subject` 与当前 `source(node).artifacts`。评审写报告时引用的是 **impl-a round2 的 operation `d60ffcef…` / activation `0e34e8f1…`**；而 gate 重算时 `sources()` 给的是**当前**（round3）provenance —— **digest/path 完全相同，只有 activation/operation 变了**，于是 6 项不全等 → `invalid_evidence`。**把「谁产的」当成了「产的是什么」**。
3. **连带**：`evaluateVerifier` 在 blocker 时 `decision.reports` 为空、`evaluateMultiview` 遇到未解析 subject 直接 `invalid()` 抛出，于是 gate 的 output 里 `reports: []`、没有任何评审文本；`src/core/execution.ts:reworkDelta` 把该 output 原样 JSON 化喂给 `reworkBriefing`，返工者只看到 `{"reason":"Review does not apply to the current artifact version"}` —— 即「返工 prompt 里没有 review 的回复」。
4. **后果**：`gate-b` 连续 3 轮「无实质进展」→ **`stalled`**（`questions.kind='stalled'`, `reason:"Three consecutive rounds made no substantial progress"`）。车道 b 卡死，整图无法收口。**这不是模型不努力**：它每轮收到的返工指令都是同一句结构性错误，无从修起。

**修法（(A)，两个改动都落在 `src/core/verification.ts`）**：
- `subject()` 增加**内容身份**兜底 `sameContent()`（`nodeId+path+digest` 相等即视为同一份产物），命中后**回传当前版本**（保持下游 subjects 为当前）；只有内容也对不上才抛 `invalid_evidence`。语义：同一份字节就是同一份产物，无论谁在哪个 activation 产的。
- `collectReports()` 收集评审正文（新增 `summarizeReview()`，覆盖 multiview/adversarial/independent/jury：取未通过的 judgement 的 `verdict/reason/files`，全通过则取第一条），挂到 `VerificationDecision.reviewText`，随 gate output 一起进返工简报。
- **未削弱的安全边界**：`tests/m2/verification.test.ts` 既有的「an old artifact version cannot satisfy the current gate」仍通过 —— 那次报告的 digest 是 `digest('stale')`，与真实产物内容不同，**仍被判 rework**。即「改了内容的旧版本」照旧不认，只有「内容没变的重新激活」被正确接受。

**先红后绿（R22）**：新增两条用例 —— ①「同一内容、不同 activation 的评审仍满足闸门」（断言 `phase='completed'`、`outcome='pass'`）；②「返工带上评审正文」（断言 `reviewText` 含 `verdict:'fail'`、`reason` 与 `files`）。**回退 `sameContent` 兜底后两条均失败（2 failed / 14 passed）**，恢复后 16/16 绿 —— 证明修复正是让它们通过的原因。门禁 <pending>。

**教训**：**「同一份产物」的判据里，身份（谁产的、第几个 activation）与内容（字节）必须分开**；把 activation 混进内容身份，会让「内容没变的重跑」被误判成「换了产物」，而返工机制恰好在此时丢掉全部可执行信息。

---

## ▶ HB-203 fixed@d0eeb96（含第一次落地的教训）：RSI activate 声称「已重载」，但**运行中的 app 仍执行旧编译产物**——因为 activate 不重建 Graph.app

**缺口**：HB-202 的修复经 `apply_rsi_change(activate:true)` 落地 `graph-rsi`，宿主也回了 **reload confirmed**（commit `d0eeb96`）。但**证据显示它没生效**：被恢复的验证图 `a2d46de9` 里，`gate-a`/`gate-b` 的裁决**与修复前逐字节相同**（仍是 `invalid_evidence: "Review does not apply to the current artifact version"`、`reports: []`）。

**根因（机器核实）**：运行中的控制台由**打包的 `Graph.app`** 承载，它执行的是 `dist/app/mac-arm64/Graph.app/Contents/Resources/app/src/…` 里**打包时拷贝的那份源码**：
- 打包副本 `…/app/src/core/verification.ts` mtime = **12:30**，`grep sameContent/summarizeReview/reviewText` = **0**（旧代码）；
- 我的提交 `d0eeb96` 时间 = **15:22**。
即 `apply_rsi_change(activate:true)` **只把改动提交并置「待重载」，不触发 `app:build`**，而重载加载的是**旧 bundle**。于是「reload confirmed」只证明「git 提交 + 待重载状态被清掉」，**不证明新代码在跑**——正是 HB-179「RSI 返回值不可信，必须自证」的又一例，也是 HB-194 的同族（运行中的控制台 ≠ 源码 checkout）。

**修法（本次实际执行）**：`node --run app:build` 重建 → **实测打包副本现在含修复（6 处命中，mtime 15:25）** → 重启 app 后新代码才真正生效。

**证据**：打包副本 `grep -c` 修复前 0 / 重建后 6 且 mtime 15:25；修复前后 gate 裁决文本逐字节相同（上文 HB-202 记录）。**建议**：`apply_rsi_change(activate:true)` 在 `app:build` 产物过期时应**要么自动重建、要么在回执里明确写「bundle 未重建，仍跑旧代码」**，而不是给一个看起来成功的 reload confirmed；控制台也应显示「我跑的是哪次构建」（与 HB-165/HB-194 同源）。

---

## ▶ HB-202 已在运行中的构建上**行为验证通过**（HB-203 收尾）

**重启已确认，修复已生效（自证，非回执）**：
- 新控制台 pid **57861，启动 15:48:01** > bundle mtime **15:25:44**；旧 pid（50456/77912）已消失 → 运行的就是重建后的 bundle。
- 打包副本与源码 checkout 的修复**逐字节一致**（`diff` 无输出；`grep sameContent/summarizeReview/reviewText` = 6）。
- **行为证明（决定性）**：直连运行中构建的 `evaluateVerifier`，喂入「评审主体与当前版本**内容相同、activation 不同**」这一正是旧缺陷的输入：
  - 修复前：`outcome=rework`、blockers=`[{invalid_evidence, "Review does not apply to the current artifact version"}]`、`reports: []`
  - 修复后：**`outcome=pass`、blockers=`[]`、`reviewText=[{node:'review-a',verdict:'pass',reason:'Content unchanged and correct'}]`**
- 探针 `/tmp/hb202-probe.mjs`（可重跑）。

**HB-203 教训（保留）**：`apply_rsi_change(activate:true)` 的「reload confirmed」只证明 git 提交 + 待重载被清，**不证明新代码在跑**；运行中的控制台是打包的 `Graph.app`，源码改动必须经 `node --run app:build` 重建并**重启**才生效。本次经此路径方才真正生效。

## ▶ HB-204 open：三条评审车道都用 grok:grok-4.7，账号额度用尽

**缺口**：形状 A 验证图 `a2d46de9` 的 `review-b`、`review-c` 均以 `403 "You have run out of credits or need a Grok subscription"` 失败（`tasks.sqlite` 3 条同因 403）；`review-a` 在耗尽前跑过。**账号/配额事实，重试无用**——只有使用者能充值，或把评审车道换模型（如 `opencode-go:mimo-v2.6-pro`）。已 escalate 两条问题。**建议**：关键车道（评审/门）不应把全部鸡蛋放在同一付费账号上——给 main 一个「同角色备选模型」声明，或让 harness 在配额类 403 上**明确标注为外部阻塞**而非普通 `execution_failed`（现在混在通用失败里，易被误当代码问题）。


---

## ▶ HB-206 fixed@3cf2e35：删掉 `graph.verify` 门后，五处机制仍焊在旧门上（评审即路由器）

**使用者定的方向**：形状 A 去掉机械门，改成「review 后跟一个路由，路由可 loop 回 work」——是否返工、返工说什么全由 review 自己决定，且不用 JSON 工具调用。方向本身是对的（`routes`/`when`/`loops`/`{declared}` 路由来源/`deliverable` 全都已实现），但**照第一性原理接线时，五处旧门依赖暴露出来**，每一处都足以让新形状数学上不可能跑通：

1. **回边只认验证决定**：`handleRework` 仅由 `isReworkDecision(result.output)`（`{kind:'verification',outcome:'rework'}`）触发 → 路由的 `fail` case **根本不会触发回边**。→ 给 `LoopSpec` 加可选 `case`（与 `when.case` 同一词汇），图校验「case 必须是该路由器声明过的分支」，settle 时路由命中即 reactivate。
2. **`routes` 只许 program 声明**（`proposal.ts:27`）→ agent 无法做路由器。→ 放开为 kind 无关。
3. **`{declared}` 只接受字符串**（图上写死），无法表达「由 agent 自述」→ 接受 `declared: null`（仅 agent）；该 agent 没给 `route` 时**明确拒绝**而非静默跳过全部分支。
4. **验收项必须绑 program**（`proposal.ts:64`），证据必须来自 program → 允许绑「必须的 agent 路由节点」；该情形下 harness **自己登记证据**，钉在评审被要求写的 deliverable 上（`resolve(workspace, path)` + sha256）；并把「缺证据」与「证据只能来自 program」两处判据一并放行。
5. **`independentReviewReady` 要求存在通过了的 `graph.verify`** → 没有门就恒 false，真实交付永远出不了图。→ 改为「评审路由器 succeeded 且其 route 未触发回边」即视为评审通过。
   另：`reworkDelta` 只收集 `verdict rework`/failed/blocked 的读者，路由退回的评审输出是普通 note 会被漏掉 → 补上「route 命中 from=该读者、to=本节点 的 loop」。

**证据**：`tests/console/review-as-router.test.ts` 5 用例；把上述机制逐处临时回退后**全红**（先红后绿）；全量门禁 1468 tests / 217 files 绿。13-Graph `3cf2e35`（push 完成，pre-push gate passed）；RSI `f1fbf31` 重载确认。**教训**：改一个形状前，先查清「谁在触发」——我原以为回边由图结构驱动，实际由验证决定驱动。

## ▶ HB-207 fixed@7165551：RSI 变更漏带同一提交里的新测试文件，自证强于实际

上一轮 RSI（`f1fbf31`）只落了 7 个 `src/core` 文件，**漏掉同一提交的 `tests/console/review-as-router.test.ts`**。后果：graph-rsi 的 `node --run check` 报 passed，但那条命令**从未执行过那 5 个新用例**——RSI 的自证覆盖弱于 13-Graph 上的全量门禁。补落（RSI `216e3f7`，activate=false）后在**新检出上**实跑 5/5 绿。

**教训**：RSI 的 `changes` 是手工列的，**别只列 src**；提交里有什么就落什么，尤其测试。判断自证是否充分要看**用例名有没有出现在输出里**，不能只看 summary 的 passed。13-Graph 与 graph-rsi 现已逐字节一致（清掉一个未使用的解构绑定并推送 `7165551`）。**HB-205 在形状 A 下不再阻塞**（门没了，那条路径不再被走到），但仍 open：任何保留 `graph.verify` 的图仍会踩到。

---

## ▶ HB-208 fixed@413ba83：agent 路由器「必须给出 route」这一点，简报与 submit_result 工具描述都没说

**实测（形状 A v33 真跑，任务 `a621e9d6`，图 9 节点 / 4 回边）**：三个评审节点（agent 路由器，`routes ['pass','fail']`，`input.route.declared=null`）里，`review-c` **两次**、`review-b` **一次**出现同一个 recovery：

```
RuntimeError: 节点 review-b 由自己选择分支，但提交的结果里没有 route（已声明：pass, fail）。
```

`review-b` 那次磁盘上**已经写出 `reviews/review-b.md`（13394 字节）**，只是 `submit_result` 的结构化结果没带 `route` 字段——说明它不是没干活，而是**不知道要交一个 `route`**。`review-c` 两次连报告都没落（`declared deliverable reviews/review-c.md ... was never written`，该护栏按预期正确地判失败）。

**根因（已定位到代码）**：
- `src/core/operation-lifecycle.ts:1091-1105` 的 settle 校验完全正确：agent 路由器 `result.route === undefined` 时，`routeSourceOf` 返回 `{declared:null}` → `resolveRouteCase` 拒绝（不是静默跳过全部分支）。护栏没错。
- 但**没有任何提示告诉 agent「你是路由器，必须在结果里给出 route，且取值必须是声明过的分支之一」**：
  - `src/runtime/agent-tool-definitions.ts:150` 的 `submit_result` 描述只有一句「Submit structured JSON output for this operation.」，完全没提 `route`；
  - 节点简报（`src/catalog/briefing.ts` / `node-prompt.ts`）里搜不到 `routes` / `route` / 「分支」的说明。
  - 于是路由器只能靠**猜**或靠自行读图才知道要交 route。

**后果**：形状 A（评审即路由器）依赖 agent 主动交 `route`，但提示层没接上这一环——不同的评审模型（本轮 `opencode-go:space-bunny-free`）会随机漏交，表现为 recovery/重试抖动，而不是稳定的产品行为。这是**提示层缺口**，不是模型能力问题。

**建议修法（本轮未改，留待后续）**：在装配 agent 节点简报时，若 `nodeSpec.routes?.length` 非空且 `routeSourceOf` 为 `{declared:null}`，就在简报里显式写一段：「你是一个路由器：完成工作后必须调用 `submit_result`，其 JSON 必须包含 `route` 字段，取值必须是以下之一：`pass` / `fail`；同时把评审报告写到声明的交付物路径。」并把同样的句子加进 `submit_result` 的工具描述（当该节点是路由器时）。改动面：简报装配 + 工具描述动态化，需过完整门禁。

**证据**：本任务 `problems` 表两条同族 recovery（`f83ffce7` review-b、`c793fbae` review-c）；`review-b/reviews/review-b.md` 已写但 result 无 route；`operation-lifecycle.ts:1091-1105` 与 `agent-tool-definitions.ts:150` 原文。

**落地（fixed@413ba83）**：按上面建议修法实现——`src/catalog/briefing.ts` 的 `focusBriefing` 对 agent 路由器增补 `routerInstruction`（点名已声明分支并要求 `submit_result` 的 outputJson 带 `route`）；`src/core/router-action.ts` 导出 `agentChoosesItsOwnRoute`（「只有 agent 能自述」这条规则的单一事实来源）；`src/runtime/agent-tool-definitions.ts` 的 `submit_result` 描述加一句。先红后绿（`tests/console/briefing.test.ts` 两用例：agent 路由器被告知 / program 路由器不被告知），13-Graph 全量门禁 217 文件 / 1470 用例绿（提交 `3b272e0`）。经 RSI 落地 graph-rsi（`413ba83`，generation 428）。**自证**：live server 进程 21:26:58 启动，晚于提交 21:26:56；`/api/app/rsi/status` 报 `lastActivation.commit=413ba83`、`pendingRestart=null`；源码树 4 处标记命中。护栏未放宽（无 route 仍拒绝），只是把要求告诉 agent。

---

## ▶ HB-209 fixed@9fab3ad：集成提交一变，全图所有 review/program 节点被重置——证据失效判据是「全局 SHA」而非「该车道的内容」

**实测（任务 a621e9d6，形状 A v33，三条互不依赖车道）**：
- `activations` 表：`impl-a` 1 次、`impl-b` 1 次、`impl-c` 2 次（1 次真返工）；而 **`review-a` 6 次、`review-b` 4 次、`review-c` 5 次，且每一条 `round` 全是 1**。
- `round` 恒为 1 说明这些评审**从未「返工」**——它们每次都是被当作**后代/兄弟节点连带失效**的。`review-b` 报告里自己写：「被审文件指纹 5 轮逐字节相同」。
- 结果：三条互不依赖的车道，收口期每个评审被无谓复跑约 N 次（N=车道数）。这张小图烧了约 2300 万 token，其中相当一部分是这些复跑。

**根因（已定位到代码）**：`src/git/integration.ts`
- `retargetEvidence(from,to)` 只在 `git diff --quiet from to`（**树逐字节相同**）时把证据改绑到新 SHA；兄弟车道一合并就是**新内容**，于是返回 false。
- 落到 `invalidateChecks(taskId)`（`:516`）：它 `UPDATE evidence SET valid=0 WHERE task_id=? AND valid=1`（**全任务**），再对 `rechecksAfterIntegrationChange(spec, status)`（`:26` = 「任何 succeeded 的 program 或 review」）的节点**连同其全部 dependents** 调 `resetIdleNode` 置回 pending（`:519-543`）。
- 判据是**全局集成 SHA**（`execution.ts:679`），而不是「这个节点所依赖的那部分内容有没有变」。于是 impl-b 合并 `scripts/diag-b.mjs` 也会把 review-a（只依赖 `scripts/diag-a.mjs`）重置。

**问题**：证据必须绑「它真正被验证的那个提交」是对的（否则旧代码上的 pass 会被错当成新代码的 pass，那才是假绿）。但**「任一车道推进全图 SHA」→「全图 review 复跑」是把「哪部分变了」这个信息丢掉了**。形状 A 的价值主张是「只重跑失败的那条车道」，而收口期它退化成了「任何车道动一次，所有评审重跑」。

**建议修法（本轮实现）**：`invalidateChecks` 改为**按内容定位**——
1. 算出这次集成推进的**变更路径集**：`git diff --name-only <from> <to>`；
2. 一个节点只有在其**依赖闭包产出的路径集**与变更路径集**有交集**时才重置（闭包路径 = 该节点及其祖先 `operation.result.output.changes[].path` / 声明的 `deliverable.path`，外加 evidence 目录）；
3. 无交集者**保持 succeeded 与证据有效**（把其证据改绑到新 SHA，因为它所依赖的内容没变）；
4. 判不出来（拿不到路径集）时**退回旧的全量失效**——宁多跑不少跑（安全默认）。

**证据**：`activations` 表 round 全 1；`integration.ts:26/370/455/516-543`；`execution.ts:679`；任务 `a621e9d6` 113 分钟 / 2300 万 token。

**落地（fixed@9fab3ad）**：按建议修法实现——`staleRecheckTargets`（纯函数）按「变更路径集 × 节点依赖闭包产出路径」判定哪些 succeeded 的 program/review 需要重跑；`invalidateChecks` 改为接收 `from/to`，用 `git diff --name-only` 取变更路径集，只重置 stale 节点，未变节点保留 succeeded 并把 evidence.commit_sha 改绑到新 SHA。两个安全默认：diff 取不到 → 全量失效（旧行为）；节点无已知产出路径 → 视为 stale。先红后绿（3 条用例红）；13-Graph 全量门禁 218 文件 / 1488 用例绿（提交 `83eaeed`）。经 RSI 落 graph-rsi（`9fab3ad`，generation 429）；自证 live：进程 21:58:41 启动晚于提交 21:58:36，`rsi/status` commit=9fab3ad、pendingRestart=null。**recactivate（loop 返工路径）与 retargetEvidence（逐字节相同时改绑）未改。**

---

## ▶ HB-205 open（第 ③ 步第二层真根因）：dependencySources 的 artifacts 恒为空，multiview 门永远匹配不上评审主体

**更正 HB-202 的「已验证」措辞**：HB-202（门按内容身份 matching + 返工带 reviewText）**代码本身正确**，但**不足以修复形状 A**——我用**合成 fixture**做的探针通过了，真实门路径仍失败。这是我必须如实说明的一点：探针喂的 fixture 里 `source.artifacts` 是**有值的**，而真实路径里它是**空的**。

**决定性证据（任务 a2d46de9，graph v2，评审已换 space-bunny-free 并跑通后）**：
- `gate-c` 仍返回 `{"outcome":"rework","blockers":[{"id":"invalid_evidence","reason":"Review does not apply to the current artifact version"}],"reports":[]}`，`reviewText` 计数 = **0**。
- `gate-c` 操作 spec 里的 `dependencySources` 原文：
  ```json
  {"impl-c":[{"nodeId":"impl-c","operationId":"c3e69b14-...","activationId":"02a79e2b-...","artifacts":[]}],
   "review-c":[{"nodeId":"review-c","operationId":"7dfa106a-...","activationId":"1d56d4ab-...","artifacts":[]}]}
  ```
  —— **两个来源的 `artifacts` 都是空数组**。
- `src/core/graph.ts:151`（`loadGraph`）：`artifacts: (result.artifacts ?? []).map(...)`，即来源的 artifacts 完全取自**该 operation 的 `result.artifacts`**。
- 实测：`impl-c` 与 `review-c` 的 operation `result` 里**都没有 `artifacts` 字段**（`json_extract(result,'$.artifacts')` 为空）。而 `result.artifacts` 在 `operation-lifecycle.ts:1074` 只是**可选、由 agent 提交**的字段。

**因果链**：agent 的 `submit_result` 没带 `artifacts` → operation.result.artifacts 缺失 → `loadGraph` 给该来源构造 `artifacts: []` → `subject()` 在**空数组**里 find → 无论 `sameArtifact` 还是新增的 `sameContent`（`nodeId+path+digest`）**都无从匹配** → `invalid()` 抛 `invalid_evidence` → 门判 rework → 返工者收到「Review does not apply to the current artifact version」这一句**无法执行**的指令 → 3 轮 → **stalled**。

**为什么 HB-202 的探针会通过**：我在 `/tmp/hb202-probe.mjs` 里手工把 `artifacts` 填了值，于是 `sameContent` 生效。**真实路径没有那个前提**。教训（写给下一次的我）：**修一层时，必须用真实路径（真任务）验证，而不是自造一个「我以为是现场」的 fixture**——这正是 HB-179 的同一病，我在 HB-202 上又犯了一次。

**两种可能的修法方向（未定，需使用者/后续定夺）**：
1. **让来源带 artifacts（改 clobber 面最小）**：`loadGraph` 在 `result.artifacts` 缺失时，回退到该节点已发布的产物（如 `artifact_events`/`artifact_links` 里 producer=该节点 的条目），或让 harness 在节点结算时**自动把产出登记为 artifact**（与「节点声明交付物 harness 落地产物」同源）。语义：来源必须**能被引用**。
2. **放宽门的匹配**：当来源 artifacts 为空时，用评审报告 evidence 里的 `path+digest` 直接对**磁盘/工作副本**校验，而不是对「来源声明的 artifact」校验。语义更弱（门不再要求「产物来自某次操作」）。
我倾向 **(1)**：因为「门要求来源有可引用的产物」本身是**合理契约**，缺的是**产出者没登记**；放宽匹配会让「评审到底审的是不是这份产物」变得不可追溯。

**证据**：`gate-c`/`gate-b`/`gate-a` 三轮裁决逐字相同；`dependencySources` 的 artifacts=[]（上面原文）；`elements` 见 `tasks.sqlite` operations 表（`json_extract(result,'$.artifacts')` 为空）；沙箱直连探针 `/tmp/hb202-probe.mjs`（人为填 artifacts 才通过）。

---

## ▶ HB-210 fixed@6c8ae38：产物「读取」侧不可观测——简报只给 uri，agent 绕过工具，读侧零记录

**实测（任务 a621e9d6，形状 A v33）**：
- 48 条 `artifact.published`，**0 条读取类事件**。`events` 表只有 `artifact.published`；每次读的 `artifact_events` 表当时是空的。
- **`artifact_list` 调用 12 次**（review-a 3 / review-b 5 / review-c 4），**`artifact_read` 0 次**；而**直读对象库 8 次**（review-b 4 / review-c 3 / impl-c 1，`cat`/`diff` 打 `artifact-workspace/objects/sha256/…` 做逐字节对账）。
- 评审确实**读了别的车道的报告**（review-a `wc -l reviews/review-{a,b,c}.md`），但「谁读了哪一版」只能靠**逆向翻 bash 命令文本**复原。

**三个根因**：
1. **简报只给 `uri`+`digest`，不给 `artifactId`**（`briefing.ts` 原代码：`${artifact.uri ?? artifact.path} (${artifact.digest})`）。`artifact_read` 需要 `artifactId`，于是 agent 得先 `artifact_list` 转换一次——多一步，多数直接去读工作树里的真实文件。
2. **简报从不提 `artifact_read`**。同一份简报里别的指令都写得很具体（「写到文件、算 sha256、不要伪造 digest」），没被要求的工具就不被用。
3. **绕过路径（直读对象库）不落任何事件**。`artifact_read` 成功会写 `artifact.accessed`（`artifact-workspace.ts:548-551`），机制本来就在，只是零调用；而 cat/diff 那条路谁也拦不到。

**修法（本轮实现，方向由使用者定）**：
1. 简报里每条依赖产物改成 `${uri} (${digest}, artifactId ${artifactId}@${version})`——把机器键交到 agent 手上，`artifact_read` 不再需要先查一次；
2. 简报尾部加一行**可执行的读指引**：`To read a dependency artifact, call artifact_read with its artifactId (the part before "@") and version; the file you already hold in the work copy is the same bytes.`
3. 新增 `ArtifactWorkspace.recordReferences`：每次因简报被交给某节点的依赖产物各写一条 **`artifact.referenced`**（`artifactId, version, nodeId, relation:'briefed'`）到 `artifact_events`，紧挨 `artifact.accessed`。执行层在简报构建完成处调用（`execution.ts`）。「产物 → 读者」边由此可查；`read()` 本来就回带该版本最近 20 条事件，UI 无需新端点。
4. **文档定调**：「harness 代发」是**交付物的保底通道**（声明即落地，未写/为空则节点不 succeeded=机械失败），`artifact_publish` 仍是子 agent **附加产物**的自有通道；两条并存（`docs/design-graph-examples.md`）。若把交付物也改成纯 agent publish，「忘了发」会变成**静默通过**、验收证据消失——所以保底不取消。

**未修（如实说明）**：直读对象库那条路**仍不落事件**——bash 打开 `objects/sha256/…` 是文件系统访问，harness 无法在不改沙箱/不接管文件访问的前提下拦截。要它可观测，只能让「读产物」都走 `artifact_read`（第 1、2 项就是在推这个），或另起一层托管文件读。

**证据**：v33 读数（list 12 / read 0 / 直读对象库 8）；`briefing.ts` artifacts 段；`artifact-workspace.ts:548-551`（accessed）与新 `recordReferences`；`execution.ts` 简报构建尾部调用点。

**落地（fixed@6c8ae38）**：先红后绿——2 条新用例先红（简报应含 `artifactId@version` 与 `artifact_read`；`artifact.referenced` 行应带 nodeId 与 relation）→ 实现后绿；13-Graph 全量门禁 **217 文件 / 1477 用例绿**（提交 `2f5fb07`，另 `895c861` 对齐调用写法）。经 RSI 落 graph-rsi（`6c8ae38`，generation 430）；自证 live：进程 22:41:20 启动晚于提交 22:41:17，`rsi/status` commit=6c8ae38、pendingRestart=null。

**顺带发现（open，低危）**：`graph-rsi` 检出的 `src/core/execution.ts` **缺一段 `publishDeliverable` 的文档注释**（13-Graph 里自 `267d347` 就有）。纯注释漂移、无功能差异（该文件功能行已逐字节一致），但破坏了「两检出逐字节一致」这个不变量。建议并入**下一次** RSI 改动一起搬过去，不为此单跑一次重载。

**证据（漂移）**：`diff 13-Graph/src/core/execution.ts graph-rsi/src/core/execution.ts` 仅剩 `584-595` 一段注释差异。

---

## ▶ HB-211 + HB-212 fixed@a8e0a2f：`send_to_peer` 的私信既没进目标节点的聊天窗口，又在 main 聊天框里冒充 main agent

**两个缺陷（实测任务 a621e9d6，形状 A v33，15 条 `send_to_peer`）**：
1. **冒充 main agent**：私信写成 `messages` 行，`role='assistant'`、`kind='agent_message'`，**无署名**。而 `Conversation.tsx`（用户的 main 聊天框）不传 `assistantAuthor`，于是标签默认成 **`主 Agent · 最终回答`**——`impl-a → review-a` 的私信在用户眼前读起来就是 main agent 在说话。踩中「绝不冒充使用者/main」的红线（`conversation_write` 那条路径做了署名，`send_to_peer` 这条没有）。
2. **目标节点看不到**：节点聊天窗口（`AgentNodeChat`）读的是 `/api/tasks/:id/nodes/:nodeId/run` 的 **`node_entries`**，而私信写在**另一张表 `messages`**（`conversation_id`）——**两条数据流不相交**。加上 15 条全部落在「最近 200 条」窗口之外（最新一条距会话末尾 412 条），默认根本看不到；往回翻又只看到伪装的 assistant 气泡。

**使用者拍板的语义（方案 ①：「送达即 prompt」）**：私信**像用户消息一样投递**给目标节点——
- 目标在跑 → `execution.steer` 注入当前回合；
- 目标已结束 → **`reactivate` 复活它**，私信成为它下一回合的输入；
- 目标节点的聊天窗口**自然显示**它（因为窗口读 `node_entries`），且**署名发送者**（`from · Agent 消息`），绝不冒充人；
- 下一回合的简报把它当**同伴指令**带进去（`Peer Agent <from> messaged you; treat this as an instruction…`）；
- **允许 A→B→A 无限往返**（不加环上限），**给已 succeeded 的节点发信就复活它**（这两条都是使用者明确选择）。

**修法（本轮实现）**：
- `node-messages.ts` 把「投递给某节点」抽成 `deliverToNode`，`sendNodeMessage`（用户→节点）与新的 **`sendPeerMessage`（节点→节点）** 共用；peer 路径经 `provenance.from` 把发送者写进 `node_entries.data`（`{from, peer:true}`），entry 的 `role` 为 `assistant`+`peer` 标记，UI 再翻成「传入消息」样式但保留署名。
- `task-runtime.ts` 暴露 `sendPeerMessage`；`pi-adapter` 的 `peers.send` 改走它（`channels.peers` thunk，rank `execution` 延迟取），无通道时退回旧的被动记录。
- `execution.ts` 返工简报区分「用户返工」与「同伴私信」两种措辞。
- `node-transcript.ts` + `TranscriptRows.tsx`：`peer` 条目渲染成**传入消息**（role user），作者行显示 **`<from> · Agent 消息`**，不写「我」。
- `agent-tool-definitions.ts` / `agent-messaging.ts`：工具描述与注释从「躺在收件箱等你拉」改成「像 prompt 一样投递」。

**证据**：v33 的 15 条私信全在 `193ce3e1`、`role=assistant`、`operation_id=NULL`、最近 200 条中 0 条；`nodeRun` 读 `node_entries`；`TranscriptRows.tsx:402` 默认 `主 Agent · 最终回答`。

**落地（fixed@a8e0a2f）**：先红后绿——2 条 `node-messages` 用例 + 1 条 `node-transcript` 用例先红（`runtime.sendPeerMessage is not a function` / peer 条目应按传入消息渲染并带 from）→ 实现后绿；13-Graph 全量门禁 **217 文件 / 1480 用例绿**（提交 `cd43de6`）。RSI 落 graph-rsi（`a8e0a2f`，generation 431，含 `app:build`）；自证 live：进程 23:21:36 启动晚于提交 23:21:31，`rsi/status` commit=a8e0a2f、pendingRestart=null。

**已知代价（使用者已接受）**：两个 Agent 若互相回信，会互相唤醒并持续重跑——这是选定语义，不是缺陷。工具为幂等（`requestId`），重复发送同一条不会二次投递。

**仍 open（低危，第二次踩到）**：`graph-rsi` 的 `src/core/execution.ts` 仍缺 `publishDeliverable` 的文档注释（13-Graph 自 `267d347` 就有）。纯注释漂移、功能行逐字节一致。**建议并入下一次 RSI 改动一起搬过去**，不为此单独重载。

---

## ▶ HB-213 fixed@477e187：声明了 deliverable 的节点，简报从没说「必须把这个文件写到磁盘」——于是评审只 publish 不写文件，被 settle 正确拒绝

**实测（任务 68543fed，形状 A v33 复跑，全节点 space-bunny-free）**：
- `review-a` 调了 **`artifact_publish`**（把报告发成共享产物）、**没调 `write`**，磁盘上 **`reviews/review-a.md` 不存在**；
- settle 正确拒绝：`reviews/review-a.md was declared as this node deliverable but was never written`；节点 blocked，等人处理。
- 同一轮里 **`review-b`/`review-c` 都同时 `write` 了文件并 `publish`，正常通过**——所以这是模型对契约的误读，不是 harness 坏了。

**根因（措辞歧义）**：节点自己的简报从来没说「声明的 deliverable 是一个必须写到磁盘的文件」。master 在图 decisions 里写的是「评审必须在**共享产物**里写一份报告」——**「共享产物」这个词让模型选择 `artifact_publish`，跳过了写盘**。而 settle 读的是**磁盘上的文件字节**（`operation-lifecycle.ts:1151-1157`），两者对不上。

**修法（本轮实现）**：`focusBriefing` 增加 `deliverableInstruction(mine)`——只要节点声明了 `deliverable`，简报就明确写出：`You must WRITE the file <path> before you finish: it is this node's declared deliverable… Publishing a shared artifact (artifact_publish) does not satisfy this on its own; write the file.`

**证据**：`reviews/review-a.md` 缺失、`artifact_publish` 有调用而 `write` 无调用；review-b/c 两者都有；`operation-lifecycle.ts:1151-1157`（读磁盘字节）；v33 的 decisions 原文（「在共享产物里写一份报告」）。

**落地（fixed@477e187）**：先红后绿——1 条 `briefing` 用例先红（声明了 deliverable 的节点应被告知写文件、且指出 publish 不算）→ 实现后绿；13-Graph 全量门禁 **217 文件 / 1481 用例绿**（提交 `e8e5c42`）。RSI 落 graph-rsi（`477e187`，generation 432）；自证 live：进程 00:28:53 启动晚于提交 00:21:21，`rsi/status` commit=477e187、pendingRestart=null。

**处理方式**：两次 `execution_failed` 都按 **retry** 解决（不是 escalate）——节点失败在一个它能修正的机械遗漏上，它的分析已经做完，不需要重做。第二次 retry 在 HB-213 落地之后，因此拿到了新的写文件指引。

---

## ▶ HB-214 fixed@4b5db0f：同一会话内返工时，整份简报被换成「只是失败证据」，节点因此丢掉自己的契约（route + 交付物）

**实测（任务 68543fed，review-a 第 3 次 block）**：review-a 的**重试简报全文**里既没有 `route` 指引，也没有 HB-213 刚加上的 `You must WRITE the file …`——所以它**提交结果时没有 route**（`recovery`：节点由自己选择分支，但提交的结果里没有 route），**同时也没写文件**，第三次被拒。

**根因（代码定位）**：`src/core/execution.ts` 的 `reworkDelta`（第 43 行）在「同一会话的 attempt>1」时把 `intent.context.briefing` **整段替换**成 `reworkBriefing({...})`，而后者只回带「失败的证据 + 被阻塞的验收」。**它没有回带节点在任何一轮都必须满足的规则**——于是 **HB-208（要交 route）与 HB-213（要写交付物文件）在任何同会话重试上同时失效**。更糟的是它的开头还写着「不要重读或重述」——主动劝退节点去看自己的契约。

**修法（本轮实现）**：
- `briefing.ts` 导出 **`nodeContract(node)`** = `routerInstruction(node)` + `deliverableInstruction(node)`；`focusBriefing` 改用它（一次陈述）；
- `reworkBriefing` 增加可选 `contract?: string[]`，在「失败证据」之后追加一段 **`Unchanged rules you must still satisfy this turn:`**；
- `execution.ts` 的 `reworkDelta` 从图中取该节点并传 `contract: nodeContract(...)`。
- 于是：**首轮**由 `focusBriefing` 陈述契约，**返工轮**由 `reworkBriefing` 重述契约——两条路径都不再丢失。

**证据**：review-a 重试 operation 的 briefing 原文（无 `route`、无 `You must WRITE the file`）；`reworkDelta` 定义（`execution.ts:43`）；三次 block 的原因依次为 execution_failed（未写交付物）→ execution_failed（未写交付物）→ recovery（无 route）。

**落地（fixed@4b5db0f）**：先红后绿——1 条 `reworkBriefing` 用例先红（返工简报应重述节点契约、且仍不含整份 briefing 正文）→ 实现后绿；13-Graph 全量门禁 **217 文件 / 1482 用例绿**（提交 `d45dcdc`）。RSI 落 graph-rsi（`4b5db0f`，generation 433）；自证 live：进程 08:03:11 启动晚于提交 08:03:07，`rsi/status` commit=4b5db0f、pendingRestart=null。

**教训（写给下一次的我）**：HB-208 与 HB-213 都是**只在首轮简报里**声明契约，所以只在「全新会话」成立；**任何同会话重试都会静默丢掉它们**。我给两次修复都只验了首轮路径（单测直接调 `briefing`/`focusBriefing`），**没验返工路径**——这正是 HB-202 那次「修一层必须用真实路径验证」的同一病，第三次踩到。新加的用例现在直接钉 `reworkBriefing`。

---

## ▶ HB-215 fixed@7b6021c：`result_handoff` 的 schema 示例把三个「字符串数组」画成裸 `[]`，而校验器要求短字符串——模型按示例填对象，被裁判拒绝

**实测（任务 68543fed，review-a 第 4 次 block）**：HB-213/214 修好后，review-a 这次**写出了 `reviews/review-a.md`（worktree 与 integration 都在）、也提交了 route**——前两个契约都满足。新的失败是 `result_noncompliant`：`result_handoff@1` 的 **`nextActions`** 传了**对象数组**，而校验器要求 **`an array of at most 50 short strings`**。

**根因（承诺的 schema 与执行的 schema 不一致）**：`src/core/execution.ts` 内联的示例把 `changes`/`decisions`/`verification` 写成**对象数组**（有形状），却把 `knownLimits`/`openQuestions`/`nextActions` 写成**裸 `[]`**——**没写元素类型**。而 `predecessor-handoff.ts` 的 `stringList()` 对这三个要求短字符串（≤50 项、每项 ≤500 字）。模型照着示例走，在 `nextActions` 里放了 `[{"action":"…"}]`，于是被裁判（正确地）拒绝。**这是我第四次遇到同一族缺陷：prompt 与校验器对同一契约的描述不一致。**

**修法（本轮实现）**：
- 把示例抽成 `predecessor-handoff.ts` 里**紧挨校验器**的导出常量 **`RESULT_HANDOFF_SCHEMA_EXAMPLE`**，让两者无法再漂移；
- 每一个字段都写明元素类型（三个字符串数组写成 `["<short string>"]`，对象数组保留形状，`evidenceRefs` 也补上示例）；
- `execution.ts` 改为引用该常量；
- 新增用例：**解析该常量并断言三个字符串数组的首元素是 string、三个对象数组的首元素是 object**——直接钉住「示例与校验器一致」。

**证据**：problem `48201fea`（path=nextActions, expected「array of at most 50 short strings」, got 对象数组）；`predecessor-handoff.ts` `stringList()` 与 `reject('nextActions', …)`；`execution.ts:922` 原示例。

**落地（fixed@7b6021c）**：先红后绿——1 条用例先红（示例里三个字段是裸 `[]`，`[0]` 是 undefined）→ 实现后绿；13-Graph 全量门禁 **217 文件 / 1483 用例绿**（提交 `7c6c4a7`）。RSI 落 graph-rsi（`7b6021c`，generation 434）；自证 live：进程 08:16:31 启动晚于提交 08:16:28，`rsi/status` commit=7b6021c、pendingRestart=null。

---

## ▶ HB-216 fixed@5028815：既是验收项的评审 Agent，永远无法把成果交给任何下游节点

**实测（任务 68543fed，review-a/b/c 全部 succeeded、三条验收 a/b/c-pass 全 valid 之后）**：`merge` 一开工就被挡，problem `17acc4fe` `context_rejected`：`Result handoff operation result mismatch for review-a`。**形状 A 走到整合这一步就断了**——三条评审都过了，却一分成果都交不出去。

**根因（写入顺序与指纹定义互相矛盾）**：`settleResultHandoff`（`src/core/predecessor-handoff.ts`）会把「被交接的那份结果」的指纹 `source.operationResultDigest` 存进 `result_handoffs`。而绑了验收项的评审 Agent 的**证据是由 harness 自己登记的**——`operation-lifecycle.ts` 的结算路径会把 result **整个替换**成带 evidence 的版本（证据就是评审自己写的那份 review）。这次替换发生在 `settleResultHandoff` **之后**，于是：指纹记的是「加证据前」的结果，库里存的是「加证据后」的结果，任何下游来读都判为指纹不符 → `context_rejected`。

**离线逐字节证明（真任务、全库）**：review-a 的 handoff 记录 `f15591ca`，库中 result 的指纹 `3007c3a1`，而**去掉 evidence 后正好是 `f15591ca`**；review-b `e3c20c1e`/`76fc486a`、review-c `37c4c168`/`48712acf` 同样。**全库 7 条 handoff：只有这 3 条「路由器+验收项」带这个签名，另外 4 条分毫不差。**

**修法（两处改动，一条不变式：handoff 的指纹必须描述库里真正存着的那份结果）**：
1. **写入路径**：把「路由器验收证据登记」与 `rework`/`routed` 的计算**移到 `settleResultHandoff` 之前**，指纹因此覆盖将要落库的那份结果。
2. **读取路径**：额外接受「无证据形式」——从**库中结果**重算，不需要任何猜测。这只对旧行生效；**篡改 outcome/output/route/artifacts 两种形式都不匹配，仍然拒绝**（已实测三种篡改全部被拒）。第 2 条是必需的：第 1 条只能保证新行正确，**已写下的 3 条旧行依然读不了**。

**先红后绿**：新增 e2e 用例 `the handoff of an Agent router bound to acceptance is readable by its downstream`（reviewer 绑验收项 + 下游要求 result_handoff）——修前 `after-a` **blocked**，修后 succeeded。**改 1 处（只重排、不放开读取）仍红**，证明两处都不可少。

**走过的弯路（已实测，写下来免得再走）**：一开始想「干脆把 evidence 从指纹定义里删掉」，**结果全库 7 条全坏**——`canonicalJson` 会保留空数组，`evidence: []` 这个键一直在指纹里，删键等于把**所有**行的指纹都改了。

**落地**：13-Graph 提交 `3ee8d00`，`node --run check` **217 文件 / 1484 用例绿**。RSI 落 graph-rsi（`5028815`，generation 435）；自证 live：进程 21852 启动 08:45:18 晚于提交 08:45:15，`rsi/status` commit=5028815、pendingRestart=null，三份文件两检出逐字节一致。**真任务自证**：`retry merge` 后 merge 首次真正开工（此前一直 blocked）。

---

## ▶ HB-217 fixed@512cdcc：`context-model.test.ts` 的「篡改检测」用例是空转的——它不管篡没篡都会抛

**发现经过**：修 HB-216 时想在那个用例里加一句「加证据后仍可读」，结果**未篡改的结果也抛** `operation result mismatch`。

**根因**：那个用例手搓 `result_handoffs` 行，指纹写的是 `digest(result)`（裸对象），而产品算的是 `digest({outcome, output, evidence, artifacts, route})`——**两者本来就不相等**。用例里唯一读取 handoff 的那次调用（`buildPredecessorHandoffs` + result_handoff）永远不会匹配，所以 `expect(...).toThrow(/operation result mismatch/)` **无论有没有篡改都成立**。它测的不是篡改检测，是同义反复（R27 说的「复现实现的测试不是测试」）。

**为什么这次能确认**：把「未篡改」的情形插到同一处断言，立刻红——而这本该绿。

**建议修法**：不要手搓行，改成**走产品自己的写入路径**（`settleResultHandoff`）建行，再读回；或者让 harness 导出可测的指纹投影。**HB-216 的读取容忍正是靠这类测试才该被拦住的。**

**证据**：`tests/console/context-model.test.ts` 约 346 行 `operationResultDigest: digest(result)`；约 388 行 `expect(...).toThrow(/operation result mismatch/)`；本地把未篡改分支插进去后该断言立即失败。

**落地（fixed@512cdcc）**：改成**用产品自己的写入器 `settleResultHandoff` 建行**，并**两个方向都断言**——同一条记录在 result_handoff 边上**读得出来**（指纹与库中结果相符），被篡改后**读不出来**。单留任一半都是空转；两半合起来才是测试。`tsc` 干净，13-Graph 门禁 **220 文件 / 1494 用例绿**（提交 `2695180`）；RSI 落 `512cdcc`（gen 438），自证 live（进程 11:05:05 > 提交 11:04:58）。**这个测试本该拦住 HB-216 却拦不住——现在能拦了。**

---

## ▶ HB-218 fixed@39d93e3：两条线已合并，`rsi/product-line` 为权威（产品线 main 与 live harness 所在分支）

**发现经过**：修完 HB-216 做落地自证时，顺手把**整个** `src/`、`tests/` 逐文件比对（此前每轮只比对本轮碰过的文件，所以一直没看见）。

**事实（可复核）**：
- `/Users/macmini/workspace/graph-rsi` **不是独立克隆，而是同一个仓库的 git worktree**（`git -C 13-Graph worktree list` 里就在列），跑在分支 **`rsi/product-line`**。13-Graph 工作区是 **`main`**。
- 两棵树**双向都有对方没有的东西**：`main` 独有一条（`publishDeliverable` 的文档注释块，即此前记的「注释漂移」）；`rsi/product-line` 独有 **8 个 `fix:` 提交**（都不是 RSI 镜像，是真修复）：
  `9eba3bf recover plain XML tool calls and analysis leaks`、`3d100df hide analysis text before real tool calls`、`a5e1110 hide orphaned analysis closing tags in transcript`、`1fd9b16 contain private response markup across Graph turns`、`1115b60 keep response corrections atomic for worker frames`、`0e3ea3a recover bare parameter text instead of treating it as tools`、`4c11380 recover from session summaries leaked as chat replies`、`56ef9f8 image prompt worker stdin backpressure`。
- 受影响文件（`src`）：`execution.ts`(12 行，仅 main)、`verification.ts`、`handoff-response.ts`(110 行，多为 live 新增)、`unexecuted-tool-call.ts`、`web/GraphCanvas.tsx`、`web/transcript-model.ts`；另 `src/core/assistant-visible-text.ts`、`src/web/graph-edges.ts` **只存在于 live 分支**。`tests/` 同理（`loop-channels.test.ts` 只在 live）。
- 两个分支的提交计数（`git rev-list --left-right --count main...rsi/product-line`）= `19 / 37`——这个数字被「同一改动在两条线上各提交一次」放大，**真实差异是上面那份文件清单**，不要用提交数判断。

**为什么值得记**：`main` 是产品线、用户看到的仓库；live 分支是真正在跑的 harness。**今天 live 比 main 多 8 个修复**，也就是说「从 main 构建出来的 app」和「在跑的 app」不是同一个东西。分叉每轮都在长。

**建议（需使用者定夺，未动手）**：把 `rsi/product-line` 合回 `main`（或反过来以 live 为准重建 main），并把「每轮只镜像本轮碰过的文件」升级为「每轮结束核对两棵树」。**没做**：合并会动到 live 正在跑的代码，且哪个分叉是权威属于使用者的决定。

**证据**：`git -C 13-Graph worktree list`；`git -C 13-Graph log --oneline main..rsi/product-line`；`diff -rq 13-Graph/src graph-rsi/src`。

---

## ▶ HB-219 open：「在集成副本上跑整套测试」这道门**在 harness 放副本的地方永远跑不过**——同一提交换个位置就全绿

**实测（任务 68543fed，merge 已 succeeded、集成 SHA `56cd786`，这是形状 A 的最后一道门）**：`full-tests`（`graph.command`：`node --run check`，workspace = `~/Library/Application Support/Graph/state/worktrees/<task>/integration`）先被 **SIGKILL**，重跑则 **42 个文件 / 127 个用例失败**（1480 中）。这三个只读诊断脚本不可能造成 127 个无关失败。

**决定性 A/B（同一提交 `56cd786`、同一命令、同一份 `node_modules`）**：
| 位置 | 结果 |
|---|---|
| `~/Library/Application Support/Graph/state/worktrees/<task>/integration`（harness 现在用的） | **127 failed / 1480** |
| `~/workspace/13-Graph-intcheck`（工作区根目录的同级 worktree） | **7 passed / 7**（`tests/m8/conversation-pi.test.ts` + `tests/m7/page.test.ts`） |
| 产品检出 `~/workspace/13-Graph` | **1484 passed** |

**merge 自己已经把这个结论写下来了**：它在 `/Users/macmini/workspace/.graph-full-check-81437`（**工作区根目录下**）跑出 `217 files / 1480 tests passed`，并在 README 里写明「`node --run check` 在**正确准备的副本**里通过（hardlinked node_modules、**npm 在 PATH 上**）——**这正是 full-tests 节点必须复现的状态**」。也就是说：**merge 做对了，是这道门自己没复现那个状态。**

**已查明的一个具体原因**：`tests/m7/page.test.ts` / `tests/m7/clone.ts` 用 `process.cwd()/../12-MediaBookmarks` 取同级仓库——那个同级目录在 `~/workspace/` 下有，在 state 目录下没有（补上软链后该文件立刻转绿）。**未查明**：m8 一组用例在 state 目录下报「模型请求根本没到 provider」（1 秒内失败，不是在等超时），另有若干 vite 构建类用例 30–46s 超时（疑似资源争用）。**所以位置是原因、但不止一个原因**——不要以为加一个软链就够。

**为什么这是 harness 缺陷而不是「成果有毛病」**：提交本身在产品检出里 1484 全绿；merge 的 own-check 也在别处全绿。**返工 merge 不可能修好它**——图里声明的回边 `full-tests → merge` 会白白空转烧 token（已因此**没有**盲目 retry）。

**可选修法（代价递增，需使用者选）**：
1. **让门在「正确准备的副本」里跑**（等于 merge 已经证明可行的那条路：工作区根目录下的临时副本 + 完整 PATH）——最便宜，且不改变「整套测试真绿」这个契约；
2. **收窄门的命令**：只跑本次改动碰到的测试子集——便宜，但门变弱，与「整套测试」的原意不符；
3. **把测试改成位置无关**（去掉 `../12-MediaBookmarks` 之类的 cwd/sibling 假设、查清 m8 那一组）——最贵，但最正；否则**任何任务的这道门都会失败**。

**证据**：`/tmp/ft-repro.log`（state 目录下 127 failed/1480）；`/tmp/graph-int-evidence/HARNESS-FULL.log`、`FULL-CHECK.log`（merge 在 `~/workspace/.graph-full-check-81437` 的 217/1480 passed）；`diff`/`git worktree` 对比见上表。

---

## ▶ HB-219 fixed@7e96c15：跑项目自带命令的检查要在**项目旁边**跑，而且依赖必须是真文件

**实测（任务 68543fed，merge 之后的那道全量测试门）**：同一提交 `56cd786`、同一命令 `node --run check`、同一份依赖，只换位置与形态——

| 位置 | 结果 |
|---|---|
| 宿主状态目录下的工作副本（`state/worktrees/<task>/integration`） | **127 failed / 1480** |
| 项目根旁边的副本（`<项目根的父目录>/.graph-check-13-Graph-full-tests`） | **1480 passed** |
| 产品检出 `13-Graph` | 1484 passed |

两个原因：**（1）依赖是软链**——`canonicalGrant` 拒绝一切 `realpath(path) !== path` 的授权路径（这条守卫是有意的：worker 能在自己副本里造软链），而套件里那些把 `resolve('node_modules')` 当 `readPaths` 交给沙箱的用例一律抛错、沙箱内进程起不来。**一个变量就能复现**：同一目录里软链 6 失败 / 硬链 6 通过。**（2）套件要读项目根旁边的同级仓库**（`tests/m7` 用 `process.cwd()/../12-MediaBookmarks`），状态目录下没有。

**修法**：`graph.command` 新增可选 `copy: "project"` —— 该检查改建在项目根旁边的新 worktree 里跑，并把唯一一份安装**硬链**进去；副本以「做它时的那次提交」为键，提交没变就复用（实测复用生效，省掉 12 秒硬链）、变了一律重建。写进 ADR 0027 追加节。

**先红后绿**：新增 `tests/console/program-copy.test.ts`（6 用例）；关掉接线那一条立刻红。13-Graph 门禁 **218 文件 / 1490 用例绿**（提交 `5ce1058`）。RSI 落 `7e96c15`（gen 436），自证 live（进程 10:06:49 > 提交 10:06:40）。**第一次 RSI 检查失败是我自己的用例脆**：拿未解析的临时路径与 `process.cwd()` 比（`/var/folders` 实际经 `/private` 前缀），两侧都 realpath 后修好。

---

## ▶ HB-220 fixed@7cfbd28：每道 `graph.command` 检查都被硬性 2 分钟超时杀掉，而且杀得像「结果的判断」

**实测（同一天的两道门）**：operation 行给出的时间**精确到秒**——第一次 09:16:19 派发、**120s** 结束；第二次 10:08:52 派发、**133s** 结束。而整套测试需要 **127–145 秒**。杀它的是 `workspace-command.ts` 里写死的 `timeoutMs: 120_000`，`restricted-process` 到点用 SIGKILL 收割进程组，只记一句 `Process terminated by SIGKILL`——**读起来像「命令判定这份活不行」，而不是「harness 设的限」**。这让任何一个稍长的检查都会被限本身决定成败。

**修法**：`graph.command` 新增可选 `timeoutMs`（正整数毫秒，上限一天）；默认仍是 2 分钟；给不出能兑现的值就拒绝而不是悄悄替换；被限杀掉时记录里写明**是超时**（`Process terminated by SIGKILL: it exceeded the <n>ms timeout`）。

**先红后绿**：新增 `tests/console/program-check-timeout.test.ts`（3 用例：限内跑完 / 越限被切且记录写明超时 / 不可兑现的限被拒）；关掉接线后「越限被切」立刻红。13-Graph 门禁 **219 文件 / 1493 用例绿**（提交 `b8b841d`）。RSI 落 `7cfbd28`（gen 437），自证 live（进程 10:27:04 > 提交 10:27:02）。

**合并前实测**：同一仓库两个 worktree，**双向都有对方没有的东西**——live 线独有 8 类修复（XML 工具调用与分析文本恢复、跨回合私有响应标记包含、孤儿分析闭合标签、worker 帧响应修正原子性、裸参数文本恢复、图片 prompt stdin 背压）；`main` 独有 `summarizeReview`（评审自己的话）、它那条「同内容换激活仍应满足门」的测试，以及全部 planning / acceptance 记录。**8 个 src 文件 + 12 个测试文件不同，另有 2 个文件只存在于 live 线。**

**做法**：`git merge --no-ff -X theirs rsi/product-line`（冲突以 live 线为准）。**唯一需要人工解的地方**：`verification.ts` 里 `summarizeReview` 出现了**两次**——同一个修复在两条线上各自提交过（两份**逐字节相同**），保留一份后该文件与 live 线**逐字节一致**；`main` 多出的那条测试**保留**（live 线有实现却没有它）。

**验证**：合并后的 `main` 门禁 **221 文件 / 1509 用例绿**（合并前 220/1494）。以后 `main` 描述的就是真正在跑的 harness。**注意**：合并只动 `main`，`graph-rsi` 那棵树没变，所以**对正在运行的东西零影响**。

**未做**：**没推**（13-Graph 的 push 在本会话沙箱里被静默拦掉，本地提交完好）。

---

## ▶ HB-221 fixed@917f550（连修两轮：先「能声明走出沙箱」，再「走出沙箱不等于交出应用环境」）：

**先撤回我自己的错**：本条目上一版写「host 模式不给平台 git 运行时读授权，9 条 `commit-msg.sample` 拒绝」。**这个诊断不成立**——我写了探针实测：full-access 检查用**沙箱自己的 PATH**（`/usr/bin/git`，正是需要读 CLT 的那个 shim），在工作副本里和 scratch 下都**成功建了仓库，status=0，没有任何拒绝**。那条 stderr 只是被杀时留下的**尾巴**（失败结果只保留 `stderr.slice(-4000)`，且完全不留 stdout），所以我当时看到的 9 行是**尾部噪声**，不是原因。

**失败记录其实在磁盘上，只是没人被告知它在哪**：`program-adapters` 在判失败**之前**已经把完整记录写进 `<scratchRoot|workspace>/checks/<nodeId>.json`（stdout 36KB + stderr），但失败结果只回报 `{code, stderr 尾部}`，**不指向那个文件**。我是在 state 目录里翻到 `state/checks/full-tests.json` 才看到真相的。

**那里的真相**：同一份副本（`56cd786`、`/Users/macmini/workspace/.graph-check-13-Graph-full-tests`）**不进沙箱时 1480/1480 全绿**；**进沙箱后：224 失败 / 49 通过**，而且失败以套件**自己的超时**为主（15s×40+、60s×6、还有 240s/180s），前面还有一大批「毫秒级就失败」的（`tests/m8/app-shell-ux.test.ts` 30/30 在 1.5s 内全挂、`tests/console/rsi-reload.test.ts` 8/8）。所以**「在沙箱里跑整套测试」这件事本身不成立**，不是一个可以用一行修掉的沙箱授权缺口。

**结论**：`full-tests` 这道门的形状需要使用者定夺（收窄到改动涉及的测试子集 / 换个跑法 / 接受它不可用）。**继续往下挖之前应当先定这个**，否则每轮都要等 10 分钟。

**证据**：`state/checks/full-tests.json`（54KB，完整 stdout/stderr）；operation `c419db56-e892-471d-832b-9d1e2a2dcc8e`（派发 10:28:08，600s 被切）；`tests/console/program-check-host-git.test.ts`（探针，已作为负结果留在仓库里）。


**增补（使用者 2026-09-30 决定）**：**保留 gate**，并**明确告诉 merge 不要重复跑整套测试**——整份交付的测试由「全量测试」门在集成副本上跑一次，那是唯一跑全套的地方（既不重复：实测 impl-a/impl-b/review-b/merge 各跑一次全套、每次约 2.5 分钟；也不把证明权交给 agent）。已写进形状 A 草稿 v35 的 merge 节点说明与 decisions。**仍未解的是「这道门在沙箱里能不能跑完」本身**（沙箱内 224 失败/49 通过、以套件自身超时为主），方向仍待定夺。
---

## ▶ HB-222 open：失败的检查**不告诉任何人完整记录在哪**，于是长时间失败无从诊断

**实测**：一个跑满 600 秒才被切的全量检查，最终只回报 `{code: null, stderr: <最后 4000 字>}`；**stdout 全丢**，而完整记录（36KB stdout）明明已经写在 `checks/<nodeId>.json`。为了诊断这次失败，我得在 state 目录里手动翻找那个文件——**任何人（包括 main Agent）都不该需要这样**。

**建议修法**：失败结果里带上记录文件的绝对路径（它已经在写），或至少保留 stdout 的一段；理由与 HB-220 同源——**harness 自己造成的失败必须能被读出来，而不是只剩一句像判决的话**。

**证据**：`program-adapters.ts` 里「先写 `checks/<nodeId>.json`，再 `return {outcome:'failed', output:{code, stderr: stderr.slice(-4_000)}}`」；operation `c419db56`。

---

## ▶ HB-223 open：合并之后**漂移会自己长回来**——RSI 每次改动仍然只落 `rsi/product-line`

**实测**：HB-218 把两条线合了（main `39d93e3`，门禁 221 文件 / 1509 用例绿，两条线此刻内容一致）。但 RSI 通道**照旧把每次自改进提交到 `rsi/product-line`**，`main` 不会自动跟进——所以**下一次 RSI 改动之后，漂移立刻重现**（这次漂移就是这么来的：40 个提交、8 个 src 文件、12 个测试文件，两个文件只在 live 线上）。

**建议（需使用者定夺，与「谁权威」是同一个决定）**：要么每次 RSI 落地后把 `rsi/product-line` 合回 `main`（可以做成 RSI 落地报告里的一步），要么把「任务构建用的分支」直接改成 `rsi/product-line`，让两者合一。**不做**：这属于流程/权威决定，且会动到 live 正在跑的代码。

**证据**：`git -C 13-Graph rev-list --left-right --count main...rsi/product-line`（合并前 22/40）；合并后 `main..rsi/product-line` = 0。
## ▶ HB-224 fixed@06a4622：

**代码**：`send_to_peer` 走的是 `channels.peers().deliver()` → `sendPeerMessage` → **把消息变成目标节点自己的条目**（运行中就 steer，已结束就重新激活，下次派发时作为 prompt 读到）。**被动收件箱**（`messages` 表 `to_node_id`）只由 `sendNodeMessage` 写，而那只是「运行时没有投递通道」时的兜底 —— 图里永远有通道。所以 `nodeInbox` 恒空。`nodeInbox`/`sendNodeMessage` 的调用点只剩这个兜底和测试。

**但它是被广告的**：`list_peers` 的描述写着「Combined with send_to_peer and read_peer_messages, this is how the Agents of one graph work together」。**实测任务 `68543fed`：7 个节点里 4 个（impl-a/impl-b/impl-c/merge）各调了一次 `read_peer_messages`，拿回空**——4 个回合白烧。

**建议**：删掉 `read_peer_messages`（连同 `nodeInbox`，视兜底是否需要保留 `sendNodeMessage`），并改掉 `list_peers` 的描述。**证据**：`src/runtime/pi-adapter.ts:463-472`、`src/core/node-messages.ts:28`、`src/runtime/agent-messaging.ts`（`nodeInbox` 读 `messages`）、node_entries 里 4 次调用。


**落地（fixed@06a4622，13-Graph 3426f75→76 前身）**：`read_peer_messages` 与它的读侧（`nodeInbox`）和写侧（`agent-messaging.sendNodeMessage`、pi-adapter 的兜底分支）整条删除；`list_peers` 描述不再推荐它。`conversation-scope.ts`（`sameGraphReach`）随载体一起删除——跨图拒绝改由真正投递点保证，并新增用例钉住（`node-messages.test.ts`：不得向本图之外的节点投递、不得给自己发）。解除测试：`agent-messaging-e2e.test.ts` 现在断言工具面上**没有** `read_peer_messages`，且 `send_to_peer` 交给投递通道、不写任何可读的表。**实测回归**：任务 68543fed 里 4/7 个节点各白调一次的那个工具，从此不存在。
---

## ▶ HB-225 fixed@06a4622：

**实测（3/3 命中，不是巧合）**：`68543fed` 里只有 review-a/review-b/review-c 声明了 `deliverable`，也只有这三个节点出现**同名两版本、digest 相同**：review-b v1「车道 b 评审报告（verdict: pass）」/v2「车道 b 评审报告」同为 `341eaad270`；review-c 同为 `62cdf31714`；review-a v3/v4 同为 `14e5b5d323`。

两次都由**同一个 operation、同一个 activation** 发布：v1 是 agent 自己 `artifact_publish`，v2 是 harness 的 `publishDeliverable`。**根因**：`publishDeliverable` 只检查「文件存在且非空」，**不检查同名头部的 digest 是否已经相同**，无条件再发一版。声明 deliverable 的语义本来是「怕节点忘了发」，不是「一定要发两遍」。

**建议**：publish 前比一次头部 digest，相同就记下不新增版本（但**必须保住它作为验收证据的登记**——HB-216 的机制就挂在这次发布上）。**证据**：`src/core/execution.ts:1111`（无条件 `publishDeliverable`）、`artifacts` 表 3 组同 digest 双版本。


**落地（fixed@06a4622）**：新增 `ArtifactWorkspace.head(taskId, logicalKey)`（最新已发布版本的 digest），`publishDeliverable` 在**字节相同**时不再新增版本。先红后绿：`tests/console/node-deliverable.test.ts` 新用例用**产品自己的 publish** 造夹具（改前版本号 `[1,2]`，改后 `[1]`）。验收证据不受影响——HB-216 的证据是**按磁盘文件内容**登记的，与是否新增版本无关。
---

## ▶ HB-226 fixed@06a4622：

**实测**：`68543fed` 里 27 次 `artifact_publish` **有 7 次失败**（impl-a 3、impl-b 1、impl-c 1、review-a 3）。而失败原因**不在任何可读记录里**——`node_entries` 的 result 只有 `{isError:true}`、`text` 只有「工具执行失败」；`instances/<id>/tool-calls/*.jsonl` 也只有 `isError` 和时间。**只有模型自己的话留下了原因**（从它的下一条 assistant 消息读出）：

> 「The source path must stay in my work copy. The file is under /tmp; let me write it into the worktree instead」「The publish requires a path inside my operation workspace, not `/tmp`.」

即 `sourcePath escaped the operation workspace`（`src/core/artifact-workspace.ts:267`）。**「把报告写在 /tmp 再发布」是再自然不过的做法，却只能靠失败三次试出来**；impl-a 还先试了不带命名空间的裸名字。每个节点都自己重学一遍。

**建议（两箭）**：① 失败结果里带上**原因**（`{isError:true, message}`，与 HB-222 同源：harness 造成的失败必须读得出来）；② `artifact_publish` 的描述**开门见山**说明源文件必须位于本次操作的工作副本内、或直接用 `content` 提交正文。**证据**：`src/core/artifact-workspace.ts:247-270`、7 次失败、模型原话。


**落地（fixed@06a4622）**：①任何工具失败都把原因写进记录——`node_entries` 结果行文本变成「工具执行失败：<原因>」，`data.message` 带上完整（有界 2000 字）原因，`message.tool` 事件同样带上；先红后绿用**真子 agent 节点过假 provider** 的 E2E（`tests/m8/tool-failure-record.test.ts`，改前结果行文本恰为「工具执行失败」）。②规则不再只能撞墙学到：`artifact_publish` 描述开门见山写明源文件必须在本次操作的**工作副本**内、并指向 `content` 替代；拒绝消息改成点名**改法**（「写进工作副本再发布，或直接用 content 正文」，`artifact-workspace.test.ts` 钉住）。
---

**落地（fixed@b463626 + 917f550）**：`graph.command` 新增可选 `sandbox: boolean`（默认 `true` 不变）。声明 `false` 时命令**直接以宿主进程运行**（自成进程组、超时按组收割、输出有界），**仅在完全访问下兑现**，否则**拒绝并把原因写到节点问题**（绝不悄悄降级）；记录里写 `sandboxed: true|false`（ADR 0029）。

**第一次真跑立刻暴露了第二层缺陷（我自己的设计错误，已改）**：第一版让沙箱外的检查**继承宿主进程的整个环境**，于是把应用自己的东西交了出去——`ps eww` 读出 `GRAPH_SUBSCRIPTION_OPENCODE_GO_API_KEY`（**真实供应商密钥**）、`GRAPH_RSI_ROOT`（**live 检出路径**，测试可能往那里写）、`ELECTRON_RUN_AS_NODE`，外加 GUI 应用的最小 PATH（缺 `/opt/homebrew/bin`，而 merge 当初就得手写这个路径才能跑套件）。真任务上表现为 **178 失败 / 1278 通过**。改为 `checkEnvironment()`：**走出沙箱只解除围栏，不改变命令能看到什么**——允许清单构造 PATH/HOME/TMPDIR/locale/Git 变量 + 宿主声明优先，绝不继承 `GRAPH_*`。先确认 live 检出未被写脏（`git status` 干净）。

**终点（真任务 `68543fed`）**：改后重跑，门 **`completed`、code 0、217 文件 / 1480 用例全通过、139 秒、`sandboxed:false`**（记录 `state/checks/full-tests.json`），任务从 `full-tests:blocked` 推进到 `human-accept`。**三道门的前后对照**：沙箱内 224 失败/49 通过 → 沙箱外但环境错 178 失败/1278 通过 → 沙箱外且环境对 **1480/1480 全绿**。

**顺带记下一条更广的教训**：这是本会话第三次踩 **macOS `/private` 前缀**（断言两侧都要 `realpath`），已按 HB-219 的老办法修掉。
