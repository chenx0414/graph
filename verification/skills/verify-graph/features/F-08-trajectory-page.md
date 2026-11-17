# F-08 轨迹页（12 个量化面板）

「轨迹」页把一次运行的上下文、token、耗时、事件、命令、文件、请求全摊开；这是 Graph 最重的可视化页。

- 入口：侧栏「轨迹」（`railItems[0]`，kind=`trajectory`）
- 面板（`trajectoryPageKinds()`，12 个）：上下文统计 / Token 统计 / 当前上下文 / 耗时统计 / 上下文趋势 / 上下文事件 / 命令执行 / 文件活动 / Token 组成 / 请求浏览 / Agent 网络 / 请求详情
- 数据源：`GET /api/conversations/{id}/trajectory`、`/api/tasks/{t}/nodes/{n}/trajectory`、`/api/trajectory/insights`
- 现有自动化覆盖：`app/trajectory_*_test.go`、`app/trajectory_context_overview_test.go`（渲染层）

## Sub-features

- 空白态：没有轨迹数据时 12 个卡片都给出「还没有轨迹」类文案，不白屏。
- Token 数字：`Token 统计` 的总量与 `trajectory.totalTokens` 一致。
- 耗时：`耗时统计` 的分段与 `timing` 字段一致（不比墙钟，比字段）。
- 事件/命令/文件：分别对应 `events[]`、`commands[]`、`files[]` 的条数。
- 请求浏览 → 请求详情：点一条请求，详情卡显示该请求的模型/耗时/用量。
- Agent 网络：与编队页共享数据（`/api/fleet`），节点数与 `stats.agents` 一致。

## How to get to it (user POV)

点侧栏第一个图标「轨迹」→ 主区出现 12 张卡片 → 点「请求浏览」里一条 → 右侧/详情卡显示该请求。

## Driving it with verify-graph

```sh
verification/verify-graph verify --journey F-08
verification/verify-graph verify --journey F-08 --lane window
verification/verify-graph evidence verify --run <run>
```

本 journey 实测覆盖：轨迹页：点侧栏「轨迹」后出现轨迹量化页签与它的量化面板。

人工复核项（**尚未写进 journey**，不要当成已覆盖）：12 个分组名全部出现（或空态文案全部出现）；`Token 统计` 的首个大数字 = `trajectory.totalTokens`；`请求浏览` 行数 = `requests[]` 长度。

## Gotchas

- 12 个面板一次渲染在很长一页里，AX 快照 `--max-depth` 默认 10 会截断：需要 `--max-depth 20` 或按 `--root` 逐卡取。
- 没有轨迹的空实例只能判空态；「数字对不对」必须靠 `seed` 造一次真运行或用用户实例的只读快照（只读、不点击）。
- `Token 统计` 里的百分比是四舍五入：比整数或比 `sha256(格式化字符串)`，不要比浮点原文。
