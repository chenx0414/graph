# Pi 系统自我感知机制研究（2026-09-19）

## 研究范围

- 上游源码固定到 `earendil-works/pi` `main` 的 commit `e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe`（2026-09-18）。
- Graph 当前本地安装版本是 `@earendil-works/pi-coding-agent@0.85.1`，对应 tag commit `d981de1229ef899957bbe968bc8dcda02a21f477`。
- 本地副本路径：`node_modules/@earendil-works/pi-coding-agent`、`node_modules/@earendil-works/pi-agent-core`、`node_modules/@earendil-works/pi-ai`。
- 本报告只使用 Pi 仓库源码、README、docs、类型与 tool definition，以及本地 `node_modules` 副本；不把 Pi 的 observation 能力外推成不存在的自动自我修改能力。

## 结论

Pi 没有让模型“天生知道自己”。它采用的是三层机制：

1. 宿主根据真实运行状态构造 system context，把项目规则、工具清单、Skill 摘要、文档路径、工作目录等投影给模型。
2. Extension API提供 `getSystemPrompt()`、`getAllTools()`、`getCommands()`、session/model/context usage 等自省接口，但这些接口默认是宿主侧的 extension API，不是模型可直接调用的 introspection tools。
3. 如果希望模型直接查询自身状态，需要 extension 把安全、经过裁剪的宿主事实注册成 custom tool；Pi 官方示例展示了这种模式。

因此，Pi 的“自我感知”主要由 **事实投影 + 文档指针 + shell 会话元数据 + 可选 custom introspection tool** 组成，而不是一个内建 `inspect_self` 工具。

## 1. System context 中注入了什么

| 事实 | Pi 的行为 | 主要来源 |
|---|---|---|
| Agent 基础身份 | 默认 prompt 说明当前运行在 Pi coding-agent harness；自定义 prompt 可替换默认前缀 | [`system-prompt.ts` L120-L160][pi-system-prompt] |
| 当前可见工具 | 仅列出被选中且提供 `promptSnippet` 的工具；没有 snippet 的 custom tool 不进入 `Available tools` | [`system-prompt.ts` L142-L160][pi-system-prompt]，[`types.ts` L451-L462][pi-extension-types] |
| 工具规则 | 根据 active tools 选择文件工具规则，并追加工具或宿主提供的 guideline | [`system-prompt.ts` L81-L118][pi-system-prompt-rules] |
| Pi 自身文档入口 | 注入 README、docs、examples 的绝对路径，并指示仅在用户询问 Pi 本身、SDK、extension、Skill 等时读取 | [`system-prompt.ts` L153-L160][pi-system-prompt] |
| 宿主追加 prompt | `APPEND_SYSTEM.md`、CLI append prompt 或 SDK `appendSystemPrompt` | [`resource-loader.ts` L515-L545][pi-resource-loader] |
| 项目指令 | 载入全局和 cwd/祖先目录的 `AGENTS.override.md`、`AGENTS.md`、`CLAUDE.md`，以 XML 包裹 | [`resource-loader.ts` L71-L157][pi-context-files]，[`system-prompt.ts` L72-L78][pi-system-prompt-project] |
| Skill 摘要 | 只常驻 `name`、`description`、`location`；完整 `SKILL.md` 需要模型按需读取 | [`skills.ts` L347-L382][pi-skills-format] |
| 工作目录 | 将当前 `cwd` 注入 prompt | [`system-prompt.ts` L165-L170][pi-system-prompt] |
| 模型与 session | 默认不把 model/provider/session ID 写进 prompt；bash/powershell 工具可通过 `PI_*` 环境变量观察 | [`environment-variables.md` L20-L49][pi-env]，[`bash.ts` L175-L195][pi-bash-env] |

当前上游把 prompt 表示为可独立 diff 的 section，例如 `preamble`、`tools`、`rules`、`docs`、`project_context`、`skills`、`cwd`。当 extension 在 `before_agent_start` 修改 prompt 时，Pi 可以只追加发生变化的 section，而不是每次重发完整 prompt。[`system-prompt.ts` L120-L180][pi-system-prompt]、[`agent-session.ts` L1115-L1128][pi-agent-session-prompt]

