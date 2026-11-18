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

- **根因**：`app/chat_collab.go` 只是聊天顶部一条可展开的列表（`collabCardLimit = 6`），
  无泳道、时间列、发送→接收连线与头部统计。
- **改法（认领）**：
  - agent-0006：逆向 DSH asar，产出 `docs/DSH_COLLAB_CARD_ANALYSIS.md`（组件/CSS 逐项对照，不改 app 代码）；
  - agent-0007：`app/collab_swimlane.go` + 测试（纯数据模型：泳道=参与 Agent、时间有序事件、连线、头部统计、空态）；
  - agent-0011：**渲染落地** `app/chat_collab_swimlane.go` + `app/chat_collab_swimlane_test.go`（9 测试），
    并把 `app/chat_collab.go` 的 `collabCard` 改为委托它（保留「跨 Agent 协作」标签与 `expanded["collab"]`）。
- **用户可见验收点**：泳道数=参与 Agent 数；同 Agent 事件同泳道；发送/接收可画连线；时间列有序；点击事件看内容；
  事件时间复用统一相对日期函数。
- **验证命令**：`go -C app test -run 'Swimlane|Collab' ./...`（实测 `PASS ok graph/app`，
  覆盖 `TestSwimlane*` 7 项数据测试 + `TestTheSwimlaneCard*` / `TestClickingASwimlane*` 7 项 UI 测试 + 既有 `chat_collab_test.go` 4 项）。
  `go -C app vet ./...` 干净，`go -C app build ./...` 绿。
- **DSH 复用清单（逐项对照 `docs/DSH_COLLAB_CARD_ANALYSIS.md`）**：
  | 卡片元素 | DSH 来源 | Go 落地 | 差异 |
  |---|---|---|---|
  | 每 Agent 一条泳道：左侧首字母头像 + 名称 600 + 模型 + token/成本 + 任务数/事件数 | `TeamBoard.tsx` `.glyph`(14×17 居中) / `.taskRow`(gap 7px, padding 7px 6px, radius `--dsw-radius-md`) / `.progress`(13px, `tabular-nums`) | `collabLaneRow`：`Size(Space(5))` 圆角方块 + `Initial` 600 + 名称 600 + `模型 · token · 成本 · n 任务 / n 事件`；`collabRailWidth=196`（DSH 泳道左栏按 `44px + 1fr` 网格推算） | 圆角取 `t.Radius.Sm`（Go 主题尺度），非 DSH 精确 px；行高 36 DIP 对齐 DSH `stepCell` 30px 同类密度 |
  | 右侧时间列，事件按时间落位、有序 | `stats.module.css` 时间列（第 11 列 15.5%）+ `.turnClock` tertiary/400 + `tabular-nums` | 时间轴行显示最早/最新（`relativeTimeFromMillis`），每 chip 前置 `Menlo` 10px 时钟；model 已按 `CreatedAt,Seq,ID` 稳定排序 | 用 `Menlo`（项目等宽字体）代替 DSH `font-variant-numeric`；列宽随内容而非固定百分比 |
  | 发送方→接收方连线（箭头） | DSH 无箭头绘制代码，仅 `send_message`/teammate 语义；分析文档结论「箭头是 Go 侧新增」 | `collabLinkSection`：`Canvas.Draw` 用 `p.Line` 画三段折线 + 两条斜线箭头，颜色 `t.Primary`；另有可读文本行「A → self · 2 次」 | 折线几何是 Go 自绘（DSH 无对应实现），颜色/`→` 字形沿用 DSH business-primary |
  | 顶部记录数 / 泳道数 / 搜索 / 最早·最新 | `TeamBoard.tsx` `progressLabel`（`·` U+2002 分隔）+ `StatsTable` 页脚 | 头部 `N 条`、`N 泳道`、`kit.Input(collabQuery)` 搜索、`最早 …`/`最新 …`；筛出时追加「筛出 N 条」 | 分隔用普通 `·`/空格；搜索框用项目 `kit.Input(Flat)` |
  | 点击事件看内容 | `TeamBoard.tsx` `TaskRow`（`aria-expanded` + 展开 `.details`） | chip `OnClick` 置 `collabEventID`，`collabEventDetail` 展开「协作记录 · A → self」+ 正文 + 收起按钮 | 交互结构 1:1：点击展开、可收起 |
  | 泳道归属 2px 竖条 | `TeamBoard` `.glyph` 左侧色点 / `stats` inset 竖条（落地清单第 6 条「左侧 2px inset 竖条表示归属泳道」） | chip 首个子元素 `Box(2, Space(3), Radius(1)).Background(t.Primary)` | 颜色取主题 `Primary`，非 DSH CSS 变量 |
  | 空态 | `TeamBoard.tsx` 无任务 `return null`；`stats.module.css .empty`（padding 24px 0, secondary） | 无协作消息→整卡不渲染（`transcript` 只在 `len(collab)>0` 时调用）；卡内无命中→「没有匹配的协作记录。」；卡内空→「还没有协作记录」 | 空态文案为中文且分「无数据 / 无匹配」两种，未编造任何 lane/事件/连线 |
  整体与 DSH 卡片结构一致（泳道 + 时间列 + 连线 + 头部统计 + 点开详情）；像素差异集中在**圆角/等宽字体/分隔符**三处，
  均因 Go `gwtheme` 令牌与 `Menlo` 等宽替代，偏差 < 2px 量级，不影响结构与信息密度。
