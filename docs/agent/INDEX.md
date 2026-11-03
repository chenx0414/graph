# Graph Agent Documentation

这是 Graph 源码内的只读 Agent 文档索引。system prompt 只注入入口路径、本文档目录、示例目录和阅读协议；主题正文必须在需要时通过 `read` 按需读取。

## 阅读规则

- 构建或修改 graph、处理运行失败，或配置模型与能力时，先读对应主题；解释系统事实时也使用这些文档。
- 主题路径始终相对本文件所在目录解析，不相对业务仓库或 Agent worktree 解析。
- 建图先读 `graph-v2.md`，选择结构时读 `../design-graph-examples.md`；其他操作按下表读取直接相关主题。只继续读取解决当前操作所需的引用，不递归展开所有文档。
- 完成相关 Markdown 文件后再下结论，不要只根据文件名或本索引猜测。
- 本文档描述行为契约。实时状态必须通过 `read_system_capabilities`、`inspect_graph_system`、`list_problems` 和节点记录确认。
- 不要从 `~/.graph/prompts/docs` 读取旧副本；源码内的 `docs/agent` 是唯一 Agent 文档来源。
- system prompt 中的绝对路径来自运行中应用。业务仓库中的 Graph 文档可能属于旧版本，只用于理解被修改的项目，不能覆盖宿主的 schemaVersion:2 API。

## 主题

| 文档 | 何时读取 |
| --- | --- |
| `README.md` | 需要了解文档范围、源码布局和推荐阅读顺序 |
| `graph-overview.md` | 需要理解 Graph 是什么、有哪些角色和核心术语 |
| `../design-graph-examples.md` | 需要设计（或改动）一张任务图时：先判档（简单/中等/复杂），再照对应档的范例写 |
| `graph-v2.md` | 创建、投递、局部修改、控制 graph 或查看边/模块历史 |
| `execution-model.md` | 需要理解接口投递、串行队列、常驻会话、模块和恢复 |
| `capabilities.md` | 需要判断 Skill、MCP、extension、工具如何发现、绑定和注入 |
| `permissions-and-recovery.md` | 需要解释权限、预算、暂停、用量、问题所有权和未知结果 |
| `artifacts-and-git.md` | 需要理解 worktree、handoff、artifact、evidence、integration 和 merge |
| `self-configuration.md` | 需要查看或修改 Agent prompt、工具选择和系统能力；比较同一任务的多个 harness、采纳教训或读取自己的运行证据 |
| `models-and-providers.md` | 需要配置模型厂商/订阅凭据、新增或调整模型及其参数、排查模型不可用 |
| `provider-authorization.md` | 需要接通 OpenRouter 浏览器授权或 Grok / xAI 设备码登录，或排查授权状态机、令牌刷新、断开凭据 |
| `matt-team.md` | 按 ask-matt 装配、保存、复用 Matt 团队，传递精确 plan 并处理双轴审查与原节点返工 |
| `agent-recipes.md` | 需要新建/改描述/删除子 Agent 配方，或核对配方编译结果 |
| `troubleshooting.md` | 任务卡住、工具失败、模型不可用、恢复不确定或用户报告异常 |

## 事实优先级

发生冲突时按以下顺序判断：

1. 宿主工具的实时返回值与持久状态；
2. 已确认任务、图版本、acceptance 和 decision snapshot；
3. 当前生效的 Agent definition、capability bundle 和运行策略；
4. 本索引与 topic docs；
5. 对话记忆或模型推断。

低优先级事实不能覆盖高优先级事实。
