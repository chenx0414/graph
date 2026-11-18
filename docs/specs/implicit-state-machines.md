# 隐式状态机：盘点、决策与收口顺序

<!-- graph:allow-large-file: 一份盘点表按机器逐条列出状态、位置与隐性缺陷，拆开后同一台机器的事实会散在多处；拆分待收口完成后进行 -->

日期：2026-11-15
范围：`app/`（原生界面，Go + MyGo）与 `backend/`（守护进程、内核）中所有"用若干布尔、自由字符串或派生函数共同回答『现在处于哪一步』"的地方。

机器可读的唯一注册表是 [backend/statemachine/machines.json](../../backend/statemachine/machines.json)（人读视图 [状态机地图](../agent/state-machines.md)，门禁 `go -C backend run ./cmd/graphcheck machines`，实时台数以门禁输出为准）。那份注册表管落库与派生的权威状态；本文件是界面运行期状态机的盘点与收口决策，两者交叉处（编队 Agent 状态）以注册表为准，由 `app/state_machines_test.go` 钉住两边一致。

## 结论

1. **本次盘点到 27 台隐式状态机**：界面层 17 台（下表 A），后端与界面呈现直接相关的 10 台（下表 B，完整清单以注册表为准）。它们不是"可以不要"的抽象——每一台都在真实运行，只是状态与迁移分散在字段、`if` 与各页面的 `switch` 里。
2. **不新建通用框架去整体替换**。界面层同时有 58 个裸布尔字段、16 处状态字符串比较；一次性换掉会把"呈现"与"权威"绑死，且无法在一步内证明不破坏行为。
3. **先做共享词汇表这一层**：`app/status.go` 定义唯一的工作相位（`workStatus`）、别名折叠、终态、标签与色调；把编队/轨迹/图三处的四份映射收敛到它。这一层是后续每台机器的公共底座，也是 Agent 读代码时的唯一入口。
4. **顺带修掉它暴露的真实缺陷**：`fleetTerminalStatus` 只认 `completed`/`stopped`/`abandoned`/`succeeded`，`done` 与 `failed` 被判成"仍在进行"，编队图会把一张已经失败或完成的图当成当前活动图。回归用例先红后绿（见「验证」）。
5. 其余机器按「风险 × 收益」分批显式化（见「迁移顺序」），每批都遵守「规则」四条。

## 判定标准

满足任一条即算隐式状态机：

- 同一个"现在处于哪一步"由 ≥2 个字段共同表达（`loading` + `failed`，`owned` + `launched` + `stopped`）；
- 状态取值是自由字符串，靠调用点各写一份 `switch` 解释（`status`、`phase`、`state`）；
- 状态迁移写在使用点而不是定义点（"点下去之后再判断一次"）；
- 用派生布尔或帧计数代替状态（`ready`、`historySettle`、`broken`）。

盘点用的可复跑命令：

```sh
grep -rn --include=*.go -E '^\s+[a-zA-Z]+\s+bool\s*$' app | grep -v _test | wc -l   # 58 个裸布尔
grep -rn --include=*.go -E '(status|state|phase|State|Status|Phase)' app | grep -v _test \
  | grep -cE '"(running|done|queued|pending|failed|completed|blocked|stopped|idle|streaming|available|open|resolved)"'  # 16 处
grep -rno --include=*.go -E '(==|!=) "(running|done|queued|pending|failed|completed|blocked|stopped|idle|streaming|succeeded|skipped|retired|abandoned|stopping|preparing|dispatched|waiting|paused|cancelled|discussing|chatting|completing|settled)"' backend | grep -v _test | wc -l  # 229 处
```

## A. 界面层（`app/`）

