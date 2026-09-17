# Pi SDK 子 Agent 能力注入研究

研究日期：2026-09-17
研究分支：`feat/app-ux`（研究开始时 HEAD `62583094`）
研究对象：仓库锁定的 Pi `0.85.1`，不是笼统的 “Pi main”

## 结论摘要

1. Pi SDK 的核心单位是**单个 AgentSession**。它把 `pi-ai` 的模型流、`pi-agent-core` 的有状态 Agent、`SessionManager` 的持久化，以及 `ResourceLoader` 提供的能力资源组合在一起。[SDK 文档](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md#L46-L68)、[SDK 源码](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/sdk.ts#L173-L189)
2. Pi 不内置 subagent 编排，也没有 `parentAgent / createSubagent` 之类的公开对象模型。独立 Agent 由多次 `createAgentSession()` 创建；官方 subagent 示例更进一步，用独立 `pi` 子进程实现上下文隔离。[Pi README](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/README.md#L495-L501)、[Subagent 示例](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/examples/extensions/subagent/README.md#L1-L12)
3. 能力可以**按会话注入**，但没有一个统一的 “capability bundle” API。公开装配点是 `ResourceLoader`、`customTools`、`tools/excludeTools`、`systemPrompt/appendSystemPrompt`。Skill、Pi extension、prompt 和 tools 都有对应入口；MCP 没有内建入口，必须由 Graph 适配成 extension 或 custom tools。[SDK 文档](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md#L48-L64)、[Pi README](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/README.md#L497-L501)
4. `agent.md` 身份认知可以通过 system prompt 注入；`tool.md` 能力感知是 **Graph 的约定**，Pi 不会自动生成或识别名为 `tool.md` 的文件。Pi 能自动追加 skill 描述，并能通过 `promptSnippet/promptGuidelines` 自动描述 active tools，但在使用自定义 system prompt 时，后两者不会自动进入自定义 prompt，需要 Graph 自己拼装或显式追加。[System prompt 源码](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/system-prompt.ts#L28-L73)、[Tool prompt metadata](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/types.ts#L451-L461)
5. “按会话”是逻辑隔离，不等于安全隔离。Pi extension 以宿主进程权限执行；cwd、`agentDir`、prompt 和 tool allowlist 都不能替代 OS sandbox。[扩展安全说明](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/extensions.md#L42-L50)、[Pi README](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/README.md#L503-L505)
6. 对 Graph 而言，正确抽象是版本化 `CapabilityBundle`，并在每个活跃 Agent 实例打开时构造**独立 ResourceLoader + 独立 SessionManager + 精确 tools allowlist**。不要跨并发 Agent 共享同一个 ResourceLoader/extension runtime；session JSONL 不保存能力绑定，恢复时必须按原定义版本重新装配。[Session context 源码](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/session-manager.ts#L461-L469)、[AgentSession extension runtime 源码](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts#L2788-L2806)

## 版本与资料基线

| 来源 | 锁定内容 | 本地材料 |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent` | `0.85.1` | `node_modules/@earendil-works/pi-coding-agent`；公开 `d.ts` 入口见 `dist/index.d.ts:3-24` |
| `@earendil-works/pi-agent-core` | `0.85.1` | `node_modules/@earendil-works/pi-agent-core`；Agent API 见 `dist/agent.d.ts:4-121` |
| `@earendil-works/pi-ai` | `0.85.1` | `node_modules/@earendil-works/pi-ai` |
| 仓库依赖 | 三个包均精确锁定 `0.85.1` | `package.json:43-47`、`pnpm-lock.yaml:188-200` |
| 官方源码 | `v0.85.1` tag 指向 commit `d981de1229ef899957bbe968bc8dcda02a21f477` | `git ls-remote` / GitHub API 核对；本报告 GitHub 链接固定到该 commit |

本文优先引用两类材料：

1. 固定到 `v0.85.1` commit 的官方 README、docs、examples 和源码。
2. 本机实际安装包的 `package.json`、`.d.ts` 与已安装官方材料。

## 1. Pi SDK 的 Agent / Session 模型

### 1.1 三层职责

| 层 | 公开职责 | 不含什么 |
| --- | --- | --- |
| `@earendil-works/pi-ai` | 统一模型/provider、消息上下文、tool schema、流式事件、usage | 不含 Pi Skill、ResourceLoader、SessionManager、subagent 编排 |
| `@earendil-works/pi-agent-core` | 有状态 `Agent`：systemPrompt、model、thinking、tools、messages、tool loop、steer/followUp、abort | 稳定层不负责文件会话持久化、Skill/extensions/MCP 发现或父子 Agent 关系 |
| `@earendil-works/pi-coding-agent` | `AgentSession`：持久化会话、资源加载、模型/thinking、compaction、extension runtime、工具注册 | 不提供内建 MCP client，也不提供内建 subagent 编排 |

依据：

- `Agent` 是“当前 transcript + 工具执行 + 队列”的有状态包装器，见 [Agent 源码](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L169-L205)。
- `createAgentSession()` 的文档明确定义为“single `AgentSession`”；一个 session 管理生命周期、消息历史、模型状态、compaction 和事件流，见 [SDK 文档](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md#L46-L68)。
- `AgentSession` 的公开操作包括 `prompt/steer/followUp/subscribe`、`setModel/setThinkingLevel`、`compact`、`abort`、`dispose`，见 [SDK 文档](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md#L70-L111)。

### 1.2 独立 Agent 如何表示、创建与运行

Pi 没有 “Agent registry” 或父子节点对象。每个独立 Agent 的推荐表示是：

```text
Graph AgentInstance
  -> 一个 SessionManager / session JSONL
  -> 一个 AgentSession
  -> 一个底层 Agent state
  -> 一组该会话实际装配的 ResourceLoader 资源与 tools
```

创建多个独立 Agent 的最小方式是多次调用 `createAgentSession()`；每次都能提供不同的 `cwd`、`agentDir`、model、tools、customTools、ResourceLoader、SessionManager 和 SettingsManager。公开选项见 [SDK `CreateAgentSessionOptions`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/sdk.ts#L20-L72)。

运行方式是对每个 session 分别调用 `prompt()` 或 `continue()`，并订阅各自的 `AgentSessionEvent`。事件的 session 归属来自具体 `AgentSession.subscribe()`，不是全局事件总线。[SDK 文档](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md#L66-L81)

### 1.3 恢复与隔离边界

Pi 的持久化单位是单个 session JSONL：

- `SessionManager.create(cwd)`：新会话。
- `SessionManager.open(path)`：打开指定会话。
- `SessionManager.continueRecent(cwd)`：继续最近会话。
- `SessionManager.inMemory()`：不落盘；也可从外部 entries 恢复。

公开 API 见 [Session 示例](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/examples/sdk/11-sessions.ts#L9-L43) 与 [SessionManager d.ts](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/session-manager.ts#L1551-L1601)。

`AgentSessionRuntime` 负责当前运行时的 `/new`、`/resume`、`/fork`、import 替换，但它仍然只有“当前一个 `session`”这一模型，不是多 Agent 调度器。[SDK 文档](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md#L114-L167)

关键限制：

- Session 恢复会还原 messages、model、thinking level；**不会保存或还原 ResourceLoader、Skills、MCP、Pi extensions 与 capability binding**。依据是 `buildSessionContext()` 只返回 `messages/thinkingLevel/model`，见 [源码](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/session-manager.ts#L456-L469)。
- 不同 `Agent` 的 messages/tools/systemPrompt 状态相互独立；但如果不提供隔离的 cwd、agentDir、ResourceLoader 或进程，它们仍可能看到同一组全局/project 资源。
- `cwd` 影响 project-local discovery 和 built-in tool 路径解析，但不等于 OS sandbox。官方 subagent 示例为了“isolated context”使用独立 `pi` process，见 [示例说明](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/examples/extensions/subagent/README.md#L1-L12)。

### 1.4 官方 subagent 示例代表什么

官方 subagent 是一个 **extension 示例**，不是 Pi 内建子系统。它：

- 为每次调用 `spawn()` 一个独立 `pi` 进程；
- 使用 `--mode json -p --no-session`；
- 将 agent markdown body 写到临时文件，再用 `--append-system-prompt` 注入；
- 用 `--tools` 限工具、用 `--model/--thinking` 继承或覆盖模型配置；
- 在父 extension 中负责 single/parallel/chain 调度和结果汇总。

见 [subagent index.ts](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/examples/extensions/subagent/index.ts#L300-L350)、[agent discovery](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/examples/extensions/subagent/agents.ts#L128-L153)、[agent definition 格式](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/examples/extensions/subagent/README.md#L125-L146)。

它的 agent frontmatter 只演示了 `name/description/tools/model` 和 systemPrompt body；没有“capability bundle”字段。若 Graph 要区分 skills、MCP、extensions 与 prompts，必须由 Graph 生成子进程环境或使用 SDK 自定义 ResourceLoader。

## 2. 能力注入支持矩阵

| 能力 | 公开 SDK 入口 | 作用域 | 是否可按 AgentSession 隔离 | 关键限制 |
| --- | --- | --- | --- | --- |
| Skills | `DefaultResourceLoader.additionalSkillPaths`、`noSkills`、`skillsOverride`；也可实现自定义 `ResourceLoader.getSkills()` | ResourceLoader -> AgentSession | 是 | Skill 是 prompt + on-demand 文件资源，不是权限沙箱 |
| MCP | 无内建 MCP server API；通过 `customTools` 或 Pi extension `registerTool()` 适配 | Graph 适配层 + AgentSession tools | 是，但由 Graph 自己实现 | MCP 连接、认证、授权、计量和进程限制都要 Graph 负责 |
| Pi extensions | `additionalExtensionPaths`、`extensionFactories`、`noExtensions`、`extensionsOverride` | ResourceLoader -> AgentSession | 逻辑上是 | Extension 可执行任意宿主代码；不是安全隔离 |
| Agent identity prompt | `ResourceLoader.systemPrompt` / `systemPromptOverride`；`appendSystemPrompt` | AgentSession system prompt | 是 | 自定义 prompt 会改变 Pi 默认自动拼装行为 |
| Capability awareness `tool.md` | Graph 生成后放入 system/append prompt，或使用 `promptSnippet/promptGuidelines` | AgentSession system prompt | 是 | Pi 不识别 `tool.md` 这个文件名；custom prompt 下不会自动附加 tool metadata |
| Per-session tools | `customTools` + `tools/excludeTools`；运行时 `setActiveToolsByName()` | AgentSession | 是 | `tools` 只过滤可调用工具，不等于阻止已加载 extension 的 hook 运行 |
| Prompt templates | `additionalPromptTemplatePaths` / `noPromptTemplates` | AgentSession -> 用户消息展开 | 是 | 它是 `/name` 消息模板，不是身份 system prompt |

### 2.1 Skills

公开注入方式：

```ts
const loader = new DefaultResourceLoader({
  cwd: workspace,
  agentDir: stateDir,
  settingsManager: SettingsManager.inMemory(),
  additionalSkillPaths: [skillSnapshotA, skillSnapshotB],
  noSkills: true,
  noExtensions: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await loader.reload();
```

依据：

- `DefaultResourceLoaderOptions` 公开 `additionalSkillPaths/noSkills/skillsOverride`，见 [ResourceLoader 源码](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/resource-loader.ts#L159-L193)。
- `noSkills: true` 会关闭默认发现，但显式 additional paths 仍会进入最终 skill 列表，见 [reload 实现](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/resource-loader.ts#L468-L473)。
- Skill 在系统提示中只暴露 name/description/location，正文由模型按需读取，见 [Skills 文档](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/skills.md#L65-L72) 和 [formatSkillsForPrompt](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/skills.ts#L347-L383)。
- `disable-model-invocation: true` 会从 system prompt 隐藏该 skill，但仍可通过 `/skill:name` 明确调用，见 [Skills 文档](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/skills.md#L138-L150)。

结论：Skill 是**按会话可注入的 prompt/resource 能力**，但不是硬权限。模型能否执行 Skill 中的动作，取决于该 Agent 同时拥有的 read/bash/custom tools 及其宿主权限。

### 2.2 MCP

Pi `0.85.1` 没有内建 MCP。官方文档直接写着 “No MCP”；可以：

- 写一个 Pi extension，在 extension 中连接 MCP，再通过 `pi.registerTool()` 暴露工具；
- 或由 Graph 直接连接 MCP，将发现的 tools 构造成 `ToolDefinition[]`，通过 `customTools` 注入 AgentSession。

见 [Pi README Philosophy](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/README.md#L495-L501) 与 [SDK custom tools](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md#L579-L609)。

`customTools` 与 extension-registered tools 都进入同一个 session tool registry；如果给出 `tools` allowlist，则必须把每个希望启用的 custom/extension tool 名写进去，见 [SDK 文档](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md#L605-L609)。

Graph 现有实现已经采用第二种路径：`loadCapabilities()` 根据定义版本解析 MCP/extension 快照，发现 MCP tools 后转成带命名空间的 `ToolDefinition`，并在调用时再次过 gate。[`src/runtime/capabilities.ts:154-280`](</Users/macmini/workspace/13-Graph/src/runtime/capabilities.ts:154>)

### 2.3 Pi extensions

公开注入方式：

```ts
const loader = new DefaultResourceLoader({
  cwd: workspace,
  agentDir: stateDir,
  additionalExtensionPaths: [extensionEntry],
  extensionFactories: [inlineFactory],
  noExtensions: true,
});
```

依据：

- `additionalExtensionPaths` 与 `extensionFactories` 是公开选项，见 [SDK Extensions](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md#L613-L635)。
- `noExtensions: true` 会关闭默认发现，但 explicit additional extension paths 仍会加入最终集合，见 [reload 实现](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/resource-loader.ts#L452-L465)。
- Extension 可以注册 tools/commands/hooks，并在 `before_agent_start` 修改 system prompt、在 `context` 修改消息、在 `tool_call` 阻止调用。生命周期与事件见 [Extensions 文档](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/extensions.md#L270-L340)。
- `resources_discover` 还能在 session start 后补充 skill/prompt/theme paths，因此能力感知也可由 extension 动态扩展。[Extensions 文档](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/extensions.md#L370-L386)

重要限制：

- Extension 是任意 TypeScript 代码，拥有宿主进程权限；“只启用某些工具名”不等于限制 extension 其他 hook 的行为。[扩展安全说明](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/extensions.md#L42-L50)
- 为避免跨 Agent 泄漏，**不要并发共享同一个 ResourceLoader 的 extension runtime**。`AgentSession` 从 `resourceLoader.getExtensions()` 取得 extensions/runtime，每个 session 构造自己的 `ExtensionRunner`；`bindCore()` 又把 session action 写回 shared runtime。源码见 [AgentSession 构造](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts#L2788-L2806) 与 [ExtensionRunner.bindCore](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/runner.ts#L317-L340)。
- `agentDir`/cwd 只控制发现范围，不是安全边界。需要第三方 extension 的强隔离时，应使用独立 Pi 进程或 Graph 自己的受限 worker。

### 2.4 `agent.md`、`tool.md` 与 prompt templates

先区分三件事：

| 名称 | 在 Pi 中的位置 | 作用 |
| --- | --- | --- |
| `agent.md` 身份 | `ResourceLoader.systemPrompt` / `systemPromptOverride`，或 `appendSystemPrompt` | 定义 subagent 的长期身份、职责、输出约束 |
| `tool.md` 能力感知 | Graph 生成后放进 custom system prompt 或 append prompt | 描述该 Agent 可用的 skills/MCP/extensions/tool 使用方式 |
| prompt template | `prompts/*.md` | 在用户输入 `/name` 时展开为 user message，不是身份或能力清单 |

依据：

- `systemPrompt` 会替换默认 prompt；`appendSystemPrompt` 追加到 prompt；context files 与 skills 仍会追加，见 [System prompt 源码](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/system-prompt.ts#L28-L73)。
- Prompt template 的官方定义是“用户通过 `/name` 展开的 Markdown snippet”，见 [Prompt Templates 文档](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/prompt-templates.md#L3-L17)。

这里有一个容易误判的细节：

- 默认 prompt 中，active custom tool 只有在提供 `promptSnippet` 时才进入 `Available tools`；`promptGuidelines` 进入 Guidelines，见 [ToolDefinition 字段](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/types.ts#L451-L461) 与 [默认 prompt builder](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/system-prompt.ts#L80-L116)。
- 但只要使用自定义 `systemPrompt`，builder 走 custom prompt 分支；该分支不加入 selected tools、toolSnippets 或 promptGuidelines，只追加 append prompt、context files、skills 和 cwd。见 [System prompt 源码](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/system-prompt.ts#L48-L72)。

因此“身份 + 能力感知严格拆分”可以做到，但有两条不同路线：

1. **Graph 全权拼装**：`systemPrompt = agent.md`，`appendSystemPrompt = tool.md`，并把所有 skill/MCP/extension 能力写进 tool.md。若还要加载 Pi Skills 但不希望 Pi 再自动追加 skill 描述，可在 `skillsOverride` 中把这些 Skill 标成 `disableModelInvocation: true`，由 tool.md 负责描述，正文仍按 location 由模型读取。
2. **Pi 原生感知优先**：保留 Pi 自动追加的 `<available_skills>`，并让 MCP/extension tools 通过 `promptSnippet/promptGuidelines` 进入默认 prompt；Graph 的 tool.md 只补充跨能力的安全规则和未自动表达的信息。这种方式重复更少，skill 的自动命中通常更可靠。

如果 tool.md 必须是唯一的能力感知来源，建议路线 1；如果更重视 Skill 自动调用质量，建议路线 2。

### 2.5 每个会话的工具集

`createAgentSession({ tools, excludeTools, customTools })` 决定初始 tool registry/active set。公开语义是：

- `noTools: "all"` 先禁用全部；
- `tools` 是跨 built-in/extension/custom 的允许名单；
- `excludeTools` 在允许名单后再排除；
- `customTools` 与 extension tools 合并。

见 [SDK Tools](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md#L518-L609)。

运行时可以调用 `AgentSession.setActiveToolsByName()`，但只对已注册工具生效，且系统提示会随 active tool set 重建，下一轮请求生效。[AgentSession 源码](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts#L964-L985)

## 3. Pi 是否支持把“能力”注入不同 subagent？

答案是：**支持组合式注入，不支持单一的官方 capability API**。

| 需求 | Pi `0.85.1` 支持程度 | 推荐实现 |
| --- | --- | --- |
| 不同 subagent 使用不同 Skills | 支持 | 每 Agent 一个 ResourceLoader；`additionalSkillPaths` + `noSkills:true`；必要时 `skillsOverride` |
| 不同 subagent 使用不同 MCP | 需 Graph 适配 | Graph 连 MCP，按 capability 命名空间生成 `customTools`；tools allowlist 精确放行 |
| 不同 subagent 使用不同 Pi extensions | 支持 | 每 Agent 一个 ResourceLoader；`additionalExtensionPaths/extensionFactories` + `noExtensions:true`；不共享 loader |
| 不同 subagent 使用不同 agent identity | 支持 | `systemPrompt` / `systemPromptOverride` |
| 不同 subagent 使用不同 tool.md | 支持，但由 Graph 生成 | `appendSystemPrompt` 或 custom prompt；保证 capability bundle digest 可追踪 |
| 能力不跨 Agent 泄漏 | 逻辑支持，安全上要 Graph 加固 | 独立 loader、独立 agentDir/cwd、精确 tools、独立 session、进程/OS sandbox |

## 4. MCP 与 subagent 编排：内建还是适配？

### 4.1 MCP

不是内建。必须：

- 由 Pi extension 实现 MCP client 并注册工具；或
- 由 Graph host 实现 MCP client，转换成 `ToolDefinition` 注入 `customTools`。

Pi 的公开 `CreateAgentSessionOptions` 没有 `mcpServers`、`mcpTransport` 或类似字段，见 [SDK d.ts](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/sdk.ts#L20-L72) 与 [Pi README](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/README.md#L497-L501)。

### 4.2 Native subagent orchestration

不是内建。Pi 只提供独立 AgentSession/进程的底层能力：

- 官方文档把 “build custom tools that spawn sub-agents” 列为 SDK 用例，但没有 `createSubagent()` API。[SDK 文档](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md#L5-L14)
- 官方 subagent 示例明确由 extension 自己 spawn `pi` process 并负责 parallel/chain、结果汇总和 abort。[Subagent README](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/examples/extensions/subagent/README.md#L1-L12)

因此 Graph 必须继续拥有：Agent 实例身份、并发名额、任务图、权限 gate、预算/usage、进程沙箱、工作副本与恢复。

## 5. 公开 API 与内部实现

### 5.1 可以依赖的公开 API

- `createAgentSession`、`AgentSession`、`AgentSessionRuntime`
- `DefaultResourceLoader`、`ResourceLoader`
- `SessionManager`
- `SettingsManager`
- `customTools` / `ToolDefinition` / `defineTool`
- `additionalSkillPaths` / `noSkills` / `skillsOverride`
- `additionalExtensionPaths` / `extensionFactories` / `noExtensions` / `extensionsOverride`
- `systemPrompt` / `appendSystemPrompt` / `agentsFilesOverride`
- `tools` / `excludeTools` / `setActiveToolsByName`
- `promptSnippet` / `promptGuidelines`

公开导出见本地 [`node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts:3-24`](</Users/macmini/workspace/13-Graph/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts:3>)，公开 options 见本地 [`dist/core/sdk.d.ts:10-55`](</Users/macmini/workspace/13-Graph/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts:10>) 与 [`dist/core/resource-loader.d.ts:67-110`](</Users/macmini/workspace/13-Graph/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.d.ts:67>)。

### 5.2 不应写进 Graph 契约的内部行为

- `DefaultResourceLoader` 的 package discovery 顺序、extension module cache、`extensionCacheGeneration` 等是 `0.85.1` 的实现细节，不应成为 Graph 的兼容性依赖。[Extension loader 内部 cache](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/loader.ts#L149-L170)
- `ExtensionRunner.bindCore()` 将 session action 写回 extension runtime；共享 loader 时的并发行为不应被当成稳定支持。[源码](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/runner.ts#L317-L340)
- `DefaultResourceLoader` 的 settings/package/global discovery 与 cwd/agentDir 绑定关系，在 `0.85.1` 中可从源码看到，但 Graph 应把“每个 Agent 的精确资源集”作为自己的 manifest，而不是依赖 Pi 的默认发现顺序。

### 5.3 版本特定结论

以上结论针对 `@earendil-works/pi-*` `0.85.1` / commit `d981de1229ef899957bbe968bc8dcda02a21f477`。未来版本可能加入 native MCP、subagent 或新的 resource API；Graph 应把 `CapabilityBundle` 与 Pi adapter 分层，避免在 UI/领域模型中直接写 Pi option 名。

## 6. Graph 落地建议

### 6.1 建议的数据模型

把“能力”与“运行实例”分开：

```text
CapabilityBundleVersion
  id, version, digest
  skills[]       { id, version, snapshotPath, digest }
  mcp[]          { id, version, transport, manifestPath, discoveredTools, digest }
  extensions[]   { id, version, entry, mode, digest }
  prompts        { agentPath, agentDigest, toolPath, toolDigest }
  toolPolicy     { builtins[], customToolNames[], deny[] }
  runtimePolicy  { sandboxProfile, networkDomains, writePaths, usageOwner }

AgentInstance
  definitionVersion
  capabilityBundleVersion
  sessionFile
  workspace/worktree
  model + thinkingLevel
```

### 6.2 每个 Agent 的装配顺序

1. 从 Agent 定义版本解析不可变 `CapabilityBundleVersion`；缺少任何一个绑定版本时 fail closed，不自动使用“最新版”。
2. 打开该实例的独立 `SessionManager.open(sessionFile)`（新实例则 create）。
3. 创建该 Agent 专用的 `SettingsManager.inMemory(...)`，避免读到全局 `settings.json`。
4. 创建该 Agent 专用的 `DefaultResourceLoader`：
   - 固定 `cwd = worktree`、`agentDir = instanceStateDir`；
   - `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles` 全部关闭默认发现；
   - 只显式加入 bundle 中列出的 skill snapshots、extension entries 或 inline factories；
   - `systemPrompt` 放 agent.md，`appendSystemPrompt` 放 Graph 生成的 tool.md。
5. 对 MCP/extension 能力通过 Graph adapter 生成 `ToolDefinition[]`；工具名带 capability namespace，避免冲突：

   ```text
   mcp_<capabilityId>_<toolName>
   ext_<capabilityId>_<toolName>
   ```

6. 调用 `createAgentSession({ resourceLoader, sessionManager, settingsManager, model, customTools, tools, noTools: "all" })`，其中 `tools` 只列该 bundle 产生的工具名与明确允许的 built-ins。
7. 将 bundle digest、Pi version、session file、model/thinking 和实际 tool names 写入实例 manifest；恢复时逐项核对。

Graph 现在的 [`src/runtime/pi-instance.ts:98-126`](</Users/macmini/workspace/13-Graph/src/runtime/pi-instance.ts:98>) 已经接近这个形状：每次 open 创建独立 loader、独立 SessionManager、no-default discovery、显式 skills 和 customTools；下一步应把 prompt bundle、完整 capability set 和 bundle digest 纳入同一 manifest。

### 6.3 Prompt 组装建议

推荐先把两种模式明确分开，避免重复描述：

**模式 A：Pi 原生能力感知**

- `agent.md` 作为身份 prompt。
- Skills 正常加载，接受 Pi 自动追加 `<available_skills>`。
- MCP/extension tools 设置 `promptSnippet/promptGuidelines`。
- `tool.md` 仅补充通用安全规则、组合方式和 Graph 特有操作约束。

适合希望 Skill 自动命中最可靠的 Agent。

**模式 B：严格 `agent.md + tool.md`**

- `systemPrompt` 放 agent.md。
- `appendSystemPrompt` 放 Graph 生成的 tool.md，显式列出每个 skill、MCP tool、extension tool、来源/版本/调用限制。
- Skills 仍加载为快照，但在 `skillsOverride` 中把已写入 tool.md 的 skill 标记为 `disableModelInvocation: true`，避免 Pi 自动追加同一份描述。
- 所有 MCP/extension tool awareness 都写入 tool.md；不依赖 custom prompt 自动拼装 `promptSnippet`。

这是最接近你提出的 “prompts = agent.md + tool.md” 的模式，但代价是 Skill 的自动命中完全依赖 tool.md 质量。

### 6.4 防泄漏规则

1. **每个活跃 AgentSession 一个 ResourceLoader**；不要跨并发 Agent 共享。extension runtime 是 session 装配的一部分，共享会把 hook/runtime 生命周期混在一起。
2. **每个 Agent 一个 stateDir/agentDir**；不要使用默认 `~/.pi/agent` 聚合全局 skills/extensions/settings。
3. **只加载 bundle 中声明的 extension**。`tools` allowlist 不是卸载 extension；未授权 extension 的 `agent_start/context/tool_call/resources_discover` hook 仍可能运行。
4. **Skill 不是权限**。真正的写入/命令/网络权限在 Graph 工具、MCP adapter、extension adapter 和 OS sandbox 中落实。
5. **MCP 必须逐能力、逐工具授权**。连接成功、工具列表、MCP 自报 annotation 都不能替代 Graph grant。
6. **恢复必须重用原 bundle**。session JSONL 只保存对话上下文；不保存 capability bundle，缺版本时不能静默降级。
7. **第三方 extension 只在隔离进程运行**。若需要官方 Pi extension 的完整语义，最稳妥是每个 Agent 一个独立 Pi 进程，并给它独立的 cwd/agentDir/output channel；若继续在 Graph 宿主内加载，则接受其完整宿主权限风险。

Graph 现有 [ADR 0008](</Users/macmini/workspace/13-Graph/docs/adr/0008-definition-bound-capability-loading.md:1>) 与 [`src/runtime/capabilities.ts`](</Users/macmini/workspace/13-Graph/src/runtime/capabilities.ts:182>) 已经建立了“定义版本绑定、能力快照、受限 worker、远程 MCP 域名/调用门”的主体。建议下一版只补上“**CapabilityBundleVersion + agent.md/tool.md digest + per-Agent ResourceLoader manifest**”，不要另起一套与现有能力库并行的配置系统。
