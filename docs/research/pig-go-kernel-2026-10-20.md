# Graph 迁移至 PiG（Pi in Go）内核：三项能力核对

调研日期：2026-10-20。目标是判定 [PiG](https://github.com/MichaelKinsy/PiG)（[官网](https://pi-in-go.dev/)）能否替换 Graph 当前的 `@earendil-works/pi-*` 1.1.0 TypeScript 内核，并确定 MCP 与 codemode 的落地方式。三问分别是：PiG 是否有 durable、是否原生支持 MCP、是否支持 codemode。本文只做能力核对与差距分析，未迁移用户数据库，未调用真实模型。

## 权威来源与版本

- PiG 仓库浅克隆于 `/tmp/pig-probe/PiG-src`，HEAD 为 `6dfa6bfa3b6d95896ead8feb438416e3e14f2521`（2026-10-19，`Keep nine data-only directories out of the root module zip, and gate the zip size in CI (#226)`）。最新发布 tag 为 `v0.5.1`（`git ls-remote --tags`）；`v0.5.0` 的 `go.mod` 明确 `retract v0.5.0`，原因是模块源码超过 Go 模块体积上限。
- 模块路径 `github.com/MichaelKinsy/PiG`，`go.mod` 声明 `go 1.26.0`、`toolchain go1.27.2`。作为依赖引入本仓库时，依赖的 `toolchain` 与 `godebug` 行不向下传播，只有 `go` 指令参与约束。
- PiG 的上游 Pi 钉住版本在 `.upstream/pin`：`package_version=1.3.0`，commit `1402973a9dbe8c627341e04c9744c54953e285ca`。PiG 的 durable 对照语料钉住版本另在 `durable/contract/PIN`：release `v1.0.4`，commit `06a466935536f8c9bcacb2d5efc0fc021be1bdff`。
- Graph 当前钉住 `@earendil-works/pi-ai`、`pi-coding-agent`、`pi-durable` 均为 `1.1.0`（`package.json`），MCP 走 `pi-mcp-adapter` 2.38.0 作为 pi 扩展（`src/runtime/mcp-adapter-bridge.ts`）。

**结论速览**：三问均为肯定。durable 与 codemode 是 PiG 的顶层 Go 包，MCP 是 PiG 的内置通道而非扩展。

## 问题一：PiG 是否有 durable

有，且是逐文件对照上游的移植，不是重写。

- `durable/doc.go` 声明该包移植 `@earendil-works/pi-durable` 的根模块，逐条记录 Go 映射决策（Promise 映射为阻塞调用并返回 error、`JsonValue`/`JsonObject` 映射到 chord 的 delta 对象、带品牌标记的数值 ID 映射为不同的具名 int64 类型等）。移植范围含 entry/task/document 类型、ID 类型、错误类、entry kind、文档与任务定义、工具输出截断。
- `durable/harness/` 提供 Harness 层：`OpenHarness(ctx, storage, HarnessOptions)`、`CreateRegistry()`、`DefineExtension`、`DefineTool`、`Section`、`Hook`、`WrapTool`、`AdmitSubmission`、`Configure`、`CreateAgent`。与 Graph 现有 TS 用法（`Harness.open`、`createRegistry`、`defineExtension`、`defineTool`、`section`、`hook`、`wrapTool`、`conversation.submit`）逐项对应。
- `durable/storage/sqlite/` 提供 SQLite 存储：`CreateSqliteSchema(prefix)`、`CreateSqliteMigrations(schema)`、`ApplySqliteMigrations`、`Open(db, options)`。
- `durable/` 共 950 个 Go 文件，含 `session`、`storage`、`env`、`interop`、`toolsearch`、`codemode` 子包，并带 PiG 自有的 conformance 与 oracle 测试。
- PiG 用同一 Pod 内并跑的方式把 PiG durable 与 pi-durable 参考实现做基准对比（`docs/site/docs/benchmarking.md`），参考实现版本就是 PiG 的 Pi 钉住版本。

**与 Graph 直接相关的一个关键差异**：`docs/research/pi-durable-1.1.0.md` 记录过，TS 版 1.1.0 的 `SqliteStorage` 不提供 tablePrefix 参数，Graph 只能自己写命名空间 facade 做 SQL 词法改写（`src/runtime/durable-sqlite.ts`，前缀 `graph_durable_`）。PiG 的 Go 端口**原生支持前缀**：`CreateSqliteSchema(prefix *string)` 对每张表和索引拼前缀，`ValidateSqliteSchemaPrefix` 的规则是 `^[A-Za-z_][A-Za-z0-9_]*$` 且不得以 `sqlite_` 开头。`graph_durable_` 满足该规则，所以 Go 侧宿主可以直连同一份命名空间表，不需要 SQL 改写层。

**版本落差**：Graph 钉的是 Pi 1.1.0，PiG 钉的是 Pi 1.3.0。durable 的 schema 版本位于 `durable_schema` 表，PiG 迁移器会在打开时按 `CreateSqliteMigrations` 升级命名空间内的表结构。1.1.0 与 1.3.0 之间 durable schema 与运行语义的实际差异，本文未逐条核对，属未验证项。

## 问题二：PiG 是否原生支持 MCP

是。PiG 把 MCP 做进内核通道，不需要扩展。

- `mcp/` 是顶层包：`transport.go`（stdio 与可流式 HTTP 传输）、`auth_provider.go`、`oauth/`（`discovery.go`、`flow.go`、`provider.go`、`callback.go`、`types.go`），覆盖 OAuth 发现、授权码流程、回调服务与凭据存储。
- 官方文档 `docs/site/docs/mcp.md` 说明连接方式为 stdio 或 streamable HTTP，并把服务器的工具与资源暴露给模型；`pig mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .`、`pig mcp list` 为标准用法；`/mcp` 在会话内查看连接、登录、重连、调整暴露度。
- 配置文件为 `~/.pig/agent/mcp.json`（用户级）与 `.pig/mcp.json`（项目级），项目级配置需要先授予项目信任；同名条目由项目级覆盖用户级。格式与其他 MCP 客户端一致（`mcpServers` + `command`/`args` 或 `url`/`headers`/`env`）。
- MCP 工具与 `codemode`、`tool_search` 一起作为 Go 内置扩展提供，`docs/site/docs/codemode.md` 记录 `mcp` 扩展会在 MCP 服务器需要时开启对应工具。

**对 Graph 的直接含义**：当前 `pi-mcp-adapter` 扩展（`src/runtime/mcp-adapter-server.ts`、`src/runtime/mcp-adapter-bridge.ts`、`backend/internal/graph/runtime_mcp_adapter_server.go`）及其运行时注册事件 `pi-mcp-adapter:runtime-register:v1` 可以整体退役，MCP 改由 PiG 内核直接注册。这同时消掉当前"Node 插件进程持连接、Go 侧只持定义"的跨进程边界。

## 问题三：PiG 是否支持 codemode

是，且是内核内置工具。

- `codemode/` 是顶层包：`run.go`、`execution.go`、`sandbox.go`、`engine_hostimport.go`、`haltcheck.go`、`jsvalue.go`，含 QuickJS 的 WebAssembly 装载、宿主 prelude、sandbox 快照、作业轮询与生命周期管理；沙箱有内联与远程两种形态（`NewInlineSandbox`、`NewRemoteSandbox`）。
- 官方文档 `docs/site/docs/codemode.md`：模型写一段 JavaScript 调用其他工具，脚本在 QuickJS（编译为 WebAssembly）上由 wazero 在 `pig` 进程内执行，不需要 Node；沙箱无 Node API、无文件系统、无网络、无计时器，只能通过授予的工具与 `models` 触达外部。
- `codemode` 与 `tool_search` 是两个 Go 内置扩展，默认关闭，可用 `--tools +codemode` 或 `settings.json` 的 `defaultTools` 开启；`tool_search` 检索未声明给模型的工具（如 MCP 工具）并在下一次调用时声明匹配项。

## Go 依赖可行性实测

- 在临时模块中执行 `go get github.com/MichaelKinsy/PiG@v0.5.1` 成功（首次因代理中断报 `unexpected EOF`，重试成功）。模块 zip 较大，下载需要重试，这是"一键更新"必须处理的情况。
- 本机 `go version go1.27.1 darwin/arm64`。以 `durable`、`durable/harness`、`durable/storage/sqlite`、`mcp`、`codemode` 五个包编译探针通过，链接期拉入 `modernc.org/libc v1.73.4` 等依赖；Graph 后端已使用 `modernc.org/libc` 与 `modernc.org/sqlite`，驱动栈一致。
- 引入 PiG 会把本仓库 Go 依赖树扩大到包含 `cloud.google.com/go/compute`、charmbracelet 终端库等；这是依赖体积与供应链面扩大的事实，需要在 ADR 中记录。

## 差距与迁移影响

| 维度 | 现状（TS 1.1.0 + Node 宿主） | 迁移后（PiG Go 内核） |
| --- | --- | --- |
| 内核语言 | TypeScript，`src/runtime/durable-*.ts` 约 3200 行，由 Node 侧车进程承载 | Go，`backend/` 内直接链接 PiG `durable/` |
| 宿主进程 | `graphd` 拉起 `node src/runtime/durable-service.ts`，Unix socket 传话 | Go 宿主进程内运行，可保留同一 socket 协议以实现灰度切换 |
| durable 表 | `graph_durable_` 前缀 + SQL 词法改写 | `graph_durable_` 前缀 + PiG 原生 schema 前缀，同表 |
| Pi 版本 | 1.1.0 | 1.3.0（PiG 钉住版本） |
| MCP | `pi-mcp-adapter` 扩展，跨进程注册 | PiG 内核原生通道，删除扩展 |
| codemode | 无 | 内置 `codemode` + `tool_search` |
| pi 扩展（用户插件） | Node worker 加载 TS 扩展 | 需另行设计（PiG 扩展为 Go/Rust/Python/Node 资源） |

**必须诚实说明的未验证项**：PiG 的 pi 扩展模型与 Graph 现用的"沙箱内加载 TS pi 扩展并暴露 tool/hook"形态并不等价，`src/runtime/durable-plugin-worker.mjs` 支持的 17 类 hook 与 `beforeTool`/`afterTool` 拦截在 PiG 侧的对应能力尚未逐条核对。这是本次迁移最大的不确定性，不是三项能力核对能覆盖的部分。

## 结论

三问全部为肯定，可以切换：PiG 提供 durable 内核（`durable/`）、原生 MCP（`mcp/` + `mcp.json`）与 codemode（`codemode/`），且作为 Go 模块可直接引入本仓库并在本机 Go 1.27.1 上编译通过。迁移同时应删除内置的 `pi-mcp-adapter` 扩展，MCP 全部走 PiG 原生通道。

迁移按可回退的灰度路径执行：Go 侧宿主保持与现有 Unix socket 协议一致，先让 Go 宿主接管同一份 `graph_durable_` 命名空间的 durable 存储，再逐段替换 Node 宿主行为；Pi 版本 1.1.0 → 1.3.0 的 schema 与语义差异、pi 扩展模型差异，需要各自的验收证据，不能由本文的结论推定。

关联：[ADR 0031](</../adr/0031-pi-durable-agent-kernel.md>)、[ADR 0032](</../adr/0032-go-backend-shared-durable-host.md>)、[pi-durable 1.1.0 调研](</pi-durable-1.1.0.md>)。
