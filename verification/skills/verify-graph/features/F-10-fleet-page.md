# F-10 编队页（Agent 卡片 / 网络 / 协作 / 事件 / Graph 编队）

「编队」页是 Agent 协作的主视图：谁在跑、消息怎么流、任务与产物落在哪、Graph 拓扑长什么样。

- 入口：侧栏「编队」（`railItems[2]`，kind=`fleet`，`fleetPageID`）
- 面板（`defaultFleetPage()`）：编队总览（`fleet-kpi`）/ Agent 网络（`agent-network`）/ 跨 Agent 协作 / 协作任务 / 事件检查 / 共享产物 / Agent 详情 / Graph 编队（`graph-dag`）
- 数据源：`GET /api/fleet`、`GET /api/tasks`、`GET /api/tasks/{id}/graph/topology`、`GET /api/tasks/{id}/nodes/{node}/run`
- 现有自动化覆盖：`app/fleet_*_test.go`（`fleet_detail_test.go`、`fleet_graph_test.go`、`fleet_view_test.go`）、`app/board_network_panel_test.go`、`app/board_agent_panel_test.go`

## Sub-features

- 总览 KPI：`stats.agents/running/tasks/messages/tokens/cost` 六项与 `/api/fleet.stats` 一致。
- Agent 卡片：每个 agent 一个 `编队 Agent <名>` 按钮（实测 AX 名形如 `编队 Agent Main`）。
- 点 Agent → Agent 详情：显示该 agent 的最近运行（`/nodes/{n}/run`）与产物（`/tasks/{id}/artifacts`）。
- 网络面板：节点/边数与 `/topology` 一致；`居中`/`+`/`−` 三个按钮可用。
- 事件检查：`events[]` 条数一致；`跨 Agent 协作`：消息/投递条数一致。
- Graph 编队：拓扑渲染出节点（`graph-dag`），无拓扑时给空态。

## How to get to it (user POV)

点侧栏第三个图标「编队」→ 上方 KPI、中间 Agent 网络、下方卡片/列表 → 点某个 Agent 卡片看详情。

## Driving it with verify-graph

```sh
verification/verify-graph ui click --label "编队" --json
verification/verify-graph api --run <run> --get /api/fleet --save evidence/<run>/F-10/fleet.json
verification/verify-graph ui expect --name "编队总览" --role group --json
verification/verify-graph ui click --role button --label "编队 Agent Main" --json
verification/verify-graph ui screenshot --out evidence/<run>/F-10/fleet.png
```

判过：`编队 Agent *` 按钮数量 = `fleet.agents.length`；KPI 六项与 `fleet.stats` 一致；点 Agent 后详情区出现该 agent id 的最近运行字段。

## Gotchas

- 隔离实例通常 `stats.agents = 0`：Agent 卡片断言只在有数据时成立；否则判「空态 + 网络面板不崩」。
- `编队 Agent Main` 这类名字带前缀，且同名可能多个：用 `--index` 或先取 `fleet.agents[i].name` 再精确匹配。
- 网络面板是无限画布，节点位置是布局计算的结果：只断言节点/边数量与存在性，不断言坐标（坐标会随窗口尺寸变）。
- `board_network_panel` 有缓存（历史上出现过「按 store 指针地址串味」的假回归）：断言前先 `api` 回读一次，别依赖上一次截图。
