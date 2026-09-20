# Graph Agent Documentation

这是 Graph 运行时注入给 Agent 的文档索引。system prompt 只注入本索引、文档根路径和阅读协议；主题正文必须在需要时通过 `read` 按需读取。

## 阅读规则

- 只在用户询问 Graph 自身、Agent 上下文、工具为何不可用、任务为何阻塞、执行恢复或系统配置时读取这些文档。
- `docs/...` 始终相对 host 在 `<docs>` section 中给出的文档根路径解析，不相对业务仓库或 worktree 解析。
- 先读本索引，再读与问题直接相关的主题文件；跨文件引用必须继续跟随。
- 完成相关 Markdown 文件后再下结论，不要只根据文件名或本索引猜测。
- 本文档描述行为契约。实时状态必须通过 `read_system_capabilities`、`inspect_graph_system`、`list_problems` 和节点记录确认。

## 主题

| 文档 | 何时读取 |
| --- | --- |
| `graph-overview.md` | 需要理解 Graph 是什么、有哪些角色和核心术语 |
| `execution-model.md` | 需要理解任务图、operation、激活、回环、并发和恢复 |
| `capabilities.md` | 需要判断 Skill、MCP、extension、工具如何发现、绑定和注入 |
| `permissions-and-recovery.md` | 需要解释权限、预算、暂停、用量、问题所有权和未知结果 |
| `artifacts-and-git.md` | 需要理解 worktree、handoff、artifact、evidence、integration 和 merge |
| `self-configuration.md` | 需要查看或修改 Agent prompt、工具选择和系统能力 |
| `troubleshooting.md` | 任务卡住、工具失败、模型不可用、恢复不确定或用户报告异常 |

## 事实优先级

发生冲突时按以下顺序判断：

1. 宿主工具的实时返回值与持久状态；
2. 已确认任务、图版本、acceptance 和 decision snapshot；
3. 当前生效的 Agent definition、capability bundle 和运行策略；
4. 本索引与 topic docs；
5. 对话记忆或模型推断。

低优先级事实不能覆盖高优先级事实。
