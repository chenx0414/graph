# 能力包注入与独立 Pi 进程

Agent 定义版本解析出的能力包包含 Skills、MCP、Pi extensions 与 prompts。生产执行不再在同一后台进程内直接创建 `AgentSession`，而是为每次 Agent operation 启动一个独立的受操作系统限制的 Pi 进程。

宿主进程保留：

- 供应商凭据、模型请求和 usage 账本；
- pause、预算、权限、未知用量和恢复 gate；
- 工作区/MCP/Graph extension 的真实工具实现；
- Agent 实例身份、capability digest 和会话 manifest。

子进程只收到：

- 模型元数据，不包含凭据；
- 显式 Skill 路径；
- 显式 Pi extension 入口；
- `agent.md` 身份 prompt 和 Graph 生成的 `tool.md` 能力感知 prompt；
- 工具的 JSON schema 代理，不包含工具实现。

`tool.md` 是 Graph 约定，不是 Pi 原生文件。Graph 根据实际加载的能力和可调用工具生成，即使定义绑定了自定义 `tool.md`，也会在后方追加权威 inventory。Skill 文件仍由 Pi 加载为只读资源，但自动 Skill 描述从 system prompt 隐藏，由 `tool.md` 统一表达，避免身份与能力重复。

不同 Agent 使用独立 `SessionManager`、`ResourceLoader`、Pi 进程和工作目录。Pi extension 只在该子进程内加载；模型和代理工具请求通过子进程的 fd 3 回到宿主 gate。Pi extension 注册的工具在宿主的 `tool_call` 拦截中先过一次 gate，命令、MCP 和 Graph extension 仍由宿主对应的受限 executor 执行。

实例 manifest 记录最终 capability digest。恢复时必须按原定义版本重新解析同一能力包；session JSONL 本身不保存 Skills、MCP、Pi extensions、prompts 或权限绑定，digest 不一致时 fail closed。

## 后果

- Pi extension 的任意代码仍不能获得供应商凭据，且运行在宿主建立的 OS 文件/网络限制内。
- 子进程可以加载官方 Pi extension 语义，但扩展工具的实际执行仍发生在其受限进程内；Graph 的调用门负责执行前准入，宿主代理工具负责完整计量与受限执行。
- 每次 operation 多一次进程启动成本，换取不同 Agent 之间更清晰的 resource/runtime 隔离和可追踪的能力版本。
- 该决策强化 [ADR 0008](0008-definition-bound-capability-loading.md)，不改变“安装能力不等于扩大任务权限”的规则。