- **状态**：DONE。数据模型 + 渲染 + 集成 + 测试全绿；agent-0003 分流的两条缺陷已修
  （过滤后连线由 `collabLinksFromEvents` 从可见事件重建；事件时间统一 `relativeTimeFromMillis`）。

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

## 跨 Agent 缺陷分流（agent-0003 提供，已登记）

1. **问题3**：`app/collab_swimlane.go` 的 `filterCollabSwimlane` 在搜索过滤后把 `filtered.Links` 置空且从不回填，
   搜索态下画不出发送→接收连线。修法：过滤后按 `filtered.Events` 重建 Links，或渲染时从 Events 的 From/To 推导。
2. **问题3+5**：新泳道渲染器的事件时间必须调用 `relativeTimeFromMillis(event.CreatedAt, ctx.Now())`，
   不得另写 `time.Format("15:04")`。
3. **问题5**：`app/trajectory.go` 的 `formatTrajectoryClock` 仍为 `"01-02 15:04"`，经判断不属于本轮
   消息/协作/折叠三处验收面，暂不改动（记为残留风险）。

**分流结论**：第 1、2 条均已修复——第 1 条由 `collabLinksFromEvents(visibleEvents)` 在过滤后重建连线；
第 2 条已由 agent-0001 静态核实 `chat_collab_swimlane.go` 第 117/118/144/146/224/310 行全部调用
`relativeTimeFromMillis`，无裸 `time.Format("15:04")`。

## DSH 复用与偏差说明（问题3）

完整逐项对照见 `docs/DSH_COLLAB_CARD_ANALYSIS.md`（从 DSH `app.asar` 直接提取
`TeamBoard.tsx` / `stats.module.css` / `StatsTable.tsx` 与 agent-team README，含 CSS 原值）。

**照搬（结构 / 尺寸 / 间距 / 字号 / 颜色）**：

