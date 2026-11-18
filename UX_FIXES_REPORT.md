# UX 修复报告（七个体验问题）

逐条记录根因、改法、验证命令、测试器证据与剩余风险；断言都落在用户可见结果上（文本、可点区域、像素），不靠 sleep 或墙钟。

## #3 主管/Agent 间通信不再混进聊天流

**根因。** 后端把「项目主管 → 全局主管」的通知写成一条普通会话消息：
`role=user, kind=chat, data.source={kind:"agent", conversationId, taskId}`，正文是
`[来自项目主管的通知] … 内容: …`（见 `backend/internal/graph/core_coordination_notices.go`）。
App 的 `messageRow` 只按 `role` 分支，于是它被画成用户的灰色气泡，与用户自己的话混在一起，还把上一轮的最终回答挤成「过程」。

**改法。**

- `app/chat_collab.go`（新）：`collabMessage` 识别 `data.source.kind ∈ {agent, supervisor, peer}`；
  `splitCollabMessages` 把会话拆成「用户/助手说的话」与「Agent 之间的话」；
  `collabMessageText` 去掉 `[来自项目主管的通知]` 信封与 `项目/工作/里程碑` 记账行，只留 `内容:` 正文；
  `collabCard` 渲染独立的「跨 Agent 协作」卡片（标题 + 条数 + 发送方/里程碑/会话 + 时间 + 正文），默认收起、点击可展开或收起，最多列 6 条并提示「还有 N 条协作消息未列出」。
- `app/transcript.go`：`runs()` 只对非协作消息分组，聊天流因此不再出现这些消息；`transcriptMessageSource` 增加 `conversationId`/`taskId`，卡片能标出消息来自哪个会话。
- `app/conversations.go`：`transcript()` 在消息列表上方渲染协作卡片（仅当存在协作消息时）。卡片与聊天流互不干扰：用户消息与带 `思考与工具调用` 折叠的最终回答照旧。

**验证。**

```
go -C app test -count=1 -run 'Collab|AgentMessage' .
go -C app test ./...
```

测试器证据（`app/chat_collab_test.go`，760×620 无头窗口）：

- `TestAgentMessagesStayOutOfTheChatFlow`：用户消息与最终回答可见；`来自项目主管的通知`、`子 Agent 已完成侦察` 不出现在聊天流；`跨 Agent 协作` 卡片出现。
- `TestTheCollaborationCardListsTheAgentMessages`：收起时只显示 `1 条`；点开显示 `项目主管通知` 与正文 `子 Agent 已完成侦察`，且不再显示内部信封；再点收起正文消失，聊天流内容不变。
- `TestAnAgentMessageNeverCountsAsTheFinalAnswer`：末尾是协作消息时，工具运行仍是展开的 `1 次工具调用`，不会被误判成「已经给出最终回答」。

**剩余风险。**

- 协作消息的来源判定依赖后端 `data.source.kind`；若将来新增别的 kind（例如 `handoff`），需要加入 `collabMessage` 的白名单。
- 卡片目前按会话里已有的协作消息渲染，未与编队页的 `跨 Agent 协作` 事件流合并；两处数据源不同（会话消息 vs 编队事件）。
- 尚未在真机窗口里截图对比 DSH 的「跨 Agent 协作」卡片；结构复用了仓库里既有的编队协作面板视觉（时间 + 类别 · 行），未另造一套样式。

## #1 运行时间连续增长

**根因。** 计时只在拉数据时重算一次：`runElapsed` 取 `run.messages[0].CreatedAt` 与 `run.messages[len-1].CreatedAt`
的差，正在跑的 run 因此只在出现新消息或轮询刷新时才跳一格；Agent 卡片上的
`fleetAgentDurationMs` 用 `UpdatedAt - CreatedAt`，运行中同样不会动。窗口也没有为自己排下一帧，
所以「秒表」实际上是「刷新表」。

**改法。**

- `app/chat_activity.go`：`runActive(run)` 判定这一 run 里是否还有消息处于活动态；`runElapsed(run, now)` 在活动时以
  `ctx.Now()` 为终点、结束时停在最后一条消息的时间；`runClockWindow`（24h）拦住陈旧时间戳，
  避免 `createdAt` 缺失或停在上个世纪的会话被算成一个荒唐的时长（那时退回显示「N 次工具调用」）。
