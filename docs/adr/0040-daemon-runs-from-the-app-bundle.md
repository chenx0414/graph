# ADR 0040：守护进程从 app 包内运行，稳定副本退役

日期：2026-11-11

## 状态

已接受，已实施。修正 ADR 0038 的第 2 条。

## 背景

ADR 0039 让签名要求不再绑 cdhash 之后，`desktop` 工具仍然 `PERM_DENIED`。实测对照（同一份字节
的两个位置，权限面板里只给 `/Applications/Graph.app` 打过勾）：

| 守护进程启动路径 | `snapshot --app Graph` |
|---|---|
| `/Applications/Graph.app/Contents/MacOS/Graph daemon …` | `ok`，返回 37 KB 窗口树 |
| `~/Library/Application Support/Graph/bin/graphd daemon …` | `PERM_DENIED` |

结论：TCC 除了签名要求，还按「二进制所在的 bundle」决定一条授权是否适用于某个进程。稳定副本在
任何 bundle 之外，它就是自己的客户端，App 上的勾永远不会落到它头上。ADR 0038 认为稳定副本「承载
TCC 授权绑定的稳定身份」——那句话是错的：副本本身才是授权落不到的原因。

## 决策

1. launchd 的 `ProgramArguments` 用**运行中那一份二进制本身**：从 app 包内启动时就是
   `/Applications/Graph.app/Contents/MacOS/Graph`，带 `daemon` 参数。`Paths.daemonLauncher()`
   负责这个判断。
2. 稳定副本只留作包外启动（开发时直接跑 `go`/裸二进制）的后备，不再是装好 App 的路径。包内启动
   时顺手删掉遗留的副本（`dropStableDaemon`）：它既是 60 MB 死重量，也是第二个授权客户端。
3. 包内启动路径在重装后不变，所以「新构建是否已经在跑」不再靠内容比较：`daemonStale` 比较守护
   进程的 `startedAt` 与启动二进制的 mtime，二进制比进程新就重启。`refresh()` 把这三种变化
   （plist、副本、进程落后于二进制）统一成「要不要重启」。

## 后果

- 辅助功能授权与 App 上的勾一致：daemon、工具、agent-desktop 都在 Graph.app 名下，重建不再需要
  重新授权（签名要求也不随内容变化，见 ADR 0039）。
- `~/Library/Application Support/Graph/bin/graphd` 在装好的机器上不再存在；只有包外启动才会生成。
  磁盘少一份 60 MB 重复。
- 重装 App 后守护进程会被自动重启（二进制 mtime 新于进程启动时间），不再是「跑旧代码直到退出」。
- 代价：包外启动（裸二进制、临时构建目录）仍然沿用稳定副本，这条分支保留并有测试
  （`TestLaunchAgentFallsBackToTheStableCopyOutsideABundle` 覆盖不到时至少
  `TestLaunchAgentRunsTheBinaryInsideTheBundleSoTheGrantApplies` 与 `TestTheBundleLauncherRemovesTheLeftoverCopy`
  留守两端）。
