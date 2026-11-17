# F-09 洞察页（用量 KPI / 趋势 / 会话排行）

「洞察」页把历史用量做成 KPI、按天趋势和会话排行，是「我花了多少」的唯一入口。

- 入口：侧栏「洞察」（`railItems[1]`，kind=`insights`）
- 面板（`openModule("insights")` 造 3 个）：洞察概览（`insights-kpi`）/ 用量趋势（`insights-days`）/ 会话排行（`insights-sessions`）
- 数据源：`GET /api/insights`、`GET /api/trajectory/insights?days=N`、`GET /api/usage`
- 现有自动化覆盖：`app/usage_test.go`、`app/insights*_test.go`（渲染层）

## Sub-features

- KPI：总 token / 总成本 / 会话数三项与 `/api/usage` 一致。
- 天数切换：7/30/90 天切换后重新请求 `/api/trajectory/insights?days=`。
- 趋势图：每天一个数据点，点数 = API 返回天数。
- 排行：会话行按用量降序，行数与 API 一致。
- 空态：无历史时三卡都给空态文案。

## How to get to it (user POV)

点侧栏第二个图标「洞察」→ 三张卡片并排 → 切换天数下拉 → 曲线/列表刷新。

## Driving it with verify-graph

```sh
verification/verify-graph ui click --label "洞察" --json
verification/verify-graph ui expect --name "洞察概览" --role group --json
verification/verify-graph api --run <run> --get /api/usage --save evidence/<run>/F-09/usage.json
verification/verify-graph ui click --label "30 天" --json
verification/verify-graph ui screenshot --out evidence/<run>/F-09/insights.png
```

判过：三卡存在；KPI 数字 = `usage` JSON 对应字段；天数切换后界面点数 = 新请求返回的点数。

## Gotchas

- 成本依赖模型定价表，可能为 0 或 `—`：断言「字段存在且是数字/占位符之一」，不要断言具体金额。
- 天数按钮文案是中文数量词（`7 天`），`--exact` 时注意空格。
- 隔离实例默认零用量：这一页的「真数字」断言必须有数据（`seed` 或用户实例只读）。