| # | 机器 | 承载位置 | 状态 | 迁移/判定方式 | 隐性缺陷 |
| --- | --- | --- | --- | --- | --- |
| 1 | 工作状态词汇与呈现 | `fleet_cards.go` `fleetStatusColor`；`fleet_model.go` `fleetStatusLabel`、`fleetTerminalStatus`；`trajectory_panel.go` `trajectoryStatusLabel`；`fleet_graph_view.go` `status == "running"` | 运行中/空闲/阻塞/失败/完成/已停止/未知 | 四份独立 `switch`；两份互不相同的终态定义 | `failed`、`done` 不算终态；未知字符串被读成"完成"或"运行中" |
| 2 | 会话历史分页 | `transcript.go` `chatState{historyLoading,noMoreHistory,pagedHistory,historySettle,oldestSeq}`；`history.go` `ensureHistory`；`conversations.go` `transcript` | 最新页/加载更早/已到最早 | `historySettle` 用帧计数当锁；`noMoreHistory` 由三个来源写 | 刷新率或可见行数变化即改变取数行为；失败分支与成功分支各自复位 |
| 3 | 对话轮次忙闲 | `conversations.go` `busy()`、`composerMode()`；`paused`；`messageStreaming` | 可发送/进行中/已暂停/待继续 | 忙=有 streaming 消息；暂停是独立 bool；草稿为空再改成"继续" | 轮次边界靠"最后一条消息"，排队消息与失败轮次不参与 |
| 4 | 顶部状态行 | `chatState.status`（`artifacts.go`、`chat_source.go`、`conversation_ops.go` 等 20 余个写入点） | 加载中/成功/失败/空态 | 一个自由字符串；轮询成功时 `c.status = ""` | 错误会被下一次轮询清掉；成功提示与错误共用一个通道 |
| 5 | 工具调用行 | `chat_node.go` 由"有无 result"推 `running`/`done`；`chat_activity.go` `message.State != "done"` | 排队/运行中/完成/失败 | 缺省即运行中 | 任何未知或失败状态都显示"正在运行" |
| 6 | 编队快照加载 | `fleet.go` `fleetState{loading,globalLoading,failed}` | 空闲/加载中/就绪/失败 | 三个字段 + `nil` 切片共同判断 | 初次加载与全局刷新共用 `loading`，空数据与未加载不可分 |
| 7 | 编队详情与网络面板 | `fleet_detail.go` `fleetDetailEntry{agentID,loading,failed}`；`board_network_panel.go` `netPanelState{loading,topology,topoKey}`；`fleet_graph.go` `loading` | 未请求/加载中/就绪/失败 | 每个面板一套 `loading`，用 `topoKey`/`agentID` 兼作缓存键 | 切目标与重试走同一标志，重复请求靠 `topology != nil` 挡 |
| 8 | 白板拖拽 | `board.go` `boardState{drag,press,pressX,pressY,pendingDrop,hoverSince}` | 空闲/按下/拖动/悬停/待放下 | 指针事件里逐字段改 | 放下动作延后执行，压栈时机由 `pendingDrop` 隐式决定 |
| 9 | 无限画布视图 | `infinite_canvas.go` `{fit,dragging,zoom,x,y}` | 待自适应/已定位/拖动中 | `fit` 同时表示"首次自适应"和"点过居中"；点「居中」反而置 `false` | 语义倒置：读代码的人会先以为 `fit` 是"已经适配好" |
| 10 | 守护进程生命周期 | `daemon.go` `{owned,launched,stopped,adoptedPid,command}`、`supervised()`、`refresh` | 未启动/启动中/launchd 托管/直接子进程/已交接/已停止 | 五字段组合；`stop()` 遇到 `launched` 直接返回，交给 launchd | 状态不可枚举；`stopped` 只在退出回调里读一次 |
| 11 | 供应商页 | `providers_page.go` `{loading,failed,entries,packageAccounts,enabled}` | 加载中/失败/就绪；未配置/未启用/已连接 | 三态由 `Configured` 与 `enabled` map 拼出，状态文案在解析函数里定死 | 同一行同时表示"凭据有没有"和"模型开没开" |
| 12 | 资源库就绪 | `resources.go` `resourceRow{status,missing,err,ready}`、`resourceSummary` | 可用/待配置/加载失败/不可用 | `ready` 是派生布尔；文案按 `missing`→`err`→`ready` 顺序判断 | 上一版"0/120 未就绪"就是这条派生链走偏（已修，但结构未变） |
| 13 | 通知去重边沿 | `tasks.go` `notificationState{Primed,Questions,Status}` | 首轮/已就绪；每任务"问题数""状态" | 以"是否初始化过"布尔 + 两张表表达"刚完成/刚冒问题" | 任务从结果里消失即被当作无变化，无法表达"重开" |
| 14 | 模型选择器 | `model_picker.go` `{open,query,active,provider,showAll}` | 关闭/搜索/按供应商过滤/展开全部 | 打开与筛选共用一个结构，`active` 是行号 | 关闭时没有清理路径，`active` 越界靠渲染处兜底 |
| 15 | 输入框菜单 | `transcript.go` `{menuTrigger,menuActive,menuDismissed,pathQuery,pathItems,pathLoading,skillItems,skillsLoading}` | 关闭/命令/路径/技能；每种各自加载 | 触发器类型 + 两个加载标志 + 一个"已忽略"字符串 | 忽略用字符串记录，输入改回同一触发词会重新弹 |
| 16 | 会话接入/断连 | `shell.go` `{broken,api.address}`、`adoptConsole` | 正常/换过地址/读失败 | `broken` 既表示"刚接管新地址"也表示"列表读失败" | 接管成功后仍显示为坏，直到下一次 `loadRows` 成功 |
| 17 | 轨迹加载 | `trajectory.go` `loading` | 空闲/加载中/失败 | 布尔 + `failed` 字符串 | 作用域切换时靠外部再判断一次 |