## 2. 自省工具与 API 如何暴露

### 模型默认看到什么

Pi 内建可执行工具集合是 `read`、`bash`、`powershell`、`edit`、`write`、`grep`、`find`、`ls`。[`tools/index.ts` L93-L105][pi-built-in-tools]

其中没有通用的 `inspect_system`、`list_capabilities` 或 `read_session_metadata` 工具。模型主要通过以下方式获得运行事实：

- system prompt 中的工具、Skill、项目指令、cwd 和文档路径；
- 通过 `read`/`bash` 主动读取文档或 shell 环境变量；
- 由 extension 注册的 custom tool。

### Extension 可读的宿主事实

Pi 把这些信息暴露给 extension runtime：

- `ctx.getSystemPrompt()`：当前有效 system prompt。
- `before_agent_start` 的 `event.systemPromptOptions`：构造 prompt 的可变结构化输入。
- `ctx.getSystemPromptOptions()`：命令上下文中的基础 prompt 输入。
- `pi.getActiveTools()`：当前 active tool names。
- `pi.getAllTools()`：所有已配置工具的 `name`、`description`、`parameters`、`promptGuidelines`、`sourceInfo`。
- `pi.getCommands()`：extension commands、prompt templates、skill commands。
- `ctx.model`、`ctx.modelRegistry`、`ctx.scopedModels`、`ctx.thinkingLevel`。
- `ctx.sessionManager`、`ctx.getContextUsage()`。

来源：[`types.ts` L309-L348][pi-extension-context]、[`types.ts` L717-L727][pi-before-agent-start]、[`types.ts` L1667-L1672][pi-tool-info]、[`extensions.md` L1005-L1084][pi-introspection-docs]、[`extensions.md` L1580-L1605][pi-commands]、[`agent-session.ts` L960-L975][pi-agent-session-tools]。

这些 API 是给 extension 代码调用的。模型不会自动获得 `getAllTools()` 的返回结果，除非 extension 将结果投影到 system prompt，或注册一个 custom tool 代为调用。

Pi 示例 `system-prompt-header.ts` 用 `ctx.getSystemPrompt()` 读取当前 prompt；Dynamic Tool Loading 示例则把注册但暂未启用的工具通过搜索工具暴露给模型，并在匹配后调用 `pi.setActiveTools()` 激活它们。[`system-prompt-header.ts` L1-L16][pi-system-prompt-example]、[`extensions.md` L2385-L2495][pi-dynamic-tools]

### Shell 会话元数据

`bash` 和 `powershell` 工具会注入：

- `PI_SESSION_ID`
- `PI_SESSION_FILE`
- `PI_PROVIDER`
- `PI_MODEL`
- `PI_REASONING_LEVEL`

文档明确要求模型在询问“当前使用哪个模型或 provider”时检查这些变量，而不是从 system prompt 猜测。[`environment-variables.md` L20-L49][pi-env]

## 3. Extensions、Skills、MCP 的发现与描述

### Skills

- 发现来源包括全局、项目、Pi package、settings 和 CLI path；项目资源要经过 project trust。
- 目录中包含 `SKILL.md` 时按 Skill 处理，并递归发现；部分顶层 `.md` 也可作为单个 Skill。
- 模型常驻看到的是 XML `<available_skills>`，每项只有 name、description、location。完整内容由模型按需读取，属于 progressive disclosure。
- `disable-model-invocation: true` 会让 Skill 从 system prompt 隐藏，只能显式调用。

来源：[`skills.md` L20-L72][pi-skills-docs]、[`skills.ts` L160-L170][pi-skills-discovery]、[`skills.ts` L347-L382][pi-skills-format]。Pi 还提供 `resources_discover` event，允许 extension 在 startup/reload 时追加 skill/prompt/theme paths；该 hook 不接受 extension 或 MCP 路径。[`extensions.md` L370-L387][pi-resources-discover]、[`types.ts` L545-L557][pi-resources-types]

### Extensions

