# src/runtime 里只剩 worker 脚本

TypeScript 侧的运行时实现在 `eb5ef9c8` 归档删除（`src/runtime/*.ts`，约 10,900 行）：
守护进程早已由 Go (`graphd`) + PiG 内核承担运行，那些模块只被测试引用。

**这里的 `.mjs` / `.cjs` 不是残留**：它们是 Go 守护进程 fork 出来执行受控工作的脚本，
路径由 Go 侧的资产解析器给出。实测删掉会让图命令与扩展加载静默失败（`go-command-output`、
`go-review-module` 变红，命令 `passed=false`）。

| 脚本 | fork 它的 Go 代码 |
| --- | --- |
| `check-resolver.cjs` | `runtime_workspace_command.go` |
| `module-worker.mjs` | `runtime_module_evaluator.go` |

`extension-worker.mjs` 已删除：扩展由 PiG 内核自己的 `pigkernel.ExtensionHost` 承载
（`runtime_pig_extensions.go`），本仓库没有它的调用者。

`host-command-worker.mjs` 已删除：宿主命令改由 Go 原生执行（`runtime_host_command.go`），
不再需要 Node 与 JSON-over-stdio 握手协议。

这些脚本在磁盘上没有时，daemon 从二进制内嵌副本解压到 `~/.graph/assets/` 使用
（`runtime_assets.go`）。改这里的文件要同步 `backend/internal/graph/embedded/runtime/`，
`go -C backend test ./internal/graph/embedded/` 会逐字节比对并报出不一致的文件。

要动它们之前，先在 `backend/` 里搜文件名。