## B. 后端（权威状态，`backend/`）

后端是这些状态的唯一权威；界面侧机器必须能容纳下表的取值，而不是自己发明一套。

| # | 机器 | 承载位置 | 状态 |
| --- | --- | --- | --- |
| 18 | 任务 phase | `core_kernel_store.go` 表结构；`core_execution_nodes.go`；`core_graph_runtime_complete.go` | discussing/chatting/queued/running/idle/blocked/completing/completed/stopping/stopped/abandoned |
| 19 | 节点 status | `core_task_nodes.go` `SetNodeStatus`；`core_operation_block.go` | preparing/running/idle/blocked/failed/succeeded/skipped/retired |
| 20 | 投递与提交 | `core_kernel_store.go` `deliveries.state`、`submissions.state` | accepted/queued/running/done/settled… |
| 21 | 预算与用量 | `core_kernel_store.go` 预算表；`usage` 字段 | reserved/committed/settled；authoritative/account_delta/estimated/unknown |
| 22 | 问题处理阶段 | `questions.route_stage`（见 `CONTEXT.md`「问题处理阶段」） | project/global/user |
| 23 | 图运行时 phase | `core_graph_phase.go`（词汇表）；`core_graph_runtime_deliver.go` `State` | 与任务 phase 同一字母表，由 `displayPhase` 叠加 `paused` |
| 24 | 内核队列 | `core_kernel_queue.go` | queued/running/done |
| 25 | 执行槽位 | `runtime_execution_slots_scale_test.go` 覆盖的调度状态 | idle/reserved/running |
| 26 | 节点运行条目 | `core_node_entry_paging.go` 产出的 `state` | queued/running/done |
| 27 | 恢复与停滞 | `runtime_*` 恢复路径；`harness` 探针 | starting/settled/retired |

## 已落地：`workStatus`（第 1 台的收口）

`app/status.go` 是注册表里 `fleet.agent_status` 的界面侧读法（相位 + 别名折叠 + 终态 + 文案）：

- 相位：`idle`、`pending`、`running`、`blocked`、`failed`、`done`、`stopped`、`unknown`。
- 别名表把后端与历史词汇折叠进相位：`queued`/`preparing`/`starting`/`dispatched`/`reserved` → `pending`；`chatting`/`discussing`/`active`/`streaming` → `running`；`waiting`/`paused` → `blocked`；`completed`/`succeeded`/`settled`/`skipped`/`retired` → `done`；`stopping`/`cancelled`/`abandoned` → `stopped`。
- 唯一终态定义 `Terminal()`（`done`/`failed`/`stopped`）；`Label()` 与 `toneOf()` 提供文案与色调（`statusTone` 是有类型的枚举，不是新一组自由字符串）。
- 未知值不吞掉：`fleetStatusLabel` 原样返回（空串仍读"未知"），界面不会把没见过的状态显示成"完成"或"运行中"。

接线：