- 从 global/project 目录、settings、npm/git/local package 或 CLI path 发现。
- 项目本地 extension 只有在 project trust 后才加载；extension 代码拥有完整系统权限。
- extension 通过 `pi.registerTool()` 注册模型可调用工具；工具必须有 description 和参数 schema。
- `promptSnippet` 决定是否进入 `Available tools`，`promptGuidelines` 为 active tool 追加规则。
- `pi.registerTool()` 可在启动后动态执行；`pi.setActiveTools()` 立即改变 active tool 集合。Pi 会把工具变更写入 transcript/system state，使模型后续请求看到新的 loadout。

来源：[`extensions.md` L109-L137][pi-extension-locations]、[`extensions.md` L1385-L1397][pi-register-tool]、[`types.ts` L448-L500][pi-tool-definition]、[`extensions.md` L1697-L1723][pi-tool-management]、[`extensions.md` L2385-L2495][pi-dynamic-tools]。

### MCP

Pi core 明确没有内建 MCP，也没有内建 subagents。MCP 必须由 extension/package 提供；Pi 本身只负责加载 extension 并暴露 extension 注册的 tools。[`README.md` L497-L507][pi-readme-limits]、[`README.md` L387-L400][pi-extension-capabilities]。

因此，MCP 的发现和描述必须由 MCP bridge extension 完成。模型能看到的内容取决于 bridge 如何映射 MCP tool schema、description，以及是否再提供 prompt snippet/guideline。Pi 没有一层原生 MCP capability inventory 会自动注入。

## 4. Graph 可安全借鉴的模式

### 4.1 用“运行时事实快照”取代记忆推断

提供一个只读、结构化、可裁剪的 system snapshot tool，返回当前真实状态：主要 Agent 定义与版本、能力包 digest、已绑定能力和加载结果、可用工具与 schema 摘要、模型/provider/thinking、项目与权限状态、session、预算和 usage source。Pi 的关键模式是“从当前有效配置构造上下文”，而不是让模型根据历史聊天声称某能力存在。

