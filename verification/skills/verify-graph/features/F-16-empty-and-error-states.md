# F-16 空态与错误态（daemon 不可达 / 401 / 空数据）

最容易被跳过、也最容易在生产里咬人的一面：daemon 没起来、cookie 失效、数据为空时，界面必须说清是什么问题。

- 入口：任意页面（无需导航）
- 源码：`app/shell.go`（`status` 文案、`broken` 标志）、`app/skeleton_pages.go`（骨架）、`app/composer_*`、各页 `读不到 …` 文案
- 现有自动化覆盖：`app/skeleton_pages_test.go`、`app/shell_view_test.go`（`status` 文案）

## Sub-features

- 加载中：骨架行 + `正在读取会话…`。
- daemon 不可达：窗口仍开、状态行给出失败原因，不崩溃、不空白。
- 401（cookie 失效）：与「不可达」区分（授权 vs 连接）。
- 空数据：会话 `[]`、fleet `agents:[]`、catalog 空 → 各自空态文案。
- 部分失败：`/api/catalog` 成功但 `/api/providers/magpie` 失败时，只有后者显示错误态（互不影响）。

## How to get to it (user POV)

停掉后台（或换错的端口）后打开 Graph → 窗口还在，顶部/左栏告诉你读不到数据 → 修好后重开即恢复。

## Driving it with verify-graph

```sh
verification/verify-graph verify --journey F-16-empty-and-error
verification/verify-graph api GET /api/health --run <run>          # {"ok":true}
verification/verify-graph api GET /api/conversations --run <run>   # 空实例为 []
verification/verify-graph doctor --run <run>                       # 没有窗口/AX 权限等前提也在这里报
```

判过（已实测）：`verify --journey F-16-empty-and-error` 通过 —— 每条 journey 开头先归一化到 `标签页 白板`（`clickIf`），然后「编队」→ `编队总览窗口`、「资源」→ `资源库窗口` 都能从无数据状态渲染出来，同时 `/api/health` = `{"ok":true}`、`/api/startup.mode` = `view`、`/api/fleet` 200。证据：`evidence/<run>/F-16/{fleet-page.png,resources-page.png,check-01..03.json,summary.json}`。

**cookie 与不可达的 401 回读**（单独跑，不放在 journey 里）：匿名请求必页 401 —— 本轮已独立实测（`curl` 不带 cookie → 401，带 `state/session-token` → 200）。

## Gotchas

- 停 daemon 会让窗口进入错误态，这是**故意**的破坏性一步：只在隔离实例上做，做完必须重建实例并在断言里记 `sequence: stop→assert→relaunch`。
- **共享一个 run 的后果**：`verify --all` 里所有 journey 跑在同一个实例上，前一条 journey 会把界面停在别的页签、或已经造出会话；所以「空态」类断言必须先归一化（`clickIf 标签页 白板`），否则同一断言单独跑过、`--all` 里却红。
- 错误文案是中文长句且可能改词：断言用稳定词根（`读不到`/`失败`/`重试`），并把实际文案写进 `actual` 便于复核。
- 骨架态是瞬时的：断言要轮询到「骨架消失」或「真实内容出现」，不能靠 sleep 定时器。