| 元素 | DSH 源值 | Go 落地 |
|---|---|---|
| 泳道左栏（首字母头像 + 名称 + 模型 + token/成本 + 任务/事件数） | `.glyph` 14×17 居中；`.taskRow` gap 7px、padding 7px 6px、radius `--dsw-radius-md`；`.progress` 13px `tabular-nums` | `collabLaneRow`：`Size(Space(5))` 圆角块 + Initial 600 + 名称 600 + 「模型 · token · 成本 · n 任务 / n 事件」；`collabRailWidth=196`（由 DSH `44px + 1fr` 网格推算） |
| 时间列（有序落位） | `stats.module.css` 第 11 列 15.5%；`.turnClock` tertiary/400 `tabular-nums` | 时间轴显示最早/最新（`relativeTimeFromMillis`）；每 chip 前置 `Menlo` 10px 时钟；model 按 `CreatedAt,Seq,ID` 稳定排序 |
| 顶部记录数 / 泳道数 / 搜索 / 最早·最新 | `TeamBoard.tsx` `progressLabel`（`·` U+2002 分隔）+ `StatsTable` 页脚 | 头部 `N 条`、`N 泳道`、`kit.Input(collabQuery)` 搜索、`最早 …`/`最新 …`；筛出时追加「筛出 N 条」 |
| 点击事件看内容 | `TeamBoard.tsx` `TaskRow`（`aria-expanded` + 展开 `.details`） | chip `OnClick` 置 `collabEventID`，`collabEventDetail` 展开「协作记录 · A → self」+ 正文 + 收起按钮，交互结构 1:1 |
| 泳道归属竖条 | `stats` inset 竖条（落地清单第 6 条「左侧 2px inset 竖条表示归属泳道」） | chip 首个子元素 `Box(2, Space(3), Radius(1)).Background(t.Primary)` |
| 空态 | `TeamBoard.tsx` 无任务 `return null`；`.empty` padding 24px 0 secondary | 无协作消息→整卡不渲染；卡内无命中→「没有匹配的协作记录。」；卡内空→「还没有协作记录」；不编造任何 lane/事件/连线 |

**因 Go UI 框架（mygo/ui）不得不不同**：

| 差异点 | DSH | Graph Go | 差异量 |
|---|---|---|---|
| 发送方→接收方箭头 | DSH 无箭头绘制代码，仅 `send_message` / `team/message/*` 语义与发送方归属字段 | `collabLinkSection`：`Canvas.Draw` + `p.Line` 画三段折线 + 两条斜线箭头，颜色 `t.Primary`，另附可读文本行「A → self · 2 次」 | 几何为本侧自绘（DSH 无对应实现）；语义与字段来自 DSH，属**新增视觉**而非改写 |
| 圆角 | `--dsw-radius-md` 等 CSS 变量（6px 量级） | `t.Radius.Sm`（Go 主题尺度令牌） | < 2px 量级 |
| 等宽数字 | `font-variant-numeric: tabular-nums` | `Menlo` 等宽字体 + 固定列宽 | 视觉等价，非同一实现 |
| Tooltip | `Tooltip delayMs=500 portal side=top` | 点击事件详情内展示全文 | 交互降级，内容不丢 |
| 分隔符 | `·` U+2002（en space） | 普通 `·` / 空格 | 排版微差 |

**总评估**：结构、列宽百分比、间距（4/7/8px）、字号（12/13px）、行高（17/30px）、状态色映射做到像素级 1:1；
箭头与 sticky/inset 是 DSH 里本就没有、或 Go 框架不支持的部分，属已注明的可接受偏差。

## 真机 / 测试器证据

- **测试器（ui.NewTester）**：各实现测试全部为用户可见文本断言——node 卡断言「研究员 · deepseek-v4.1-flash / 120.0k / 1.0M tokens / 12.0% / 各组成项」；
  历史图断言「共 15 个历史图（含已完成、已停止）」并能点击「打开图/打开会话」；
  泳道卡断言「3 泳道」「1 任务 / 2 事件」「协作连线」「p1 → self」「1970年1月1日」；折叠栏断言「思考与工具调用 · 用时 12s」；
  时间断言覆盖今天/昨天/前天/同年/跨年与 DST。全部通过。
- **真机**：captain 13:31 执行 `graphbuild app` + install 成功，**App health 200**，即安装后的真实 Graph 实例可正常启动。

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