Graph 已有 `read_system_capabilities`、`search_resources`、`get_resource` 和 [`capabilityPrompts()`](../../src/runtime/capabilities.ts#L729) 生成的权威 `tool.md` inventory，可以扩展它们，而不是另建一套事实来源。

### 4.2 自省 API 必须同时有“宿主接口”和“模型工具”

Pi 的 extension API 能读 prompt、tools、commands、session 和 model，但模型默认不能直接调用这些 API。Graph 若要让 Main Agent 自主感知，应提供模型可调用的 read-only tools，例如：

- `read_system_state`：获取当前运行事实；
- `search_capabilities` / `get_capability`：渐进式查看能力摘要和详情；
- `explain_capability_availability`：说明未配置、缺凭据、未授权或 fail-closed 的原因；
- `propose_system_change`：只生成待批准变更，不直接写入。

这样可以把“观察”留在模型层，把真实权限和副作用留在宿主层。

### 4.3 分层披露，不把全部内容塞进 prompt

Pi 对 Skill 采用“摘要常驻、正文按需读取”。Graph 可沿用同一原则：

- system prompt 只包含稳定、简短的能力名称、用途、状态和最少量选择规则；
- 详细 schema、Skill 正文、MCP 工具列表和配置要求通过工具按需读取；
- full prompt、`AGENTS.md` 内容、凭据值和用户路径只在宿主内部使用，不暴露给不必要的模型上下文。

Pi 文档也明确提醒 `ctx.getSystemPromptOptions()` 可能包含完整 context file 内容，应视为敏感 extension-local data。[`extensions.md` L1124-L1135][pi-prompt-options]

### 4.4 能力发现不等于授权

Pi 的 project trust 只控制是否加载项目本地资源；extension tool 是否 active、是否出现在模型请求中又是另一层状态。Graph 已有更强的 capability binding、task grant、MCP grant 和 send gate 边界，应继续保持：

- 扫描到能力不等于绑定；
- 绑定能力不等于授权工具调用；
- 自省结果必须同时展示 `available`、`loaded`、`executable`、`needs_configuration`、`permission_required` 等不同事实。

Graph 的现有约束见 [`ADR 0011`](../../docs/adr/0011-isolated-pi-process-capability-bundles.md)、[`ADR 0012`](../../docs/adr/0012-filesystem-capability-library.md)、[`ADR 0013`](../../docs/adr/0013-capability-declared-mcp-network.md)。

### 4.5 自我优化拆成可审计的两阶段

Pi 提供 observation hooks、动态工具注册和 reload 机制，但源码中没有定义一个自动发现自身缺陷并直接修改配置的闭环。安全适配方式应是：

1. 从真实运行事件中发现系统问题，例如能力加载失败、凭据缺失、工具调用反复失败、版本不兼容。
2. 生成带证据的 `system finding` 和候选修复方案。
3. 向用户展示影响、风险和所需权限，取得明确批准。
4. 由宿主 API 执行变更，然后重新加载、验证可用性并记录结果。

这保留了“Main Agent 主动发现问题”的价值，又避免把能力文件当普通项目文件直接改写。Main Agent 是否绑定项目不应成为读取自身运行配置的前提；但修改系统配置仍应是独立、审计化的能力。

## 明确不存在的 Pi 行为

- 没有内建 MCP server discovery；MCP 由 extension/package 提供。
- 没有内建 subagent orchestration；由外部进程、tmux 或 extension 实现。
- 没有默认模型可调用的 self-introspection tool；宿主 API 必须先被 extension 包装。
- 没有自动修改自身 prompt、tools、extensions 或 MCP 配置的自优化闭环。
- 项目本地资源和 extension 在 project trust 前不会正常加载。

## 主要来源

- Upstream `main` commit：[`e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe`](https://github.com/earendil-works/pi/commit/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe)
- Local installed package：`node_modules/@earendil-works/pi-coding-agent`
- Local installed version：`0.85.1`，tag commit `d981de1229ef899957bbe968bc8dcda02a21f477`

[pi-system-prompt]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/src/core/system-prompt.ts#L120-L180
[pi-system-prompt-rules]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/src/core/system-prompt.ts#L81-L118
[pi-system-prompt-project]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/src/core/system-prompt.ts#L72-L78
[pi-resource-loader]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/src/core/resource-loader.ts#L515-L545
[pi-context-files]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/src/core/resource-loader.ts#L71-L157
[pi-skills-format]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/src/core/skills.ts#L347-L382
[pi-skills-discovery]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/src/core/skills.ts#L160-L170
[pi-skills-docs]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/docs/skills.md#L20-L72
[pi-env]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/docs/environment-variables.md#L20-L49
[pi-bash-env]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/src/core/tools/bash.ts#L175-L195
[pi-built-in-tools]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/src/core/tools/index.ts#L93-L105
[pi-extension-context]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/src/core/extensions/types.ts#L309-L348
[pi-before-agent-start]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/src/core/extensions/types.ts#L717-L727
[pi-tool-info]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/src/core/extensions/types.ts#L1667-L1672
[pi-extension-types]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/src/core/extensions/types.ts#L451-L462
[pi-tool-definition]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/src/core/extensions/types.ts#L448-L500
[pi-resources-types]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/src/core/extensions/types.ts#L545-L557
[pi-introspection-docs]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/docs/extensions.md#L1005-L1084
[pi-commands]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/docs/extensions.md#L1580-L1605
[pi-prompt-options]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/docs/extensions.md#L1124-L1135
[pi-extension-locations]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/docs/extensions.md#L109-L137
[pi-register-tool]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/docs/extensions.md#L1385-L1397
[pi-tool-management]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/docs/extensions.md#L1697-L1723
[pi-dynamic-tools]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/docs/extensions.md#L2385-L2495
[pi-resources-discover]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/docs/extensions.md#L370-L387
[pi-readme-limits]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/README.md#L497-L507
[pi-extension-capabilities]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/README.md#L387-L400
[pi-system-prompt-example]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/examples/extensions/system-prompt-header.ts#L1-L16
[pi-agent-session-tools]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/src/core/agent-session.ts#L960-L975
[pi-agent-session-prompt]: https://github.com/earendil-works/pi/blob/e4ce7b449f4d91589c8760d6fbfa6eaaf82b05fe/packages/coding-agent/src/core/agent-session.ts#L1115-L1128
