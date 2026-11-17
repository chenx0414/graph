# F-15 托盘与系统通知

菜单栏 Graph 图标提供「打开 Graph / 退出 Graph」；待答问题与任务完成/失败会发系统通知。

- 入口：macOS 菜单栏 Graph 图标（`app/main.go:createTray`）、通知中心
- Journey：`scenarios/F-15-tray.json`（`surface: menu-bar-extras`）
- 现有单测：`app/background_notice_test.go`（应用内通知行，不是系统通知）

## Sub-features

- 托盘菜单项：`打开 Graph`、`退出 Graph`，均为 `menuitem`，中间有分隔线。journey 已覆盖：用本 run 的窗口进程读 `menu-bar-extras`，打开未命名托盘根，再断言两个名字都存在。
- 关窗不退出：`ui window close` 后 daemon 仍 healthy（`acceptance` 的窗口车道回归覆盖）；托盘「打开 Graph」也能再开窗，但不在 journey 里点（会抢焦点）。
- 系统通知：`待答问题`/`任务完成`/`任务失败` 三类（`watchTasks` 轮询 `/api/tasks`）。journey 只把 `list-notifications --app <instance>` 的原始 JSON 落成 `notifications.json`，**不作为 pass 条件**：没有真实待答/完成任务就不会有系统通知，硬断言会变成环境噪声。
- 通知点击回到对应会话（`OnNotificationClick`）：**未覆盖**，原因同上（无法在不制造真实用户任务的前提下产生一条可点通知）。

## How to get to it (user POV)

看菜单栏右上角 → 点 Graph 图标 → 看到两项菜单；任务完成时右上角弹通知。

## Driving it with verify-graph

```sh
cd verification
./verify-graph verify --journey F-15-tray           # surface 车道：只读 + 打开未命名托盘根，绝不点 退出 Graph
./verify-graph verify --journey F-15-tray --lane window
./verify-graph evidence verify --run <run>
```

证据在 `evidence/<run>/F-15/`：`surface.json`（`app/surface/window/elements`）、`result.json`（步骤与可见文案）、`tray.png`（托盘与展开菜单）、`notifications.json`（通知中心原始读取，可能为空）、`assertions.json`、`manifest.json`。

判过：`surface.json.surface == "menu-bar-extras"` 且窗口属于本 run 的 appPid；渲染树里 `打开 Graph` 与 `退出 Graph` 都以 `menuitem` 出现；`tray.png` 非空；`/api/tasks` 200。

## Gotchas

- **绝不点「退出 Graph」**：会杀掉被测实例（用户实例里就是杀掉用户的后台）。journey 只点没有名字的托盘根节点；已命名的菜单项只 `assertAccess`。
- 用户自己的 Graph 与验证实例 app 名都叫 `Graph`；必须用 `snapshot --surface menu-bar-extras --window-id <本 run 的窗口>`（已实现为 `SnapshotSurfaceWindow`），不要用 `--app Graph`，否则会读/点到用户的托盘。
- `menu-bar-extras` 在不同 macOS 版本里层级不同；取不到时记录实际 surface 与错误，不要改成「托盘不存在」。
- 系统通知是异步轮询（`time.Tick(15s)`）且有系统权限门槛：没有真实任务就不会有通知。`notifications.json` 是证据，不是判据。
- 同一台机器上同时跑多个验证实例时，托盘会同时出现多个 Graph 图标；journey 的窗口 scope 是本 run 的 appPid，这一点必须保持。