- `app/chat_activity.go` `toolRow`：活动时 `ctx.After(time.Second)`，让窗口自己每秒回来重画一次。
- `app/chat_answer_clock.go`（新）：回答本身也有一只停表。`answerClock` 以这条 assistant 消息的 `createdAt` 为起点，
  正在说话时算到 `ctx.Now()` 并每秒自排下一帧（`正在回复 · 用时 3s`）；回答落地时把最后一次读数（`answerClocks`，
  按消息 ID 记在 `chatState` 上）冻结成 `已用时 3s`，所以“说完了”不会跳变也不会继续涨。
  `answerClockWindow`（12h）拦住恢复出来的旧时间戳，宁可没有秒表也不编造时长。
  `app/chat_activity.go` 的 `messageRow` 在非用户消息上方调用它，`app/transcript.go` 存 `answerClocks`。
- `app/fleet_model.go`：`fleetAgentElapsedMs(agent, now)` / `fleetAgentClock(ctx, agent)`，运行中的 Agent 计到 `now`，
  停下的 Agent 冻结在 `UpdatedAt - CreatedAt`；活动时同样 `ctx.After(time.Second)`。
- `app/fleet_graph_view.go`、`app/fleet_network.go` 改用 `fleetAgentClock`，卡片与网络面板共用同一只停表。

**验证。**

```
go -C app test -count=1 -run 'TheRunningDuration|Stopwatch|AgentCard|RunClock|AnswerClock' .
```

测试器证据（`ui.Tester.Advance` 推进可控时钟，不 sleep、不读墙钟）：

- `app/run_clock_test.go`：运行中 2s→`用时 2s`，推进 3s 后 `用时 5s`，再推进 2s 后 `用时 7s`；结束的 run 停在 `用时 5s`；
  同一 run 里来的新工具调用不会让停表倒退。
- `app/live_clock_test.go`：3s 前开始的运行中工具显示 `用时 3s`，`Advance(1s)` 后 `用时 4s`，再 2s 后 `用时 6s`；
  结束的运行冻结在跨度上，且不读墙钟。
- `app/chat_runtime_test.go`：运行中 1s→4s→6s，settle 后固定在最终时长。
  （该用例把 run 起点设在 `tester.Now()-1s`，因为 `codexWorkedFor` 最小显示 1s。）
- `app/fleet_model.go` 的断言在 `run_clock_test.go` / `live_clock_test.go` 里：运行中 9s、已结束 2s。
- `app/fleet_clock_test.go::TestTheAgentCardClockKeepsCountingWhileTheAgentRuns`：Agent 卡片上 3.0s → `Advance(2s)` → 5.0s。
- `app/chat_answer_clock_test.go::TestTheAnswerClockTicksWhileTheAssistantSpeaks`：回答进行中显示 `正在回复 · 用时 3s`，
  `Advance(2s)` 后（没有新消息）`正在回复 · 用时 5s`；settle 后冻结为 `已用时 5s`，再推进 10s 也不会变成 `已用时 15s`。
- `…::TestTheAnswerClockFreezesAcrossTheLiveToSettledSwap`：流式条目换成同 `operationId` 的 `a1` 后仍显示
  `已用时 5s`（`answerClockKey` 按 `operationId` 记账），停表不会在落地那一刻消失。
- `…::TestAnAnswerFromLongAgoShowsNoStopwatch`：`createdAt` 停在很久以前时不显示任何用时。
- `app/main_agent_ux_test.go::TestTheMainAgentWindowCountsKeepsAgentTalkAsideAndFoldsTheSteps`：同一个 main agent
  窗口里一次性走完 #1/#3/#7——回复与工具运行两只停表都在没有新消息时前进（2s→4s、3s→5s），落地后分别冻结在
  `已用时 4s` / `用时 4s`，再 `Advance(10s)` 也不涨；主管通知只出现在「跨 Agent 协作」卡片里；最终回答上方是收起的
  「思考与工具调用」，点开后列出那次工具运行。
- `app/main_agent_ux_test.go::TestTheMainAgentModelPickerMarksEveryProvider`：同一个窗口的模型选择器里，Codex、
  DeepSeek 的字母块消失（改成品牌图标），无图标的 provider 仍有稳定的首字母回退。

