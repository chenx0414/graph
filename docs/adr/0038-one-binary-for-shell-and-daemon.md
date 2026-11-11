# ADR 0038：壳与守护进程合并为同一个二进制

日期：2026-11-11

## 状态

已接受，已实施。

## 背景

界面退役浏览器控制台（ADR 0037）之后，仓库里仍是两个 Go 程序：`app/`（MyGo 窗口）与
`backend/cmd/graphd`（HTTP/SSE 守护进程）。壳启动时把 `dist/graphd` 拷到
`~/Library/Application Support/Graph/bin/graphd`，再让 launchd 从这里拉起它。

这套安排有两个代价：

1. 装好的 `/Applications/Graph.app` 不是自洽的：它的守护进程来自源码目录的 `dist/graphd`。
   checkout 一搬走或者 `dist/` 一清空，App 就只能靠稳定副本里那份旧守护进程活着。
2. 壳与守护进程可以各走一个版本：装好的窗口是新代码，正在跑的守护进程是旧代码，而两者的
   接口约定只写在两边的代码里。

## 决策

1. 一个可执行文件，两种模式：正常启动开窗口；第一个参数是 `daemon` 时调用
   `backend/daemon.Run`，把后续参数交给既有的 `graph.RunCLI`。`dist/graphd` 仍为
   `node --run start` 与 E2E 保留，但不再是 App 的来源。
2. launchd 走固定路径 `~/Library/Application Support/Graph/bin/graphd`（`dist/` 那样的构建
   目录不行：重建就换路径或换 cdhash）。**这一条后来被 ADR 0040 推翻**：副本在任何 bundle 之外，
   macOS 因此把它当成独立的授权客户端，App 上的勾落不到守护进程头上。现在 launchd 直接跑
   `/Applications/Graph.app/Contents/MacOS/Graph daemon …`，副本只在包外启动时保留。
3. 刷新顺序固定：先原子替换稳定副本，再写 plist，最后重启 launchd。反过来的话，launchd 会用
   新参数（`daemon`）拉起旧二进制，守护进程起不来，窗口在 40 秒里等一个不会出现的地址。
   `Paths.LaunchAgentFile` 让这条顺序能被测试端到端地跑一遍。
4. `app:build` 只做一件事：用 `go tool mygo build` 打 `Graph.app`。它不再先构建
   `dist/graphd`，因为包里已经包含守护进程。

## 后果

- App 自洽：`Graph.app/Contents/MacOS/Graph` 一份二进制同时是窗口与守护进程，装上就能跑，
  不再读源码目录。
- 壳与守护进程不可能再版本错配：launchd 跑的就是壳拷给它的自己。
- 二进制从 12.5 MiB（壳）与 73.5 MiB（守护进程）合并成一份约 78 MiB 的产物，`app/` 的构建
  因此链接了 `backend/` 的全部依赖：`app/go.mod` 多了 `require github.com/chenx0414/graph/backend`
  与 `replace ... => ../backend`，`go.sum` 随之变长，`go -C app test ./...` 的首次编译也变慢
  （之后走构建缓存）。
- `GRAPH_DAEMON` 仍然能覆盖守护进程的来源，供测试与开发把守护进程指到别处。
- Chromium 链路的收尾：`scripts/perf/**`、`playwright-launch-report.mjs`、`make-icons.mjs`
  与 `playwright` 依赖在同一次清理中删除；图标改为提交产物，需要重绘时从历史取回脚本。
