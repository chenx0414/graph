# F-07 白板布局与面板管理

主区是「页签 + 可拖拽分栏」的白板：能加面板、换页签、拖拽分区、在新标签页打开、移除；布局持久化在 `state/whiteboard.json`。

- 入口：主区顶部 `白板标题` 页签栏 + 每个面板的右上角 `在新标签页打开` / `移除`
- 源码：`app/board_layout.go`（布局树、`defaultBoardLayout`、拖拽分区）、`app/board_drag_test.go`、`app/board_layout_test.go`(若在)、`app/whiteboard*`
- 持久化：`<state-dir>/whiteboard.json`（`loadBoard`/`saveBoard`，含 `Version` 迁移）

## Sub-features

- 页签切换：页签标题 = `boardPanelTitle(kind)`（如 `轨迹量化`、`洞察概览`）；`标签页 白板` 是首页签。
- 加面板：模块入口生成新页签（`openModule` 对 `fleet` 复用已有页、`insights` 造三面板、`trajectory` 造 12 面板）。
- 拖拽换区：拖动面板主体到另一分区的中心/边缘 → 布局树 `leaves` 顺序变化（`board_drag_test.go` 的断言方式）。
- 固定不重叠：四宫格分区必须互不重叠（`board_view_test.go` 已有严格断言）。
- `移除` / `在新标签页打开`：面板从布局树消失 / 新页签出现同 kind 面板。
- 持久化：关窗重开后页签与分栏保持不变（`whiteboard.json` 里 `pages[]`）。

## How to get to it (user POV)

打开窗口 → 主区就是白板 → 点侧栏任一模块会新增/切到对应页签 → 拖卡片边缘换位置 → 右上角两个小按钮做「打开/移除」。

## Driving it with verify-graph

```sh
verification/verify-graph verify --journey F-07
verification/verify-graph verify --journey F-07 --lane window
verification/verify-graph evidence verify --run <run>
```

本 journey 实测覆盖：白板：默认页签存在，点侧栏开新页签，页签切换与面板移除都反映在界面上。

人工复核项（**尚未写进 journey**，不要当成已覆盖）：每次操作后 `whiteboard.json` 的 `pages[].Panels[].Kind` 与 AX 里出现的 `…窗口` 分组名一一对应；`移除` 后文件里少一个面板且界面上对应分组消失（**文件 + 界面双向**）。

## Gotchas

- 白板状态是**用户数据**（`whiteboard.json`）：窗口车道的实例必须是隔离 state-dir，否则你在改用户的布局。
- 拖拽是几何行为：headless 语义点击做不了拖拽，必须 `press/move/release` 或 headless overlay 车道；窗口车道里拖拽要 `--headed`（会动真光标）——默认不做，记 skip 并写理由，不要判 pass。
- 页签标题重复时（例如 `共享产物` 在编队与轨迹里都有）同名元素会命中多个：用 `ui text` 先确认唯一名字；`ui click --name` 只按精确名点第一个可交互元素。
- `boardPanelTitle` 对未知 kind 回落到 kind 本身：看到英文 kind 出现在界面上，是漏翻译，不是「布局没生效」。