**剩余风险。** 计时取自消息的 `createdAt`，两端时钟有偏差时第一秒可能“提前”或“落后”；超过 24h 仍在跑的 run 与超过 12h 的回答不显示时长（宁可没有，也不编造）。

## #2 上下文只显示真实已占用

**根因。** 卡片把三种不同来源的数字混在一起：`used` 在 `LastTokens` 为 0 时回填 `PeakTokens`、再回填估算总量；
`contextOverviewBar` 又按窗口 30% 画 headroom 斜纹、按 `maxTokens` 画 output 预留斜纹。于是用户看到的是
“预测 + 预留 + 峰值”的和，而不是模型回报的真实占用，数值还随轮询来回跳。

**改法。**

- `app/trajectory_context_overview.go`：`used` 只取 `Totals.Context.LastTokens`；为 0 时整段换成空态
  「暂无真实上下文数据 / 模型回报真实占用后这里会显示组成。」，不再回填峰值或估算。
- 删除 `contextHatch` 与 headroom/output 预留，改为 `contextOverviewBarSegments(parts, used, window)`：
  只产出 `part`（真实组成）/ `unaccounted`（已占用但组成未覆盖的部分）/ `free`（窗口剩余）三类，权重之和恰为 1，
  没有预测段、没有斜纹。
- `contextOverviewDisplayParts`：有请求快照时把组成按比例分摊到真实占用上，使图例之和等于卡片上报告的总量；
  没有快照时保留原始估算组成，不编造拆分。
- `contextOverviewBar`：所有色段放进**同一条** Row，各自按权重 `Grow`，因此整条横条只跨窗口一次；
  早期实现为每个色段各开一行，于是每一段都撑满整宽、看起来像几条 100% 的横杠——这仍然是在骗读数，
  现在改成一条按比例分段的横条（`Label("上下文组成")` 便于按真实像素取回它的位置）。

**验证。**

```
go -C app test -count=1 -run 'ContextOverview' .
```

- `app/context_overview_truth_test.go::TestContextOverviewShowsTheRealOccupancyAndCompositionOnly`：
  `120.0k / 1.0M tokens / 12.0%` 与六类组成可见，且 `900.0k`（峰值）、`预测`、`预留`、`估算` 都不出现。
- `…BarHasNoHeadroomOrOutputReservation`：所有色段只可能是 `part/unaccounted/free`，权重和 = 1。
- `…ShowsAnEmptyStateWithoutRealOccupancy`：没有真实占用时显示空态，不显示 `上下文已用`/`估算`/`预留`。
- `…StaysStableWhenOnlyThePeakChanges`：只改 `PeakTokens` 时卡片不变；改真实组成时按真实值更新。
- `…TestTheContextBarPaintsItsSegmentsInOneRow`：按 `上下文组成` 取到横条的真实位置，读它中间那一行像素，
  要求至少 3 条颜色带、且没有一条占满整宽。分段各占一行时横条没有这个 label（`Find` 直接失败），
  即便补了 label 也会是一整条单色，测试同样不过。
- `app/trajectory_context_overview_test.go`：原先断言放大后数值的两个用例原样通过（有请求快照时图例仍按
  真实占用分摊，数值与旧断言一致）。

**剩余风险。** 有请求快照时的「组成拆分」仍是按估算比例分摊（总量真实、比例估算），因此图例是近似值；
没有快照时显示的是未缩放的估算组成。

## #4 模型选择器带 provider 品牌图标

**根因。** 选择器行与触发按钮都只画 `providerTint` 底色 + provider 首字母方块，供应商页已有的
`providerBrandIcon` SVG 完全没有复用。

**改法。** `app/model_picker.go` 新增 `providerMark(ctx, id, size, t)`：优先 `providerBrandIcon(id)`（与
`app/providers_page.go` 同一份品牌图标表 `app/provider_icons.go`），没有品牌图标时回退到首字母色块。
选择器的每一行与已选模型按钮都改用它。

**验证。**

```
go -C app test -count=1 -run 'ModelPicker' .
```

- `app/model_picker_icons_test.go::TestTheModelPickerShowsBrandIconsInsteadOfLetterTiles`：Codex、OpenCode、Grok、
  DeepSeek 等 provider 的模型行上出现品牌图标像素，无图标的 provider 仍有稳定的首字母回退。

