# Graph Capabilities

Graph 的“能力”是版本化、可绑定的外部工具或指令资源。能力安装不等于扩权；Agent definition 绑定能力后，其已发现工具默认可在现有沙箱和任务边界内调用。

## 能力类型

### Skill

Skill 是一组按需读取的指令和资源，通常包含 `SKILL.md`。System prompt 只应提供 skill 的名称、描述和绝对路径；模型需要时再读取正文。

### MCP

MCP server 可以是本地 stdio 进程，也可以是远程 HTTP 服务。Graph 负责连接、工具发现、调用门、网络域、错误和清理。远程 MCP 在只读讨论阶段可能不加载。

### Graph Extension

Graph extension 由受限 worker 加载，按最小 `register(api)` 接口暴露工具。它仍经过 Graph 调用 gate。

### Pi Extension

Pi extension 可以注册工具和生命周期 hook。Graph 只在定义的 capability bundle 中加载已绑定 extension，并把允许的 tool 名称加入 Agent session。

### Prompt

Prompt capability 可以充当 identity 或 tool guidance。用户可编辑版本位于 `.graph/prompts`；definition 中绑定的 prompt 仍是版本化能力。

## Tool surface

一个 Agent 的实际 tool surface 由以下来源合并：

1. Pi 原生 coding tools：`read`、`bash`、`edit`、`write`、`ls`、`find`、`grep`，以及 Windows 上的 `powershell`；
2. role 对应的 Graph host tools；
3. definition 绑定的 capability tools；
4. Pi extension 注册且允许的 tools；
5. 当前 operation 的 pause、access policy 和 disabled-tool policy。

模型可见的 `<tools>` 文本和 provider 的可执行 tool schema 必须来自同一个实际启用集合。关闭工具时，两者都应移除。

`<tools>` 先以简洁的 Pi 风格条目列出原生 coding tools，再以过渡段引出 Graph tools。参数、版本、权限摘要等详细元数据保留在 UI 工具详情和宿主运行时中，不重复注入 system prompt。

Main Agent 在完全访问模式下额外获得 `inspect_rsi_status` 与 `apply_rsi_change`，用于直接修改 Graph Harness——修缺陷、重构、新增功能、改进命令或文档都可以。它们只注册给 `master` 角色，不进入 worker 或 reviewer 的 tool surface。见 [self-configuration.md](self-configuration.md) 的“Harness 自我改进（RSI）”。

Pi 原生工具在 Pi 子进程内执行。默认 full 模式放开宿主文件系统、命令、网络和能力运行时；standard 模式才启用 Graph send gate 与 workspace sandbox。Graph 的旧 `read`、`write_file`、`list_dir`、`run_command` 与原生工具同名或职责重复时，启用原生工具会让它们退出实际 session，避免 custom tool 覆盖 Pi 原生实现。

## Capability binding

Agent definition 引用精确 `id@version`。恢复 session 时核对 capability/bundle/runtime digest；不一致 fail closed，不能自动绑定“最新版”。

## 网络和运行边界

- 标准模式下，本地 MCP 的 provisioning 网络与 runtime 网络分离，runtime 网络由 capability manifest 声明，extension 没有自动网络权限，命令、MCP 和工具仍在 OS sandbox 内运行。
- 完全访问模式下，网络、MCP、extension 和宿主文件系统限制不阻止调用；能力清单仍用于发现、版本与审计。
- Native bash/powershell 在 standard 模式下不能越过 workspace、受保护路径和宿主访问策略。
- `networkDomains`、工具自报 annotation 或 MCP 描述都不是权限本身。

## 发现与诊断

- `search_resources`：搜索能力库，只用于发现。
- `get_resource`：读取一个能力 metadata；不等于绑定。
- `read_system_capabilities`：读取模型、订阅、配方和 definition 等配置事实。
- `inspect_graph_system`：只读取当前 conversation 的运行健康，包括无效能力、失败节点、开放问题和待处理系统变更。
- `get_graph_state`：读取当前 graph revision、phase、nodes、evidence、worktrees 和内部问题。
- `list_projects` / `bind_project`：列出配置项目并把当前 conversation 绑定到已准备项目。
- Node run：查看某实例实际加载的 capability facts 和 tools。

当用户问“为什么没有某个工具”时，先检查 definition 是否绑定、capability 是否有效、实际 session 是否加载，以及 host policy 是否禁用；不要根据历史对话推断。