- `fleetStatusColor` 按 `toneOf` 取色（`pending`/`blocked` 现在走 `Attention`，不再落成灰色 `Idle`）。
- `fleetStatusLabel`、`trajectoryStatusLabel` 从相位派生（轨迹仍保留"进行中"这一措辞）。
- 编队图"当前"胶囊与"当前图"选择改用相位：`workStatusOf(status) == workRunning`、`workStatusOf(unit.Status).Terminal()`。
- 删除 `fleetTerminalStatus` 这张手写终态表——它是缺陷来源。

## 迁移顺序（下一批）

按"用户能看见的错误 → 开发反复踩的坑 → 纯内部风格"排序（✅ 表示本批已经落地，见下方对应小节）：

1. **状态行（#4）** → `notice{kind,text}`：加载/成功/失败/空态分开，失败不被轮询清掉。界面层收益最大。
2. **加载三态（#6、#7）** → 复用已成型的 `loadState`，把"空数据"与"没加载"分开；#17 已落地（✅「已落地：`loadState`」）。
3. **历史分页（#2）** → `historyPhase{latest,loading,exhausted}`，删掉 `historySettle` 帧计数。
4. **工具行（#5）** → ✅ 已由 `roundPhase`/`messagePhaseOf` 收口，`cancelled` 不再显示为运行中。
5. **守护进程（#10）** → ✅ 已由 `daemonPhase` 收口（见「已落地：守护进程生命周期」）。
6. 其余（#3、#8、#9、#11–#16）在改动其所在功能时顺手显式化，不单独开一批。

## 规则

1. 新状态先登记进相位词汇表；禁止在新代码里新增裸字符串比较（`x == "running"`）与手写终态表。
2. 终态只有一个定义：`workStatus.Terminal()`。
3. 呈现（颜色、文案、图标）从相位派生，不在各页面各写一份 `switch`。
4. 每台显式化的机器配表驱动用例：每个状态一条、未知值一条、非法迁移一条；未知值必须可读且不得落到"完成/运行中"。

## 验证

```sh
go -C app test -run 'TestWorkStatus|TestEveryPhase|TestUnknownStatuses|TestTerminalGraph|TestEveryTerminalStatus|TestGraphUnitsPrefers|TestFleetStatusLabels' -v
go -C app test ./...
python3 scripts/check-queue.py
```

先红后绿的证据（回归用例在实现前运行）：

```
--- FAIL: TestTerminalGraphUnitsDoNotOutrankRunningOnes
    a running graph is the current one while a failed one is terminal, got [... TaskID:t-fail Status:failed ...]
--- FAIL: TestEveryTerminalStatusEndsItsGraphUnit
    status "done" must be terminal, got [... TaskID:t-end Status:done ...]
```

实现后同一组用例通过；`TestFleetStatusLabelsCoverTheContractStatuses`（既有用例）继续通过，说明对外文案未变。

## 已落地：`loadState`（第 17 台，迁移顺序第 2 批的第一台）

`app/load_state.go` 是上面 `loadState{idle,loading,ready,failed}` 的唯一实现，形状取自本仓已经验证过的那一档（`fleet.go` 的 generation + 作用域比较），把纪律从“每处手写”变成“类型保证”：

- 相位：`""`（idle）、`loading`、`ready`、`failed`；`data`/`failed` 字段名与迁移前一致，既有调用点与测试零改动。
- `begin() (generation, start)`：`loading`/`ready` 时不再发请求（重复渲染不重复取数），idle/failed 时开始新一代。
- `reset()`：换代并清空，用在范围/作用域切换处，让在途响应作废。
- `settle(generation, data, failure) bool`：代号不匹配即丢弃并返回 false，**迟到的响应无法写入状态**；这是本仓此前只有 `fleet` 一族具备的保证。

接线：`trajectoryState` 改为内嵌 `loadState[T]`，`loading` 字段变 `loading()`；切换会话/节点时先 `reset()`，旧作用域的响应不再落进当前页面。

同时修掉一处用户可见缺陷（先红后绿）：

- 轨迹页在上一次取数未回时切走，新作用域发不出请求、界面停在“正在整理轨迹…”（`TestTrajectoryKeepsTheScopeTheUserOpened`）。

先红后绿的证据（同一组用例在实现前跑在 `HEAD` 的 `app/` 上）：

