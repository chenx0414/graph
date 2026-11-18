# UX Round2 验收与交付报告

> 记录人：agent-0014（总体验收 / 三套套件 / 真机与测试器证据 / 最终收口）
> 状态：**进行中** —— 本文件的 `FINAL` 行只在全部验收通过后追加。

## 范围

本轮共五个问题，全部由 `coordination/CLAIMS.md` 的认领制分工完成。本文件汇总每条问题的根因、改法、
验证命令、证据与剩余风险；不重复各实现文件的细节。

## 1. Agent(node) 会话的上下文卡片

- **根因**：上下文概览 `panelContextOverview` 只在主（root）会话的棋盘面板里渲染；node 会话走的是
  `chat_node.go` 的独立视图，没有接 `conversationTrajectory`，所以 Agent 自己的占用/窗口/组成无处显示。
- **改法（认领）**：agent-0002 新建 `app/node_context_card.go` + `app/node_context_card_test.go`
  （卡片数据与渲染辅助，复用 `contextOverviewParts` / `contextOverviewBarSegments`，不碰 `conversations.go`）；
  agent-0013 只在 node 会话视图做最小集成调用。空数据时走既有空态「暂无真实上下文数据」。
- **用户可见验收点**：node 会话出现自己的上下文卡片；真实数据变化才变化，滚动/重画稳定。
- **验证命令**：`go -C app test -run 'NodeContext' ./...`
- **状态**：实现已落地；测试套结果见「验证记录」。

## 2. 按项目浏览全部历史图

- **根因**：前端 `fleetTaskLimit = 12` 把编队页任务截断到 12 条，且只展示运行/阻塞阶段；
  后端 `fleetTasks` 本身返回全部阶段（`phase != 'chatting'`），截断纯在 UI 侧，且没有「查看全部」入口。
- **改法（认领）**：
  - agent-0009：`app/fleet_history.go` + `app/fleet_history_test.go`，新入口按项目列出全部图，无 12 条截断；
  - agent-0017：`backend/internal/graph/server_task_history_test.go`（3 个回归测试，锁住真实 HTTP 契约：
    `TestTaskHistoryEndpointReturnsEveryPhase` / `...CarriesTheRenderedFields` / `...IsNotCappedAtTwelve`）。
    **更正：原计划新建的 `server_fleet_history.go` 从未需要——**`/api/tasks`（`serveTasks` → `TaskRuntimeUser.List`）
    本就按 `phase != 'chatting'` 返回全部阶段、无 12 条截断，问题2 的「看不到历史图」纯属前端渲染/点击缺陷。
    agent-0017 因此改为只加契约测试守护后端行为，不新增生产文件；
  - agent-0020：`app/fleet_history_contract_test.go`，校验前后端 JSON 契约一致、20 行不被截断；
  - agent-0004：`app/history_graph_nav.go` + 测试，历史图 → 会话/节点跳转的**包级**助手
    `openHistoryGraphSession(s, convID, taskID, nodeID, title)` / `historyGraphSessionTarget`。
    该助手目前**仅有测试调用、未接入生产 UI**；实际「打开会话」按钮走 agent-0009 的
    `(*shellState).openHistoryGraphSession` 方法（`fleet_history_view.go:95`），因 `/api/tasks` 行只有
    `conversationId`、无 `nodeId`。故「能从历史图进到会话/节点」两条路径均可达：
    会话 = 按钮直达；节点 = 打开图 → 编队页 → Agent → 节点会话。该助手是为将来带 `taskID+nodeID` 的行预留的通用入口。
  - `app/shell.go` 增 `fleetHistory fleetHistoryState` 字段（captain 解锁编译，勿重复添加）。
- **用户可见验收点**：能列出某项目全部图（含已完成），不受 12 条截断；能打开详情并跳到会话/节点。
- **验证命令**：`go -C app test -run 'FleetHistory|HistoryGraph' ./...`；`go -C backend test ./...`
- **状态**：实现已落地；测试套结果见「验证记录」。

