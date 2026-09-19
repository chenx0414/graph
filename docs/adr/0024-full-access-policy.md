# ADR 0024：完全访问策略

日期：2026-09-19

## 状态

已接受。

## 背景

Graph 当前把问题审批、任务授权、命令白名单、Agent 路径边界、MCP 网络声明和 Pi
extension 运行时声明分别实现。使用者需要一个显式的完全访问模式，让 Graph
自动处理运行授权、访问宿主工作路径，并运行能力声明的命令和网络，而不需要把
这些边界散落成多个 `fullAccess === true` 分支，也不能让权限开关意外关闭预算、
暂停、计量、恢复、审计或任务范围确认。

绝对“所有路径”和同一 OS 用户下的宿主凭据隔离不能同时成立。Agent 如果能读取
`$HOME/.ssh`、`.aws`、`.netrc`、Git credential store 和 Graph 正式状态，就能绕过
宿主凭证代理。需要同时满足两者的执行身份应使用独立 OS 用户、容器或 VM。

## 决策

- 配置新增版本化 `access` 文档，默认等价于现有 `standard` 行为。
- `full` 预设自动批准 `permission` 和 `system_change`，允许宿主文件系统、任意
  可执行命令、任意网络、Pi extension 宿主运行时、本地绑定和 Unix socket。
- `budget`、`human_check`、模型订阅决策、任务图确认、暂停、计量、并发、审计和
  恢复核对不随访问模式自动通过；需要无人值守确认时使用独立配置。
- 默认保护 credential stores、Graph 正式状态和 Git metadata。Credential stores
  可读、Git metadata 可写、Apple Events 和全部 Unix socket 属于独立高风险开关。
- 每次 operation 在准入时冻结 effective policy 和 digest。运行中的 operation
  不因热配置变化扩大权限；回退只影响下一次准入。
- 自动批准复用正常问题答案路径，保留原始问题、自动答案、策略 digest 和审计事件。
- 命令始终以 executable + argv 执行，不把模型输入拼成 shell 文本。

## 后果

完全访问模式可以在当前 macOS 同一用户模型下放开工作路径和能力，但不能承诺
宿主凭证绝对隔离。需要绝对隔离时必须选择独立执行身份。

使用者随后确认了界面修订：完全访问开关放在聊天输入区，点击即可开启或关闭，
不再要求输入 typed phrase。运行权限仍在 operation 准入时冻结，界面开关只改变
下一次准入使用的配置；effective roots、网络、命令、受保护路径和策略 digest
继续保存在有效配置与 operation 审计记录中。

新策略进入 operation 记录，不重写历史 `task_grants`、预算、credential groups
或历史事件。回退不会撤销已经发出的外部副作用，这些副作用继续走恢复和核对。