```
--- FAIL: TestTrajectoryKeepsTheScopeTheUserOpened (0.00s)
    the sessions card names the range the user picked, texts [... "近 7 天还没有会话用量。"]
--- FAIL: TestTrajectoryKeepsTheScopeTheUserOpened (2.00s)
    the trajectory of the chat the user opened never happened
```

实现后同一组用例通过，另外三条钉住机器本身（`TestLoadStateRejectsAnAnswerFromASupersededRequest`、`TestLoadStateStartsOnceUntilTheAnswerOrAReset`、`TestLoadStateKeepsAFailureUntilTheNextAttempt`）；`go -C app test ./...` 全绿，既有 `TestTrajectoryModuleQuantifiesTheLatestConversation`、`TestSwitchingChatsMovesTheTrajectoryToTheNewAgent` 不需要修改，说明对外行为未被改写。

验证：

```sh
go -C app test -run 'TestLoadState|TestTrajectory' -count=1 ./...
```

下一台直接复用同一类型：#6（`fleet`/`global` 两套）、#7（编队详情、网络面板、编队图），把它们手写的 generation/守卫分支收进类型。

## 已落地：任务 phase 词汇表（第 18 台）

`backend/internal/graph/core_graph_phase.go` 是任务 phase 的唯一字母表：`GraphPhase` 的 12 个常量（11 个可持久化状态 + `PhasePaused` 这个只在读模型里出现的叠加态），外加 `Known`、`Closed`、`Cancelling`、`CompletionClosed`、`LaneEligible` 与 `displayPhase`。`core_task_lifecycle_phases.go` 在其上给出互斥的状态族（conversational / working / halting / finished）。

收口前同一“图已结束”的判断散在 12 个文件里各写一遍（`phase == "completed" || phase == "stopping" || phase == "stopped"`，另有一份自由函数 `phaseClosed`），`paused` 叠加态在 `GraphRuntime.State()` 与 `kernelNodePhase` 里各推一次。现在：

- 所有结束态判断走 `GraphPhase(phase).Closed()`（委派 `taskPhaseHalting`，含 `abandoned`），停止中判断走 `Cancelling()`，交付关闭走 `CompletionClosed()`，lane 允许清单走 `LaneEligible()`。
- `State()` 与 `kernelNodePhase` 共用 `displayPhase(phase, paused)`，读模型不再各自发明 `paused`。
- `setPhase`/`StartTaskPhase` 等写点使用常量，不再写裸字符串。

验证：

```sh
go -C backend test ./internal/graph -run 'TestGraphPhase|TestEveryStoredTaskPhase|TestDisplayPhase|TestClosedPhase|TestOpenPhase|TestPhaseWriteGuards' -count=1
```

用例钉住三件事：预算/暂停/控制写入在结束态被拒绝、在开放态被接受（`TestClosedPhase*`/`TestOpenPhase*`）；`BlockTaskPhase`/`CompleteTaskPhase`/`CompleteBlockedTask` 不会把已完结的图写回去（`TestPhaseWriteGuards*`）；12 个状态的谓词真值表与 `displayPhase` 叠加规则（`TestGraphPhasePredicates*`/`TestDisplayPhase*`）。`TestEveryStoredTaskPhaseIsInTheVocabulary` 防止新增自由字符串绕过词汇表。

## 已落地：任务 phase 的写点与 SQL 谓词（第 18 台的下半段）

`core_task_lifecycle_phases.go` 不只提供谓词：所有按 phase 过滤的 SQL 也从同一组状态族生成（`taskPhaseIn` / `taskPhaseNotIn`），不再各写一份 `NOT IN (...)`。

- 写点守卫：`StopTask`、`BlockTask`、`ResumeTask` 不会把已结束（`completed` / `stopped` / `abandoned`）的任务写回活跃相位；`AbandonTask` 不会覆盖 `completed` / `stopped`。收口前 `ResumeTask` 能把一张已完成的图直接改回 `running`。
- 归档暂停：`PauseProjectTasks` 的两条语句共用 `taskPhasePausedOnArchive`（聊天是控制对话、不暂停；讨论属于工作、要暂停）。收口前第二条语句漏了 `stopping`，与第一条不一致。
- 已归档工作：`ArchivePausedWorkGraphs` 用 `taskPhaseArchivable`，与原来的 `NOT IN` 集合等价，但只有一处定义。
- 工作副本回收：`SweepTerminalWorkcopies` 用 `terminalWorkcopyPhases`（全部结束态）。收口前只认 `completed` / `abandoned`，**`stopped` 任务的 worktree 永不回收**。
- 建任务：`CreateConversationTask`、`CreateConfirmedTask`、`AcceptProposal` 用 `requireTaskPhase` 拒绝词汇表外的相位，拼错的字符串在写入前就失败。

