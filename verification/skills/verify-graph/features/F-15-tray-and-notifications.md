# F-15 托盘与系统通知

菜单栏图标提供「打开 Graph / 退出 Graph」；待答问题与任务完成/失败会发系统通知。

- 入口：macOS 菜单栏 Graph 图标（`app/main.go:createTray`）、通知中心
- 现有自动化覆盖：`app/background_notice_test.go`（应用内通知行渲染，不是系统通知）

## Sub-features

- 托盘菜单项：`打开 Graph`、`退出 Graph`（中间有分隔线）。
- 关窗不退出：点窗口关闭按钮后 daemon 仍在，托盘菜单「打开 Graph」能再开窗。
- 系统通知：`待答问题`/`任务完成`/`任务失败` 三类（`watchTasks` 轮询 `/api/tasks`）。
- 通知点击：点通知回到对应会话（`OnNotificationClick`）。

## How to get to it (user POV)

看菜单栏右上角 → 点 Graph 图标 → 看到两项菜单；任务完成时右上角弹通知。

## Driving it with verify-graph

```sh
verification/verify-graph ui surface --surface menu-bar-extras --app Graph --json
verification/verify-graph ui expect --name "打开 Graph" --json
verification/verify-graph ui notifications --save evidence/<run>/F-15/notifications.json
verification/verify-graph ui screenshot --out evidence/<run>/F-15/tray.png
```

判过：菜单栏 extras 里出现 Graph 的菜单项；`打开 Graph` / `退出 Graph` 两个名字都存在。

## Gotchas

- **不要点「退出 Graph」**：会杀掉实例（用户实例里就是杀掉用户的后台）。只断言存在。
- 通知是异步的（`time.Tick(15s)`）：没有真实任务就不会有通知，判据降级为「通知中心命令可读」并记 skip 理由。
- `menu-bar-extras` surface 在不同 macOS 版本里层级不同；取不到时用 `snapshot --surface menubar` 兜底，并记录实际 surface。