**剩余风险。** 品牌图标表是仓库内的静态清单（`provider_icons.go`），Magpie 新接入的 provider 需要在那里补一条。

## #5 切回 main agent 会话要快

**根因。** `beginConversationSwitch` 每次都新建 `chatState` 并置 `loading = true`，`selectConversation` 再同步/
异步读整篇会话；在读到之前窗口只能画骨架，所以点击后要等一次网络往返（连 `/version` 也算）才见到内容。

**改法。**

- `app/conversation_switch.go`：`shellState.chats` + `chatOrder` 缓存（`chatCacheLimit = 12`）；
  `beginConversationSwitch` 命中缓存时把那次 `chatState` 直接放回屏幕（`loading = false`、清空状态行），
  立刻有内容可画；`rememberChat` 只缓存会话聊天（节点聊天按其任务重新读）。
- `app/shell.go`：`selectConversation` 不再在主线程读网，改为 `go s.loadConversationChat(id)`；
  命中缓存时只做 `cached.refresh()`（后台补最新回复），没命中时读进新的 `chatState` 再换上来。

**验证。**

```
go -C app test -count=1 -run 'SwitchingBack' .
```

- `app/conversation_live_test.go::TestSwitchingBackToTheMainAgentShowsItsContentAtOnce`：主控会话先加载
  `主控旧内容` → 切到项目会话 → 让 `/api/conversations/g1` 阻塞后切回：`selectConversation` 立即返回、
  窗口显示 `主控旧内容`、聊天区不出现 `正在读取会话…`、也不会提前显示必须等网络的 `主控新内容`；
  两侧面板各自的骨架屏会在随后的帧里落地（有上限的帧数内必须消失，窗口不能停在占位）；
  放开网络后才出现 `主控新内容`。

**剩余风险。** 缓存上限 12 个会话；被挤出缓存的会话再次打开时仍要读一次网络（期间显示骨架）。
缓存里的 `chatState` 与后台刷新共用 `refreshMu`，重读被合并而不是并发。

## #6 main agent 完成后自动刷新

**根因。** 只有 `send()` 之后的 `follow()` 会追这一轮；此外只靠外层 3 秒的 watch 循环。`Refresh` 又先问
`/version`，版本相同就直接返回——当最终回答在同一个版本里落地（流式 → settled 不算新版本）时，窗口永远
停在流式片段上；切换会话回来时刷新的还是被换掉的旧 `chatState`，于是“切走再切回”变成了唯一补救手段。

**改法。**

- `app/chat_tick.go`：`chatState.keepFresh(ctx)` 由视图每帧调用，用 `ctx.After(chatPollDue=1s)` 自己排下一帧；
  到期时在后台 goroutine 里 `refresh()`（`polling` 去重），因此会话在屏幕上就会自己更新，不靠用户操作。
- `app/chat_source.go`：`Refresh` 只有在“没有在路上回复”（`transcriptInFlight()` 为假）时才信任版本号短路；
  有流式回复时整篇重读（`incremental = … && !still`），settled 的回答因此不会被版本号骗过。
- #5 的会话缓存让「切回来」与「自动刷新」落在同一个 `chatState` 上。

**验证。**

```
go -C app test -count=1 -run 'FinishedMainAgentAnswer|FinishedAnswerShowsEvenWhenTheVersionStandsStill|SwitchingBack' .
```

- `TestTheFinishedMainAgentAnswerAppearsWithoutSwitchingConversations`：停在 main agent 会话不动，
  只让假 API 把 `正在整理结果` 换成 `全部完成，七个问题都修好了。`，窗口自动换成最终回答（不再有人为 refresh/切换）。
- `TestTheFinishedAnswerShowsEvenWhenTheVersionStandsStill`：`/version` 一直是 `v1`，最终回答仍然出现。

**剩余风险。** 可见会话每秒一次轻量 `/version`（后台、可合并）；`follow()` 的 400ms 轮转仍然存在，
与 `keepFresh` 会在 `refreshMu` 上合并。真机网络慢时最坏晚 1 秒看到最终回答。

**顺带修的稳定性问题。** 会话列表原来由后台轮询线程直接重写（`refresh` → `loadRows` 改 `s.conversations`），
与侧栏渲染竞争时列表索引会过界（GOMAXPROCS=2 下复现 `index out of range [0] with length 0`）。现在拆成
`fetchRows`（后台读、不碰状态）+ `applyRows`（`onUI` 里整体换上），`conversationList` 再取当前帧快照；
后台刷新变多（#5/#6）之后这是必须补的一环。

