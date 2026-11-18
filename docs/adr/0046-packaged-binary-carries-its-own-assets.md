# 0046 打包自洽：资源编进二进制，Agent 命令不再经过 Node

## 状态

已接受，已实施。

## 背景

`/Applications/Graph.app` 里只有一个约 61 MiB 的 `Contents/MacOS/Graph`（`otool -L` 只有系统库），
二进制本身零外部依赖。但「完整体验」当时并不自洽：它在运行时从 `ApplicationRoot` 读两类磁盘文件。

| 资源 | 读取位置 | 缺失时 |
| --- | --- | --- |
| `presets/manifest.json` + `presets/bootstrap/**` | `server_start_daemon.go` 的 `presetsRoot` | 只发 master/coder/reviewer 最小定义，日志 "Bootstrap preset pack not available" |
| `src/runtime/*.mjs`、`check-resolver.cjs` | `runtime_host_command.go`、`runtime_module_evaluator.go`、`runtime_workspace_command.go` | Agent 的 shell 命令直接失败（`node /src/runtime/host-command-worker.mjs` 不存在） |
| `node_modules/elkjs/lib/elk.bundled.js` | `server_layout_elk.go` | 图布局回落 `layoutFallback` |

`ApplicationRoot` 从 `~/.graph/app-root` 读，而**没有写入者**。在新机器上它退化成 `/`（从 Finder
启动 cwd 是 `/`），于是每个路径都变成 `/presets/…`、`/src/runtime/…`：catalog 为空，
host-command worker 路径不存在。也就是说「拷到别的机器能不能一样用」的答案是不能。

同时 `graph-command` 这条链路还压着一个 Node 进程：`src/runtime/host-command-worker.mjs` 只有 55 行，
只做 `spawn`（`detached`）、转发 stdout/stderr、`process.kill(-pid)` 杀组、回 `{kind:"ready"}` 与
`{kind:"result", code}`、退出前写一个 quiescence JSON。这些全是 Go 标准库能做的事，中间不存在任何
JS 独有语义。为此要多装一个 Node 运行时，并且多一条 60 秒握手超时与一套 JSON-over-stdio 协议。

## 决策

1. **资源编进二进制。** `backend/internal/graph/embedded` 用 `//go:embed` 嵌入 `presets` 与
   `src/runtime` 的副本（`backend/internal/graph/embedded/{presets,runtime}`）。
2. **统一解析器，磁盘优先。** `runtime_assets.go` 提供三个入口：`presetsRoot()`、`runtimeScript(name)`、
   `elkScript()`。前两个先看 `ApplicationRoot` 下有没有真实文件——有就用磁盘（开发时改文件立即生效），
   没有就把内嵌副本解压到 `GraphHome()/assets/` 下的只读缓存（路径稳定，内容一致就不重写）。
3. **副本不许漂移。** 内嵌副本与仓库根是两份文件，必须有一道门禁盯住。`embedded_test.go` 逐字节比对
   两个方向：只在 embedded 里、只在仓库根里、内容不一致，都失败并打印完整差异清单。它随
   `go test ./...` 进 `scripts/check-queue.py` 的快层，改了 `presets/` 或 `src/runtime/` 却忘了同步
   副本时立刻变红。
4. **宿主命令改由 Go 原生执行。** 删除 `src/runtime/host-command-worker.mjs`、它的内嵌副本、
   `hostCommandHandshake` 与整套 JSON-over-stdio 协议。`RunHostCommand` 直接用 `exec.Cmd` +
   `SysProcAttr{Setpgid: true}`，自己转发流、自己 `kill(-pgid)`、自己在退出前写 quiescence 收据。
5. **`GraphNodeRuntime` 不再把 Graph 二进制当 node。** 原先没有 node 时回落到 `os.Executable()`，
   于是命令以 Graph 二进制自身运行并神秘失败。现在找不到就返回空，由调用方给出带说明的错误：
   `No Node.js runtime is available to …; install node, or point GRAPH_APP_NODE at one`。
6. **elkjs 不内嵌。** `elk.bundled.js` 体积数 MB，而它只决定图节点的坐标；缺失时 `layoutElk` 已经
   有完整的 `layoutFallback`。这是**有意的降级**，不是半截实现：`TestTheElkLayoutStaysOptional`
   断言没有 elkjs 时布局仍给出全部子节点与坐标。

## 后果

- App 打包后自洽：presets 与运行时脚本来自二进制本身，空 `HOME`、空 cwd、没有 `ApplicationRoot`
  的机器上行为与开发机一致（验证脚本见 `scripts/verify-bundle-selfcontained.sh`）。
- Agent 的 shell 命令链路**不再需要 Node**。仍需 Node 的执行面只剩两条：`module-worker.mjs`
  （动态 `import` 用户模块的 `evaluate`，真 JS 语义）与 `check-resolver.cjs`（`node --require`
  的解析钩子，它本来就是 Node 的入口）。它们由第 1–3 条兜底：磁盘没有时用内嵌副本，脚本本身
  随二进制走。`extension-worker.mjs` 已删除，扩展由 PiG 的 `ExtensionHost` 承载。
- 少一条协议：Go 与 Go 之间不再需要 60 秒握手、ready/start 两段式与重放；`BeforeStart` 的准入语义
  变成一次普通的函数调用，准入拒绝的命令根本不会被启动（`TestHostCommandDoesNotRunWhenAdmissionRefuses`）。
- 少一个安装项：不再是「装 Graph 还要装 Node 才能让 Agent 跑命令」。`GRAPH_APP_NODE` 仍然有效，
  供扩展/模块那两条执行面用。
- 代价：`backend/internal/graph/embedded/{presets,runtime}` 是仓库根文件的副本。门禁会拦住漂移，
  但同步仍是手工的一次 `cp`（README 里写明要同步哪两个目录）。
- 代价：`presets/bootstrap/master/agent.md` 现在有两份内容来源（磁盘与内嵌）。磁盘优先保证开发者
  改 prompt 不用重新编译；发版时以仓库根那份为准，由门禁保证一致。
