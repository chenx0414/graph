# F-02 模块导航（侧栏 7 项）

点侧栏七项，每一页真的要出现它自己的面板，而不是白屏或上一页残留。

- 入口：窗口最左侧图标栏（`app/board.go:18 railItems`）
- 用户看到的名字：**轨迹 / 洞察 / 编队 / 供应商 / 资源 / 装配 / 设置**
- 现有自动化覆盖：`app/rail_view_test.go`（钉住 7 项与 kind）、`app/shell_view_test.go`（三栏与 rail 存在）

## Sub-features

| 点击 | 期望页面（白板页签标题 = `boardPanelTitle`） | 期望面板分组（AX group 名） |
| --- | --- | --- |
| 轨迹 | 轨迹量化 | 轨迹量化窗口 / 上下文统计 / Token 统计 / 耗时统计 / 当前上下文 / 上下文趋势 / 上下文事件 / 命令执行 / 文件活动 / Token 组成 / 请求浏览 / Agent 网络 / 请求详情（共 12 个） |
| 洞察 | 洞察概览 | 洞察概览 / 用量趋势 / 会话排行 |
| 编队 | 编队总览 | 编队总览 / Agent 网络 / 跨 Agent 协作 / 协作任务 / 事件检查 / 共享产物 / Agent 详情 / Graph 编队 |
| 供应商 | 供应商 | 供应商窗口（含 `查找供应商`、`Magpie <状态>`） |
| 资源 | 资源库 | 资源库窗口（含 `资源库` 面包屑、`分类 …`、`资源 …`） |
| 装配 | 能力装配 | 能力装配窗口（含 `把资源库里的技能、指令、MCP 与 Pi 扩展装配成 Agent 角色…`） |
| 设置 | 运行设置 | 运行设置窗口（含 `打开 扩展自动更新`） |

## How to get to it (user POV)

打开 Graph 窗口 → 点左侧第 1～7 个图标（悬停有 tooltip 写名字）→ 主区出现对应页签与卡片。

## Driving it with verify-graph

```sh
# 一次跑完七页（journey 文件 verification/scenarios/F-02-nav.json，32 步）
verification/verify-graph verify --journey F-02-nav
# 只渲染不判（看它到底渲染出什么）
verification/verify-graph ui render F-02-nav
# 看证据
verification/verify-graph evidence list --run <run>
```

判过（已实测）：`verify --journey F-02-nav` 的 32 步全 pass —— 七个 rail 按钮文字都在；点「洞察」后 `洞察概览窗口`/`用量趋势窗口`/`会话排行窗口` 出现；「供应商」→`供应商窗口`；「资源」→`资源库窗口`；「装配」→`能力装配窗口`；「设置」→`运行设置窗口`；「编队」→`编队总览窗口`；「轨迹」→页签 `标签页 轨迹量化` + `上下文统计窗口`、`Token 统计窗口`。证据：`evidence/<run>/F-02/{nav-insights,nav-fleet,nav-trajectory}.png` + `result.json` + `summary.json`。

**页面形态（写断言前必须知道）**：每个模块是「一个页签 + 若干面板窗口」，页签文案是 `boardPanelTitle(kind)`（如 `轨迹量化`、`洞察概览`），面板是 `<面板标题>窗口`。轨迹页有 12 个面板，所以**没有**「轨迹量化窗口」这个东西——它只有页签 `标签页 轨迹量化` 和 12 个面板窗口。

## Gotchas

- 每个 rail 按钮的 AX name 就是中文 label，**不要**用坐标或 tab 顺序（MyGo `.Label()` 落到 AX name）。
- `find` / `list-windows` 默认 3–5s 会 `TIMEOUT`（实测），必须放宽超时并用窗口 id 锁定本 run 的窗口，否则可能点到用户那份窗口。
- 点完要等「页面切换真的发生」再断言：用 `waitText` 轮询（8s 默认，重页面给 15000–25000ms），不要 sleep。
- **多个 journey 共用同一个 run** 时窗口状态会残留（前一条 journey 停在别的页签）：所以每条 journey 开头都要先 `waitText 白板标题` + `clickIf 标签页 白板` 归位，否则「点洞察应出现洞察概览」会因为已经停在该页而误判。
- 面板数是 12/3/8 这种硬数字时，先从 `board_layout.go` 核对，别把「新增面板」误判成回归。
- 第一次点某模块会新建页签并写 `state/whiteboard.json`：跑完全套后状态目录里的白板页签比开跑前多，这是**产品行为**，不是污染（隔离 run 目录随 cleanup 删除）。