验证：

```sh
go -C backend test ./internal/graph -run 'TestTaskPhaseFamilies|TestHaltingCovers|TestTerminalWorkcopy|TestBlockingAFinished|TestAbandoningACompleted|TestPauseProjectTasks|TestArchivablePhases|TestConversationTasksRefuse' -count=1
```

用例直接读回 `tasks` 表：已结束的任务在任何写点都保持原相位；归档只暂停工作相位；worktree 回收清单覆盖三种结束态；词汇表外的相位在建任务时被拒绝。

先红后绿的证据（实现前同一组用例）：

```
--- FAIL: TestBlockingAFinishedTaskKeepsItsPhase
    writing a finished "completed" task moved it to "blocked"
--- FAIL: TestAbandoningACompletedTaskKeepsItsPhase
    abandoning a "completed" task moved it to "abandoned"
--- FAIL: TestConversationTasksRefuseAPhaseOutsideTheVocabulary
    a conversation task must not be created with an invented phase
```

## 已落地：守护进程生命周期（第 10 台）

`app/daemon_phase.go` 把 `daemon{command, adoptedPid, owned, launched, stopped}` 五个字段共同回答的“后台现在归谁”收成一台显式状态机：

- 相位：`stopped`、`starting`、`supervised`（launchd 托管）、`owned`（本窗口拉起）、`adopted`（接管已有进程）、`stopping`。
- 迁移表 `daemonTransitions` 是唯一写点：`stopped --start--> starting`，`starting` 分三路（launchd / 直接子进程 / 失败），`owned --exited--> stopped`，`owned|adopted --stop--> stopping --stopped--> stopped`；launchd 托管的进程被 stop 时只解除本窗口跟踪、不杀进程；launchd 重启自己的子进程不产生本窗口的迁移。
- 写错顺序不会静默：`advance` 返回是否真的发生迁移，退出通知只在 `owned --exited--> stopped` 成立时发。
- `status()` 给出 `{Phase, Pid, Supervised}`，托盘提示显示 `Phase.Label()`（“由 launchd 托管 / 本窗口启动 / 已接管的进程”），不再只写 “Graph”。
- 顺带删掉两个死字段：`owned` 只写不读；`stopped` 从未被置真（退出通知的抑制实际靠“先清 command”）。

验证：

```sh
go -C app test -run 'TestDaemonPhase|TestEveryDaemonPhase|TestANewDaemonIsStopped|TestAdoptingAProcessMoves|TestASupervisedDaemon|TestRestartingNeedsAPhase|TestDaemon' -count=1 .
```

用例钉住：迁移真值表（合法与非法都断言）、每个相位的 label 非空且互不相同、接管一个真实 `sleep` 进程后相位变 `adopted` 且 `stop()` 回收、launchd 托管时 `adopt` 不夺走 pid、未拉起的后台无法被重启并给出原因。先红后绿：实现前这组用例因 `daemonPhase` 尚未定义而编译失败（`undefined: daemonPhase`），实现后全绿；既有 `TestDaemon*`、`TestRestartFollowsTheLaunchAgent*` 与 `rsi` 的重启用例继续通过。

## 已落地：对话轮次与实时流（第 3、5 台）

对话页此前有两套并存的“正在回复”词汇：后端写入 `messages.state = running/pending/queued/done/failed/cancelled`，界面却只把 `assistant.state == "streaming"` 当流式，而 `streaming` 在 Go 后端里从未产生。结果是运行中的回复不显示、发送按钮不变“暂停”、`follow` 轮询提前结束。

现在：

