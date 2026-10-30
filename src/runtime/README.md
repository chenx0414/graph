# src/runtime 里只剩 worker 脚本

TypeScript 侧的运行时实现在 `eb5ef9c8` 归档删除（`src/runtime/*.ts`，约 10,900 行）：
守护进程早已由 Go (`graphd`) + PiG 内核承担运行，那些模块只被测试引用。

**这里的 `.mjs` / `.cjs` 不是残留**：它们是 Go 守护进程 fork 出来执行受控工作的脚本，
路径写死在 Go 侧。实测删掉会让图命令与扩展加载静默失败（`go-command-output`、
`go-review-module` 变红，命令 `passed=false`）。

| 脚本 | fork 它的 Go 代码 |
| --- | --- |
| `check-resolver.cjs` | `runtime_workspace_command.go` |
| `extension-worker.mjs` | `runtime_capability_connections.go` |
| `host-command-worker.mjs` | `runtime_host_command.go` |
| `module-worker.mjs` | `runtime_module_evaluator.go` |

要动它们之前，先在 `backend/` 里搜文件名。