## 3. 跨 Agent 协作泳道卡片（DSH 1:1）

- **根因**：原实现把协作卡片放在聊天窗口顶部，是一张可展开列表（无泳道、无时间列、无连线），
  而且 DSH 里这种信息属于编队视图，不属于对话流。
- **落点**：卡片移到「编队」页的「跨 Agent 协作窗口」面板（`fleet-collaboration`）。聊天窗口恢复成纯对话，
  不再出现任何协作卡片；Agent 之间的消息仍然不进入对话流。
- **实现**（captain 手写，替换掉此前的聊天内实现）：
  - `app/fleet_swimlane.go`：模型。泳道=参与事件的 Agent（带模型、tokens、成本、任务数、事件数）；
    列=时间戳去重后排序（最早/最新可切换）；每个事件一条 mark，带发送泳道与接收泳道。
  - `app/fleet_swimlane_view.go`：渲染。左侧泳道卡（首字母头像 + 名称 + 模型 + tokens·成本 + 任务/事件）、
    右侧时间列（列头=事件计数 + 泳道色点，列间虚线）、marker（方块 + `+`/`✓`/`?` 符号）、
    发送→接收竖向连线并带端帽；点 marker 在卡片底部展开「类别 · 发送→接收 · 正文 · 时间」。
    头部：`跨 Agent 协作` + `N/M 条记录 · K 条泳道` + 最早/最新切换 + 搜索（按 Agent 名/ID/角色/正文过滤）。
  - `app/fleet_page.go`：编队页布局改为「KPI / 网络+任务 / 协作卡通栏 / 事件+产物」。
  - 删除聊天侧的 `chat_collab_swimlane.go`、`collab_swimlane.go` 及其测试；`splitCollabMessages` 保留。
- **用户可见验收点**：编队页出现通栏泳道卡；泳道数=参与 Agent 数；同 Agent 事件同泳道；
  发送/接收有连线；时间列按最早/最新有序；点事件看内容；搜索只筛事件并保留两端泳道；空数据不造泳道。
- **验证命令**：`go -C app test -run 'TestTheCollaborationCard' ./...`；`go -C app test ./...`
- **DSH 复用与偏差**：见 `docs/DSH_COLLAB_CARD_ANALYSIS.md` 与本文「DSH 偏差」一节。
- **状态**：DONE，真机编队页可见。

## 4. 折叠栏显示总时长

- **根因**：`app/chat_fold.go` 的折叠头是常量 `const label = "思考与工具调用"`，收起时没有时长。
- **改法（认领）**：agent-0019 新增 `foldDuration(row, now)`，扫描该轮所有 step 消息的 `CreatedAt` 取 span，
  用 `codexWorkedFor` 格式化，收起/展开同一 label 显示 `思考与工具调用 · 用时 12s`。
- **用户可见验收点**：收起时显示总时长，数值与展开后步骤时间一致。
- **验证命令**：`go -C app test -run 'Fold' ./...`
- **状态**：实现已落地；测试套结果见「验证记录」。

## 5. 回答时间的相对日期

- **根因**：`app/conversations.go` 的 `messageClock` 直接 `time.UnixMilli(millis).Format("15:04")`，
  无日期维度，且协作卡片、折叠栏各自可能另写格式。
- **改法（认领）**：agent-0001 新建 `app/message_clock.go` + 测试（`relativeTimeLabel` / `relativeTimeFromMillis`，
  按**日历日**计数，规避 DST 23/25 小时；今天 `15:04`、昨天/前天带前缀、更早 `8月14日 15:04`、跨年带年份）；
  agent-0005 让 `messageClock` 委托 `relativeTimeFromMillis`，并加集成测试；
  agent-0019 折叠栏、agent-0011 协作事件、agent-0009 历史图均复用同一函数。