- `app/round_phase.go` 把轮次收成 `roundPhase{idle,queued,preparing,running,blocked,paused}`，`roundPhaseOf(paused, master, messages)` 是唯一判定；`busy()` 与 `composerMode()` 都从它派生。判定顺序是服务端优先：`paused` 一票否决 → `master.status` 的 `preparing`/`running`/`blocked` → 消息相位。只有 `preparing`/`running`/`blocked` 算忙，所以「真的在跑」时输入框才是「暂停」，而单独一条排队消息不冒充轮次（仍可撤销、仍可发送）。
- `messagePhaseOf` 折叠消息状态：`running`/`streaming` 为运行，`queued` 为排队，`pending` 只在工具行是等待（用户提问的 `pending` 是尚未派发，不算进行中），`delivered` 的用户消息是历史而不是进行中（真实库里 1849 条 `delivered` 的用户提问都已答过，而重置回 `pending` 的用户提问不该把「暂停」永久钉住），`failed`/`cancelled` 不再显示成“正在运行”。
- 工具行按 `cancelled` 单独呈现：命令读「已取消 …」、编辑读「已取消编辑 …」、面板尾注从「成功」改为「已取消」，不再把被取消的调用永远显示为「正在运行」。
- `app/chat_live_state.go` 读取后端 `streams[]`（`operationId`/`entryId`/`partId`/`ordinal`/`text`），按 entry 合并成一条 `assistant` 实时消息；`applyLiveStreams` 每次刷新先删旧 live 行再加新行，所以同一行原地更新、不会重复；一旦同一 `operationId` 的正式 assistant 消息落地，live 行立即让位。
- `chat_source.go` 的加载与轮询都走这条合并路径；`changed` 同时比较消息指纹与 `master.status`，轮次开始/结束都会重绘输入区。顶部等待提示只在“用户提问后已有后续条目且轮次不再忙”时清除，因此工具型/被取消的轮次不会把「已发出，等待回复…」永久留在屏幕上。
- `follow()` 的收尾条件也从“最后一条是 assistant 且不在流式中”改成“轮次不忙且已有后续条目”：工具型轮次（末条是 tool）不再指向 450 次 × 400ms 的空轮询，assistant 正常收尾的行为不变。

先红后绿用例：`TestConversationStreamsRenderAsALiveReply`、`TestTheLiveReplyYieldsToTheSettledMessage`、`TestALiveReplyUpdatesInPlace`、`TestAQueuedPromptBehindARunningRoundKeepsThePauseAction`、`TestMessageHelpersReadTheBackendStateVocabulary`、`TestASettledUserMessageDoesNotHoldTheRoundOpen`、`TestTheMasterNodeSayingRunningTurnsTheButtonIntoPause`、`TestAFinishedRoundLeavesTheSendButtonAlone`、`TestAQueuedPromptAloneLeavesTheRoundOff`、`TestACancelledToolIsNoLongerRunning`、`TestTheWaitingLabelClearsWhenAToolOnlyRoundEnds`、`TestTheWaitingLabelStaysWhileThePromptIsStillUnanswered`、`TestARefreshReportsARoundThatStartedOrEnded`、`TestFollowStopsWhenAToolOnlyRoundEnds`。

先红后绿的证据（把 `roundPhase.busy()` 改回旧的“只看消息”判定、把 `follow()` 改回旧的“最后一条是 assistant”后分别重跑）：

```
--- FAIL: TestTheMasterNodeSayingRunningTurnsTheButtonIntoPause
    the master node status says the round is running
--- FAIL: TestAQueuedPromptBehindARunningRoundKeepsThePauseAction
    a queued prompt behind a running round is work to pause, busy false mode 0
--- FAIL: TestFollowStopsWhenAToolOnlyRoundEnds (3.00s)
    a finished tool-only round must stop the follow
```

恢复实现后同一组用例通过；既有用例 `TestQueuedMessagesCanBeCancelled`（排队消息不算轮次、仍给「发送」）、`TestTheComposerButtonPausesARunningRound`、`TestFollowStopsWhenTheReplyLands`、`TestPausedStateComesFromTheConversation` 继续通过，说明对外行为未被改写。

验证：

```sh
go -C app test -run 'TestConversationStreams|TestTheLiveReply|TestALiveReply|TestAQueuedPrompt|TestMessageHelpers|TestASettledUser|TestRoundPhaseOfTheServerSignals|TestTheMasterNode|TestAFinishedRound|TestACancelledTool|TestTheWaitingLabel|TestARefreshReports|TestFollowStops' -count=1 ./...
```