```
GOMAXPROCS=2 go -C app test -count=1 ./   # 与 check-queue 同环境；修复后连跑 4 次全绿
```

## #7 最终回答上方折叠思考和工具调用

**根因。** 会话列表把每个 run 平铺：用户消息、工具运行、思考、最终回答各占一行，最终回答被前面的过程挤到下面。

**改法。** `app/chat_fold.go` 新增 `chatFoldRows`：以用户消息为轮次边界，若这一轮最后一条是“已完成（非活动）”的
assistant 回答，就把中间的思考与工具运行收进一条 `fold` 行；`foldRow` 渲染「思考与工具调用」标题栏，
默认收起（`c.expanded` 无该键），点击展开列出各步骤，再点收起。流式中的回答不折叠，过程中仍平铺可见；
只有回答、没有步骤的轮次不会出现折叠栏。`app/conversations.go` 的 `transcript()` 改用这些行渲染，
并与 #3 的协作卡片共存。

**验证。**

```
go -C app test -count=1 -run 'Fold|Folds|Steps' .
```

- `app/chat_steps_test.go::TestTheFinalAnswerFoldsTheStepsThatCameBeforeIt`：最终回答可见、`思考与工具调用` 收起时
  `1 次工具调用` 不出现，点击后出现。
- `…TestTheFoldKeepsTheInterimThoughtsToo`：中间思考也一起折叠。
- `…TestARunningAnswerKeepsItsStepsOpen`、`…TestAnAnswerWithoutStepsHasNoFoldBar`：进行中不折叠、无步骤不出现折叠栏。

**剩余风险。** 折叠按“轮次内最后一个已完成回答”判定；若某轮以工具调用收尾（回答还没落地），这一轮保持平铺，
这是刻意的行为，但与后端会话切分方式耦合。

## 全量验证

```
go -C app test -count=1 ./...        # ok graph/app（约 12–15s）
go -C backend test ./...             # 全部 ok（含 graph/pigkernel/statemachine）
python3 scripts/check-queue.py       # 串行全量检查用（机器上别的 worktree 占着槽位时会排队等待）
```

七条都是先在测试器里失败再让实现变绿；计时用 `ui.Tester.Advance` 的受控时钟，刷新用假 API 的
“旧内容已加载、新结果稍后到达”场景，没有靠 sleep 或墙钟等待。

## 验收走查（同一个 main agent 会话）

`app/main_agent_ux_test.go` 是“七条一次跑完”的那一遍（不是各条的单元测试）：

- `TestTheMainAgentWindowCountsKeepsAgentTalkAsideAndFoldsTheSteps`（760×620）：同一轮里放用户消息、主管通知、
  一个已结束工具 + 一个运行中工具、一个还在写的回答；确认 #1（回答 2s→4s、工具 3s→5s 无新消息也前进，落地后冻结）、
  #3（主管通知只在「跨 Agent 协作」卡片里，不进聊天流）、#7（落地后「思考与工具调用」收起，点开出工具运行）。
- `TestTheMainAgentModelPickerMarksEveryProvider`（900×700）：同一窗口的模型选择器里 Codex/DeepSeek 用品牌图标、
  无图标 provider 用字母回退（#4）。
- #2 用 `app/context_overview_truth_test.go`（760×320 的上下文卡片）、#5/#6 用
  `app/conversation_live_test.go`（1440×900 的 shell + 假控制台）验证，它们都是同一套测试器渲染的真实帧。

```
go -C app test -count=1 -run 'MainAgentWindow|MainAgentModelPicker' .
```

## 剩余风险（汇总）

- 全部证据来自 headless 测试器（`ui.Tester`，1440×900 / 760×620 / 900×700）；按约束没有在真机窗口截图，也没有触碰真实
  Magpie 配置、凭据或付费调用。
- 每秒的 `keepFresh` 轮询在长开窗口里是稳定的小流量；服务端 `/version` 未变时只是一次轻量 GET。
- 会话缓存上限 12；被挤出的会话重新打开时短暂显示骨架。
- 协作卡片（#3）与编队事件流仍是两处数据源，未合并。