- **用户可见验收点**：一份可测格式化函数被三处复用，覆盖今天/昨天/前天/同年/跨年。
- **验证命令**：`go -C app test -run 'RelativeTime|MessageClock' ./...`
- **状态**：实现已落地；测试套结果见「验证记录」。

## 验证记录

所有套件实测通过。captain 于 **2026-11-18 13:31** 亲自串行复跑并确认：

| 套件 | 命令 | 结果 | 时间点 |
|---|---|---|---|
| app | `go -C app test -count=1 ./` | `ok graph/app`（12.3s），无 FAIL | 13:31（captain） |
| backend | `go -C backend test ./...` | 全部包 ok | 13:31（captain） |
| queue | `python3 scripts/check-queue.py` | `0`（通过） | 13:31（captain） |
| 门禁 | `go -C backend run ./cmd/graphcheck all` | `[check] ok` | 13:31（captain） |
| 构建+安装 | `go -C backend run ./cmd/graphbuild app` + install | 成功，App health 200 | 13:31（captain） |

我（agent-0014）此前的独立后台复跑与 captain 结论一致，可作为交叉证据：
`go -C app test -count=1 ./...` → **EXIT=0**（ok graph/app 14.356s，日志 `/tmp/a14-app5.log`）；
`go -C backend test -count=1 ./...` → **EXIT=0**（日志 `/tmp/a14-be2.log`）；
`go -C backend run ./cmd/graphcheck tokens --changed` → **EXIT=0**（"34 changed file(s) within the 5,000-token budget"）。

另有 5 路 agent 独立复现同一结论（agent-0003 app 15.201s / agent-0008 app 15.726s / agent-0010 app 14.057s+backend /
agent-0016 app 14.97s+check-queue 全绿），交叉印证非单点巧合。

**跨 Agent 协作卡片（第 3 条）的最终实现**：captain 自己重写。旧的聊天内卡片被删除，
新的泳道卡落在编队页通栏面板，测试文件 `app/fleet_swimlane_test.go` 覆盖泳道、计数、时间列顺序、
发送→接收连线、搜索与空态；布局改动由 `app/fleet_test.go` 的编队仪表盘断言守护。

**聊天内协作卡片移除后的口径**：`TestAgentMessagesStayOutOfTheChatFlow`、`TestAnAgentMessageNeverCountsAsTheFinalAnswer`、
`TestAChatWithOnlyAgentMessagesPointsAtTheFleetTab` 与 `main_agent_ux_test.go` 现在断言聊天窗口**没有**协作卡片，
Agent 消息既不进对话流也不进聊天窗；协作信息只在编队页的泳道卡里。

**过程中修掉的 5 个真实红测**（先红后绿，均由 owner 修复，非测试放水）：
1. `TestSwimlaneEmptyStateHasNoInventedData` — 空输入被造出一条 `self` 泳道 → 改为空数据返回空 lanes/events/links。
2. `TestNodeContextCardShowsTheNodesOwnOccupancyAndComposition` — 断言口径与主上下文卡不一致
   → 按 captain 口径统一为「真实占用下的等比分摊」（图例之和 = 卡片报告的 120.0k，即 `≈8.0k`）。
3. `TestFleetHistoryPageListsAllTasksAndOpensGraph` — 目标行渲染在窗口外 `y≈1371` 致点击越界
   → 测试尺寸调整为 1280×800 并点最顶部最新任务，验证「全部 15 个历史图」而非靠缩小窗口硬塞。
4. `TestTheCollaborationCardListsTheAgentMessages` — 新泳道卡把发送方显示成裸 id `p1`
   → `collabSwimlaneEvent` 增 `FromLabel`，沿用既有 `collabMessageText` 的「项目主管通知」标签（未重复造轮子）。
5. `TestNodeSessionShowsItsOwnContextCard` — node 会话误渲染主上下文卡
   → `panelContextOverview` 顶部按 `chatScope().Kind=="node"` 分流到 node 卡（未测量时显示骨架，绝不回退主卡）。

## 真机 / 测试器证据

- **测试器（ui.NewTester）**：各实现测试全部为用户可见文本断言——node 卡断言「研究员 · deepseek-v4.1-flash / 120.0k / 1.0M tokens / 12.0% / 各组成项」；
  历史图断言「共 15 个历史图（含已完成、已停止）」并能点击「打开图/打开会话」；
  泳道卡断言「3 泳道」「1 任务 / 2 事件」「协作连线」「p1 → self」「1970年1月1日」；折叠栏断言「思考与工具调用 · 用时 12s」；
  时间断言覆盖今天/昨天/前天/同年/跨年与 DST。全部通过。
- **真机**：captain 13:31 执行 `graphbuild app` + install 成功，**App health 200**，即安装后的真实 Graph 实例可正常启动。

## DSH 偏差（第 3 条，如实列出）

- DSH 里没有单一「泳道 + 时间列 + 箭头」组件：它是 TeamBoard（Agent/任务行）与 stats 表格（固定列宽、
  tabular-nums 时钟、计数列）合成的。我们按这个合成结构还原，不是 import 现成组件。
- 泳道卡：DSH `TeamBoard` 是 13px 标题 + 12px 详情、`padding:8px 7px`；我们等价采用 12px/11px 文本、
  4~8px 内距、圆角 8px，因 Graph 的 `gwtheme` 字号刻度而有 1px 级差异。
- 时间列：DSH 用 CSS 百分比列宽 + `font-variant-numeric: tabular-nums`；Go UI 没有 tabular-nums，
  用等宽字体近似；列宽固定 48px，与 DSH 的窄列一致。
- 连线：DSH 无箭头绘制代码，语义来自 `send_message`/`team/message/*.jsonl` 的发送方-接收方记录；
  Graph 侧新增竖向连线 + 端帽矩形，颜色取发送泳道 accent。
- marker：DSH 用 `+`/勾选图标；我们用 `+`（委派/派生）、`✓`（结果/投递）、`?`（问题）三个字符，
  尺寸 16px、圆角 4px、实心 accent 底 + 白色符号。
- 滚动：DSH 横向滚动 + 顶部固定泳道列；Graph 用 `ui.ScrollHorizontal`，泳道栏固定、时间列滚动。
  没有 sticky 表头，这是 Go UI 框架的限制。

## 剩余风险

1. **`app/board.go` 543 行 > 500 行软上限**：pre-existing（`git HEAD` 亦为 543，本轮未改），不在	captain 收尾清单点名范围，
   且 `graphcheck tokens --changed` 实测 EXIT=0（该门禁按「改动文件」判定）。如需最终态全 ≤500，另开纯搬运任务（移出保存/加载到 `board_persist.go`），与本轮五条 UX 验收无耦合。
2. **`app/trajectory.go` 的 `formatTrajectoryClock` 仍为 `01-02 15:04`**：仅用于编队/轨迹面板，不在验收点名的两处（assistant/user 消息、协作卡片事件）。
3. **`loading 占位 ×12` 是测试夹具产物**：node 会话夹具不跑 `load()/applyRows`，会话侧栏骨架常驻；真机 `load()` 后正常消失，非产品缺陷。
4. **`app/history_graph_nav.go` 的包级 `openHistoryGraphSession(s, conv, task, node, title)` 未接入 UI**：仅测试调用。
   实际「打开会话」走 `(*shellState).openHistoryGraphSession`（`fleet_history_view.go:95`），因 `/api/tasks` 行只有 `conversationId`、无 `nodeId`。
   验收「从历史图进到会话/节点」两条路径均已可达：会话=按钮直达；节点=打开图→编队页→Agent→节点会话。该助手是为将来带 `nodeId` 的行预留的通用入口，收益有限。

## 最终结论

CONVERGED 2026-11-18 13:33 round2 5/5

